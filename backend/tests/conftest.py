"""Shared test setup.

Pins vision and proctor detection to deterministic stubs for the whole suite.

This used to happen by accident: build_backend() read os.getenv("VISION_BACKEND")
and defaulted to "stub" when unset, so tests got the stub simply because nobody
had exported the variable. That same lookup ignored backend/.env, which meant a
developer's real `VISION_BACKEND=insightface` never reached the pipeline — the
API reported "insightface" while actually running the 64-dim stub against a
512-dim gallery, and every face-bearing frame killed the capture socket.

Now that .env is honoured, the suite must say what it wants instead of relying
on a variable being unset — otherwise the tests you run depend on the contents
of your private .env file. Individual tests can still override this with
monkeypatch.setenv("VISION_BACKEND", ...), which takes precedence.
"""

import pytest

# uid -> app_role, as user_roles would answer. See _stub_auth_verification.
DB_ROLES: dict[str, str] = {}


def staff_token(role: str = "teacher") -> str:
    """A token the fake resolver in _stub_auth_verification accepts as `role`.

    /ws/capture is staff-gated (it drives the attendance write path and every
    frame costs model inference), and a WebSocket handshake cannot carry an
    Authorization header, so the token goes in the query string.
    """
    import base64
    import json

    payload = base64.urlsafe_b64encode(json.dumps({"app_role": role, "sub": "uid-test"}).encode())
    return f"h.{payload.decode().rstrip('=')}.s"


STAFF_WS_TOKEN = staff_token()


@pytest.fixture(autouse=True, scope="session")
def _pin_stub_vision_backend():
    import os

    from app.config import settings

    prior = os.environ.get("VISION_BACKEND")
    prior_proctor = settings.proctor_backend
    os.environ["VISION_BACKEND"] = "stub"
    # Local demos intentionally use the real YOLO backend via backend/.env;
    # the suite remains deterministic and never loads production weights.
    settings.proctor_backend = "stub"
    yield
    settings.proctor_backend = prior_proctor
    if prior is None:
        os.environ.pop("VISION_BACKEND", None)
    else:
        os.environ["VISION_BACKEND"] = prior


@pytest.fixture(autouse=True)
def _stub_auth_verification(monkeypatch, request):
    """Resolve the suite's fake JWTs without a network call to GoTrue.

    Endpoint auth now goes through app.auth, which VERIFIES a token by asking
    Supabase and then reads the role from user_roles — because the old
    per-module `_decode_claims` trusted the unsigned payload, and a hand-made
    "AAAA.<base64 {"app_role":"admin"}>.BBBB" authenticated as an admin against
    every staff endpoint.

    Tests still build tokens as `h.<base64 claims>.s`. Only the verification
    round-trip is stubbed here: `require_role` still runs for real, so the
    allowed-set checks and the 403s they produce are genuinely exercised. A
    token with no app_role resolves to role None, which is exactly how an
    unroled account behaves in production.
    """
    import base64
    import json

    from app import auth as app_auth

    # tests/test_auth.py exercises app.auth itself — stubbing its resolver there
    # would test the stub instead of the thing under test.
    if request.node.module.__name__.endswith("test_auth"):
        yield
        return

    def _fake_resolve(token: str):
        try:
            payload = token.split(".")[1]
            claims = json.loads(
                base64.urlsafe_b64decode(payload + "=" * ((4 - len(payload) % 4) % 4))
            )
        except Exception:  # noqa: BLE001 — an unparseable test token = no session
            from fastapi import HTTPException

            raise HTTPException(401, "Invalid or expired session") from None
        uid = claims.get("sub", "")
        # DB_ROLES stands in for the user_roles table: production always reads
        # the role from there after verifying the token, never from the token
        # itself. A test registers a uid here to assert exactly that.
        role = DB_ROLES.get(uid, claims.get("app_role"))
        return uid, role

    app_auth.invalidate()
    monkeypatch.setattr(app_auth, "_resolve", _fake_resolve)
    yield
    DB_ROLES.clear()
    app_auth.invalidate()
