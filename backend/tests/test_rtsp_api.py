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
