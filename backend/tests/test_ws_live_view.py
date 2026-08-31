"""The WS result gets a live 'engagement' view (both modes) and a live
'proctor' view (exam mode only) once a session_id is attached — this is the
plumbing the capture UI's exam overlay and engagement panel read. The
underlying proctor/engagement logic has its own unit tests (test_proctor.py,
test_engagement.py); these tests only cover the new WS attachment + mode gate.
"""

from __future__ import annotations

import base64
import json

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app.ws as ws_mod
from app.main import app
from proctor.detector import StubProctorDetector
from tests.conftest import STAFF_WS_TOKEN
from vision.embedding_store import EmbeddingStore
from vision.stub import StubDetector, StubEmbedder


class FakeSessionWriter:
    """No-op writer satisfying every PresenceWriter method the session-attach
    path (recorder, proctor engine, zone aggregator) may call."""

    def __init__(self, persisted_mode: str = "exam", ended: bool = False) -> None:
        self.persisted_mode = persisted_mode
        self.ended = ended
        self.end_calls = []
        self.opened = []
        self.closed = []
        self.qr_closed = 0
        self.writer_closed = 0

    def get_session(self, session_id):
        return {
            "id": session_id,
            "mode": self.persisted_mode,
            "starts_at": "2026-08-31T00:00:00+00:00",
            "ends_at": "2026-08-31T01:00:00+00:00" if self.ended else None,
        }

    def create_session(self, class_section, subject, mode):
        raise AssertionError("ws loop must not create sessions")

    def end_session(self, session_id, ends_at):
        self.end_calls.append((session_id, ends_at))

    def open_interval(self, row):
        self.opened.append(row)

    def close_interval(self, row):
        self.closed.append(row)

    def create_flag(self, row):
        pass

    def create_zone_aggregate(self, row):
        pass

    def open_verification_targets(self, session_id):
        return {}

    def close_open_qr_presence(self, session_id, at):
        self.qr_closed += 1

    def close(self):
        self.writer_closed += 1


def _marker_frame() -> str:
    img = np.full((240, 320, 3), 255, dtype=np.uint8)
    cv2.rectangle(img, (130, 90), (190, 170), (0, 0, 255), -1)
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return base64.b64encode(buf.tobytes()).decode()


def _workshop_phone_frame() -> str:
    img = np.full((240, 320, 3), 255, dtype=np.uint8)
    cv2.rectangle(img, (130, 90), (190, 170), (0, 0, 255), -1)
    cv2.rectangle(img, (205, 145), (245, 185), (255, 0, 0), -1)
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return base64.b64encode(buf.tobytes()).decode()


def _enrolled_store() -> EmbeddingStore:
    frame = np.full((240, 320, 3), 255, dtype=np.uint8)
    cv2.rectangle(frame, (130, 90), (190, 170), (0, 0, 255), -1)
    detection = StubDetector().detect(frame)[0]
    store = EmbeddingStore(threshold=0.45)
    store.add("s1", StubEmbedder().embed(frame, detection))
    return store


def test_lecture_mode_gets_engagement_but_not_proctor(monkeypatch) -> None:
    writer = FakeSessionWriter()
    monkeypatch.setattr(ws_mod, "build_writer", lambda: writer)
    monkeypatch.setattr(ws_mod, "_load_store", lambda: EmbeddingStore())
    client = TestClient(app)
    with client.websocket_connect(
        f"/ws/capture?session_id=sess-live&mode=lecture&token={STAFF_WS_TOKEN}"
    ) as ws:
        ws.send_json({"type": "frame", "ts": 0.0, "jpg_b64": _marker_frame()})
        r = ws.receive_json()
        assert "engagement" in r
        assert "proctor" not in r
        ws.send_json({"type": "end", "ts": 1.0})
        assert ws.receive_json()["type"] == "session_ended"
    assert len(writer.end_calls) == 1
    assert writer.qr_closed == 1
    assert writer.writer_closed == 1


def test_engagement_suppressed_below_k_anonymity_floor(monkeypatch) -> None:
    # One tracked face << k_min=5 -> suppressed, vnei withheld (never estimated).
    monkeypatch.setattr(ws_mod, "build_writer", lambda: FakeSessionWriter())
    monkeypatch.setattr(ws_mod, "_load_store", lambda: EmbeddingStore())
    client = TestClient(app)
    with client.websocket_connect(
        f"/ws/capture?session_id=sess-live2&mode=lecture&token={STAFF_WS_TOKEN}"
    ) as ws:
        ws.send_json({"type": "frame", "ts": 0.0, "jpg_b64": _marker_frame()})
        r = ws.receive_json()
        eng = r["engagement"]
        assert eng["visible"] == 1
        assert eng["k_min"] == 5
        assert eng["suppressed"] is True
        assert eng["vnei"] is None
        ws.send_json({"type": "end", "ts": 1.0})
        ws.receive_json()


def test_exam_mode_gets_both_proctor_and_engagement(monkeypatch) -> None:
    writer = FakeSessionWriter()
    monkeypatch.setattr(ws_mod, "require_supabase_writer", lambda: writer)
    monkeypatch.setattr(ws_mod, "_load_store", lambda: EmbeddingStore())
    monkeypatch.setattr(ws_mod, "build_proctor_detector", StubProctorDetector)
    client = TestClient(app)
    with client.websocket_connect(
        f"/ws/capture?session_id=sess-exam&mode=exam&token={STAFF_WS_TOKEN}"
    ) as ws:
        ws.send_json({"type": "frame", "ts": 0.0, "jpg_b64": _marker_frame()})
        r = ws.receive_json()
        assert "engagement" in r
        assert "proctor" in r
        assert r["proctor"]["detections"] == []  # no phone marker in this frame
        assert r["proctor"]["flags"] == []
        ws.send_json({"type": "end", "ts": 1.0})
        ws.receive_json()
    assert writer.opened == [] and writer.closed == []
    assert writer.qr_closed == 0
    assert len(writer.end_calls) == 1


def test_workshop_measures_phone_without_qr_proctor_or_presence(monkeypatch) -> None:
    writer = FakeSessionWriter(persisted_mode="workshop")
    monkeypatch.setattr(ws_mod, "require_supabase_writer", lambda: writer)
    monkeypatch.setattr(ws_mod, "_load_store", _enrolled_store)
    monkeypatch.setattr(ws_mod, "build_proctor_detector", StubProctorDetector)

    def _attendance_recorder_forbidden(*args, **kwargs):
        raise AssertionError("workshop must not construct the attendance recorder")

    monkeypatch.setattr(ws_mod, "SessionRecorder", _attendance_recorder_forbidden)
    client = TestClient(app)
    with client.websocket_connect(
        f"/ws/capture?session_id=sess-workshop&mode=workshop&token={STAFF_WS_TOKEN}"
    ) as ws:
        ws.send_json({"type": "frame", "ts": 0.0, "jpg_b64": _workshop_phone_frame()})
        result = ws.receive_json()
        assert "proctor" not in result
        assert result["engagement"]["phone"] == 1
        assert result["engagement"]["phone_observed"] == result["engagement"]["visible"]
        assert result["engagement"]["phone_detector"]["ready"] is True
        assert result["faces"][0]["student_id"] is None
        assert result["faces"][0]["score"] == 0.0
        assert result["present"] == [f"participant-{face['track_id']}" for face in result["faces"]]
        assert result["attended"] == [] and result["transitions"] == []
        assert "s1" not in json.dumps(result)
        ws.send_json({"type": "end", "ts": 1.0})
        ws.receive_json()

    assert writer.opened == [] and writer.closed == []
    assert writer.qr_closed == 0
    assert len(writer.end_calls) == 1


def test_no_session_id_gets_neither_view(monkeypatch) -> None:
    monkeypatch.setattr(ws_mod, "_load_store", lambda: EmbeddingStore())
    client = TestClient(app)
    with client.websocket_connect(f"/ws/capture?token={STAFF_WS_TOKEN}") as ws:
        ws.send_json({"type": "frame", "ts": 0.0, "jpg_b64": _marker_frame()})
        r = ws.receive_json()
        assert "engagement" not in r
        assert "proctor" not in r
        ws.send_json({"type": "end", "ts": 1.0})
        ws.receive_json()


def test_exam_socket_requires_a_persisted_session_id() -> None:
    client = TestClient(app)
    with (
        pytest.raises(WebSocketDisconnect) as exc,
        client.websocket_connect(f"/ws/capture?mode=exam&token={STAFF_WS_TOKEN}"),
    ):
        pass
    assert exc.value.code == 1008


@pytest.mark.parametrize(
    ("writer", "mode"),
    [
        (FakeSessionWriter(persisted_mode="lecture"), "exam"),
        (FakeSessionWriter(persisted_mode="workshop", ended=True), "workshop"),
    ],
)
def test_exam_and_workshop_reject_wrong_or_ended_sessions(monkeypatch, writer, mode) -> None:
    monkeypatch.setattr(ws_mod, "require_supabase_writer", lambda: writer)
    client = TestClient(app)
    with (
        pytest.raises(WebSocketDisconnect) as exc,
        client.websocket_connect(
            f"/ws/capture?session_id=sess-invalid&mode={mode}&token={STAFF_WS_TOKEN}"
        ),
    ):
        pass
    assert exc.value.code == 1008
    assert writer.writer_closed == 1
