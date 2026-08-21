"""POST /v1/sessions/{id}/request-check tests (fake writer, no network, no DB).

Core invariant under test: the acting student_id ALWAYS comes from the
verified caller's own linked record — there is no student_id in the request
body, so a student can never request-check anyone else."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

AUTH = {"Authorization": "Bearer x"}


class FakeRequestCheckWriter:
    def __init__(self, *, student=None, fail=False):
        self.student = student
        self.fail = fail
        self.overrides: list[tuple[str, str, str]] = []

    def student_by_auth_uid(self, auth_uid):
        return self.student

    def override_presence(self, session_id, student_id, state, at):
        if self.fail:
            raise RuntimeError("boom")
        self.overrides.append((session_id, student_id, state))

    def close(self):
        pass


def _patch(monkeypatch, writer, uid="uid-1"):
    monkeypatch.setattr("app.sessions.require_supabase_writer", lambda: writer)
    monkeypatch.setattr("app.sessions._verify_user", lambda auth: uid)


def test_request_check_requires_auth_header():
    r = client.post("/v1/sessions/sess-1/request-check")
    assert r.status_code == 401


def test_request_check_not_linked_to_student_forbidden(monkeypatch):
    _patch(monkeypatch, FakeRequestCheckWriter(student=None))
    r = client.post("/v1/sessions/sess-1/request-check", headers=AUTH)
    assert r.status_code == 403


def test_request_check_marks_only_the_callers_own_student_id(monkeypatch):
    writer = FakeRequestCheckWriter(student={"id": "stud-caller", "reg_no": "R1"})
    _patch(monkeypatch, writer)
    r = client.post("/v1/sessions/sess-1/request-check", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["student_id"] == "stud-caller"
    assert body["state"] == "UNVERIFIED"
    assert writer.overrides == [("sess-1", "stud-caller", "UNVERIFIED")]


def test_request_check_write_failure_returns_502(monkeypatch):
    writer = FakeRequestCheckWriter(student={"id": "stud-caller"}, fail=True)
    _patch(monkeypatch, writer)
    r = client.post("/v1/sessions/sess-1/request-check", headers=AUTH)
    assert r.status_code == 502


def test_request_check_no_supabase_configured_returns_503(monkeypatch):
    from app.store import SupabaseNotConfigured

    def _raise():
        raise SupabaseNotConfigured("not configured")

    monkeypatch.setattr("app.sessions.require_supabase_writer", _raise)
    monkeypatch.setattr("app.sessions._verify_user", lambda auth: "uid-1")
    r = client.post("/v1/sessions/sess-1/request-check", headers=AUTH)
    assert r.status_code == 503
