"""CLI: python -m dailytimes {build,deliver,serve,auth}"""
from __future__ import annotations

import argparse
import getpass
import json
import logging
import sys
import time
from datetime import date


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="dailytimes", description="The Personal Times")
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="collect sources and print today's edition")
    b.add_argument("--date", type=date.fromisoformat)
    b.add_argument("--no-llm", action="store_true", help="skip the Codex editor (wire edition)")

    d = sub.add_parser("deliver", help="email the edition; print the Telegram message")
    d.add_argument("--date", type=date.fromisoformat)
    d.add_argument("--force", action="store_true", help="re-send email even if already sent")
    d.add_argument("--dry-run", action="store_true", help="print only, send nothing")

    sub.add_parser("serve", help="run the web server")
    sub.add_parser("sites-sync", help="upload all saved editions to ChatGPT Sites")

    a = sub.add_parser("auth", help="manage the subscriber login")
    asub = a.add_subparsers(dest="auth_cmd", required=True)
    sp = asub.add_parser("set-password")
    sp.add_argument("--username", default="reader")
    asub.add_parser("totp-enable")
    asub.add_parser("totp-disable")
    asub.add_parser("revoke-sessions", help="sign out every browser")
    asub.add_parser("passkeys", help="list registered passkeys")
    pr = asub.add_parser("passkey-remove", help="remove a passkey by id prefix")
    pr.add_argument("id_prefix")

    args = p.parse_args(argv)
    # stdout is reserved for the Telegram message (Hermes delivers it verbatim); logs go to stderr.
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    from . import config
    settings = config.load()

    if args.cmd == "sites-sync":
        from .sites import sync
        print(f"Uploaded {sync(settings)} editions", file=sys.stderr)
        return 0

    if args.cmd == "build":
        from .build import build
        ed = build(settings, args.date, use_llm=not args.no_llm)
        from .sites import publish
        publish(settings, ed["date"])
        print(json.dumps({"date": ed["date"], "edition_no": ed["edition_no"], "llm": ed["editor"]["llm"],
                          "editor_error": ed["editor"]["error"], "headline": ed["front"]["headline"],
                          "stories": {d["key"]: len(d["stories"]) for d in ed["desks"]},
                          "inbox": ed["inbox"].get("counts"), "markets": bool(ed["markets"])},
                         ensure_ascii=False), file=sys.stderr)
        return 0

    if args.cmd == "deliver":
        from .deliver import deliver
        text = deliver(settings, args.date, force=args.force, dry_run=args.dry_run)
        if text:
            print(text)
        return 0

    if args.cmd == "serve":
        import uvicorn
        uvicorn.run("dailytimes.server:app", host=settings.host, port=settings.port,
                    proxy_headers=False, access_log=False)
        return 0

    from . import auth
    state = auth.AuthState.load()
    if args.auth_cmd == "set-password":
        pw = getpass.getpass("New password (min 12 chars): ")
        if len(pw) < 12:
            print("Too short.", file=sys.stderr)
            return 1
        if getpass.getpass("Again: ") != pw:
            print("Passwords differ.", file=sys.stderr)
            return 1
        if state:
            state.username, state.password_hash = args.username, auth.hash_password(pw)
            state.session_epoch += 1
        else:
            state = auth.AuthState.create(args.username, pw)
        state.save()
        print(f"Password saved to {auth.AUTH_FILE}; existing sessions signed out.")
        return 0
    if not state:
        print("Run `auth set-password` first.", file=sys.stderr)
        return 1
    if args.auth_cmd == "totp-enable":
        import pyotp
        import segno
        secret = pyotp.random_base32()
        uri = pyotp.TOTP(secret).provisioning_uri(name=state.username, issuer_name="The Personal Times")
        segno.make(uri).terminal(compact=True)
        print(f"\nScan with your authenticator app, or enter this key manually: {secret}")
        if not pyotp.TOTP(secret).verify(input("Enter the 6-digit code to confirm: ").strip(), valid_window=1):
            print("Code didn't match — TOTP not enabled.", file=sys.stderr)
            return 1
        state.totp_secret = secret
        state.session_epoch += 1
        state.save()
        print("Two-factor sign-in enabled; existing sessions signed out.")
    elif args.auth_cmd == "totp-disable":
        state.totp_secret = None
        state.save()
        print("Two-factor sign-in disabled.")
    elif args.auth_cmd == "revoke-sessions":
        state.session_epoch += 1
        state.save()
        print("All sessions signed out.")
    elif args.auth_cmd == "passkeys":
        if not state.passkeys:
            print("No passkeys registered.")
        for p in state.passkeys:
            added = time.strftime("%Y-%m-%d", time.localtime(p["created_at"]))
            used = time.strftime("%Y-%m-%d %H:%M", time.localtime(p["last_used_at"])) if p.get("last_used_at") else "never"
            print(f"{p['id'][:12]}  {p['name']:<14}  added {added}  last used {used}")
    elif args.auth_cmd == "passkey-remove":
        matches = [p for p in state.passkeys if p["id"].startswith(args.id_prefix)]
        if len(matches) != 1:
            print(f"{len(matches)} passkeys match that prefix — be more specific.", file=sys.stderr)
            return 1
        state.passkeys.remove(matches[0])
        state.save()
        print(f"Removed passkey “{matches[0]['name']}”.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
