import hashlib
import json
from unittest.mock import Mock

import pytest

from dailytimes import sites


def test_no_configuration_keeps_local_mode(tmp_path, monkeypatch):
    monkeypatch.setattr(sites, 'CONFIG_DIR', tmp_path)
    assert sites.configuration() is None
    assert sites.reader_url('http://localhost') == 'http://localhost'


def test_upload_checks_receipt_and_does_not_follow_redirects(tmp_path, monkeypatch):
    path = tmp_path / '2026-09-14.json'
    path.write_text('{"date":"2026-09-14"}')
    cfg = {'url': 'https://paper.example.chatgpt.site', 'bypass_token': 'test', 'upload_key': 'key'}
    response = Mock(status_code=200)
    response.json.return_value = {'ok': True, 'date': path.stem, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    post = Mock(return_value=response)
    monkeypatch.setattr(sites.requests, 'post', post)
    assert sites.publish_file(path, cfg)['ok']
    assert post.call_args.kwargs['allow_redirects'] is False
    response.json.return_value['sha256'] = 'wrong'
    with pytest.raises(RuntimeError, match='verification failed'):
        sites.publish_file(path, cfg)
    response.status_code = 302
    with pytest.raises(RuntimeError, match='HTTP 302'):
        sites.publish_file(path, cfg)


def test_configuration_rejects_credential_exfiltration_origin(tmp_path, monkeypatch):
    monkeypatch.setattr(sites, 'CONFIG_DIR', tmp_path)
    (tmp_path / 'sites.json').write_text(json.dumps({'url': 'https://example.org'}))
    with pytest.raises(ValueError):
        sites.configuration()
