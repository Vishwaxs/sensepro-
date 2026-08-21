"""POST /v1/sessions/{id}/override tests (fake writer, no network, no DB)."""

from __future__ import annotations

import base64
import json

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _jwt(role: str | None) -> str:
    claims = {"app_role": role} if role is not None else {}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"h.{payload}.s"


def _jwt_sub(role: str | None, sub: str) -> str:
    """Test token carrying an explicit subject, so the fake resolver in
    conftest can look the uid up in DB_ROLES (standing in for user_roles)."""
    claims: dict = {"sub": sub}
    if role is not None:
        claims["app_role"] = role
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"h.{payload}.s"


def _hdr(role: str) -> dict:
    return {"Authorization": f"Bearer {_jwt(role)}"}


class FakeOverrideWriter:
    def __init__(self, *, db_role=None, fail=False):
        self.db_role = db_role
        self.fail = fail
        self.overrides: list[tuple[str, str, str]] = []

    def role_for_auth_uid(self, auth_uid):
        return self.db_role

    def override_presence(self, session_id, student_id, state, at):
        if self.fail:
            raise RuntimeError("boom")
        self.overrides.append((session_id, student_id, state))

    def close(self):
        pass


def _patch_writer(monkeypatch, writer):
    monkeypatch.setattr("app.sessions.require_supabase_writer", lambda: writer)


BODY = {"student_id": "stud-1", "state": "PRESENT"}


def test_override_requires_auth_header():
    r = client.post("/v1/sessions/sess-1/override", json=BODY)
    assert r.status_code == 401


def test_override_requires_staff_role(monkeypatch):
    _patch_writer(monkeypatch, FakeOverrideWriter())
    r = client.post("/v1/sessions/sess-1/override", json=BODY, headers=_hdr("student"))
    assert r.status_code == 403


def test_override_ok_with_teacher_role(monkeypatch):
    writer = FakeOverrideWriter()
    _patch_writer(monkeypatch, writer)
    r = client.post("/v1/sessions/sess-1/override", json=BODY, headers=_hdr("teacher"))
    assert r.status_code == 200
    assert writer.overrides == [("sess-1", "stud-1", "PRESENT")]


def test_override_role_from_db_when_jwt_has_no_app_role(monkeypatch):
    from tests.conftest import DB_ROLES

    writer = FakeOverrideWriter(db_role="admin")
    _patch_writer(monkeypatch, writer)
    DB_ROLES["uid-1"] = "admin"
    tok = _jwt_sub(None, "uid-1")
    r = client.post(
        "/v1/sessions/sess-1/override", json=BODY, headers={"Authorization": f"Bearer {tok}"}
    )
    assert r.status_code == 200


def test_override_no_role_in_jwt_or_db_forbidden(monkeypatch):
    writer = FakeOverrideWriter(db_role=None)
    _patch_writer(monkeypatch, writer)
    monkeypatch.setattr("app.sessions._verify_user", lambda auth: "uid-1")
    r = client.post(
        "/v1/sessions/sess-1/override", json=BODY, headers={"Authorization": f"Bearer {_jwt(None)}"}
    )
    assert r.status_code == 403


def test_override_rejects_invalid_state(monkeypatch):
    _patch_writer(monkeypatch, FakeOverrideWriter())
    bad = {**BODY, "state": "MAYBE"}
    r = client.post("/v1/sessions/sess-1/override", json=bad, headers=_hdr("admin"))
    assert r.status_code == 400


def test_override_write_failure_returns_502_not_silent_success(monkeypatch):
    _patch_writer(monkeypatch, FakeOverrideWriter(fail=True))
    r = client.post("/v1/sessions/sess-1/override", json=BODY, headers=_hdr("admin"))
    assert r.status_code == 502


def test_override_no_supabase_configured_returns_503(monkeypatch):
    from app.store import SupabaseNotConfigured

    def _raise():
        raise SupabaseNotConfigured("not configured")

    monkeypatch.setattr("app.sessions.require_supabase_writer", _raise)
    r = client.post("/v1/sessions/sess-1/override", json=BODY, headers=_hdr("admin"))
    assert r.status_code == 503
