# ABICOR key-vault

A thin proxy that sits in front of Gemini so **the app never holds your real key**.
The app is given a revocable **handshake token**; the vault swaps it for the real
key, forwards the call, meters what each token spends, and can cut any token off
instantly. Run it on your Hetzner box next to Rocky.

```
   app  ──(handshake token)──►  VAULT (your box)  ──(real key)──►  Gemini
                                   │  per-token metering + caps + kill switch
                                   └─ Rocky drives /admin to issue/revoke/watch
```

**What never leaves your box:** the real Gemini key. ABICOR (or whoever runs the
app) only ever has a handshake token, which you can revoke at will.

## Deploy on Hetzner

```bash
# on the server
cd /opt/abicor/keyvault
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # then edit .env (real key, admin token, caps)
python vault.py               # or use the systemd unit below
```

Put it behind your reverse proxy with **HTTPS** (Caddy/nginx/Cloudflare) so the
handshake token travels encrypted, e.g. `https://vault.yourdomain.com`.

Run it as a service:

```bash
sudo cp abicor-vault.service /etc/systemd/system/
sudo systemctl enable --now abicor-vault
```

## Issue a token for the app

```bash
python manage_tokens.py new --label "ABICOR app" --max-tokens 2000000
#   hsk_xxxxxxxx...   <-- shown once
```

Then in the **app's** `.env` (not the vault's):

```
GEMINI_PROXY_URL=https://vault.yourdomain.com
GEMINI_API_KEY=hsk_xxxxxxxx...     # the handshake token — the app holds this, not the real key
```

The app now calls Gemini through the vault. Revoke any time:

```bash
python manage_tokens.py list
python manage_tokens.py revoke "ABICOR app"     # instant — next call gets 401
python manage_tokens.py kill                     # global breaker: vault refuses everything
```

## Let Rocky drive it (HTTP /admin API)

Set `VAULT_ADMIN_TOKEN` in `.env`; Rocky sends it as the `X-Admin-Token` header.
(The /admin surface 404s until the token is set.)

```
POST   /admin/tokens                 {label, max_tokens?, max_requests?} -> {token, id, ...}
GET    /admin/tokens                 -> tokens + per-token usage + global + killed
POST   /admin/tokens/{id|label}/revoke
POST   /admin/tokens/{id|label}/enable
DELETE /admin/tokens/{id|label}
POST   /admin/kill                   {on: true|false}    # global breaker
GET    /admin/usage                  -> raw ledger (for Rocky's monitoring/alerts)
GET    /healthz                      -> liveness (no secret leaked)
```

Rocky's job: issue a token to the app, watch `/admin/usage` for spend, alert you
on a spike, and `revoke` / `kill` if anything looks wrong.

## Why this protects your €214

1. **Separate money** — point the vault's `GEMINI_API_KEY` at a small-float key
   (~€20). Even total compromise can't exceed that float.
2. **Per-token + global caps** — `--max-tokens` per token and `VAULT_GLOBAL_TOKEN_CAP`
   across all of them; the vault returns `402` once a cap is hit.
3. **Instant revoke + kill switch** — no key rotation, nobody else affected.
4. **The key never leaves the vault** — the app and ABICOR only ever see a token.

## Notes / limits

- Token usage is metered from Gemini's `usageMetadata.totalTokenCount` on
  `:generateContent` / `:embedContent` calls (the cost centers). Large file
  *uploads* stream straight through and aren't token-metered (they're ~free).
- Streaming (`:streamGenerateContent`) is passed through but not token-metered;
  this app uses non-streaming generation, so caps apply to its real spend.
- Files are gitignored: `.env`, `tokens.json`, `usage.json`, `KILL`.
