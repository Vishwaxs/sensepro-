"""Authenticated proctor review API tests with no network or database access."""

from __future__ import annotations

import base64
import json

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _headers(role: str, sub: str = "reviewer-1") -> dict[str, str]:
    claims = {"app_role": role, "sub": sub}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return {"Authorization": f"Bearer h.{payload}.s"}


class FakeProctorWriter:
    def __init__(self, *, mode: str = "exam", reviewed: bool = True) -> None:
        self.mode = mode
        self.reviewed = reviewed
        self.closed = False
        self.review_call: tuple[str, str, str, str] | None = None

    def get_session(self, session_id: str) -> dict | None:
        if session_id == "missing":
            return None
        return {"id": session_id, "mode": self.mode}

    def list_proctor_flags(self, session_id: str) -> list[dict]:
        return [
            {
                "id": "flag-1",
                "session_id": session_id,
                "student_id": None,
                "flag_type": "phone",
                "suppressed": False,
                "flagged_at": "2026-08-31T10:00:00Z",
                "review_status": "pending",
                "reviewed_by": None,
                "reviewed_at": None,
            }
        ]

    def review_proctor_flag(
        self, session_id: str, flag_id: str, review_status: str, reviewed_by: str, reviewed_at
    ) -> dict | None:
        self.review_call = (session_id, flag_id, review_status, reviewed_by)
        if not self.reviewed:
            return None
        return {
            "id": flag_id,
            "session_id": session_id,
            "review_status": review_status,
            "reviewed_by": reviewed_by,
            "reviewed_at": reviewed_at.isoformat(),
        }

    def close(self) -> None:
        self.closed = True


def test_proctor_queue_requires_staff(monkeypatch) -> None:
    monkeypatch.setattr("app.sessions.require_supabase_writer", lambda: FakeProctorWriter())
    response = client.get("/v1/sessions/exam-1/proctor-flags", headers=_headers("student"))
    assert response.status_code == 403


def test_proctor_queue_rejects_non_exam_session(monkeypatch) -> None:
    writer = FakeProctorWriter(mode="workshop")
    monkeypatch.setattr("app.sessions.require_supabase_writer", lambda: writer)
    response = client.get("/v1/sessions/workshop-1/proctor-flags", headers=_headers("teacher"))
    assert response.status_code == 404
    assert writer.closed


def test_proctor_queue_returns_retained_events(monkeypatch) -> None:
    writer = FakeProctorWriter()
    monkeypatch.setattr("app.sessions.require_supabase_writer", lambda: writer)
    response = client.get("/v1/sessions/exam-1/proctor-flags", headers=_headers("teacher"))
    assert response.status_code == 200
    assert response.json()[0]["flag_type"] == "phone"
    assert writer.closed


def test_proctor_review_records_verified_reviewer(monkeypatch) -> None:
    writer = FakeProctorWriter()
    monkeypatch.setattr("app.sessions.require_supabase_writer", lambda: writer)
    response = client.patch(
        "/v1/sessions/exam-1/proctor-flags/flag-1",
        headers=_headers("admin", sub="clerk-user-1"),
        json={"review_status": "dismissed"},
    )
    assert response.status_code == 200
    assert writer.review_call == ("exam-1", "flag-1", "dismissed", "clerk-user-1")
    assert writer.closed


def test_proctor_review_rejects_invalid_decision(monkeypatch) -> None:
    monkeypatch.setattr("app.sessions.require_supabase_writer", lambda: FakeProctorWriter())
    response = client.patch(
        "/v1/sessions/exam-1/proctor-flags/flag-1",
        headers=_headers("teacher"),
        json={"review_status": "pending"},
    )
    assert response.status_code == 422


def test_proctor_review_conflicts_when_event_is_no_longer_pending(monkeypatch) -> None:
    writer = FakeProctorWriter(reviewed=False)
    monkeypatch.setattr("app.sessions.require_supabase_writer", lambda: writer)
    response = client.patch(
        "/v1/sessions/exam-1/proctor-flags/flag-1",
        headers=_headers("teacher"),
        json={"review_status": "upheld"},
    )
    assert response.status_code == 409
    assert writer.closed
