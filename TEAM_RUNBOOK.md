# ABICOR Assembly-Doc — Team Runbook (Demo Day)

**Everything is already deployed, hosted, and tested.** You do **not** install anything,
touch the server, run any commands, or edit any files. It's all in the browser.

You only need: **two links + one admin password** (the password and the ready-made
codes are sent to you privately — they are *not* in this file on purpose).

---

## The two links

| What | Link |
|---|---|
| **The app** — give to anyone you want to give access to | `https://abicor.darth-hidious.com` |
| **Admin page** — team only, to make/cancel codes | `https://abicor.darth-hidious.com/static/admin.html` |

---

## What is a "code"? (30-second explanation)

A **code** looks like `ABICOR-1A2B-3C4D`. It is **one person's key** to the app.

- They type the code once in the app. From then on they can use it.
- They **never see our real Gemini key** — the server uses it on their behalf.
- You can **switch any code off in one click**, anytime, without affecting anyone else.

That's the whole pitch: *give people access, keep full control, never hand out the key.*

---

## A) How a USER uses the app (what to tell the person you're giving access to)

1. Open **`https://abicor.darth-hidious.com`** — on a phone or laptop, just a browser.
2. Click the **⚙ gear** (top-right) → paste the **code** you gave them → **Save & verify**.
3. Upload a tutorial video → wait a moment → download the step-by-step **Word document**.

Nothing to install. Works on a phone.

---

## B) How YOU give someone access — by clicking (no files, no commands)

1. Open the **Admin page** → type the **admin password** → **Unlock**.
2. Type **who it's for** (e.g. "ABICOR – Prasad") → click **Issue code**.
3. Click **Copy** and send that code to the person.
   - *(Optional)* set an **expiry date** or a **max uses** limit before issuing.

> A batch of ready-to-hand-out codes was already made for you (sent privately) — so you
> can demo immediately without making any. Use the admin page only if you need more.

---

## C) How to cut someone off (instant)

On the **Admin page**, find their row → click **Revoke**. Their code stops working
right away; everyone else is unaffected. Click **Enable** to turn it back on.

---

## D) If something looks off

- **App won't load?** Wait 10 seconds, refresh. Make sure it's `https://abicor.darth-hidious.com`.
- **"Access code invalid/expired/revoked"?** Issue a fresh code on the admin page and resend.
- **Do NOT** restart the server or touch the web server config. If truly stuck,
  message **Rocky on WhatsApp** or call the project owner.

---

## How it works (one picture, for reference — you don't touch any of this)

```
  user's browser                      Rocky server (Hetzner)
  ┌───────────┐  https + code   ┌──────────────────────────────────────────┐
  │ opens app │ ───────────────►│ Caddy (HTTPS)                             │
  │ types code│                 │   → ABICOR app  (checks the code)         │
  └───────────┘                 │     → local key-vault (holds real key)    │
                                │       → Google Gemini                      │
                                └──────────────────────────────────────────┘
```

- The **real Gemini key never leaves the server's vault**. The app uses a revocable token.
- Users only ever hold a **code**, which you can revoke instantly.
- **Tested today, end-to-end:** open link → enter code → upload video → assembly document
  generated, zero errors.

---

*Operational note (for whoever maintains the box, not for demo day): the app runs as the
`abicor-app` systemd service on `127.0.0.1:8000`, fronted by Caddy at
`abicor.darth-hidious.com`. `systemctl reload caddy` is currently broken on this host
(a systemd `/tmp` mount-namespace bug) — use `caddy reload --config /etc/caddy/Caddyfile`
(in-process admin API) to apply Caddy changes, and avoid restarting Caddy.*
