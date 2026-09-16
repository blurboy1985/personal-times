"""Gmail: read the last day's inbox (metadata + snippet) and send the edition email.

Uses the shared Hermes OAuth token read-only: a refreshed access token lives in
memory for this run and is never written back (the gmail-whatsapp-bridge owns
write-back of that file).
"""
from __future__ import annotations

import base64
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from email.message import EmailMessage
from email.utils import parseaddr
from pathlib import Path

from google.auth.transport.requests import AuthorizedSession, Request
from google.oauth2.credentials import Credentials

log = logging.getLogger(__name__)
API = "https://gmail.googleapis.com/gmail/v1/users/me"
_BULK_SENDER = re.compile(r"no-?reply|notifications?@|newsletter|mailer|marketing|digest", re.I)


def _session(token_path: Path) -> AuthorizedSession:
    creds = Credentials.from_authorized_user_file(str(token_path))
    if not creds.valid:
        creds.refresh(Request())
    return AuthorizedSession(creds)


def score(labels: list[str], sender: str, bulk: bool) -> int:
    s = 0
    s += 4 if "STARRED" in labels else 0
    s += 3 if "IMPORTANT" in labels else 0
    s += 2 if "CATEGORY_PERSONAL" in labels else 0
    s += 1 if "UNREAD" in labels else 0
    s -= 3 if bulk else 0
    s -= 1 if _BULK_SENDER.search(sender) else 0
    return s


def collect(token_path: Path, since: datetime, limit: int = 60, scan: int = 160) -> list[dict]:
    http = _session(token_path)
    query = (f"after:{int(since.timestamp())} in:inbox -from:me "
             "-category:promotions -category:social -category:forums")
    ids: list[dict] = []
    page_token = None
    while len(ids) < scan:
        params = {"q": query, "maxResults": 100}
        if page_token:
            params["pageToken"] = page_token
        resp = http.get(f"{API}/messages", params=params, timeout=30)
        resp.raise_for_status()
        body = resp.json()
        ids.extend(body.get("messages", []))
        page_token = body.get("nextPageToken")
        if not page_token:
            break

    def fetch(mid: str) -> dict | None:
        r = http.get(f"{API}/messages/{mid}", timeout=30, params=[
            ("format", "metadata"), ("metadataHeaders", "From"), ("metadataHeaders", "Subject"),
            ("metadataHeaders", "List-Unsubscribe"), ("metadataHeaders", "Date")])
        if r.status_code != 200:
            return None
        m = r.json()
        headers = {h["name"].lower(): h["value"] for h in m.get("payload", {}).get("headers", [])}
        name, addr = parseaddr(headers.get("from", ""))
        labels = m.get("labelIds", [])
        bulk = "list-unsubscribe" in headers
        return {
            "id": m["id"],
            "thread_id": m["threadId"],
            "from_name": name or addr,
            "from_addr": addr,
            "subject": (headers.get("subject") or "(no subject)")[:200],
            "snippet": (m.get("snippet") or "")[:280],
            "received": datetime.fromtimestamp(int(m["internalDate"]) / 1000).astimezone().isoformat(),
            "labels": [l for l in labels if l in ("IMPORTANT", "STARRED", "UNREAD", "CATEGORY_PERSONAL", "CATEGORY_UPDATES")],
            "bulk": bulk,
            "score": score(labels, f"{name} {addr}", bulk),
        }

    with ThreadPoolExecutor(max_workers=8) as pool:
        messages = [m for m in pool.map(fetch, [i["id"] for i in ids[:scan]]) if m]

    newest_per_thread: dict[str, dict] = {}
    for m in sorted(messages, key=lambda m: m["received"], reverse=True):
        newest_per_thread.setdefault(m["thread_id"], m)
    ranked = sorted(newest_per_thread.values(), key=lambda m: (m["score"], m["received"]), reverse=True)
    for m in ranked:
        m["gmail_url"] = f"https://mail.google.com/mail/u/0/#all/{m['thread_id']}"
    return ranked[:limit]


def send(token_path: Path, to: str, subject: str, text: str, html_body: str) -> str:
    msg = EmailMessage()
    msg["To"] = to
    msg["From"] = to
    msg["Subject"] = subject
    msg["X-Personal-Times"] = "edition"
    msg.set_content(text)
    msg.add_alternative(html_body, subtype="html")
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    resp = _session(token_path).post(f"{API}/messages/send", json={"raw": raw}, timeout=30)
    resp.raise_for_status()
    return resp.json()["id"]
