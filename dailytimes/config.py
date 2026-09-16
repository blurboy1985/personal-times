from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
TZ = ZoneInfo("Asia/Singapore")
CONFIG_DIR = Path(os.environ.get("PERSONAL_TIMES_CONFIG_DIR", "~/.config/personal-times")).expanduser()


@dataclass(frozen=True)
class Settings:
    public_url: str
    host: str
    port: int
    data_dir: Path
    web_dist: Path
    feeds_file: Path
    google_token: Path
    portfolio_dir: Path
    codex_bin: str
    codex_model: str
    codex_effort: str
    codex_timeout: int
    channels: tuple[str, ...]
    email_to: str | None
    session_days: int
    cookie_secure: bool

    @property
    def editions_dir(self) -> Path:
        return self.data_dir / "editions"

    @property
    def raw_dir(self) -> Path:
        return self.data_dir / "raw"


def _path(value: str) -> Path:
    return Path(value).expanduser()


def load() -> Settings:
    cfg_file = CONFIG_DIR / "config.toml"
    raw = tomllib.loads(cfg_file.read_text()) if cfg_file.exists() else {}
    src = raw.get("sources", {})
    ed = raw.get("editor", {})
    dl = raw.get("delivery", {})
    au = raw.get("auth", {})
    return Settings(
        public_url=raw.get("public_url", "http://127.0.0.1:8740").rstrip("/"),
        host=raw.get("host", "127.0.0.1"),
        port=int(raw.get("port", 8740)),
        data_dir=_path(raw.get("data_dir", "~/.local/share/personal-times")),
        web_dist=ROOT / "web" / "dist",
        feeds_file=ROOT / "config" / "feeds.toml",
        google_token=_path(src.get("google_token", "~/.hermes/google_token.json")),
        portfolio_dir=_path(src.get("portfolio_dir", "~/portfolio")),
        codex_bin=ed.get("codex_bin", "codex"),
        codex_model=ed.get("model", "gpt-6-astra"),
        codex_effort=ed.get("reasoning_effort", "medium"),
        codex_timeout=int(ed.get("timeout_seconds", 420)),
        channels=tuple(dl.get("channels", ["email", "telegram"])),
        email_to=dl.get("email_to"),
        session_days=int(au.get("session_days", 30)),
        cookie_secure=bool(au.get("cookie_secure", True)),
    )


def ensure_private_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)
    return path


def write_private(path: Path, text: str) -> None:
    """Atomic write with 0600 permissions (editions hold personal data)."""
    ensure_private_dir(path.parent)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    os.replace(tmp, path)
