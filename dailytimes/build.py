"""Assemble a day's edition: collect → edit → join back trusted data → save."""
from __future__ import annotations

import json
import logging
import time
from datetime import date, datetime, timedelta

from . import editor, gmail, news, portfolio
from .config import TZ, Settings, write_private

log = logging.getLogger(__name__)
MAX_STORIES, MIN_STORIES, MAX_EMAILS = 5, 3, 12


def edition_number(settings: Settings, day: date) -> int:
    meta_path = settings.data_dir / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    first = meta.get("first_date")
    if not first or date.fromisoformat(first) > day:
        first = day.isoformat()
        write_private(meta_path, json.dumps({**meta, "first_date": first}))
    return (day - date.fromisoformat(first)).days + 1


def _desks(desks: dict, editorial: dict | None) -> list[dict]:
    out = []
    picks = (editorial or {}).get("desks", {})
    for key, desk in desks.items():
        by_id = {i["id"]: i for i in desk["items"]}
        stories, used = [], set()
        for pick in picks.get(key, []):
            item = by_id.get(pick.get("id"))
            if not item or item["id"] in used or len(stories) >= MAX_STORIES:
                continue
            used.add(item["id"])
            stories.append({**item, "headline": pick["headline"].strip() or item["title"],
                            "summary": pick["summary"].strip(), "why": pick["why"].strip() or None})
        # Top up from the wire (newest first) if the editor was absent or returned too little.
        for item in desk["items"]:
            if len(stories) >= (MIN_STORIES if editorial else 4):
                break
            if item["id"] not in used:
                used.add(item["id"])
                stories.append({**item, "headline": item["title"], "why": None})
        out.append({"key": key, "title": desk["title"], "stories": stories, "errors": desk["errors"]})
    return out


def _inbox(emails: list[dict] | None, editorial: dict | None, error: str | None) -> dict:
    if emails is None:
        return {"overview": "The inbox desk could not reach Gmail this morning.", "items": [], "scanned": 0, "error": error}
    by_id = {e["id"]: e for e in emails}
    items = []
    if editorial:
        seen = set()
        for pick in editorial.get("inbox", {}).get("items", []):
            e = by_id.get(pick.get("id"))
            if not e or e["id"] in seen or len(items) >= MAX_EMAILS:
                continue
            seen.add(e["id"])
            items.append({**_email_fields(e), "priority": pick["priority"], "gist": pick["gist"],
                          "action": pick.get("action"), "deadline": pick.get("deadline")})
        overview = editorial["inbox"]["overview"]
    else:
        for e in (e for e in emails if e["score"] >= 3):
            if len(items) >= 8:
                break
            items.append({**_email_fields(e), "priority": "heads_up" if e["score"] >= 5 else "fyi",
                          "gist": e["snippet"], "action": None, "deadline": None})
        important = sum("IMPORTANT" in e["labels"] for e in emails)
        overview = f"{len(emails)} conversations reached the inbox in the last day; Gmail marked {important} as important."
    counts = {p: sum(i["priority"] == p for i in items) for p in ("action", "heads_up", "fyi")}
    return {"overview": overview, "items": items, "counts": counts, "scanned": len(emails), "error": error}


def _email_fields(e: dict) -> dict:
    return {k: e[k] for k in ("id", "from_name", "from_addr", "subject", "received", "gmail_url")}


def _fmt_sgd(value) -> str:
    return f"S${value:,.0f}" if isinstance(value, (int, float)) else "—"


def assemble(day: date, now: datetime, number: int, desks: dict, emails, markets, editorial,
             errors: dict, model: str | None) -> dict:
    desk_out = _desks(desks, editorial)
    if editorial:
        front = editorial["front"]
    else:
        lead = next((d["stories"][0] for d in desk_out if d["stories"]), None)
        front = {"headline": lead["headline"] if lead else "A quiet morning on the wires",
                 "dek": "Today's edition went to press without the editor's desk; stories appear as filed."}
    markets_out = None
    if markets:
        ed = (editorial or {}).get("markets")
        markets_out = {**markets,
                       "headline": ed["headline"] if ed else f"Household book at {_fmt_sgd(markets['household_total_sgd'])}",
                       "note": ed["note"] if ed else (markets.get("recommendation") or "")}
    return {
        "date": day.isoformat(),
        "edition_no": number,
        "generated_at": now.isoformat(timespec="seconds"),
        "editor": {"llm": editorial is not None, "model": model if editorial else None, "error": errors.get("editor")},
        "front": front,
        "desks": desk_out,
        "inbox": _inbox(emails, editorial, errors.get("inbox")),
        "markets": markets_out,
        "markets_error": errors.get("markets"),
    }


def build(settings: Settings, day: date | None = None, use_llm: bool = True) -> dict:
    now = datetime.now(TZ)
    day = day or now.date()
    errors: dict[str, str] = {}

    desks = news.collect(news.load_desks(settings.feeds_file), now)
    try:
        emails = gmail.collect(settings.google_token, since=now - timedelta(hours=24))
    except Exception as exc:
        log.exception("gmail collection failed")
        emails, errors["inbox"] = None, f"{exc.__class__.__name__}: {str(exc)[:200]}"
    try:
        markets = portfolio.collect(settings.portfolio_dir, now)
    except Exception as exc:
        log.exception("portfolio collection failed")
        markets, errors["markets"] = None, f"{exc.__class__.__name__}: {str(exc)[:200]}"

    write_private(settings.raw_dir / f"{day}.json",
                  json.dumps({"desks": desks, "emails": emails, "markets": markets}, ensure_ascii=False))

    editorial = None
    if use_llm:
        try:
            editorial = editor.run(settings, desks, emails, markets, now)
        except Exception as exc:
            log.error("editor failed, printing wire edition: %s", exc)
            errors["editor"] = str(exc)[:300]

    edition = assemble(day, now, edition_number(settings, day), desks, emails, markets,
                       editorial, errors, settings.codex_model)
    write_private(settings.editions_dir / f"{day}.json", json.dumps(edition, ensure_ascii=False, indent=1))
    _prune(settings)
    return edition


def _prune(settings: Settings, keep_days: int = 14) -> None:
    cutoff = time.time() - keep_days * 86400
    for f in settings.raw_dir.glob("*.json"):
        if f.stat().st_mtime < cutoff:
            f.unlink()
