"""Unit tests for Resend notification service and API endpoints."""

from __future__ import annotations

import asyncio
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.notify import (
    is_configured,
    send_deletion_request_notification,
    send_email,
    send_proctor_alert_notification,
    send_session_summary_notification,
    send_test_notification,
)

client = TestClient(app)


def test_is_configured():
    assert is_configured() is True


def test_send_email_mocked(monkeypatch):
    calls = []

    class MockResponse:
        status_code = 200

        def json(self):
            return {"id": "msg_test_123"}

    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass

        async def post(self, url, headers=None, json=None):
            calls.append({"url": url, "headers": headers, "json": json})
            return MockResponse()

    monkeypatch.setattr("httpx.AsyncClient", MockAsyncClient)

    res = asyncio.run(
        send_email(
            to="test@example.com",
            subject="Test Subject",
            html="<p>Test Body</p>",
        )
    )
    assert res["success"] is True
    assert res["id"] == "msg_test_123"
    assert len(calls) == 1
    assert calls[0]["json"]["to"] == ["test@example.com"]
    assert calls[0]["json"]["subject"] == "Test Subject"


def test_send_session_summary_notification_mocked(monkeypatch):
    calls = []

    async def mock_send_email(to, subject, html, text=None):
        calls.append({"to": to, "subject": subject, "html": html})
        return {"success": True, "id": "summary_msg_1"}

    monkeypatch.setattr("app.notify.send_email", mock_send_email)

    res = asyncio.run(
        send_session_summary_notification(
            session_id="sess-test-1",
            class_section="MCA-4B",
            subject="Distributed Systems",
            mode="lecture",
            present_count=45,
            total_enrolled=53,
            attended_count=42,
            vnei_pct=0.88,
            flags_count=0,
            to_email="instructor@example.com",
        )
    )
    assert res["success"] is True
    assert len(calls) == 1
    assert calls[0]["to"] == "instructor@example.com"
    assert "MCA-4B" in calls[0]["subject"]
    assert "Distributed Systems" in calls[0]["subject"]
    assert "42" in calls[0]["html"]
    assert "88%" in calls[0]["html"]


def test_send_proctor_alert_notification_mocked(monkeypatch):
    calls = []

    async def mock_send_email(to, subject, html, text=None):
        calls.append({"to": to, "subject": subject, "html": html})
        return {"success": True, "id": "alert_msg_1"}

    monkeypatch.setattr("app.notify.send_email", mock_send_email)

    res = asyncio.run(
        send_proctor_alert_notification(
            session_id="sess-exam-1",
            flag_type="phone",
            student_name="Aarav Sharma",
            student_reg="2347101",
            timestamp_str="2026-08-21 10:30:00",
            to_email="proctor@example.com",
        )
    )
    assert res["success"] is True
    assert len(calls) == 1
    assert "Phone" in calls[0]["subject"]
    assert "Aarav Sharma" in calls[0]["html"]
    assert "2347101" in calls[0]["html"]


def test_send_deletion_request_notification_mocked(monkeypatch):
    calls = []

    async def mock_send_email(to, subject, html, text=None):
        calls.append({"to": to, "subject": subject, "html": html})
        return {"success": True, "id": "deletion_msg_1"}

    monkeypatch.setattr("app.notify.send_email", mock_send_email)

    res = asyncio.run(
        send_deletion_request_notification(
            student_id="s-123",
            student_name="Ananya Verma",
            student_reg="2347105",
            reason="Graduated student request",
            to_email="dpo@example.com",
        )
    )
    assert res["success"] is True
    assert len(calls) == 1
    assert "Ananya Verma" in calls[0]["subject"]
    assert "2347105" in calls[0]["html"]
    assert "Graduated student request" in calls[0]["html"]


def test_notification_status_endpoint():
    r = client.get("/v1/notifications/status")
    assert r.status_code == 200
    data = r.json()
    assert data["configured"] is True
    assert data["provider"] == "Resend"
    assert "onboarding@resend.dev" in data["from_email"]


def test_session_summary_endpoint():
    r = client.post(
        "/v1/notifications/session-summary",
        json={
            "session_id": "sess-abc",
            "class_section": "MCA-4B",
            "subject": "Cloud Computing",
            "mode": "lecture",
            "present_count": 48,
            "total_enrolled": 53,
            "attended_count": 46,
            "vnei_pct": 0.92,
            "flags_count": 0,
            "to_email": "vashishtha.vishwas@gmail.com",
        },
    )
    assert r.status_code == 200
    assert r.json().get("queued") is True


def test_proctor_alert_endpoint():
    r = client.post(
        "/v1/notifications/proctor-alert",
        json={
            "session_id": "sess-xyz",
            "flag_type": "phone",
            "student_name": "Test Student",
            "student_reg": "2347199",
            "to_email": "vashishtha.vishwas@gmail.com",
        },
    )
    assert r.status_code == 200
    assert r.json().get("queued") is True
