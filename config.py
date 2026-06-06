"""Central configuration + runtime API-key management."""
import os, json, hashlib, secrets, threading, datetime
from pathlib import Path
from dotenv import load_dotenv
from google import genai
from google.genai import types

APP_DIR  = Path(__file__).resolve().parent
# Runtime state (jobs, access codes, incidents) lives here. Defaults to the app dir,
# but in a read-only / containerised deploy point ABICOR_DATA_DIR at a writable volume.
DATA_DIR = Path(os.getenv("ABICOR_DATA_DIR", str(APP_DIR)))
DATA_DIR.mkdir(parents=True, exist_ok=True)
JOBS_DIR = DATA_DIR / "jobs"
JOBS_DIR.mkdir(exist_ok=True)
ENV_PATH = APP_DIR / ".env"
CODES_PATH = DATA_DIR / "access_codes.json"   # gitignored — operator-managed

# Load .env from the app dir first, then the parent home dir as a fallback.
load_dotenv(ENV_PATH)
load_dotenv(APP_DIR.parent / ".env")

# Generation settings (deterministic)
MODEL       = "gemini-3.5-flash"
EMBED_MODEL = "gemini-embedding-2"
SEED        = 42
TEMPERATURE = 0.0

PART_MATCH_THRESHOLD = 0.62
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB

# SAM backend preference (first that loads wins). SAM 3 is preferred but gated;
# the app auto-falls back so it runs everywhere.
SAM_PREFERENCE = [s.strip() for s in
                  os.getenv("SAM_PREFERENCE", "sam3,sam2,sam1").split(",") if s.strip()]


def hf_token():
    """HuggingFace token for gated models (e.g. SAM 3). Optional."""
    return (os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_HUB_TOKEN")
            or os.getenv("HUGGINGFACEHUB_API_TOKEN") or "").strip() or None

# When set, the app talks to Gemini THROUGH the key-vault proxy (keyvault/vault.py),
# and _API_KEY holds a revocable *handshake token* — never the real €214 key.
PROXY_URL = (os.getenv("GEMINI_PROXY_URL") or "").strip() or None

# Runtime key/token store (may be set via the in-app Settings dialog)
_API_KEY = (os.getenv("GEMINI_API_KEY") or "").strip() or None


def _make_client(key: str) -> "genai.Client":
    """Build a Gemini client. In proxy mode the SDK points at the vault and `key`
    is a handshake token; otherwise it's a direct Gemini key."""
    key = (key or "").strip()
    if PROXY_URL:
        return genai.Client(api_key=key, http_options=types.HttpOptions(base_url=PROXY_URL))
    return genai.Client(api_key=key)


def has_key() -> bool:
    return bool(_API_KEY)


def get_api_key() -> str:
    return _API_KEY or ""


def set_api_key(key: str, persist: bool = True) -> str:
    global _API_KEY, _CLIENT, _CLIENT_SIG
    _API_KEY = (key or "").strip() or None
    _CLIENT = None; _CLIENT_SIG = None        # force the cached client to rebuild
    if _API_KEY:
        os.environ["GEMINI_API_KEY"] = _API_KEY
        if persist:
            _persist_key(_API_KEY)
    return _API_KEY or ""


def _persist_key(key: str):
    """Write/replace GEMINI_API_KEY in the app's .env so it survives restarts."""
    lines = []
    if ENV_PATH.exists():
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    found = False
    for i, ln in enumerate(lines):
        if ln.strip().startswith("GEMINI_API_KEY"):
            lines[i] = f"GEMINI_API_KEY={key}"
            found = True
    if not found:
        lines.append(f"GEMINI_API_KEY={key}")
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def validate_key(key: str) -> bool:
    """Cheap check that a key (or handshake token, in proxy mode) actually works."""
    try:
        c = _make_client(key)
        next(iter(c.models.list()), None)
        return True
    except Exception:
        return False


# A single long-lived client, reused everywhere. Creating a client per call and
# letting it fall out of scope lets its __del__ close the shared HTTP transport
# mid-request ("client has been closed"), so we cache and hold a strong reference.
_CLIENT = None
_CLIENT_SIG = None


def get_client() -> "genai.Client":
    global _CLIENT, _CLIENT_SIG
    if not _API_KEY:
        raise RuntimeError("No API key configured — add it in Settings.")
    sig = (PROXY_URL, _API_KEY)
    if _CLIENT is None or _CLIENT_SIG != sig:
        _CLIENT = _make_client(_API_KEY)
        _CLIENT_SIG = sig
    return _CLIENT


# ===================================================================
# Revocable access codes (the "API but not API" gateway)
# -------------------------------------------------------------------
# When the operator hosts the app with their own GEMINI_API_KEY in .env,
# clients NEVER receive that key. Instead each client is given a revocable
# access code. The server uses the operator's key on their behalf and the
# operator can disable any code instantly (no key rotation, no downtime).
#
# Gateway mode turns on automatically the moment any access code exists
# (or REQUIRE_ACCESS_CODE=1 is set). With no codes it stays in "bring your
# own key" mode so local/dev use is unchanged.
# ===================================================================
_codes_lock = threading.Lock()


def admin_token():
    """Token guarding the /api/admin/* code-management API. Disabled if unset."""
    return (os.getenv("ADMIN_TOKEN") or "").strip() or None


def _today() -> str:
    return datetime.date.today().isoformat()


def _now_iso() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


def _hash_code(code: str) -> str:
    return hashlib.sha256(("abicor-access:" + (code or "").strip()).encode()).hexdigest()


def _load_codes() -> list:
    if not CODES_PATH.exists():
        return []
    try:
        return json.loads(CODES_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_codes(codes: list):
    CODES_PATH.write_text(json.dumps(codes, indent=2), encoding="utf-8")


def gateway_mode() -> bool:
    """True when clients must present a revocable access code."""
    if (os.getenv("REQUIRE_ACCESS_CODE", "").strip().lower() in ("1", "true", "yes", "on")):
        return True
    return bool(_load_codes())


def issue_code(label: str = "", expires: str = None, max_uses: int = None) -> dict:
    """Mint a new access code. Returns the plaintext code ONCE (only the hash is stored)."""
    raw = "ABICOR-" + "-".join(secrets.token_hex(2).upper() for _ in range(2))  # ABICOR-1A2B-3C4D
    rec = {
        "id": secrets.token_hex(4),
        "label": (label or "").strip(),
        "hash": _hash_code(raw),
        "hint": raw[:10] + "..." + raw[-2:],
        "enabled": True,
        "created": _today(),
        "last_used": None,
        "uses": 0,
        "max_uses": max_uses,
        "expires": (expires or None),
    }
    with _codes_lock:
        codes = _load_codes()
        codes.append(rec)
        _save_codes(codes)
    return {"code": raw, **{k: rec[k] for k in
            ("id", "label", "hint", "enabled", "created", "max_uses", "expires")}}


def check_code(code: str, consume: bool = False):
    """Return {id,label} if the code is valid + active, else None.
    consume=True counts one metered use (call it only for billable actions)."""
    code = (code or "").strip()
    if not code:
        return None
    h = _hash_code(code)
    with _codes_lock:
        codes = _load_codes()
        rec = next((c for c in codes if c.get("hash") == h), None)
        if not rec or not rec.get("enabled"):
            return None
        if rec.get("expires") and _today() > rec["expires"]:
            return None
        mu = rec.get("max_uses")
        if mu is not None and rec.get("uses", 0) >= mu:
            return None
        if consume:
            rec["uses"] = rec.get("uses", 0) + 1
            rec["last_used"] = _now_iso()
            _save_codes(codes)
        return {"id": rec["id"], "label": rec.get("label", "")}


def list_codes() -> list:
    """Sanitized list for display/admin (never exposes the hash)."""
    return [{k: c.get(k) for k in
             ("id", "label", "hint", "enabled", "created", "last_used", "uses", "max_uses", "expires")}
            for c in _load_codes()]


def _match(c: dict, ident: str) -> bool:
    ident = (ident or "").strip().lower()
    return c.get("id") == ident or (c.get("label", "").strip().lower() == ident and ident != "")


def set_code_enabled(ident: str, enabled: bool) -> int:
    """Enable/disable by id or label. Returns how many records changed."""
    n = 0
    with _codes_lock:
        codes = _load_codes()
        for c in codes:
            if _match(c, ident):
                c["enabled"] = enabled
                n += 1
        if n:
            _save_codes(codes)
    return n


def delete_code(ident: str) -> int:
    with _codes_lock:
        codes = _load_codes()
        keep = [c for c in codes if not _match(c, ident)]
        n = len(codes) - len(keep)
        if n:
            _save_codes(keep)
    return n
