import pyotp

from dailytimes import auth


def test_password_roundtrip():
    stored = auth.hash_password("correct horse battery")
    assert auth.verify_password("correct horse battery", stored)
    assert not auth.verify_password("wrong", stored)
    assert not auth.verify_password("x", "garbage")


def test_token_valid_tampered_expired_revoked():
    state = auth.AuthState.create("reader", "a-long-password")
    token = auth.make_token(state, days=1, now=1_000_000)
    assert auth.read_token(state, token, now=1_000_100) == "reader"
    body, sig = token.split(".")
    assert auth.read_token(state, body + "." + sig[:-2] + "AA", now=1_000_100) is None
    assert auth.read_token(state, token, now=1_000_000 + 2 * 86400) is None
    state.session_epoch += 1
    assert auth.read_token(state, token, now=1_000_100) is None
    assert auth.read_token(state, None) is None
    assert auth.read_token(state, "not-a-token") is None


def test_limiter_per_key_and_global():
    lim = auth.Limiter(per_key=3, global_max=5, window=60)
    for _ in range(3):
        lim.fail("a", now=100)
    assert lim.blocked("a", now=101)
    assert not lim.blocked("b", now=101)
    lim.fail("b", now=101)
    lim.fail("c", now=101)
    assert lim.blocked("d", now=102)  # global ceiling
    assert not lim.blocked("a", now=200)  # window expired


def test_totp_rejects_replay():
    secret = pyotp.random_base32()
    guard = auth.TotpGuard()
    now = 1_700_000_000
    code = pyotp.TOTP(secret).at(now)
    assert guard.verify(secret, code, now=now)
    assert not guard.verify(secret, code, now=now)
    assert not guard.verify(secret, "12345", now=now)
