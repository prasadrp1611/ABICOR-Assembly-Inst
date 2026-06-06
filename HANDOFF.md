# Handoff — test at 10:30

Everything below is **built, wired and tested locally. Nothing is committed or pushed**
(you wanted to try it first). Server was left running; if it's not, start it:

```bash
python server.py        # or run.bat   →   http://127.0.0.1:8000
```

## 30-second test checklist

1. **App still works** — open http://127.0.0.1:8000, generate a doc as usual.
2. **Bigger labels** — on a result, click a part → "Outline" / "Precise highlight".
   Labels are now big + high-contrast (readable when printed). Buttons renamed from
   "Boxes / SAM segmentation" to plain words.
3. **Support widget** — bottom-right "🛟 Support". Ask it something ("how do I add
   part IDs?") → it answers (white-labeled, never names the model). "Send report to
   the team" files an incident to `incidents/`.
4. **Settings** — gear icon. In normal local mode it asks for an API key (unchanged).
   When you turn on the vault/codes it auto-switches to asking for an access code.

## The key thing you asked for: never share your €214 key

Three independent protections (each alone caps the loss):

1. **Separate the money** — run the vault on a *small-float* Gemini key (~€20 project),
   never the €214 one.
2. **Key-vault on Hetzner** — `keyvault/` is a proxy that holds the real key and hands
   the app a **revocable handshake token**. The app/ABICOR never see the real key.
3. **Caps + kill switch** — per-token + global token caps, instant revoke, global KILL.

### To go live (hand Rocky the prompts)

- Prompts are in **`ROCKY_PROMPTS.md`** (vault operation + support/hot-patch).
- Get `keyvault/` onto the box (push the repo and clone, or scp it).
- Put the small-float key straight into `keyvault/.env` yourself (so it never enters
  Rocky's context). Template: `keyvault/.env.example`. Full guide: `keyvault/README.md`.
- Rocky issues a handshake token → you set in the **app's** `.env`:
  ```
  GEMINI_PROXY_URL=https://vault.<yourdomain>
  GEMINI_API_KEY=hsk_...        # the token; the app never holds the real key
  ```
- Manage anytime: `python keyvault/manage_tokens.py list / revoke / kill`.

## Security (your "final check")

- ✅ No secret is tracked by git, none in history, none in any tracked file.
- ✅ `.env`, `access_codes.json`, `keyvault/.env`, `keyvault/tokens.json`,
  `keyvault/usage.json`, `KILL`, `incidents/` are all gitignored.
- ✅ Real key never reaches a browser; support bot has no tools; intake is dumb
  (injection-safe). No model names in the UI.
- ⚠️ **Regenerate the Gemini key you pasted in chat earlier** — it's in this
  conversation's history. Put the fresh one only in a file, never in chat.

## What changed this session

Modified: `.gitignore`, `config.py`, `server.py`, `vision.py`, `docx_export.py`,
`static/app.js`, `static/index.html`, `static/styles.css`
New: `ACCESS.md`, `ROCKY_PROMPTS.md`, `manage_codes.py`, `static/report.js`, `keyvault/`

Features added: revocable access-code gate, key-vault handshake proxy, Gemini support
chat + report widget, bigger print-readable labels, friendlier label names, part-ID
safeties, fun mode (from before). When you're happy after testing:

```bash
git add -A && git commit -m "Revocable key-vault, support bot, print-ready labels"
# git push   # only when you're ready
```
(`git add -A` is safe — the gitignore keeps every secret out.)
