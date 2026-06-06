#!/usr/bin/env python3
"""Manage revocable access codes for the ABICOR Assembly-Doc gateway.

The operator hosts the app with their own GEMINI_API_KEY in .env. Clients never
receive that key — they get a revocable access code instead. The server uses the
operator's key on their behalf, and any code can be disabled instantly (no key
rotation, no downtime). Gateway mode turns on automatically once a code exists.

Examples:
  python manage_codes.py new --label "ABICOR - Prasad"
  python manage_codes.py new --label "Trial" --expires 2026-12-31 --max-uses 200
  python manage_codes.py list
  python manage_codes.py revoke <id|label>     # instant cut-off
  python manage_codes.py enable <id|label>
  python manage_codes.py rm     <id|label>

A code is shown ONCE at creation (only its hash is stored). To rotate, revoke the
old one and issue a new one.
"""
import argparse
import config


def _print_table(codes):
    if not codes:
        print('(no access codes yet — run:  python manage_codes.py new --label "...")')
        return
    print(f"{'id':10} {'on':4} {'uses':>6} {'hint':16} {'expires':12} label")
    print("-" * 74)
    for c in codes:
        print(f"{c['id']:10} {'yes' if c['enabled'] else 'NO ':4} "
              f"{c.get('uses', 0):>6} {(c.get('hint') or ''):16} "
              f"{(c.get('expires') or '-'):12} {c.get('label', '')}")


def main():
    ap = argparse.ArgumentParser(
        description="Revocable access codes for the AI engine gateway.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    n = sub.add_parser("new", help="issue a new access code")
    n.add_argument("--label", default="", help="who it's for, e.g. 'ABICOR - Prasad'")
    n.add_argument("--expires", default=None, help="YYYY-MM-DD (optional)")
    n.add_argument("--max-uses", type=int, default=None,
                   help="max jobs before the code stops working (optional)")

    sub.add_parser("list", help="list all codes")
    for verb in ("revoke", "enable", "rm"):
        p = sub.add_parser(verb, help=f"{verb} a code by id or label")
        p.add_argument("ident")

    a = ap.parse_args()

    if a.cmd == "new":
        rec = config.issue_code(a.label, a.expires, a.max_uses)
        print("\n  New access code (copy it now — shown only once):\n")
        print("      " + rec["code"] + "\n")
        print(f"      label    : {rec['label'] or '(none)'}")
        print(f"      id       : {rec['id']}")
        print(f"      expires  : {rec['expires'] or 'never'}")
        print(f"      max uses : {rec['max_uses'] if rec['max_uses'] is not None else 'unlimited'}\n")
        print("  Give this code to the user. Gateway mode is now ON.")
    elif a.cmd == "list":
        _print_table(config.list_codes())
    elif a.cmd == "revoke":
        n = config.set_code_enabled(a.ident, False)
        print(f"Revoked {n} code(s) matching '{a.ident}'." if n
              else f"No code matched '{a.ident}'.")
    elif a.cmd == "enable":
        n = config.set_code_enabled(a.ident, True)
        print(f"Enabled {n} code(s) matching '{a.ident}'." if n
              else f"No code matched '{a.ident}'.")
    elif a.cmd == "rm":
        n = config.delete_code(a.ident)
        print(f"Deleted {n} code(s) matching '{a.ident}'." if n
              else f"No code matched '{a.ident}'.")


if __name__ == "__main__":
    main()
