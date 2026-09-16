"""Deterministic Portfolio Desk: every number comes from Mission Control files,
never from the language model."""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)|\[([^\]]+)\]\[[^\]]*\]")
_INLINE_LINK = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")
_REF_LINK = re.compile(r"\[([^\]]+)\]\[([^\]]+)\]")
_REF_DEF = re.compile(r"^\[([^\]]+)\]:\s*(\S+)", re.M)
# A trailing "(… [source](url); [other][ref] …)" citation group at the end of a bullet.
_CITATION = re.compile(r"\s*\((?:[^()]|\([^()]*\))*\)(?=[.;]?\s*$)")
_MD = re.compile(r"(\*\*|__|`)")
_PRIORITY = {"🔴": "urgent", "🟡": "review", "🟢": "monitor"}


def _plain(text: str) -> str:
    text = _LINK.sub(lambda m: m.group(1) or m.group(2), text)
    return _MD.sub("", text).strip()


def _priority(text: str) -> str:
    return next((v for k, v in _PRIORITY.items() if k in text), "monitor")


def _source_links(text: str, refs: dict) -> list[dict]:
    """External sources only — local references such as [state][s] are dropped."""
    links = [{"label": label, "url": url} for label, url in _INLINE_LINK.findall(text)]
    for label, ref in _REF_LINK.findall(text):
        url = refs.get(ref, "")
        if url.startswith(("http://", "https://")):
            links.append({"label": label, "url": url})
    return links


def _news_text(text: str) -> str:
    m = _CITATION.search(text)
    if m and re.search(r"\]\(|\]\[", m.group()):
        text = text[: m.start()] + text[m.end():]
    return _plain(text)


def parse_scan(markdown: str) -> dict:
    date = None
    if m := re.search(r"·\s*(\d{4}-\d{2}-\d{2})", markdown[:400]):
        date = m.group(1)
    refs = dict(_REF_DEF.findall(markdown))
    actions, news, notes = [], [], []
    section, holding = None, None
    for line in markdown.splitlines():
        if line.startswith("## "):
            section = ("actions" if "Suggested actions" in line
                       else "news" if "News by holding" in line else None)
            continue
        if section == "actions" and line.startswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) < 4 or cells[0] in ("Priority", "---") or set(cells[0]) <= {"-", " "}:
                continue
            actions.append({
                "level": _priority(cells[0]),
                "ticker": _plain(cells[1]),
                "action": _plain(cells[2]),
                "why": _plain(cells[3]),
            })
        elif section == "news":
            stripped = line.strip()
            if stripped.startswith("### "):
                head = stripped[4:]
                holding = {"ticker": _plain(re.sub("[🔴🟡🟢]", "", head)), "level": _priority(head), "items": []}
                news.append(holding)
            elif stripped.startswith("- ") and holding is not None:
                body = stripped[2:]
                holding["items"].append({"text": _news_text(body), "links": _source_links(body, refs)})
            elif note := re.match(r"\*\*(.+?)\*\*\s*(.*)", stripped):
                body = note.group(2)
                notes.append({"label": note.group(1).strip().rstrip(":"), "text": _news_text(body),
                              "links": _source_links(body, refs)})
    return {"date": date, "actions": actions, "news": news, "news_notes": notes}


def _level(value) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    m = re.search(r"-?\d+(?:\.\d+)?", str(value or ""))
    return float(m.group()) if m else None


def _brokerage_total(*sources: dict) -> float:
    """Sum per-account totals (any `<account>_total_sgd` key other than the aggregates)."""
    return round(sum(v for src in sources for k, v in src.items()
                     if k.endswith("_total_sgd") and k not in ("household_total_sgd", "direct_total_sgd")
                     and isinstance(v, (int, float))), 2)


def _history(path: Path, days: int = 60) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines()[-days:]:
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        rows.append({
            "date": r.get("date"),
            "household": r.get("household_total_sgd"),
            "direct": _brokerage_total(r),
        })
    return rows


def collect(portfolio_dir: Path, now: datetime) -> dict:
    state = json.loads((portfolio_dir / "state.json").read_text())
    updated = datetime.fromisoformat(state["updated_at"])
    positions = []
    for p in [p for k, v in state.items() if k.endswith("positions") for p in (v or [])]:
        positions.append({k: p.get(k) for k in (
            "ticker", "book", "ccy", "price", "prev_close", "day_pct", "pl_pct", "pl_sgd", "mv_sgd", "weight_pct", "sleeve", "stale")})
    movers = sorted((p for p in positions if p["day_pct"] is not None), key=lambda p: abs(p["day_pct"]), reverse=True)

    triggers = []
    for a in (state.get("alerts") or {}).get("armed", []):
        level, current = _level(a.get("level")), a.get("current")
        if level and current:
            triggers.append({
                "ticker": a.get("ticker"), "type": a.get("type"), "level": a.get("level"),
                "current": current, "hit": bool(a.get("hit")),
                "distance_pct": round((current - level) / level * 100, 2),
                "note": a.get("note"),
            })
    triggers.sort(key=lambda t: (not t["hit"], abs(t["distance_pct"])))

    goals, seen = [], set()
    for g in state.get("goals") or []:
        if g.get("name") in seen:
            continue
        seen.add(g.get("name"))
        goals.append({k: g.get(k) for k in (
            "name", "current_sgd", "target_sgd", "progress_pct", "projected_sgd", "on_track", "target_date", "scenario_label")})

    scan_file = portfolio_dir / "latest-scan.md"
    scan = parse_scan(scan_file.read_text()) if scan_file.exists() else {"date": None, "actions": []}
    totals = state.get("totals") or {}
    return {
        "updated_at": state["updated_at"],
        "age_hours": round((now - updated).total_seconds() / 3600, 1),
        "markets_closed": now.weekday() >= 5,
        "fx_usdsgd": state.get("fx_usdsgd"),
        "household_total_sgd": state.get("household_total_sgd"),
        "direct_total_sgd": _brokerage_total(totals, state),
        "pl_sgd": totals.get("pl_sgd"),
        "us_equity_pct": (state.get("geography") or {}).get("us_equity_pct"),
        "us_cap_pct": (state.get("geography") or {}).get("us_cap_pct"),
        "health": state.get("health_scores"),
        "sleeves": state.get("sleeves") or [],
        "positions": positions,
        "movers": movers[:6],
        "triggers": triggers[:8],
        "goals": goals,
        "flags": state.get("flags") or [],
        "recommendation": state.get("recommendation"),
        "open_items": state.get("open_items") or [],
        "scan": scan,
        "history": _history(portfolio_dir / "history.jsonl"),
    }
