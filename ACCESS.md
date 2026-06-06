# Revocable access — "API, but not API"

You pay for Gemini. You must **not** hand your raw Gemini key to ABICOR or anyone
else. This gateway lets people use the app on **your** key while you keep full,
instant control: issue a code per person, revoke any code in one command, no key
rotation and no downtime.

## How it works

```
   client browser                your server (.env: GEMINI_API_KEY)
   ┌────────────┐   X-Access-Code   ┌─────────────────────────────┐
   │ access code│ ────────────────► │ check code → use YOUR key   │ ──► Gemini
   │ (revocable)│                   │ (clients never see the key) │
   └────────────┘                   └─────────────────────────────┘
```

- The real Gemini key lives only in the server's `.env` — never sent to a browser.
- Each client enters a **revocable access code** in Settings (not a Gemini key).
- The server validates the code, then calls Gemini with *your* key on their behalf.
- Only the code's **hash** is stored on disk (`access_codes.json`, gitignored).

**Two modes, auto-detected:**
- **Gateway mode** (revocable codes) — turns on automatically the moment one code
  exists, or when `REQUIRE_ACCESS_CODE=1`.
- **Bring-your-own-key** — with no codes, the app behaves exactly as before
  (good for local dev / self-hosting): a user pastes their own Gemini key.

## Operator quick start

```bash
# 1. put YOUR Gemini key in .env (never commit it)
echo "GEMINI_API_KEY=A;..." >> .env

# 2. issue a code for someone — printed ONCE, copy it
python manage_codes.py new --label "ABICOR - Prasad"
#   ABICOR-1A2B-3C4D     <-- give this to Prasad

# 3. see who has access
python manage_codes.py list

# 4. cut someone off instantly (no key change, nobody else affected)
python manage_codes.py revoke "ABICOR - Prasad"      # or by id
python manage_codes.py enable "ABICOR - Prasad"      # turn back on
python manage_codes.py rm     "ABICOR - Prasad"      # delete entirely
```

Optional limits per code:

```bash
python manage_codes.py new --label "Trial" --expires 2026-12-31 --max-uses 200
```

`--max-uses` counts one per generated/re-run document; `--expires` is a hard date.

## Remote management (optional — for your Hetzner / Rocky bot)

Set `ADMIN_TOKEN=...` in `.env` to enable a token-guarded HTTP API (it 404s while
unset, so it's invisible by default). Your external bot can then issue/revoke
codes programmatically:

```
GET    /api/admin/codes                 (header: X-Admin-Token)
POST   /api/admin/codes                 {label, expires?, max_uses?}  -> {code, ...}
POST   /api/admin/codes/{id|label}/revoke
POST   /api/admin/codes/{id|label}/enable
DELETE /api/admin/codes/{id|label}
```

## Security notes

- Serve over **HTTPS** in production (the code travels in a request header).
- `access_codes.json` and `.env` are gitignored — keep them off GitHub.
- Revoking is instant: the next request with that code gets `401`.
- A leaked `access_codes.json` does **not** leak working codes (only hashes) and
  never contains your Gemini key.
