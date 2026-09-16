"""Collect candidate stories per desk from RSS/Atom feeds."""
from __future__ import annotations

import calendar
import hashlib
import html
import logging
import re
import tomllib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import feedparser
import requests

log = logging.getLogger(__name__)
UA = "Mozilla/5.0 (X11; Linux x86_64) PersonalTimes/1.0 (+personal newsletter)"
_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def load_desks(feeds_file: Path) -> dict:
    return tomllib.loads(feeds_file.read_text())


def clean(text: str | None, limit: int = 360) -> str:
    text = _WS.sub(" ", html.unescape(_TAG.sub(" ", text or ""))).strip()
    return text if len(text) <= limit else text[: limit - 1].rsplit(" ", 1)[0] + "…"


def _published(entry) -> datetime | None:
    for key in ("published_parsed", "updated_parsed"):
        st = entry.get(key)
        if st:
            return datetime.fromtimestamp(calendar.timegm(st), tz=timezone.utc)
    return None


def _fetch(feed: dict) -> tuple[dict, list, str | None]:
    try:
        resp = requests.get(feed["url"], headers={"User-Agent": UA}, timeout=20)
        resp.raise_for_status()
        return feed, feedparser.parse(resp.content).entries, None
    except Exception as exc:  # one dead feed must not sink the desk
        log.warning("feed %s failed: %s", feed["url"], exc)
        return feed, [], f"{feed['name']}: {exc.__class__.__name__}"


def _norm_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def collect(cfg: dict, now: datetime) -> dict:
    window = timedelta(hours=cfg.get("window_hours", 30))
    per_desk = cfg.get("per_desk", 28)
    jobs = [(desk["key"], feed) for desk in cfg["desk"] for feed in desk["feeds"]]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda job: (job[0], *_fetch(job[1])), jobs))

    desks: dict[str, dict] = {
        d["key"]: {"key": d["key"], "title": d["title"], "items": [], "errors": []} for d in cfg["desk"]
    }
    seen: dict[str, set] = {k: set() for k in desks}
    for key, feed, entries, err in results:
        if err:
            desks[key]["errors"].append(err)
        for entry in entries:
            title = clean(entry.get("title"), 220)
            url = entry.get("link") or ""
            if not title or not url.startswith(("http://", "https://")):
                continue
            published = _published(entry)
            if published and now - published > window:
                continue
            norm = _norm_title(title)
            if norm in seen[key]:
                continue
            seen[key].add(norm)
            desks[key]["items"].append({
                "id": f"{key[:2]}-{hashlib.sha1(url.encode()).hexdigest()[:8]}",
                "title": title,
                "source": feed["name"],
                "url": url,
                "published": published.isoformat() if published else None,
                "summary": clean(entry.get("summary") or entry.get("description")),
            })
    epoch = datetime.min.replace(tzinfo=timezone.utc).isoformat()
    for desk in desks.values():
        desk["items"].sort(key=lambda i: i["published"] or epoch, reverse=True)
        desk["items"] = desk["items"][:per_desk]
    return desks
