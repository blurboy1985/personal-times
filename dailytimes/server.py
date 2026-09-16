"""Web server: login + authenticated edition reader. Bind to loopback; expose via
Tailscale Funnel (or any TLS reverse proxy)."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from urllib.parse import quote, urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from . import auth, config, passkeys

settings = config.load()
COOKIE = "dt_session"
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
limiter = auth.Limiter()
totp_guard = auth.TotpGuard()
challenges = auth.ChallengeStore()
RP_ID, ORIGIN = passkeys.rp(settings.public_url)
WA_COOKIE = "dt_wa"
PASSKEY_ENROL_WINDOW = 600  # adding a passkey needs a sign-in from the last 10 minutes
log = logging.getLogger(__name__)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    h = response.headers
    h["Content-Security-Policy"] = CSP
    h["X-Content-Type-Options"] = "nosniff"
    h["X-Frame-Options"] = "DENY"
    h["Referrer-Policy"] = "no-referrer"
    h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if settings.cookie_secure:
        h["Strict-Transport-Security"] = "max-age=31536000"
    if not request.url.path.startswith("/assets/"):
        h.setdefault("Cache-Control", "no-store")
    return response


def _state() -> auth.AuthState | None:
    return auth.AuthState.load()


def current_user(request: Request) -> str | None:
    state = _state()
    return auth.read_token(state, request.cookies.get(COOKIE)) if state else None


def _client_key(request: Request) -> str:
    host = request.client.host if request.client else "unknown"
    fwd = request.headers.get("x-forwarded-for")
    if fwd and host in ("127.0.0.1", "::1"):
        return fwd.split(",")[-1].strip()  # the proxy-appended hop, not a client-supplied one
    return host


def _same_origin(request: Request) -> bool:
    origin = request.headers.get("origin")
    if not origin:
        return True  # non-browser clients; the cookie is SameSite=Lax regardless
    netloc = urlparse(origin).netloc
    return netloc in {request.headers.get("host"), urlparse(settings.public_url).netloc}


def _html(name: str) -> FileResponse:
    path = settings.web_dist / name
    if not path.exists():
        raise HTTPException(503, "Web build missing — run `npm run build` in web/")
    return FileResponse(path, media_type="text/html")


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/login")
def login_page(request: Request):
    if current_user(request):
        return RedirectResponse("/", 303)
    return _html("login.html")


@app.get("/api/auth/state")
def auth_state(request: Request):
    state = _state()
    return {"configured": state is not None, "totp": bool(state and state.totp_secret),
            "passkeys": bool(state and state.passkeys), "authenticated": bool(current_user(request))}


def _start_session(response: Response, state: auth.AuthState) -> Response:
    response.set_cookie(COOKIE, auth.make_token(state, settings.session_days),
                        max_age=settings.session_days * 86400, httponly=True,
                        secure=settings.cookie_secure, samesite="lax", path="/")
    return response


@app.post("/api/login")
async def login(request: Request):
    if not _same_origin(request):
        raise HTTPException(403, "Cross-origin login refused")
    state = _state()
    if not state:
        return JSONResponse({"error": "No subscriber yet — run `python -m dailytimes auth set-password`."}, 503)
    key = _client_key(request)
    if limiter.blocked(key):
        return JSONResponse({"error": "Too many attempts. The door reopens in 15 minutes."}, 429)
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        body = {}
    password, code = str(body.get("password", ""))[:512], str(body.get("code", ""))[:16]
    ok = await asyncio.to_thread(auth.verify_password, password, state.password_hash)
    if ok and state.totp_secret:
        ok = totp_guard.verify(state.totp_secret, code)
    if not ok:
        limiter.fail(key)
        await asyncio.sleep(0.6)
        return JSONResponse({"error": "That password or code wasn't right."}, 401)
    limiter.reset(key)
    return _start_session(JSONResponse({"ok": True}), state)


@app.post("/api/logout")
def logout(request: Request):
    if not _same_origin(request):
        raise HTTPException(403)
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE, path="/")
    return response


def _require(request: Request) -> str:
    user = current_user(request)
    if not user:
        raise HTTPException(401, "Sign in required")
    return user


@app.get("/")
def index(request: Request):
    if not current_user(request):
        return RedirectResponse("/login", 303)
    return _html("index.html")


@app.get("/e/{day}")
def edition_page(day: str, request: Request):
    if not DATE_RE.match(day):
        raise HTTPException(404)
    if not current_user(request):
        return RedirectResponse(f"/login?next={quote('/e/' + day)}", 303)
    return _html("index.html")


def _edition_files() -> list[Path]:
    d = settings.editions_dir
    return sorted((p for p in d.glob("*.json") if DATE_RE.match(p.stem)), reverse=True) if d.exists() else []


@app.get("/api/editions")
def editions(request: Request):
    _require(request)
    out = []
    for p in _edition_files()[:120]:
        try:
            ed = json.loads(p.read_text())
            out.append({"date": ed["date"], "edition_no": ed["edition_no"], "headline": ed["front"]["headline"]})
        except (json.JSONDecodeError, KeyError):
            continue
    return out


@app.get("/api/editions/{day}")
def edition(day: str, request: Request):
    _require(request)
    files = _edition_files()
    if day == "latest":
        if not files:
            raise HTTPException(404, "No editions yet")
        path = files[0]
    elif DATE_RE.match(day):
        path = settings.editions_dir / f"{day}.json"
        if not path.exists():
            raise HTTPException(404, "No edition for that date")
    else:
        raise HTTPException(404)
    return JSONResponse(json.loads(path.read_text()))


# ---------- passkeys (WebAuthn) ----------

def _challenge_response(options_json: str, purpose: str, challenge: bytes) -> Response:
    response = Response(options_json, media_type="application/json")
    response.set_cookie(WA_COOKIE, challenges.put(purpose, challenge), max_age=challenges.ttl, httponly=True,
                        secure=settings.cookie_secure, samesite="strict", path="/api/passkey")
    return response


async def _body(request: Request) -> dict:
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        return {}
    return body if isinstance(body, dict) else {}


@app.post("/api/passkey/register/options")
def passkey_register_options(request: Request):
    if not _same_origin(request):
        raise HTTPException(403)
    _require(request)
    state = _state()
    age = auth.session_age(state, request.cookies.get(COOKIE), settings.session_days)
    if age is None or age > PASSKEY_ENROL_WINDOW:
        return JSONResponse({"error": "For safety, sign out and sign in again with your password and code, "
                                      "then add the passkey within 10 minutes.", "reauth": True}, 403)
    had_handle = bool(state.user_handle)
    options_json, challenge = passkeys.registration_options(state, RP_ID)
    if not had_handle:
        state.save()
    return _challenge_response(options_json, "register", challenge)


@app.post("/api/passkey/register/verify")
async def passkey_register_verify(request: Request):
    if not _same_origin(request):
        raise HTTPException(403)
    _require(request)
    body = await _body(request)
    challenge = challenges.pop(request.cookies.get(WA_COOKIE), "register")
    if challenge is None:
        return JSONResponse({"error": "That request expired — please try again."}, 400)
    state = _state()
    try:
        passkeys.register(state, body.get("credential") or {}, challenge, RP_ID, ORIGIN, str(body.get("name") or ""))
    except Exception as exc:
        log.warning("passkey registration rejected: %s", exc)
        return JSONResponse({"error": "Your device's passkey couldn't be verified."}, 400)
    state.save()
    response = JSONResponse({"ok": True, "passkeys": passkeys.public_view(state)})
    response.delete_cookie(WA_COOKIE, path="/api/passkey")
    return response


@app.get("/api/passkeys")
def passkey_list(request: Request):
    _require(request)
    return passkeys.public_view(_state())


@app.delete("/api/passkeys/{cred_id}")
def passkey_remove(cred_id: str, request: Request):
    if not _same_origin(request):
        raise HTTPException(403)
    _require(request)
    state = _state()
    remaining = [p for p in state.passkeys if p["id"] != cred_id]
    if len(remaining) == len(state.passkeys):
        raise HTTPException(404, "No such passkey")
    state.passkeys = remaining
    state.save()
    return passkeys.public_view(state)


@app.post("/api/passkey/login/options")
def passkey_login_options(request: Request):
    if not _same_origin(request):
        raise HTTPException(403)
    state = _state()
    if not state or not state.passkeys:
        return JSONResponse({"error": "No passkeys are registered yet."}, 404)
    if limiter.blocked(_client_key(request)):
        return JSONResponse({"error": "Too many attempts. The door reopens in 15 minutes."}, 429)
    options_json, challenge = passkeys.authentication_options(RP_ID)
    return _challenge_response(options_json, "login", challenge)


@app.post("/api/passkey/login/verify")
async def passkey_login_verify(request: Request):
    if not _same_origin(request):
        raise HTTPException(403)
    state = _state()
    if not state or not state.passkeys:
        return JSONResponse({"error": "No passkeys are registered yet."}, 404)
    key = _client_key(request)
    if limiter.blocked(key):
        return JSONResponse({"error": "Too many attempts. The door reopens in 15 minutes."}, 429)
    body = await _body(request)
    challenge = challenges.pop(request.cookies.get(WA_COOKIE), "login")
    if challenge is None:
        return JSONResponse({"error": "That sign-in request expired — please try again."}, 400)
    try:
        passkeys.authenticate(state, body.get("credential") or {}, challenge, RP_ID, ORIGIN)
    except Exception as exc:
        log.warning("passkey sign-in rejected: %s", exc)
        limiter.fail(key)
        await asyncio.sleep(0.6)
        return JSONResponse({"error": "That passkey wasn't accepted."}, 401)
    limiter.reset(key)
    state.save()
    response = _start_session(JSONResponse({"ok": True}), state)
    response.delete_cookie(WA_COOKIE, path="/api/passkey")
    return response


app.mount("/assets", StaticFiles(directory=settings.web_dist / "assets", check_dir=False), name="assets")


@app.get("/favicon.svg")
def favicon():
    path = settings.web_dist / "favicon.svg"
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/svg+xml")
