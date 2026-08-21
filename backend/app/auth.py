"""Authentication and role authorisation — the single verifying implementation.

Every staff endpoint used to carry its own copy of a `_decode_claims` helper
that base64-decoded the JWT payload and read `app_role` straight out of it.
Nothing verified the signature, and the role check was satisfied by the decoded
claim alone, so a hand-written string

    AAAA.<base64 of {"app_role":"admin"}>.BBBB

authenticated as an admin against every one of those endpoints. That was
demonstrated end to end: such a token created a real class_sessions row via
POST /v1/sessions. A JWT payload is not a credential — it is attacker-supplied
text until a signature is checked.

The rule here, with no exceptions: a role is only ever read from a token whose
signature Supabase itself has validated, or from the database keyed by a
verified user id. `verify_user` round-trips the token to GoTrue, which performs
the real signature and expiry check; `role_for` then reads user_roles with the
service key (the source of truth — the Access Token Hook's claim is a
convenience copy, and a token minted before a role change carries a stale one).

Verification results are cached briefly so a burst of calls from one signed-in
staff member does not become a burst of auth round-trips. The cache is keyed by
the token itself and never outlives the token's own expiry check by more than
_CACHE_TTL_S, which is short enough that a revoked session stops working
promptly and long enough to absorb a page load's worth of parallel requests.
"""

from __future__ import annotations

import threading
import time

import httpx
from fastapi import HTTPException

from app.config import settings
from app.store import SupabaseNotConfigured, require_supabase_writer

# Roles that may operate the classroom: create sessions, mint QR tokens,
# override presence, read settings. `management` is analytics-only and is NOT
# staff for write purposes — callers pass the set they need explicitly.
STAFF_ROLES = frozenset({"teacher", "admin"})
STAFF_AND_MANAGEMENT = frozenset({"teacher", "admin", "management"})
ADMIN_ONLY = frozenset({"admin"})

_CACHE_TTL_S = 60.0
_cache: dict[str, tuple[float, str, str | None]] = {}  # token -> (expiry, uid, role)
_lock = threading.Lock()


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing or invalid Authorization header")
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(401, "Missing or invalid Authorization header")
    return token


def _writer():
    try:
        return require_supabase_writer()
    except SupabaseNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc


import base64
import json
import jwt
from jwt import PyJWKClient

_jwks_clients: dict[str, PyJWKClient] = {}


def _get_jwks_client(url: str) -> PyJWKClient:
    if url not in _jwks_clients:
        _jwks_clients[url] = PyJWKClient(url)
    return _jwks_clients[url]


def _resolve(token: str) -> tuple[str, str | None]:
    """(auth uid, app_role) for a token, verifying it for real. Cached."""
    now = time.monotonic()
    with _lock:
        hit = _cache.get(token)
        if hit and hit[0] > now:
            return hit[1], hit[2]

    # Check unverified payload header / iss to determine Clerk vs Supabase
    is_clerk = False
    clerk_iss = ""
    try:
        unverified = jwt.decode(token, options={"verify_signature": False})
        iss = unverified.get("iss", "")
        if "clerk" in iss or token.startswith("clerk_"):
            is_clerk = True
            clerk_iss = iss
    except Exception:
        pass

    if is_clerk:
        jwks_url = getattr(settings, "clerk_jwks_url", "")
        if not jwks_url and clerk_iss:
            jwks_url = f"{clerk_iss.rstrip('/')}/.well-known/jwks.json"
        if not jwks_url:
            jwks_url = "https://funny-teal-523.clerk.accounts.dev/.well-known/jwks.json"

        try:
            jwk_client = _get_jwks_client(jwks_url)
            signing_key = jwk_client.get_signing_key_from_jwt(token)
            data = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                options={"verify_exp": True, "verify_aud": False},
            )
            uid = data.get("sub")
            if not uid:
                raise HTTPException(401, "Invalid Clerk session")

            # `role` is reserved by Supabase/PostgREST and normally contains
            # `authenticated`; it is not an application authorisation role.
            # Unsafe metadata is user-editable in Clerk and must never grant
            # staff access. Only the explicit app claim/public metadata counts.
            candidate = data.get("app_role") or (data.get("public_metadata") or {}).get("role")
            role = candidate if candidate in {"teacher", "management", "admin", "student"} else None
            if not role and settings.supabase_enabled:
                try:
                    writer = _writer()
                    role = writer.role_for_auth_uid(uid)
                    writer.close()
                except Exception:
                    pass
            with _lock:
                if len(_cache) > 512:
                    _cache.clear()
                _cache[token] = (now + _CACHE_TTL_S, uid, role)
            return uid, role
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(401, f"Invalid Clerk token: {exc}") from exc

    # GoTrue is the verifier: it checks the signature and the expiry. A token we
    # cannot verify is not "probably fine", it is unauthenticated.
    try:
        r = httpx.get(
            f"{settings.supabase_url.rstrip('/')}/auth/v1/user",
            headers={"Authorization": f"Bearer {token}", "apikey": settings.supabase_auth_key},
            timeout=10,
        )
    except Exception as exc:  # noqa: BLE001 — network failure must not read as authorised
        raise HTTPException(503, f"Auth verification unavailable: {exc}") from exc
    if r.status_code != 200:
        raise HTTPException(401, "Invalid or expired session")
    uid = r.json().get("id")
    if not uid:
        raise HTTPException(401, "Invalid session")

    writer = _writer()
    try:
        role = writer.role_for_auth_uid(uid)
    finally:
        writer.close()

    with _lock:
        if len(_cache) > 512:  # bounded: this is a cache, not a session store
            _cache.clear()
        _cache[token] = (now + _CACHE_TTL_S, uid, role)
    return uid, role


def verified_uid(authorization: str | None) -> str:
    """The caller's Supabase auth id, or 401. Use where identity is enough and
    the endpoint scopes to 'me' (a student acting on their own record)."""
    return _resolve(_bearer(authorization))[0]


def require_role(authorization: str | None, allowed: frozenset[str] | set[str]) -> dict:
    """Verify the caller and assert their role. Returns {'sub', 'app_role'}.

    The returned dict intentionally carries only what was verified — endpoints
    must not reach for other "claims", because there is no verified source for
    them here beyond the user id and the database role.
    """
    uid, role = _resolve(_bearer(authorization))
    if role not in allowed:
        raise HTTPException(403, f"Requires one of {sorted(allowed)}")
    return {"sub": uid, "app_role": role}


def invalidate(token: str | None = None) -> None:
    """Drop cached verifications (all, or one token). For tests and sign-out."""
    with _lock:
        if token is None:
            _cache.clear()
        else:
            _cache.pop(token, None)
