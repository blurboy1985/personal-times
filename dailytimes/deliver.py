"""7am delivery: email the edition teaser and emit the Telegram message on stdout
(the Hermes no-agent cron delivers stdout verbatim)."""
from __future__ import annotations

import json
import logging
from datetime import date, datetime
from html import escape

from . import gmail
from .build import build
from .config import TZ, Settings, write_private

log = logging.getLogger(__name__)
FLAGS = {"singapore": "🇸🇬", "china": "🇨🇳", "us": "🇺🇸", "ai": "🤖"}


def _long_date(day: str) -> str:
    return date.fromisoformat(day).strftime("%A, %-d %B %Y")


def _sgd(v) -> str:
    return f"S${v:,.0f}" if isinstance(v, (int, float)) else "—"


def _signed_sgd(v) -> str:
    return f"{'+' if v >= 0 else '−'}S${abs(v):,.0f}" if isinstance(v, (int, float)) else "—"


def telegram_text(ed: dict, url: str) -> str:
    lines = [f"🗞 THE PERSONAL TIMES · {_long_date(ed['date'])} · No. {ed['edition_no']}", "",
             ed["front"]["headline"], ed["front"]["dek"], "", "🌏 THE WORLD"]
    for desk in ed["desks"]:
        if desk["stories"]:
            lines.append(f"{FLAGS.get(desk['key'], '•')} {desk['stories'][0]['headline']}")
    inbox = ed["inbox"]
    counts = inbox.get("counts") or {}
    lines += ["", f"📬 INBOX — {counts.get('action', 0)} need action · {counts.get('heads_up', 0)} heads-up"]
    for item in [i for i in inbox["items"] if i["priority"] == "action"][:3]:
        lines.append(f"• {item['from_name']}: {item['action'] or item['subject']}")
    m = ed.get("markets")
    if m:
        lines += ["", f"📈 PORTFOLIO — {_sgd(m['household_total_sgd'])} household · P&L {_signed_sgd(m['pl_sgd'])}",
                  m["headline"]]
    if not ed["editor"]["llm"]:
        lines += ["", "(Wire edition — the editor's desk was unavailable this morning.)"]
    lines += ["", f"Read today's paper → {url}"]
    return "\n".join(lines)


def email_parts(ed: dict, url: str) -> tuple[str, str, str]:
    subject = f"The Personal Times — {ed['front']['headline']}"
    text = telegram_text(ed, url)
    ink, paper, rule = "#1b1a17", "#f4efe4", "#1b1a17"
    serif = "Georgia, 'Times New Roman', serif"
    desks = "".join(
        f"""<td valign="top" width="25%" style="padding:0 10px;border-left:1px solid #cfc6b4;">
          <div style="font:700 10px/1.4 {serif};letter-spacing:.14em;text-transform:uppercase;color:#6b6250;">{escape(d['title'])}</div>
          <div style="font:700 15px/1.25 {serif};color:{ink};margin-top:4px;">{escape(d['stories'][0]['headline'])}</div>
        </td>""" for d in ed["desks"] if d["stories"])
    counts = ed["inbox"].get("counts") or {}
    m = ed.get("markets")
    markets_row = "" if not m else f"""
      <tr><td style="padding:18px 24px 0;border-top:1px solid {rule};">
        <div style="font:700 10px/1.4 {serif};letter-spacing:.14em;text-transform:uppercase;color:#6b6250;">The Portfolio Desk</div>
        <div style="font:700 18px/1.3 {serif};color:{ink};margin-top:4px;">{escape(m['headline'])}</div>
        <div style="font:14px/1.5 {serif};color:#3a362e;margin-top:4px;">Household {_sgd(m['household_total_sgd'])} · Unrealised P&amp;L {_signed_sgd(m['pl_sgd'])}</div>
      </td></tr>"""
    html_body = f"""<!doctype html><html><body style="margin:0;background:#2a2119;padding:24px 8px;">
  <table role="presentation" align="center" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:{paper};color:{ink};">
    <tr><td align="center" style="padding:22px 24px 6px;">
      <div style="font:italic 12px/1 {serif};color:#6b6250;">Morning Edition · No. {ed['edition_no']}</div>
      <div style="font:700 44px/1.1 'Old English Text MT','UnifrakturMaguntia',{serif};margin-top:6px;">The Personal Times</div>
    </td></tr>
    <tr><td style="padding:0 24px;"><div style="border-top:3px double {rule};border-bottom:1px solid {rule};padding:6px 0;text-align:center;font:11px/1.4 {serif};letter-spacing:.12em;text-transform:uppercase;">{escape(_long_date(ed['date']))}</div></td></tr>
    <tr><td style="padding:20px 24px 8px;">
      <div style="font:700 30px/1.15 {serif};">{escape(ed['front']['headline'])}</div>
      <div style="font:italic 16px/1.5 {serif};color:#3a362e;margin-top:8px;">{escape(ed['front']['dek'])}</div>
    </td></tr>
    <tr><td style="padding:12px 14px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>{desks}</tr></table></td></tr>
    <tr><td style="padding:18px 24px 0;border-top:1px solid {rule};">
      <div style="font:700 10px/1.4 {serif};letter-spacing:.14em;text-transform:uppercase;color:#6b6250;">The Inbox Dispatch</div>
      <div style="font:15px/1.5 {serif};margin-top:4px;"><b style="color:#9b2318;">{counts.get('action', 0)} need action</b> · {counts.get('heads_up', 0)} heads-up · {counts.get('fyi', 0)} for the record</div>
      <div style="font:14px/1.5 {serif};color:#3a362e;margin-top:4px;">{escape(ed['inbox']['overview'])}</div>
    </td></tr>
    {markets_row}
    <tr><td align="center" style="padding:26px 24px 30px;">
      <a href="{escape(url)}" style="display:inline-block;background:{ink};color:{paper};text-decoration:none;font:700 13px/1 {serif};letter-spacing:.16em;text-transform:uppercase;padding:14px 26px;">Open today's paper</a>
    </td></tr>
  </table></body></html>"""
    return subject, text, html_body


def deliver(settings: Settings, day: date | None = None, force: bool = False, dry_run: bool = False) -> str:
    now = datetime.now(TZ)
    day = day or now.date()
    path = settings.editions_dir / f"{day}.json"
    if path.exists():
        edition = json.loads(path.read_text())
    else:
        log.warning("no edition for %s at delivery time — printing a wire edition now", day)
        edition = build(settings, day, use_llm=False)
    from .sites import publish, reader_url
    if not dry_run:
        publish(settings, str(day))
    url = f"{reader_url(settings.public_url)}/e/{day}"

    log_path = settings.data_dir / "deliveries.json"
    record = json.loads(log_path.read_text()) if log_path.exists() else {}
    if "email" in settings.channels and settings.email_to and not dry_run:
        if force or not record.get(str(day), {}).get("email"):
            subject, text, html_body = email_parts(edition, url)
            msg_id = gmail.send(settings.google_token, settings.email_to, subject, text, html_body)
            record.setdefault(str(day), {})["email"] = {"id": msg_id, "at": now.isoformat(timespec="seconds")}
            write_private(log_path, json.dumps(record, indent=1))
    return telegram_text(edition, url) if "telegram" in settings.channels else ""
