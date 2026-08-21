"""POST /v1/students tests (fake writer, no network, no DB)."""

from __future__ import annotations

import base64
import json

import httpx
import pytest
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


class FakeStudentsWriter:
    def __init__(self, *, db_role=None, conflict=False, error=False):
        self.db_role = db_role
        self.conflict = conflict
        self.error = error
        self.created: list[dict] = []

    def role_for_auth_uid(self, auth_uid):
        return self.db_role

    def create_student(self, reg_no, full_name, class_section, seat_zone):
        if self.conflict:
            resp = httpx.Response(409, request=httpx.Request("POST", "https://x/students"))
            raise httpx.HTTPStatusError("conflict", request=resp.request, response=resp)
        if self.error:
            resp = httpx.Response(500, request=httpx.Request("POST", "https://x/students"))
            raise httpx.HTTPStatusError("boom", request=resp.request, response=resp)
        row = {
            "id": "new-student-1",
            "reg_no": reg_no,
            "full_name": full_name,
            "class_section": class_section,
            "seat_zone": seat_zone,
        }
        self.created.append(row)
        return row

    def close(self):
        pass


def _patch_writer(monkeypatch, writer):
    monkeypatch.setattr("app.students_api.require_supabase_writer", lambda: writer)


BODY = {
    "reg_no": "2547299",
    "full_name": "New Student",
    "class_section": "MCA-4B",
    "seat_zone": "mid",
}


def test_create_student_requires_auth_header():
    r = client.post("/v1/students", json=BODY)
    assert r.status_code == 401


def test_create_student_requires_staff_role(monkeypatch):
    _patch_writer(monkeypatch, FakeStudentsWriter())
    r = client.post("/v1/students", json=BODY, headers=_hdr("student"))
    assert r.status_code == 403


def test_create_student_ok_with_teacher_role(monkeypatch):
    writer = FakeStudentsWriter()
    _patch_writer(monkeypatch, writer)
    r = client.post("/v1/students", json=BODY, headers=_hdr("teacher"))
    assert r.status_code == 201
    body = r.json()
    assert body["reg_no"] == "2547299"
    assert body["id"] == "new-student-1"
    assert len(writer.created) == 1


def test_create_student_role_comes_from_db_not_from_the_token(monkeypatch):
    """The role is authoritative from user_roles, never from the token payload.

    A token carrying no app_role still authorises when the DB says admin — and,
    the role is read from the database, never from the payload. Before
    app.auth existed, the claim in the unsigned payload was trusted outright —
    see tests/test_auth.py for the guarantee at the auth-module level."""
    from tests.conftest import DB_ROLES

    writer = FakeStudentsWriter(db_role="admin")
    _patch_writer(monkeypatch, writer)
    DB_ROLES["uid-1"] = "admin"
    tok = _jwt_sub(None, "uid-1")
    r = client.post("/v1/students", json=BODY, headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 201


def test_create_student_no_role_in_jwt_or_db_forbidden(monkeypatch):
    writer = FakeStudentsWriter(db_role=None)
    _patch_writer(monkeypatch, writer)
    monkeypatch.setattr("app.students_api._verify_user", lambda auth: "uid-1")
    r = client.post("/v1/students", json=BODY, headers={"Authorization": f"Bearer {_jwt(None)}"})
    assert r.status_code == 403


def test_create_student_rejects_blank_fields(monkeypatch):
    _patch_writer(monkeypatch, FakeStudentsWriter())
    bad = {**BODY, "full_name": "   "}
    r = client.post("/v1/students", json=bad, headers=_hdr("admin"))
    assert r.status_code == 400


def test_create_student_rejects_invalid_seat_zone(monkeypatch):
    _patch_writer(monkeypatch, FakeStudentsWriter())
    bad = {**BODY, "seat_zone": "back-left"}
    r = client.post("/v1/students", json=bad, headers=_hdr("admin"))
    assert r.status_code == 400


def test_create_student_duplicate_reg_no_returns_409(monkeypatch):
    _patch_writer(monkeypatch, FakeStudentsWriter(conflict=True))
    r = client.post("/v1/students", json=BODY, headers=_hdr("admin"))
    assert r.status_code == 409


def test_create_student_writer_failure_returns_502(monkeypatch):
    _patch_writer(monkeypatch, FakeStudentsWriter(error=True))
    r = client.post("/v1/students", json=BODY, headers=_hdr("admin"))
    assert r.status_code == 502


def test_create_student_no_supabase_configured_returns_503(monkeypatch):
    from app.store import SupabaseNotConfigured

    def _raise():
        raise SupabaseNotConfigured("not configured")

    monkeypatch.setattr("app.students_api.require_supabase_writer", _raise)
    r = client.post("/v1/students", json=BODY, headers=_hdr("admin"))
    assert r.status_code == 503


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
