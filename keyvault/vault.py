"""
ABICOR key-vault — a thin handshake-token proxy in front of the Gemini API.

Why this exists
---------------
You pay for Gemini. You must never hand that key to anyone who runs the app.
This service holds the ONLY copy of the real key. The app is given a revocable
**handshake token** instead. The vault swaps the token for the real key, forwards
the call to Google, meters what each token spends, and can cut any token off
instantly. Run it next to your Rocky bot on Hetzner; Rocky drives the /admin API
to issue / revoke / monitor tokens.

   app  --(handshake token)-->  VAULT  --(real key)-->  Gemini
                                  └── meters + caps + kill switch, per token

Deploy: see keyvault/README.md. Config: keyvault/.env (copy from .env.example).
"""
import os
import json
import hashlib
import secrets
import threading
import datetime
from pathlib import Path
from urllib.parse import urlencode, parse_qsl, urlsplit

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException, Header, Body, Depends
from fastapi.responses import JSONResponse, StreamingResponse, Response
from starlette.background import BackgroundTask

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

GOOGLE = "https://generativelanguage.googleapis.com"
REAL_KEY = (os.getenv("GEMINI_API_KEY") or "").strip()
ADMIN = (os.getenv("VAULT_ADMIN_TOKEN") or "").strip()
# 0 = unlimited. A hard ceiling across ALL tokens — your last line of defence.
GLOBAL_TOKEN_CAP = int(os.getenv("VAULT_GLOBAL_TOKEN_CAP", "0") or 0)

# State (token hashes, usage ledger, kill flag) lives here. Defaults next to the
# code, but set VAULT_STATE_DIR to a writable path when the install dir is read-only.
STATE_DIR = Path(os.getenv("VAULT_STATE_DIR", str(HERE)))
STATE_DIR.mkdir(parents=True, exist_ok=True)
TOKENS_PATH = STATE_DIR / "tokens.json"     # handshake tokens (hashed) — Rocky manages
USAGE_PATH = STATE_DIR / "usage.json"       # per-token ledger — Rocky monitors
KILL_PATH = STATE_DIR / "KILL"              # presence = global breaker engaged

_lock = threading.Lock()


# --------------------------------------------------------------- small helpers
def _now() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


def _today() -> str:
    return datetime.date.today().isoformat()


def _hash(tok: str) -> str:
    return hashlib.sha256(("vault:" + (tok or "").strip()).encode()).hexdigest()


def _load(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _save(path: Path, data):
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


# --------------------------------------------------------------- token store
def issue_token(label="", max_tokens=None, max_requests=None) -> dict:
    """Mint a handshake token. The plaintext is returned ONCE (only the hash is kept)."""
    raw = "hsk_" + secrets.token_urlsafe(24)
    rec = {
        "id": secrets.token_hex(4),
        "label": (label or "").strip(),
        "hash": _hash(raw),
        "hint": raw[:8] + "...",
        "enabled": True,
        "created": _today(),
        "max_tokens": int(max_tokens) if max_tokens not in (None, "") else None,
        "max_requests": int(max_requests) if max_requests not in (None, "") else None,
    }
    with _lock:
        toks = _load(TOKENS_PATH, [])
        toks.append(rec)
        _save(TOKENS_PATH, toks)
    return {"token": raw, "id": rec["id"], "label": rec["label"],
            "max_tokens": rec["max_tokens"], "max_requests": rec["max_requests"]}


def _find(toks, ident):
    ident = (ident or "").strip().lower()
    return [t for t in toks if t["id"] == ident or t.get("label", "").strip().lower() == ident]


def set_enabled(ident, enabled) -> int:
    with _lock:
        toks = _load(TOKENS_PATH, [])
        hits = _find(toks, ident)
        for t in hits:
            t["enabled"] = enabled
        if hits:
            _save(TOKENS_PATH, toks)
    return len(hits)


def delete_token(ident) -> int:
    with _lock:
        toks = _load(TOKENS_PATH, [])
        keep = [t for t in toks if t not in _find(toks, ident)]
        n = len(toks) - len(keep)
        if n:
            _save(TOKENS_PATH, keep)
    return n


def validate(token: str):
    """Return the token record if usable, None if unknown/revoked.
    Raises 402 if a cap is already exhausted."""
    h = _hash(token)
    toks = _load(TOKENS_PATH, [])
    rec = next((t for t in toks if t.get("hash") == h), None)
    if not rec or not rec.get("enabled"):
        return None
    usage = _load(USAGE_PATH, {})
    u = usage.get(rec["id"], {})
    if rec.get("max_requests") and u.get("requests", 0) >= rec["max_requests"]:
        raise HTTPException(402, "handshake token request cap reached")
    if rec.get("max_tokens") and u.get("tokens", 0) >= rec["max_tokens"]:
        raise HTTPException(402, "handshake token spend cap reached")
    if GLOBAL_TOKEN_CAP and usage.get("_global", {}).get("tokens", 0) >= GLOBAL_TOKEN_CAP:
        raise HTTPException(402, "vault global spend cap reached")
    return rec


def add_usage(tid: str, tokens_used: int, requests: int = 1):
    with _lock:
        usage = _load(USAGE_PATH, {})
        u = usage.get(tid, {"requests": 0, "tokens": 0, "last_used": None})
        g = usage.get("_global", {"requests": 0, "tokens": 0})
        u["requests"] += requests
        u["tokens"] += tokens_used
        u["last_used"] = _now()
        g["requests"] = g.get("requests", 0) + requests
        g["tokens"] = g.get("tokens", 0) + tokens_used
        usage[tid] = u
        usage["_global"] = g
        _save(USAGE_PATH, usage)


# --------------------------------------------------------------- the proxy
app = FastAPI(title="ABICOR key-vault")
_client = httpx.AsyncClient(base_url=GOOGLE, timeout=httpx.Timeout(600.0))

# hop-by-hop / auth headers we never forward upstream
_REQ_DROP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding",
             "accept-encoding", "x-goog-api-key", "authorization"}
# headers we never echo back to the client
_RESP_DROP = {"host", "content-length", "transfer-encoding", "connection", "keep-alive"}
# only these POSTs carry billable token usage worth metering exactly
_METERED = (":generatecontent", ":embedcontent", ":counttokens", ":batchembedcontents")


def _extract_token(request: Request) -> str:
    t = request.headers.get("x-goog-api-key")
    if t:
        return t.strip()
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.query_params.get("key", "").strip()


def _fwd_headers(request: Request) -> dict:
    h = {k: v for k, v in request.headers.items() if k.lower() not in _REQ_DROP}
    h["x-goog-api-key"] = REAL_KEY            # the swap: token in, real key out
    return h


def _upstream_url(request: Request) -> str:
    """Host-pinned absolute upstream URL. Rejects anything that could escape to
    another host (e.g. a scheme-relative '//evil.com/...' path) — the real key must
    only ever be sent to Google."""
    path = request.url.path
    if not path.startswith("/") or path.startswith("//"):
        raise HTTPException(400, "bad request path")
    q = [(k, v) for k, v in parse_qsl(request.url.query, keep_blank_values=True) if k != "key"]
    full = GOOGLE + path + (("?" + urlencode(q)) if q else "")
    if urlsplit(full).hostname != "generativelanguage.googleapis.com":
        raise HTTPException(400, "blocked")
    return full


def _require_admin(x_admin_token: str = Header(default="")):
    if not ADMIN:
        raise HTTPException(404, "Not found")          # admin surface hidden until configured
    if not secrets.compare_digest(x_admin_token, ADMIN):   # constant-time
        raise HTTPException(401, "bad admin token")
    return True


@app.get("/healthz")
def healthz():
    return {"ok": True, "key_configured": bool(REAL_KEY), "killed": KILL_PATH.exists(),
            "global_cap": GLOBAL_TOKEN_CAP or None}


# ---- admin API (Rocky) — registered before the catch-all so it wins routing ----
@app.post("/admin/tokens", dependencies=[Depends(_require_admin)])
def admin_issue(body: dict = Body(...)):
    return issue_token(body.get("label", ""), body.get("max_tokens"), body.get("max_requests"))


@app.get("/admin/tokens", dependencies=[Depends(_require_admin)])
def admin_list():
    usage = _load(USAGE_PATH, {})
    out = []
    for t in _load(TOKENS_PATH, []):
        u = usage.get(t["id"], {})
        row = {k: t.get(k) for k in
               ("id", "label", "hint", "enabled", "created", "max_tokens", "max_requests")}
        row.update(used_tokens=u.get("tokens", 0), used_requests=u.get("requests", 0),
                   last_used=u.get("last_used"))
        out.append(row)
    return {"tokens": out, "global": usage.get("_global", {}), "killed": KILL_PATH.exists()}


@app.post("/admin/tokens/{ident}/revoke", dependencies=[Depends(_require_admin)])
def admin_revoke(ident: str):
    return {"changed": set_enabled(ident, False)}


@app.post("/admin/tokens/{ident}/enable", dependencies=[Depends(_require_admin)])
def admin_enable(ident: str):
    return {"changed": set_enabled(ident, True)}


@app.delete("/admin/tokens/{ident}", dependencies=[Depends(_require_admin)])
def admin_delete(ident: str):
    return {"deleted": delete_token(ident)}


@app.post("/admin/kill", dependencies=[Depends(_require_admin)])
def admin_kill(body: dict = Body(default={})):
    on = bool(body.get("on", True))
    if on:
        KILL_PATH.write_text(_now(), encoding="utf-8")
    elif KILL_PATH.exists():
        KILL_PATH.unlink()
    return {"killed": on}


@app.get("/admin/usage", dependencies=[Depends(_require_admin)])
def admin_usage():
    return _load(USAGE_PATH, {})


@app.api_route("/{path:path}",
               methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy(path: str, request: Request):
    if not REAL_KEY:
        raise HTTPException(503, "vault has no GEMINI_API_KEY configured")
    if KILL_PATH.exists():
        raise HTTPException(503, "vault kill switch is engaged")

    token = _extract_token(request)
    if not token:
        raise HTTPException(401, "missing handshake token")
    rec = validate(token)                                   # may raise 402 on a cap
    if rec is None:
        raise HTTPException(401, "invalid or revoked handshake token")

    url = _upstream_url(request)          # absolute + host-pinned (no SSRF escape)
    headers = _fwd_headers(request)
    metered = request.method == "POST" and request.url.path.lower().endswith(_METERED)

    if metered:
        body = await request.body()                         # generate/embed bodies are small
        r = await _client.request(request.method, url, headers=headers, content=body)
        if "application/json" in r.headers.get("content-type", ""):
            try:
                data = r.json()
            except Exception:
                data = None
            if data is not None:
                um = data.get("usageMetadata") or {} if isinstance(data, dict) else {}
                add_usage(rec["id"], int(um.get("totalTokenCount") or 0), 1)
                return JSONResponse(data, status_code=r.status_code)
        add_usage(rec["id"], 0, 1)
        out = {k: v for k, v in r.headers.items() if k.lower() not in _RESP_DROP}
        return Response(content=r.content, status_code=r.status_code, headers=out)

    # everything else (file uploads, file fetches, streaming) — pass through untouched
    content = request.stream() if request.method in ("POST", "PUT", "PATCH") else None
    upstream = _client.build_request(request.method, url, headers=headers, content=content)
    r = await _client.send(upstream, stream=True)
    out = {k: v for k, v in r.headers.items() if k.lower() not in _RESP_DROP}
    return StreamingResponse(r.aiter_raw(), status_code=r.status_code, headers=out,
                             background=BackgroundTask(r.aclose))


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("VAULT_PORT", "8800"))
    host = os.getenv("VAULT_HOST", "127.0.0.1")     # behind the HTTPS reverse proxy by default
    print(f"ABICOR key-vault on http://{host}:{port}  (key set: {bool(REAL_KEY)})")
    uvicorn.run(app, host=host, port=port, log_level="info")
