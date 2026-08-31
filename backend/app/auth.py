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

import os
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

# Clerk publishes its signing keys on the Backend API, and that is what Clerk's
# own SDK reads (fetchJWKSFromBAPI in @clerk/backend). The version string is the
# one that SDK pins; Clerk requires it on every Backend API call.
_CLERK_BAPI_JWKS_URL = "https://api.clerk.com/v1/jwks"
_CLERK_BAPI_VERSION = "2026-05-12"

_jwks_clients: dict[str, PyJWKClient] = {}
_jwks_source_for_issuer: dict[str, str] = {}  # issuer -> the JWKS URL that worked


def _get_jwks_client(url: str, headers: dict[str, str] | None = None) -> PyJWKClient:
    if url not in _jwks_clients:
        _jwks_clients[url] = PyJWKClient(url, headers=headers, timeout=10)
    return _jwks_clients[url]


def _clerk_secret_key() -> str:
    # Server-side names only — a VITE_ variable is compiled into the browser
    # bundle, so a secret key must never be read from one.
    return getattr(settings, "clerk_secret_key", "") or os.environ.get("CLERK_SECRET_KEY", "")


def _clerk_jwks_sources(issuer: str) -> list[tuple[str, dict[str, str] | None]]:
    """Where to look for Clerk's signing keys, best source first.

    The Backend API leads because it is the only source that survives a proxied
    Production instance. Clerk stamps `iss` with the instance's own Frontend API
    host (clerk.<domain>) even when the Frontend API is proxied, and on a
    *.vercel.app provider domain that host has no DNS at all — so the
    conventional {iss}/.well-known/jwks.json can never be fetched there. The
    Backend API is reached by secret key instead of by the instance's hostname,
    which makes it immune to that whole problem.

    The issuer follows it so a deployment with no secret key configured (local
    dev against the Development instance) keeps working exactly as before, and
    so a token from a different instance than the secret key's still resolves.
    Ordering is a liveness concern only: whichever source answers, the signature
    is still checked against the key it hands back, so a wrong source cannot
    authenticate anyone — it just fails closed.
    """
    ordered: list[tuple[str, dict[str, str] | None]] = []

    secret = _clerk_secret_key()
    if secret:
        ordered.append(
            (
                _CLERK_BAPI_JWKS_URL,
                {
                    "Authorization": f"Bearer {secret}",
                    "Clerk-API-Version": _CLERK_BAPI_VERSION,
                },
            )
        )
    if issuer:
        ordered.append((f"{issuer.rstrip('/')}/.well-known/jwks.json", None))
    configured = getattr(settings, "clerk_jwks_url", "")
    if configured:
        ordered.append((configured, None))

    seen: set[str] = set()
    sources: list[tuple[str, dict[str, str] | None]] = []
    for url, headers in ordered:
        if url in seen:
            continue
        seen.add(url)
        sources.append((url, headers))

    # Whichever source answered for this issuer last time goes first, so the
    # unreachable-host attempt is paid once per process rather than per request.
    remembered = _jwks_source_for_issuer.get(issuer)
    if remembered:
        sources.sort(key=lambda source: source[0] != remembered)
    return sources


def _clerk_signing_key(token: str, issuer: str):
    """The signing key for a Clerk token, from the first source that has it."""
    last_error: Exception | None = None
    for url, headers in _clerk_jwks_sources(issuer):
        try:
            key = _get_jwks_client(url, headers).get_signing_key_from_jwt(token)
        except Exception as exc:  # noqa: BLE001 — try the next source, then fail closed
            last_error = exc
            continue
        _jwks_source_for_issuer[issuer] = url
        return key
    raise HTTPException(401, f"Invalid Clerk token: {_scrub(last_error)}")


def _scrub(error: Exception | None) -> str:
    """Error text with the secret key removed, in case a client library echoed it."""
    text = str(error) if error else "no Clerk JWKS source is configured"
    secret = _clerk_secret_key()
    return text.replace(secret, "***") if secret else text


def _resolve(token: str) -> tuple[str, str | None]:
    """(auth uid, app_role) for a token, verifying it for real. Cached."""
    now = time.monotonic()
    with _lock:
        hit = _cache.get(token)
        if hit and hit[0] > now:
            return hit[1], hit[2]

    # Check unverified payload header / iss / sub to determine Clerk vs Supabase
    is_clerk = False
    clerk_iss = ""
    try:
        unverified = jwt.decode(token, options={"verify_signature": False})
        iss = unverified.get("iss", "")
        sub = unverified.get("sub", "")
        if (
            "clerk" in iss
            or token.startswith("clerk_")
            or sub.startswith("user_")
            or "clerk.accounts.dev" in iss
        ):
            is_clerk = True
            clerk_iss = iss
    except Exception:
        pass

    if is_clerk:
        try:
            signing_key = _clerk_signing_key(token, clerk_iss)
            data = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                options={"verify_exp": True, "verify_aud": False},
            )
            uid = data.get("sub")
            if not uid:
                raise HTTPException(401, "Invalid Clerk session")

            # 1. Check claims inside token
            candidate = (
                data.get("app_role")
                or (data.get("public_metadata") or {}).get("role")
                or (data.get("metadata") or {}).get("role")
            )
            role = candidate if candidate in {"teacher", "management", "admin", "student"} else None

            # 2. If role is not in raw JWT, query Clerk API using configured secret keys
            if not role and uid.startswith("user_"):
                import os
                # Server-side names only. A VITE_-prefixed variable is compiled
                # into the browser bundle by Vite, so a secret key must never be
                # read from one — not even as a fallback.
                candidate_keys = [
                    getattr(settings, "clerk_secret_key", ""),
                    os.environ.get("CLERK_SECRET_KEY", ""),
                ]
                for key in candidate_keys:
                    if not key:
                        continue
                    try:
                        with httpx.Client(timeout=4.0) as client:
                            clerk_resp = client.get(
                                f"https://api.clerk.com/v1/users/{uid}",
                                headers={"Authorization": f"Bearer {key}"},
                            )
                            if clerk_resp.status_code == 200:
                                u_data = clerk_resp.json()
                                c_role = (u_data.get("public_metadata") or {}).get("role")
                                if c_role in {"teacher", "management", "admin", "student"}:
                                    role = c_role
                                    break
                                u_emails = [e.get("email_address", "").lower() for e in u_data.get("email_addresses", [])]
                                if settings.admin_notify_email and settings.admin_notify_email.lower() in u_emails:
                                    role = "admin"
                                    try:
                                        client.patch(
                                            f"https://api.clerk.com/v1/users/{uid}/metadata",
                                            headers={"Authorization": f"Bearer {key}"},
                                            json={"public_metadata": {"role": "admin"}},
                                        )
                                    except Exception:
                                        pass
                                    break
                    except Exception:
                        continue

            # 3. If still not resolved, query Supabase database
            if not role and settings.supabase_enabled:
                try:
                    writer = _writer()
                    # Only check user_roles if uid is a valid UUID
                    from uuid import UUID
                    try:
                        UUID(uid)
                        role = writer.role_for_auth_uid(uid)
                    except (ValueError, TypeError):
                        pass

                    # Check role_requests for this user_id or email
                    if not role:
                        user_email = data.get("email") or ""
                        req = writer.get_user_role_request(user_id=uid, email=user_email if user_email else None)
                        if req and req.get("status") == "approved":
                            role = req.get("resolved_role") or req.get("requested_role")

                    if not role:
                        # Check approved role_requests
                        reqs = writer.list_role_requests(status="approved", limit=50)
                        for r in reqs:
                            if r.get("user_id") == uid or (user_email and r.get("email") == user_email):
                                role = r.get("resolved_role") or r.get("requested_role")
                                break
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
