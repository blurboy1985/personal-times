from datetime import date, datetime

import pytest

from dailytimes import build, editor, portfolio
from dailytimes.config import TZ

DESKS = {
    "singapore": {"key": "singapore", "title": "Singapore", "errors": [], "items": [
        {"id": f"si-{i}", "title": f"SG story {i}", "source": "CNA", "url": f"https://cna.test/{i}",
         "published": "2026-09-13T05:00:00+00:00", "summary": f"Summary {i}"} for i in range(6)]},
}
EMAILS = [
    {"id": "m1", "thread_id": "t1", "from_name": "Bank", "from_addr": "bank@x.test", "subject": "Bill due",
     "snippet": "Pay by Friday", "received": "2026-09-13T01:00:00+08:00", "labels": ["IMPORTANT"], "bulk": False,
     "score": 5, "gmail_url": "https://mail.google.com/mail/u/0/#all/t1"},
    {"id": "m2", "thread_id": "t2", "from_name": "Shop", "from_addr": "promo@x.test", "subject": "Sale",
     "snippet": "50% off", "received": "2026-09-13T02:00:00+08:00", "labels": [], "bulk": True,
     "score": -3, "gmail_url": "https://mail.google.com/mail/u/0/#all/t2"},
]
NOW = datetime(2026, 9, 13, 5, 15, tzinfo=TZ)


def test_editorial_ids_are_joined_and_unknown_ids_dropped():
    editorial = {
        "front": {"headline": "Lead", "dek": "Dek"},
        "desks": {"singapore": [
            {"id": "si-3", "headline": "Edited 3", "summary": "S3", "why": "W3"},
            {"id": "evil-injected", "headline": "Click me", "summary": "x", "why": "x"},
            {"id": "si-3", "headline": "Dup", "summary": "x", "why": "x"},
        ]},
        "inbox": {"overview": "One bill.", "items": [
            {"id": "m1", "priority": "action", "gist": "A bill", "action": "Pay it", "deadline": "Friday"},
            {"id": "nope", "priority": "action", "gist": "fake", "action": None, "deadline": None},
        ]},
        "markets": {"headline": "H", "note": "N"},
    }
    ed = build.assemble(date(2026, 9, 13), NOW, 1, DESKS, EMAILS, None, editorial, {}, "m")
    stories = ed["desks"][0]["stories"]
    assert stories[0]["headline"] == "Edited 3" and stories[0]["url"] == "https://cna.test/3"
    assert all(s["headline"] not in ("Click me", "Dup") for s in stories)
    assert len(stories) == build.MIN_STORIES  # topped up from the wire
    assert [i["id"] for i in ed["inbox"]["items"]] == ["m1"]
    assert ed["inbox"]["items"][0]["gmail_url"].endswith("t1")
    assert ed["inbox"]["counts"] == {"action": 1, "heads_up": 0, "fyi": 0}


def test_wire_edition_without_editor():
    ed = build.assemble(date(2026, 9, 13), NOW, 2, DESKS, EMAILS, None, None, {"editor": "timeout"}, "m")
    assert ed["editor"] == {"llm": False, "model": None, "error": "timeout"}
    assert len(ed["desks"][0]["stories"]) == 4
    assert [i["id"] for i in ed["inbox"]["items"]] == ["m1"]
    assert ed["front"]["headline"] == "SG story 0"


def test_inbox_unavailable():
    ed = build.assemble(date(2026, 9, 13), NOW, 1, DESKS, None, None, None, {"inbox": "RefreshError"}, "m")
    assert ed["inbox"]["items"] == [] and ed["inbox"]["error"] == "RefreshError"


def test_secret_scrub():
    editor.check_secrets({"a": ["fine text", {"b": "ok"}]})
    with pytest.raises(editor.EditorError):
        editor.check_secrets({"a": ["token ya29.a0AfH6SMBxxxxxxxxxxxxxxx"]})


def test_schema_is_strict():
    schema = editor.build_schema(["singapore", "ai"])
    assert schema["additionalProperties"] is False
    assert set(schema["properties"]["desks"]["required"]) == {"singapore", "ai"}


def test_parse_scan_news_by_holding():
    md = """## 📰 News by holding
### DBS 🟡
- Lawsuit corroborated; no provision ([CNA](https://cna.test/a)).
- Weight grandfathered ([state][s]).
### XLP 🟢
- Staples resilient (vs food) ([market recap][m]; [Issuer](https://x.test/i)).
**Rotation checked (no material news found):** MSFT — nothing new ([coverage](https://y.test/c)).
## 🌐 Macro & week ahead
- ignored ([m2](https://z.test))
[s]: /home/someone/portfolio/state.json
[m]: https://recap.test/m
"""
    scan = portfolio.parse_scan(md)
    assert scan["news"][0] == {"ticker": "DBS", "level": "review", "items": [
        {"text": "Lawsuit corroborated; no provision.", "links": [{"label": "CNA", "url": "https://cna.test/a"}]},
        {"text": "Weight grandfathered.", "links": []},
    ]}
    xlp = scan["news"][1]
    assert xlp["level"] == "monitor"
    assert xlp["items"][0]["text"] == "Staples resilient (vs food)."
    assert xlp["items"][0]["links"] == [{"label": "Issuer", "url": "https://x.test/i"},
                                        {"label": "market recap", "url": "https://recap.test/m"}]
    assert len(scan["news"]) == 2
    assert scan["news_notes"] == [{"label": "Rotation checked (no material news found)",
                                   "text": "MSFT — nothing new.",
                                   "links": [{"label": "coverage", "url": "https://y.test/c"}]}]


def test_parse_scan_actions():
    md = """> _🛰️ **Hermes Portfolio Daily Scan** · 2026-09-11 (Fri)_
## ⚡ Suggested actions
| Priority | Ticker | Action | Why |
| --- | --- | --- | --- |
| 🟡 | MU | Review [thesis](http://x) | **−5%** day move |
| 🔴 | DBS | Run playbook | Trigger hit |
## 🎯 Trigger watch
| Ticker | Trigger | Current | Distance | Read |
| XLP | below | 1 | 2 | 3 |
"""
    scan = portfolio.parse_scan(md)
    assert scan["date"] == "2026-09-11"
    assert scan["actions"] == [
        {"level": "review", "ticker": "MU", "action": "Review thesis", "why": "−5% day move"},
        {"level": "urgent", "ticker": "DBS", "action": "Run playbook", "why": "Trigger hit"},
    ]
