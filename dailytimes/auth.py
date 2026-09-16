"""Single-subscriber authentication: scrypt password, optional TOTP, HMAC-signed
session cookies (revocable by bumping `session_epoch`), and login throttling."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass, field
from pathlib import Path

import pyotp

from .config import CONFIG_DIR, write_private

AUTH_FILE = CONFIG_DIR / "auth.json"
_SCRYPT = {"n": 2**15, "r": 8, "p": 1}
_MAXMEM = 64 * 1024 * 1024


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, maxmem=_MAXMEM, dklen=32, **_SCRYPT)
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${_b64(salt)}${_b64(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, expected = stored.split("$")
        if algo != "scrypt":
            return False
        expected_bytes = _unb64(expected)
        dk = hashlib.scrypt(password.encode(), salt=_unb64(salt), n=int(n), r=int(r), p=int(p),
                            maxmem=_MAXMEM, dklen=len(expected_bytes))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk, expected_bytes)


@dataclass
class AuthState:
    username: str
    password_hash: str
    session_secret: str
    session_epoch: int = 1
    totp_secret: str | None = None
    user_handle: str | None = None
    passkeys: list[dict] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path = AUTH_FILE) -> "AuthState | None":
        if not path.exists():
            return None
        return cls(**json.loads(path.read_text()))

    def save(self, path: Path = AUTH_FILE) -> None:
        write_private(path, json.dumps(asdict(self), indent=1))

    @classmethod
    def create(cls, username: str, password: str) -> "AuthState":
        return cls(username=username, password_hash=hash_password(password),
                   session_secret=_b64(secrets.token_bytes(32)))


def make_token(state: AuthState, days: int, now: float | None = None) -> str:
    exp = int((now or time.time()) + days * 86400)
    body = _b64(f"{state.username}|{exp}|{state.session_epoch}".encode())
    sig = hmac.new(_unb64(state.session_secret), body.encode(), hashlib.sha256).digest()
    return f"{body}.{_b64(sig)}"


def read_token(state: AuthState, token: str | None, now: float | None = None) -> str | None:
    if not token or token.count(".") != 1:
        return None
    body, sig = token.split(".")
    expected = hmac.new(_unb64(state.session_secret), body.encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(_unb64(sig), expected):
            return None
        username, exp, epoch = _unb64(body).decode().split("|")
    except (ValueError, UnicodeDecodeError):
        return None
    if username != state.username or int(epoch) != state.session_epoch or int(exp) < (now or time.time()):
        return None
    return username


def session_age(state: AuthState, token: str | None, days: int, now: float | None = None) -> float | None:
    """Seconds since a valid session token was issued, or None if the token is invalid."""
    if read_token(state, token, now) is None:
        return None
    exp = int(_unb64(token.split(".")[0]).decode().split("|")[1])
    return (now or time.time()) - (exp - days * 86400)


class Limiter:
    """Sliding-window failure counter per key (client) plus a global ceiling."""

    def __init__(self, per_key: int = 5, global_max: int = 25, window: float = 900):
        self.per_key, self.global_max, self.window = per_key, global_max, window
        self._fails: dict[str, deque] = {}
        self._lock = threading.Lock()

    def _recent(self, key: str, now: float) -> deque:
        q = self._fails.setdefault(key, deque())
        while q and now - q[0] > self.window:
            q.popleft()
        return q

    def blocked(self, key: str, now: float | None = None) -> bool:
        now = now or time.time()
        with self._lock:
            return (len(self._recent(key, now)) >= self.per_key
                    or len(self._recent("*", now)) >= self.global_max)

    def fail(self, key: str, now: float | None = None) -> None:
        now = now or time.time()
        with self._lock:
            self._recent(key, now).append(now)
            self._recent("*", now).append(now)

    def reset(self, key: str) -> None:
        with self._lock:
            self._fails.pop(key, None)


class TotpGuard:
    """TOTP verification (±1 step) that refuses to accept the same step twice."""

    def __init__(self):
        self.last_step = -1
        self._lock = threading.Lock()

    def verify(self, secret: str, code: str, now: float | None = None) -> bool:
        code = "".join(ch for ch in (code or "") if ch.isdigit())
        if len(code) != 6:
            return False
        totp, step_now = pyotp.TOTP(secret), int((now or time.time()) // 30)
        with self._lock:
            for step in (step_now - 1, step_now, step_now + 1):
                if step > self.last_step and hmac.compare_digest(totp.at(step * 30), code):
                    self.last_step = step
                    return True
        return False


class ChallengeStore:
    """One-time WebAuthn challenges, keyed by an opaque id carried in a short-lived cookie."""

    def __init__(self, ttl: int = 300, max_items: int = 64):
        self.ttl, self.max_items = ttl, max_items
        self._items: dict[str, tuple[bytes, str, float]] = {}
        self._lock = threading.Lock()

    def put(self, purpose: str, challenge: bytes, now: float | None = None) -> str:
        now = now or time.time()
        key = secrets.token_urlsafe(24)
        with self._lock:
            self._items = {k: v for k, v in self._items.items() if v[2] > now}
            while len(self._items) >= self.max_items:
                self._items.pop(next(iter(self._items)))
            self._items[key] = (challenge, purpose, now + self.ttl)
        return key

    def pop(self, key: str | None, purpose: str, now: float | None = None) -> bytes | None:
        if not key:
            return None
        with self._lock:
            item = self._items.pop(key, None)
        if item is None or item[1] != purpose or item[2] < (now or time.time()):
            return None
        return item[0]
