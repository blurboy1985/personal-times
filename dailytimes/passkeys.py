"""Passkeys (WebAuthn) for the single subscriber.

Passkeys are discoverable (no username needed) and always require user
verification (Face ID / Touch ID / device PIN). The password + TOTP login stays
as the backup and is also what authorises adding a new passkey.
"""
from __future__ import annotations

import secrets
import time
from urllib.parse import urlparse

from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from .auth import AuthState

RP_NAME = "The Personal Times"


def rp(public_url: str) -> tuple[str, str]:
    """(relying-party id, expected origin) — a passkey is bound to this hostname."""
    url = urlparse(public_url)
    return url.hostname, f"{url.scheme}://{url.netloc}"


def registration_options(state: AuthState, rp_id: str) -> tuple[str, bytes]:
    """Creation options JSON + challenge. Assigns a user handle on first use (caller saves)."""
    if not state.user_handle:
        state.user_handle = bytes_to_base64url(secrets.token_bytes(32))
    options = generate_registration_options(
        rp_id=rp_id,
        rp_name=RP_NAME,
        user_name=state.username,
        user_id=base64url_to_bytes(state.user_handle),
        user_display_name=state.username.title(),
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(p["id"])) for p in state.passkeys],
    )
    return options_to_json(options), options.challenge


def register(state: AuthState, credential: dict, challenge: bytes, rp_id: str, origin: str, name: str) -> dict:
    verified = verify_registration_response(
        credential=credential,
        expected_challenge=challenge,
        expected_rp_id=rp_id,
        expected_origin=origin,
        require_user_verification=True,
    )
    cred_id = bytes_to_base64url(verified.credential_id)
    if any(p["id"] == cred_id for p in state.passkeys):
        raise ValueError("passkey already registered")
    transports = (credential.get("response") or {}).get("transports") or []
    entry = {
        "id": cred_id,
        "public_key": bytes_to_base64url(verified.credential_public_key),
        "sign_count": verified.sign_count,
        "name": name.strip()[:40] or "Passkey",
        "transports": [t for t in transports if isinstance(t, str)][:6],
        "backed_up": bool(verified.credential_backed_up),
        "created_at": int(time.time()),
        "last_used_at": None,
    }
    state.passkeys.append(entry)
    return entry


def authentication_options(rp_id: str) -> tuple[str, bytes]:
    options = generate_authentication_options(rp_id=rp_id, user_verification=UserVerificationRequirement.REQUIRED)
    return options_to_json(options), options.challenge


def authenticate(state: AuthState, credential: dict, challenge: bytes, rp_id: str, origin: str) -> dict:
    entry = next((p for p in state.passkeys if p["id"] == credential.get("id")), None)
    if entry is None:
        raise ValueError("unknown passkey")
    user_handle = (credential.get("response") or {}).get("userHandle")
    if user_handle and state.user_handle and user_handle != state.user_handle:
        raise ValueError("passkey belongs to a different user")
    verified = verify_authentication_response(
        credential=credential,
        expected_challenge=challenge,
        expected_rp_id=rp_id,
        expected_origin=origin,
        credential_public_key=base64url_to_bytes(entry["public_key"]),
        credential_current_sign_count=entry["sign_count"],
        require_user_verification=True,
    )
    entry["sign_count"] = verified.new_sign_count
    entry["last_used_at"] = int(time.time())
    return entry


def public_view(state: AuthState) -> list[dict]:
    return [{k: p.get(k) for k in ("id", "name", "created_at", "last_used_at", "backed_up")} for p in state.passkeys]
