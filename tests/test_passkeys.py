import json

import pytest

from dailytimes import auth, passkeys


def test_legacy_auth_file_loads_and_roundtrips_passkeys(tmp_path):
    path = tmp_path / "auth.json"
    path.write_text(json.dumps({"username": "reader", "password_hash": "x", "session_secret": "c2VjcmV0",
                                "session_epoch": 3, "totp_secret": None}))
    state = auth.AuthState.load(path)
    assert state.passkeys == [] and state.user_handle is None
    state.passkeys.append({"id": "abc", "public_key": "pk", "sign_count": 0, "name": "iPhone",
                           "created_at": 1, "last_used_at": None})
    state.save(path)
    assert auth.AuthState.load(path).passkeys[0]["name"] == "iPhone"


def test_challenge_store_is_one_time_scoped_and_expiring():
    store = auth.ChallengeStore(ttl=60)
    key = store.put("login", b"c1", now=100)
    assert store.pop(key, "register", now=101) is None  # wrong purpose — and now consumed
    assert store.pop(key, "login", now=101) is None
    key = store.put("login", b"c2", now=100)
    assert store.pop(key, "login", now=101) == b"c2"
    assert store.pop(key, "login", now=102) is None  # one-time
    key = store.put("login", b"c3", now=100)
    assert store.pop(key, "login", now=200) is None  # expired
    assert store.pop(None, "login") is None


def test_session_age():
    state = auth.AuthState.create("reader", "a-long-password")
    token = auth.make_token(state, days=30, now=1_000_000)
    assert auth.session_age(state, token, 30, now=1_000_120) == pytest.approx(120)
    assert auth.session_age(state, "bogus", 30) is None


def test_rp_from_public_url():
    assert passkeys.rp("https://paper.example.ts.net") == ("paper.example.ts.net", "https://paper.example.ts.net")
    assert passkeys.rp("http://localhost:8741/") == ("localhost", "http://localhost:8741")


def test_registration_options_require_discoverable_verified_passkeys():
    state = auth.AuthState.create("reader", "a-long-password")
    state.passkeys.append({"id": "AQID", "public_key": "AA", "sign_count": 0, "name": "Mac",
                           "created_at": 1, "last_used_at": None})
    options_json, challenge = passkeys.registration_options(state, "localhost")
    data = json.loads(options_json)
    assert state.user_handle and data["user"]["id"] == state.user_handle
    assert data["rp"]["id"] == "localhost"
    assert data["authenticatorSelection"]["residentKey"] == "required"
    assert data["authenticatorSelection"]["userVerification"] == "required"
    assert [c["id"] for c in data["excludeCredentials"]] == ["AQID"]
    assert len(challenge) >= 32


def test_authenticate_rejects_unknown_and_foreign_passkeys():
    state = auth.AuthState.create("reader", "a-long-password")
    state.user_handle = "dXNlcg"
    state.passkeys.append({"id": "known", "public_key": "AA", "sign_count": 0, "name": "x",
                           "created_at": 1, "last_used_at": None})
    with pytest.raises(ValueError):
        passkeys.authenticate(state, {"id": "unknown"}, b"c", "localhost", "http://localhost")
    with pytest.raises(ValueError):
        passkeys.authenticate(state, {"id": "known", "response": {"userHandle": "b3RoZXI"}},
                              b"c", "localhost", "http://localhost")
