"""Mode-specific class-session creation contracts."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime

from fastapi.testclient import TestClient

from app.main import app
from app.store import NoopWriter, SupabaseNotConfigured

client = TestClient(app)


def _headers(role: str = "teacher") -> dict[str, str]:
    payload = base64.urlsafe_b64encode(json.dumps({"app_role": role}).encode()).decode().rstrip("=")
    return {"Authorization": f"Bearer h.{payload}.s"}


class _Writer:
    def __init__(self) -> None:
        self.closed = False
        self.created: list[tuple[str, str | None, str]] = []

    def create_session(self, class_section: str, subject: str | None, mode: str):
        self.created.append((class_section, subject, mode))
        return "persisted-session", datetime(2026, 8, 31, tzinfo=UTC)

    def close(self) -> None:
        self.closed = True


def _body(mode: str) -> dict[str, str]:
    return {"class_section": "MCA-4B", "subject": "Demo", "mode": mode}


def test_exam_requires_a_real_persistence_writer(monkeypatch):
    def unavailable():
        raise SupabaseNotConfigured("database unavailable")

    monkeypatch.setattr("app.sessions.require_supabase_writer", unavailable)
    response = client.post("/v1/sessions", json=_body("exam"), headers=_headers())

    assert response.status_code == 503
    assert response.json()["detail"] == "database unavailable"


def test_workshop_requires_a_real_persistence_writer(monkeypatch):
    def unavailable():
        raise SupabaseNotConfigured("database unavailable")

    monkeypatch.setattr("app.sessions.require_supabase_writer", unavailable)
    response = client.post("/v1/sessions", json=_body("workshop"), headers=_headers())

    assert response.status_code == 503


def test_lecture_keeps_the_offline_noop_path(monkeypatch):
    monkeypatch.setattr("app.sessions.build_writer", NoopWriter)
    response = client.post("/v1/sessions", json=_body("lecture"), headers=_headers())

    assert response.status_code == 201
    assert response.json()["id"] == "noop-session"


def test_persisted_writer_is_closed_after_creation(monkeypatch):
    writer = _Writer()
    monkeypatch.setattr("app.sessions.require_supabase_writer", lambda: writer)
    response = client.post("/v1/sessions", json=_body("exam"), headers=_headers())

    assert response.status_code == 201
    assert writer.created == [("MCA-4B", "Demo", "exam")]
    assert writer.closed is True
