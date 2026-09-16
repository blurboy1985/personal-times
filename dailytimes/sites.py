"""Upload editions to the private Sites reader; credentials stay outside the repo."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.parse import urlparse

import requests

from .config import CONFIG_DIR, Settings


def configuration() -> dict | None:
    path = CONFIG_DIR / 'sites.json'
    if not path.exists():
        return None
    cfg = json.loads(path.read_text())
    url = urlparse(cfg['url'])
    if url.scheme != 'https' or not url.hostname or not url.hostname.endswith('.chatgpt.site') or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
        raise ValueError('Sites URL must be an HTTPS chatgpt.site origin')
    return cfg


def publish_file(path: Path, cfg: dict) -> dict:
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    response = requests.post(cfg['url'].rstrip('/') + '/api/publish', data=data,
                             headers={'Content-Type': 'application/json',
                                      'OAI-Sites-Authorization': 'Bearer ' + cfg['bypass_token'],
                                      cfg.get('upload_header', 'X-Upload-Key'): cfg['upload_key']},
                             timeout=60, allow_redirects=False)
    if response.status_code != 200:
        raise RuntimeError(f'Sites upload failed (HTTP {response.status_code}); edition remains saved locally')
    receipt = response.json()
    if receipt.get('sha256') != digest or receipt.get('date') != path.stem or not receipt.get('ok'):
        raise RuntimeError('Sites upload verification failed')
    return receipt


def publish(settings: Settings, day: str) -> bool:
    cfg = configuration()
    if not cfg:
        return False
    publish_file(settings.editions_dir / f'{day}.json', cfg)
    return True


def sync(settings: Settings) -> int:
    cfg = configuration()
    if not cfg:
        raise RuntimeError('Sites upload is not configured')
    count = 0
    for path in sorted(settings.editions_dir.glob('????-??-??.json')):
        publish_file(path, cfg)
        count += 1
    return count


def reader_url(fallback: str) -> str:
    cfg = configuration()
    return cfg['url'].rstrip('/') if cfg else fallback
