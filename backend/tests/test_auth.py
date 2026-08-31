"""app.auth — the one place a caller's identity and role are established.

These are the guarantees the rest of the API leans on. Before this module
existed each endpoint carried its own `_decode_claims` that base64-decoded the
JWT payload and read `app_role` straight out of it, so the string

    AAAA.<base64 of {"app_role":"admin"}>.BBBB

authenticated as an admin everywhere. That was not hypothetical: such a token
created a real class_sessions row through POST /v1/sessions.
"""

import base64
import json

import pytest
from fastapi import HTTPException

from app import auth as app_auth


def _token(claims: dict) -> str:
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"h.{payload}.s"


class _FakeResp:
    def __init__(self, status_code: int, body: dict | None = None):
        self.status_code = status_code
        self._body = body or {}

    def json(self) -> dict:
        return self._body


class _FakeWriter:
    def __init__(self, role: str | None):
        self._role = role
        self.asked_for: list[str] = []

    def role_for_auth_uid(self, uid: str) -> str | None:
        self.asked_for.append(uid)
        return self._role

    def close(self) -> None:
        pass


class _FakeSigningKey:
    key = "public-key"


class _FakeJwksClient:
    def get_signing_key_from_jwt(self, _token: str) -> _FakeSigningKey:
        return _FakeSigningKey()


@pytest.fixture(autouse=True)
def _clear_cache():
    app_auth.invalidate()
    yield
    app_auth.invalidate()


def test_unverifiable_token_is_rejected(monkeypatch):
    """GoTrue says no -> 401. The payload's own claims are irrelevant."""
    monkeypatch.setattr(app_auth.httpx, "get", lambda *a, **k: _FakeResp(401))
    with pytest.raises(HTTPException) as e:
        app_auth.require_role(f"Bearer {_token({'app_role': 'admin'})}", app_auth.ADMIN_ONLY)
    assert e.value.status_code == 401


def test_role_comes_from_the_database_not_from_the_token(monkeypatch):
    """A token that CLAIMS admin gets only what user_roles actually grants."""
    writer = _FakeWriter(role="student")
    monkeypatch.setattr(app_auth.httpx, "get", lambda *a, **k: _FakeResp(200, {"id": "uid-9"}))
    monkeypatch.setattr(app_auth, "_writer", lambda: writer)
    with pytest.raises(HTTPException) as e:
        app_auth.require_role(f"Bearer {_token({'app_role': 'admin'})}", app_auth.ADMIN_ONLY)
    assert e.value.status_code == 403
    assert writer.asked_for == ["uid-9"]  # the DB was consulted, not the claim


def test_role_from_database_authorises_even_with_no_claim(monkeypatch):
    """Access Token Hook off -> no app_role in the JWT -> still works."""
    monkeypatch.setattr(app_auth.httpx, "get", lambda *a, **k: _FakeResp(200, {"id": "uid-1"}))
    monkeypatch.setattr(app_auth, "_writer", lambda: _FakeWriter(role="teacher"))
    claims = app_auth.require_role(f"Bearer {_token({})}", app_auth.STAFF_ROLES)
    assert claims == {"sub": "uid-1", "app_role": "teacher"}


def test_missing_or_malformed_header_is_401(monkeypatch):
    for header in (None, "", "Basic abc", "Bearer", "Bearer    "):
        with pytest.raises(HTTPException) as e:
            app_auth.require_role(header, app_auth.STAFF_ROLES)
        assert e.value.status_code == 401


def test_auth_outage_is_503_never_an_allow(monkeypatch):
    """If we cannot verify, we do not guess — and we never fail open."""

    def _boom(*a, **k):
        raise RuntimeError("network down")

    monkeypatch.setattr(app_auth.httpx, "get", _boom)
    with pytest.raises(HTTPException) as e:
        app_auth.require_role(f"Bearer {_token({'app_role': 'admin'})}", app_auth.ADMIN_ONLY)
    assert e.value.status_code == 503


def test_verification_is_cached_per_token(monkeypatch):
    calls = {"n": 0}

    def _get(*a, **k):
        calls["n"] += 1
        return _FakeResp(200, {"id": "uid-1"})

    monkeypatch.setattr(app_auth.httpx, "get", _get)
    monkeypatch.setattr(app_auth, "_writer", lambda: _FakeWriter(role="teacher"))
    tok = f"Bearer {_token({})}"
    for _ in range(5):
        app_auth.require_role(tok, app_auth.STAFF_ROLES)
    assert calls["n"] == 1


def _mock_clerk(monkeypatch, verified_claims: dict, db_role: str | None = None) -> None:
    def _decode(_token, *_args, **kwargs):
        if kwargs.get("options") == {"verify_signature": False}:
            return {"iss": "https://example.clerk.accounts.dev"}
        return verified_claims

    monkeypatch.setattr(app_auth.jwt, "decode", _decode)
    monkeypatch.setattr(app_auth, "_get_jwks_client", lambda _url, _headers=None: _FakeJwksClient())
    monkeypatch.setattr(app_auth, "_writer", lambda: _FakeWriter(role=db_role))


def test_clerk_uses_app_role_not_reserved_postgrest_role(monkeypatch):
    _mock_clerk(
        monkeypatch,
        {"sub": "user_clerk_1", "role": "authenticated", "app_role": "management"},
    )
    claims = app_auth.require_role("Bearer clerk-token", {"management"})
    assert claims == {"sub": "user_clerk_1", "app_role": "management"}


def test_clerk_without_trusted_app_role_fails_closed(monkeypatch):
    _mock_clerk(
        monkeypatch,
        {
            "sub": "user_clerk_2",
            "role": "authenticated",
            "unsafe_metadata": {"role": "admin"},
        },
    )
    with pytest.raises(HTTPException) as exc:
        app_auth.require_role("Bearer clerk-token", app_auth.STAFF_ROLES)
    assert exc.value.status_code == 403


# --- Clerk signing-key sources -------------------------------------------
#
# A Clerk instance whose domain is a Vercel provider domain still stamps `iss`
# with clerk.<domain>, and that host has no DNS, so {iss}/.well-known/jwks.json
# is unfetchable in production. These pin the resolution order that keeps
# verification working there without per-environment configuration.


@pytest.fixture(autouse=True)
def _clear_jwks_memo():
    app_auth._jwks_source_for_issuer.clear()
    yield
    app_auth._jwks_source_for_issuer.clear()


def test_backend_api_is_the_first_jwks_source_when_a_secret_key_is_set(monkeypatch):
    monkeypatch.setattr(app_auth, "_clerk_secret_key", lambda: "sk_live_stub")
    sources = app_auth._clerk_jwks_sources("https://clerk.sensepro-six.vercel.app")
    url, headers = sources[0]
    assert url == "https://api.clerk.com/v1/jwks"
    assert headers["Authorization"] == "Bearer sk_live_stub"
    assert headers["Clerk-API-Version"] == app_auth._CLERK_BAPI_VERSION


def test_issuer_jwks_still_offered_so_a_keyless_deployment_keeps_working(monkeypatch):
    monkeypatch.setattr(app_auth, "_clerk_secret_key", lambda: "")
    sources = app_auth._clerk_jwks_sources("https://funny-teal-523.clerk.accounts.dev")
    assert sources[0] == (
        "https://funny-teal-523.clerk.accounts.dev/.well-known/jwks.json",
        None,
    )
    assert all(url != "https://api.clerk.com/v1/jwks" for url, _ in sources)


def test_issuer_is_a_fallback_when_the_secret_key_is_for_another_instance(monkeypatch):
    monkeypatch.setattr(app_auth, "_clerk_secret_key", lambda: "sk_live_stub")
    urls = [url for url, _ in app_auth._clerk_jwks_sources("https://clerk.example.com")]
    assert "https://clerk.example.com/.well-known/jwks.json" in urls


def test_a_source_that_worked_is_tried_first_next_time(monkeypatch):
    monkeypatch.setattr(app_auth, "_clerk_secret_key", lambda: "sk_live_stub")
    issuer = "https://clerk.sensepro-six.vercel.app"
    issuer_jwks = f"{issuer}/.well-known/jwks.json"

    attempted: list[str] = []

    class _OnlyIssuerHasKeys:
        def __init__(self, url: str):
            self._url = url

        def get_signing_key_from_jwt(self, _token: str):
            attempted.append(self._url)
            if self._url != issuer_jwks:
                raise RuntimeError("unreachable host")
            return _FakeSigningKey()

    monkeypatch.setattr(app_auth, "_get_jwks_client", lambda url, _headers=None: _OnlyIssuerHasKeys(url))

    assert app_auth._clerk_signing_key("tok", issuer).key == "public-key"
    assert attempted == ["https://api.clerk.com/v1/jwks", issuer_jwks]

    attempted.clear()
    assert app_auth._clerk_signing_key("tok", issuer).key == "public-key"
    assert attempted == [issuer_jwks]  # the dead host is not retried


def test_no_usable_source_fails_closed_without_echoing_the_secret(monkeypatch):
    monkeypatch.setattr(app_auth, "_clerk_secret_key", lambda: "sk_live_stub")

    class _AlwaysEchoesTheKey:
        def get_signing_key_from_jwt(self, _token: str):
            raise RuntimeError("upstream said: Bearer sk_live_stub rejected")

    monkeypatch.setattr(app_auth, "_get_jwks_client", lambda _url, _headers=None: _AlwaysEchoesTheKey())

    with pytest.raises(HTTPException) as exc:
        app_auth._clerk_signing_key("tok", "https://clerk.sensepro-six.vercel.app")
    assert exc.value.status_code == 401
    assert "sk_live_stub" not in exc.value.detail
    assert "***" in exc.value.detail
