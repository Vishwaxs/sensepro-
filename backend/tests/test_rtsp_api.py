"""Authenticated RTSP status/control contracts without opening a camera."""

from __future__ import annotations

import threading

import pytest
from fastapi.testclient import TestClient

from app import rtsp_api
from app.main import app
from tests.conftest import STAFF_WS_TOKEN

AUTH = {"Authorization": f"Bearer {STAFF_WS_TOKEN}"}


@pytest.fixture(autouse=True)
def _clear_rtsp_state():
    with rtsp_api._lock:
        rtsp_api._active.clear()
        rtsp_api._recent.clear()
    yield
    with rtsp_api._lock:
        rtsp_api._active.clear()
        rtsp_api._recent.clear()


class _SourceState:
    state = "CONNECTED"


class _SessionWriter:
    def __init__(self, mode: str, ended: bool = False) -> None:
        self.mode = mode
        self.ended = ended
        self.closed = False

    def get_session(self, session_id: str) -> dict:
        return {
            "id": session_id,
            "mode": self.mode,
            "starts_at": "2026-08-31T00:00:00+00:00",
            "ends_at": "2026-08-31T01:00:00+00:00" if self.ended else None,
        }

    def close(self) -> None:
        self.closed = True


def _active_entry() -> dict:
    return {
        "thread": object(),
        "stop_event": threading.Event(),
        "source": _SourceState(),
        "mode": "workshop",
        "status": "running",
        "started_at": "2026-08-21T10:00:00+00:00",
        "updated_at": "2026-08-21T10:00:02+00:00",
        "frames_processed": 4,
        "telemetry": {
            "engagement": {"visible": 7, "observable": 6, "vnei": 0.833},
            "proctor": None,
        },
        "error": None,
    }


def test_status_is_authenticated_and_hides_runtime_objects() -> None:
    client = TestClient(app)
    with rtsp_api._lock:
        rtsp_api._active["sess-status"] = _active_entry()

    assert client.get("/v1/rtsp/status/sess-status").status_code == 401
    response = client.get("/v1/rtsp/status/sess-status", headers=AUTH)

    assert response.status_code == 200
    payload = response.json()
    assert payload["mode"] == "workshop"
    assert payload["running"] is True
    assert payload["source_state"] == "CONNECTED"
    assert payload["engagement"]["observable"] == 6
    assert {"thread", "stop_event", "source"}.isdisjoint(payload)


def test_capabilities_are_authenticated_and_do_not_expose_camera_url(monkeypatch) -> None:
    monkeypatch.setattr(rtsp_api.settings, "rtsp_url", "rtsp://user:secret@10.0.0.8/live")
    client = TestClient(app)

    assert client.get("/v1/rtsp/capabilities").status_code == 401
    response = client.get("/v1/rtsp/capabilities", headers=AUTH)

    assert response.status_code == 200
    assert response.json() == {"configured": True, "label": "Backend RTSP camera"}
    assert "10.0.0.8" not in response.text
    assert "secret" not in response.text


def test_stop_sets_event_and_status_remains_observable() -> None:
    client = TestClient(app)
    entry = _active_entry()
    with rtsp_api._lock:
        rtsp_api._active["sess-stop"] = entry

    response = client.post(
        "/v1/rtsp/stop",
        headers=AUTH,
        json={"session_id": "sess-stop"},
    )

    assert response.status_code == 200
    assert entry["stop_event"].is_set()
    status = client.get("/v1/rtsp/status/sess-stop", headers=AUTH).json()
    assert status["status"] == "stopping"
    assert status["running"] is True


def test_completed_status_is_retained_for_final_flush_poll() -> None:
    client = TestClient(app)
    with rtsp_api._lock:
        rtsp_api._recent["sess-done"] = {
            "session_id": "sess-done",
            "mode": "workshop",
            "status": "complete",
            "running": False,
            "engagement": {"window": {"last_window": {"state": "reported"}}},
        }

    response = client.get("/v1/rtsp/status/sess-done", headers=AUTH)

    assert response.status_code == 200
    assert response.json()["running"] is False
    assert response.json()["engagement"]["window"]["last_window"]["state"] == "reported"


def test_start_rejects_unrecognised_mode_before_spawning_worker() -> None:
    client = TestClient(app)
    response = client.post(
        "/v1/rtsp/start",
        headers=AUTH,
        json={"session_id": "sess-bad", "mode": "attendance"},
    )

    assert response.status_code == 422
    assert rtsp_api._active == {}


@pytest.mark.parametrize(
    ("writer", "body", "expected_status"),
    [
        (_SessionWriter("lecture"), {"session_id": "sess-exam", "mode": "exam"}, 409),
        (
            _SessionWriter("workshop", ended=True),
            {"session_id": "sess-workshop", "mode": "workshop"},
            409,
        ),
    ],
)
def test_start_rejects_wrong_mode_or_ended_session(
    monkeypatch, writer, body, expected_status
) -> None:
    monkeypatch.setattr(rtsp_api.settings, "rtsp_url", "rtsp://camera.invalid/live")
    monkeypatch.setattr(rtsp_api, "require_supabase_writer", lambda: writer)
    client = TestClient(app)

    response = client.post("/v1/rtsp/start", headers=AUTH, json=body)

    assert response.status_code == expected_status
    assert writer.closed is True
    assert rtsp_api._active == {}
