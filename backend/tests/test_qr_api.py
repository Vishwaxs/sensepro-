"""QR absentee-fallback endpoint tests (fake writer, no network, no DB)."""

from __future__ import annotations

import base64
import json

import pytest
from fastapi.testclient import TestClient

import app.qr_api as qr
from app.main import app

client = TestClient(app)

SESSION = {"id": "sess-1", "class_section": "CS-401", "mode": "lecture"}
STUDENT = {"id": "stud-1", "reg_no": "2547201", "class_section": "CS-401"}


@pytest.fixture(autouse=True)
def _clear_rate_limit():
    qr._claim_hits.clear()
    yield
    qr._claim_hits.clear()


def _jwt(role: str | None) -> str:
    claims = {"app_role": role} if role is not None else {}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"h.{payload}.s"


def _hdr(role: str) -> dict:
    return {"Authorization": f"Bearer {_jwt(role)}"}


class FakeQRWriter:
    def __init__(
        self, *, session=None, student=None, token=None, claim="win", present=False, db_role=None
    ):
        self.session = session
        self.student = student
        self.token = token
        self.claim = claim
        self.present = present
        self.db_role = db_role
        self.audits: list = []
        self.closed_qr = False

    def active_session(self, session_id):
        return self.session

    def role_for_auth_uid(self, auth_uid):
        return self.db_role

    def issue_qr_token(self, session_id, ttl_s):
        return {"token": "tok-xyz", "expires_at": "2026-07-29T00:01:15Z"}

    def close_qr(self, session_id):
        self.closed_qr = True

    def get_token(self, token):
        return self.token

    def student_by_auth_uid(self, auth_uid):
        return self.student

    def has_open_present(self, session_id, student_id):
        return self.present

    def claim_qr_token(self, token, student_id, ttl_s):
        if self.claim == "win":
            return {
                "window_id": "win-1",
                "session_id": SESSION["id"],
                "expires_at": "2026-07-29T00:00:30Z",
            }
        return None

    def append_audit(self, actor, action, payload):
        self.audits.append((action, payload))

    def close(self):
        pass


def _patch_writer(monkeypatch, writer):
    monkeypatch.setattr("app.qr_api.require_supabase_writer", lambda: writer)


def _patch_user(monkeypatch, uid="uid-1"):
    monkeypatch.setattr("app.qr_api._verify_user", lambda auth: uid)


# --- teacher: issue / close ---------------------------------------------------
def test_issue_token_requires_staff(monkeypatch):
    _patch_writer(monkeypatch, FakeQRWriter(session=SESSION))
    r = client.post("/v1/qr/token", json={"session_id": "sess-1"}, headers=_hdr("student"))
    assert r.status_code == 403


def test_issue_token_ok(monkeypatch):
    writer = FakeQRWriter(session=SESSION)
    _patch_writer(monkeypatch, writer)
    r = client.post("/v1/qr/token", json={"session_id": "sess-1"}, headers=_hdr("teacher"))
    assert r.status_code == 200
    body = r.json()
    assert body["token"] == "tok-xyz" and body["ttl_s"] == qr.QR_TOKEN_TTL_S
    assert ("qr_window_open", {"session_id": "sess-1"}) in writer.audits


def test_issue_token_inactive_session(monkeypatch):
    _patch_writer(monkeypatch, FakeQRWriter(session=None))
    r = client.post("/v1/qr/token", json={"session_id": "sess-1"}, headers=_hdr("teacher"))
    assert r.status_code == 409


def test_close_window(monkeypatch):
    writer = FakeQRWriter()
    _patch_writer(monkeypatch, writer)
    r = client.post("/v1/qr/close", json={"session_id": "sess-1"}, headers=_hdr("admin"))
    assert r.status_code == 200 and writer.closed_qr is True


def test_issue_token_role_from_db_when_jwt_has_no_app_role(monkeypatch):
    """Access Token Hook disabled → JWT carries no app_role → the role is resolved
    from user_roles after a real token verify. The staff endpoint still works."""
    writer = FakeQRWriter(session=SESSION, db_role="admin")
    _patch_writer(monkeypatch, writer)
    _patch_user(monkeypatch)  # _verify_user validates the token -> uid, no network
    r = client.post(
        "/v1/qr/token",
        json={"session_id": "sess-1"},
        headers={"Authorization": f"Bearer {_jwt(None)}"},  # empty claims, no app_role
    )
    assert r.status_code == 200
    assert r.json()["token"] == "tok-xyz"


def test_issue_token_no_role_in_jwt_or_db_forbidden(monkeypatch):
    """No app_role in the JWT and no user_roles row → 403 (never a silent allow)."""
    writer = FakeQRWriter(session=SESSION, db_role=None)
    _patch_writer(monkeypatch, writer)
    _patch_user(monkeypatch)
    r = client.post(
        "/v1/qr/token",
        json={"session_id": "sess-1"},
        headers={"Authorization": f"Bearer {_jwt(None)}"},
    )
    assert r.status_code == 403


# --- student: claim -----------------------------------------------------------
def _claim(token="tok-xyz"):
    return client.post("/v1/qr/claim", json={"token": token}, headers={"Authorization": "Bearer x"})


def test_claim_not_a_student(monkeypatch):
    _patch_user(monkeypatch)
    _patch_writer(monkeypatch, FakeQRWriter(student=None))
    assert _claim().status_code == 403


def test_claim_unknown_token(monkeypatch):
    _patch_user(monkeypatch)
    _patch_writer(monkeypatch, FakeQRWriter(student=STUDENT, token=None))
    assert _claim().status_code == 404


def test_claim_inactive_session(monkeypatch):
    _patch_user(monkeypatch)
    _patch_writer(
        monkeypatch, FakeQRWriter(student=STUDENT, token={"session_id": "sess-1"}, session=None)
    )
    assert _claim().status_code == 409


def test_claim_wrong_class(monkeypatch):
    _patch_user(monkeypatch)
    other = {**STUDENT, "class_section": "CS-999"}
    _patch_writer(
        monkeypatch,
        FakeQRWriter(student=other, token={"session_id": "sess-1"}, session=SESSION),
    )
    assert _claim().status_code == 403


def test_claim_already_present(monkeypatch):
    _patch_user(monkeypatch)
    _patch_writer(
        monkeypatch,
        FakeQRWriter(
            student=STUDENT, token={"session_id": "sess-1"}, session=SESSION, present=True
        ),
    )
    assert _claim().status_code == 409


def test_claim_reused_or_expired_token(monkeypatch):
    _patch_user(monkeypatch)
    _patch_writer(
        monkeypatch,
        FakeQRWriter(
            student=STUDENT, token={"session_id": "sess-1"}, session=SESSION, claim="lost"
        ),
    )
    r = _claim()
    assert r.status_code == 409
    assert "already used" in r.json()["detail"].lower()


def test_claim_success_opens_window(monkeypatch):
    _patch_user(monkeypatch)
    writer = FakeQRWriter(
        student=STUDENT, token={"session_id": "sess-1"}, session=SESSION, claim="win"
    )
    _patch_writer(monkeypatch, writer)
    r = _claim()
    assert r.status_code == 200
    body = r.json()
    assert body["window_id"] == "win-1"
    assert body["seconds"] == qr.QR_WINDOW_TTL_S
    assert any(a[0] == "qr_claim" for a in writer.audits)  # audited


def test_claim_rate_limited(monkeypatch):
    _patch_user(monkeypatch)
    writer = FakeQRWriter(
        student=STUDENT, token={"session_id": "sess-1"}, session=SESSION, claim="win"
    )
    _patch_writer(monkeypatch, writer)
    for _ in range(qr.CLAIM_RATE_MAX):
        assert _claim().status_code == 200
    assert _claim().status_code == 429  # one past the limit
