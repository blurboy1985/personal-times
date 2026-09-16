# The Personal Times

**I built myself a newspaper.** 🗞️

Every morning at 7am, a three-page broadsheet made for one reader:

| Page | Section | What's on it |
| --- | --- | --- |
| **A1 · The World** | Singapore · China · United States · AI | The morning's lead plus 3–5 stories per desk, picked from RSS wires and edited by an LLM |
| **A2 · The Inbox Dispatch** | The last 24h of email | Triaged into *Action required*, *Heads up* and *For the record* |
| **A3 · The Portfolio Desk** | Your book | Household total, P&L, goals, movers, price triggers, suggested actions and news by holding |

The reader is a 3D broadsheet built with three.js. The folded paper lands on a
lamp-lit desk and unfolds, and the pages curl as you turn them (arrow keys, the
folio bar, the dog-eared corner, or a swipe on mobile).

🎬 **Video walkthrough coming soon.**

## How it works

```
06:05  (optional) portfolio scan  → latest-scan.md: suggested actions + news by holding
06:35  systemd  personal-times-build.timer
         └─ python -m dailytimes build
              ├─ news.py       RSS → candidates per desk (ids)
              ├─ gmail.py      inbox metadata + snippets, ranked
              ├─ portfolio.py  portfolio state files → deterministic markets block
              ├─ editor.py     codex exec --output-schema (read-only sandbox, empty cwd,
              │                no user config) → picks and rewrites BY ID only
              └─ build.py      joins trusted URLs/senders/numbers back in; falls back to a
                               no-LLM "wire edition" if the editor fails
07:00  cron     deploy/hermes/personal_times_deliver.sh
         └─ python -m dailytimes deliver → email to self + chat message text (stdout)
always          hosted reader (ChatGPT Sites) or the local FastAPI reader
```

### The model can't make things up where it matters

- The LLM never writes a URL, sender or number that reaches the page. It points
  to candidate items **by ID**, and the real data is filled back in afterwards.
  Unknown IDs are dropped.
- Portfolio figures come straight from your data files. **No LLM-generated numbers.**
- Everything in the input (news, emails) is treated as untrusted. Output is scanned
  for credential-shaped strings and discarded if one appears, and everything is
  HTML-escaped on render.

### Reader security

- **Hosted (ChatGPT Sites):** owner-only access; uploads additionally require a
  separate upload key and are verified with a SHA-256 receipt.
- **Local reader (optional):** passkeys (WebAuthn) first, with an scrypt password
  plus optional TOTP as the backup. Adding a passkey requires a password sign-in
  from the last 10 minutes. HMAC-signed HttpOnly session cookie (30 days,
  revocable), login throttling, same-origin checks, strict CSP, and no third-party
  requests (fonts are self-hosted).
- Editions contain personal data, so they live outside the repo in
  `~/.local/share/personal-times` (0700).

## Setup

Requirements: Python 3.12+ with [uv](https://docs.astral.sh/uv/), Node.js, the
[Codex CLI](https://github.com/openai/codex) for the editor, and a Google OAuth
token with read-only Gmail access.

```bash
git clone https://github.com/<you>/personal-times ~/personal-times
cd ~/personal-times
uv sync
(cd web && npm ci)
npm run build

mkdir -m 700 -p ~/.config/personal-times
cp config/config.example.toml ~/.config/personal-times/config.toml   # then edit
```

Schedule the build with systemd and the delivery with any cron runner:

```bash
install -m 644 deploy/systemd/personal-times-build.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now personal-times-build.timer
# at 07:00: deploy/hermes/personal_times_deliver.sh
```

The unit files assume the repo lives at `~/personal-times`; adjust the paths if not.
Set the timer's schedule and time zone to suit you.

### Configuration

Every key in `config/config.example.toml` is optional. The main ones:

- `public_url`: the link used in the morning email/message
- `[sources] google_token`: read-only Gmail token (never written back)
- `[sources] portfolio_dir`: holds `state.json`, `history.jsonl` and an optional
  `latest-scan.md`
- `[delivery] channels` and `email_to`
- `[editor]`: the Codex binary, model and timeout

News desks and feeds live in `config/feeds.toml`; the editor prompt is in
`dailytimes/editor.py`.

## Operating

```bash
.venv/bin/python -m dailytimes build            # print today's edition now
.venv/bin/python -m dailytimes build --no-llm   # wire edition, no LLM
.venv/bin/python -m dailytimes deliver --dry-run
.venv/bin/python -m dailytimes auth revoke-sessions
.venv/bin/python -m dailytimes auth passkeys            # list; add them from the 🔑 panel in the reader
.venv/bin/python -m dailytimes auth passkey-remove <id>
journalctl --user -u personal-times-build -n 50
```

After frontend edits, run `npm run build` in `web/`. The local server picks up the
new `web/dist/` without a restart.

## Hosting on ChatGPT Sites (optional)

The Ubuntu machine still collects RSS, Gmail and portfolio data and runs the
editor. Sites only hosts the reader and stores editions.

1. Copy `.openai/hosting.example.json` to `.openai/hosting.json` and fill in your
   Sites project ID (the copy is git-ignored).
2. Run `npm run build` at the repo root (output goes to `dist/`) and publish with
   the Sites plugin. Keep the Site private.
3. Create `~/.config/personal-times/sites.json` (file mode 0600) containing `url`,
   `bypass_token` and `upload_key`. Set the same `upload_key` as the `UPLOAD_KEY`
   secret in Sites. Never put these values in source files or logs.

Once it's configured, `build` uploads each new edition, and `deliver` retries the
upload before sending, so a failed upload never sends a broken link.
`python -m dailytimes sites-sync` backfills existing editions. The scheduled
wrapper (`deploy/personal-times-run.sh`) refuses to run without `sites.json`.

## Tests

```bash
uv run --group dev pytest   # Python pipeline, auth, passkeys, Sites client
npm test                    # Sites API
```
