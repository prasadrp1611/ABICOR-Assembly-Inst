#!/usr/bin/env python3
"""Issue / revoke / monitor handshake tokens for the ABICOR key-vault.

Your Rocky bot can drive the HTTP /admin API instead; this CLI is for you on the
Hetzner box. Tokens are shown ONCE at creation (only the hash is stored).

  python manage_tokens.py new --label "ABICOR app" --max-tokens 2000000
  python manage_tokens.py list
  python manage_tokens.py revoke <id|label>      # instant cut-off
  python manage_tokens.py enable <id|label>
  python manage_tokens.py rm     <id|label>
  python manage_tokens.py kill                    # engage global breaker
  python manage_tokens.py unkill
"""
import argparse
import vault


def main():
    ap = argparse.ArgumentParser(description="ABICOR key-vault token management.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    n = sub.add_parser("new", help="issue a handshake token")
    n.add_argument("--label", default="", help="who/what it's for")
    n.add_argument("--max-tokens", type=int, default=None, help="lifetime Gemini-token cap")
    n.add_argument("--max-requests", type=int, default=None, help="lifetime request cap")

    sub.add_parser("list", help="list tokens + usage")
    for verb in ("revoke", "enable", "rm"):
        p = sub.add_parser(verb, help=f"{verb} a token by id or label")
        p.add_argument("ident")
    sub.add_parser("kill", help="engage the global breaker (vault refuses everything)")
    sub.add_parser("unkill", help="clear the global breaker")

    a = ap.parse_args()

    if a.cmd == "new":
        r = vault.issue_token(a.label, a.max_tokens, a.max_requests)
        print("\n  Handshake token (copy now — shown only once):\n")
        print("      " + r["token"] + "\n")
        print(f"      id    : {r['id']}")
        print(f"      label : {r['label'] or '(none)'}")
        print(f"      caps  : tokens={r['max_tokens'] or 'unlimited'} "
              f"requests={r['max_requests'] or 'unlimited'}\n")
        print("  In the APP's .env set:")
        print("      GEMINI_PROXY_URL=https://<your-vault-host>")
        print("      GEMINI_API_KEY=<the token above>   # app holds the token, never the real key")
    elif a.cmd == "list":
        usage = vault._load(vault.USAGE_PATH, {})
        toks = vault._load(vault.TOKENS_PATH, [])
        if not toks:
            print("(no tokens yet — run:  python manage_tokens.py new --label \"...\")")
            return
        print(f"{'id':10} {'on':4} {'tokens used':>12} {'cap':>10}  label")
        print("-" * 60)
        for t in toks:
            u = usage.get(t["id"], {})
            print(f"{t['id']:10} {'yes' if t['enabled'] else 'NO ':4} "
                  f"{u.get('tokens', 0):>12} {str(t.get('max_tokens') or '-'):>10}  {t.get('label', '')}")
        g = usage.get("_global", {})
        print(f"\n  global: {g.get('tokens', 0)} tokens / {g.get('requests', 0)} requests"
              f"  ·  cap={vault.GLOBAL_TOKEN_CAP or 'none'}  ·  killed={vault.KILL_PATH.exists()}")
    elif a.cmd in ("revoke", "enable"):
        n = vault.set_enabled(a.ident, a.cmd == "enable")
        print(f"{a.cmd}: {n} token(s) changed" if n else f"no token matched '{a.ident}'")
    elif a.cmd == "rm":
        n = vault.delete_token(a.ident)
        print(f"deleted {n} token(s)" if n else f"no token matched '{a.ident}'")
    elif a.cmd == "kill":
        vault.KILL_PATH.write_text(vault._now(), encoding="utf-8")
        print("KILL engaged — the vault now refuses every call until you run 'unkill'.")
    elif a.cmd == "unkill":
        if vault.KILL_PATH.exists():
            vault.KILL_PATH.unlink()
        print("KILL cleared — the vault serves valid tokens again.")


if __name__ == "__main__":
    main()
