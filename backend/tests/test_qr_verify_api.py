"""On-phone selfie verification endpoint tests (fake writer, stub vision, no net).

Most tests monkeypatch the probe embedding so the match/no-match logic is
deterministic; two exercise the real stub embedder end to end."""

from __future__ import annotations

import tempfile
from datetime import datetime, timedelta, timezone

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

import app.qr_api as qr
from app.main import app

client = TestClient(app)

STUDENT = {"id": "stud-1", "reg_no": "2547201", "class_section": "CS-401"}
SESSION = {"id": "sess-1", "class_section": "CS-401", "mode": "lecture"}
TEMPLATE = [{"student_id": "stud-1", "vec": [1.0, 0.0]}]
_UNSET = object()


@pytest.fixture(autouse=True)
def _clear_rate_limit():
    qr._claim_hits.clear()
    yield
    qr._claim_hits.clear()


def _future(sec: int = 30) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=sec)).isoformat()


def _past(sec: int = 30) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=sec)).isoformat()


def _window(**kw) -> dict:
    w = {
        "id": "win-1",
        "session_id": "sess-1",
        "student_id": "stud-1",
        "expires_at": _future(),
        "satisfied_at": None,
    }
    w.update(kw)
    return w


def _marker() -> np.ndarray:
    """Saturated red block (a 'face' for the stub) + noise for blur-gate texture."""
    img = np.full((240, 320, 3), 255, dtype=np.uint8)
    cv2.rectangle(img, (130, 90), (190, 170), (0, 0, 255), -1)
    noise = np.random.randint(0, 50, (240, 320, 3), dtype=np.uint8)
    return cv2.add(img, noise)


def _jpeg() -> bytes:
    ok, buf = cv2.imencode(".jpg", _marker())
    assert ok
    return buf.tobytes()


class FakeVerifyWriter:
    def __init__(
        self, *, student=STUDENT, window=_UNSET, templates=None, session=SESSION, satisfy_ok=True
    ):
        self.student = student
        self.window = _window() if window is _UNSET else window
        self.templates = [] if templates is None else templates
        self.session = session
        self.satisfy_ok = satisfy_ok
        self.satisfied: list = []
        self.presence: list = []
        self.audits: list = []
        self.closed = False

    def student_by_auth_uid(self, auth_uid):
        return self.student

    def get_window(self, window_id):
        return self.window

    def active_session(self, session_id):
        return self.session

    def student_templates(self, student_id):
        return self.templates

    def satisfy_window(self, window_id):
        self.satisfied.append(window_id)
        return self.satisfy_ok

    def write_qr_presence(self, session_id, student_id, at):
        self.presence.append(student_id)

    def append_audit(self, actor, action, payload):
        self.audits.append((action, payload))

    def close(self):
        self.closed = True


def _patch(monkeypatch, writer, *, uid="uid-1", probe=_UNSET):
    monkeypatch.setattr("app.qr_api.require_supabase_writer", lambda: writer)
    monkeypatch.setattr("app.qr_api._verify_user", lambda auth: uid)
    if probe is not _UNSET:
        monkeypatch.setattr("app.qr_api._embed_probe", lambda img: probe)


def _verify(window_id="win-1", body=None, ctype="image/jpeg"):
    files = {"selfie": ("s.jpg", body if body is not None else _jpeg(), ctype)}
    return client.post(
        "/v1/qr/verify",
        data={"window_id": window_id},
        files=files,
        headers={"Authorization": "Bearer x"},
    )


# --- happy path: match / no-match --------------------------------------------
def test_match_marks_present(monkeypatch):
    writer = FakeVerifyWriter(templates=TEMPLATE)
    _patch(monkeypatch, writer, probe=[1.0, 0.0])
    r = _verify()
    assert r.status_code == 200
    body = r.json()
    assert body["verified"] is True
    assert writer.satisfied == ["win-1"]
    assert writer.presence == ["stud-1"]
    assert any(a[0] == "qr_verified" and a[1]["via"] == "selfie" for a in writer.audits)
    assert writer.closed is True


def test_no_match_writes_nothing(monkeypatch):
    writer = FakeVerifyWriter(templates=TEMPLATE)
    _patch(monkeypatch, writer, probe=[0.0, 1.0])  # orthogonal -> cosine 0 < threshold
    r = _verify()
    assert r.status_code == 200
    assert r.json()["verified"] is False
    assert writer.satisfied == [] and writer.presence == []


# --- window / session guards -------------------------------------------------
def test_window_of_another_student_rejected(monkeypatch):
    writer = FakeVerifyWriter(window=_window(student_id="stud-2"), templates=TEMPLATE)
    _patch(monkeypatch, writer, probe=[1.0, 0.0])
    assert _verify().status_code == 403


def test_unknown_window(monkeypatch):
    writer = FakeVerifyWriter(window=None, templates=TEMPLATE)
    _patch(monkeypatch, writer, probe=[1.0, 0.0])
    assert _verify().status_code == 404


def test_expired_window(monkeypatch):
    writer = FakeVerifyWriter(window=_window(expires_at=_past()), templates=TEMPLATE)
    _patch(monkeypatch, writer, probe=[1.0, 0.0])
    assert _verify().status_code == 410


def test_already_satisfied(monkeypatch):
    writer = FakeVerifyWriter(window=_window(satisfied_at=_past()), templates=TEMPLATE)
    _patch(monkeypatch, writer, probe=[1.0, 0.0])
    assert _verify().status_code == 409


def test_session_ended(monkeypatch):
    writer = FakeVerifyWriter(session=None, templates=TEMPLATE)
    _patch(monkeypatch, writer, probe=[1.0, 0.0])
    assert _verify().status_code == 409


# --- identity / enrolment guards ---------------------------------------------
def test_not_a_student(monkeypatch):
    writer = FakeVerifyWriter(student=None)
    _patch(monkeypatch, writer, probe=[1.0, 0.0])
    assert _verify().status_code == 403


def test_no_enrolment_on_file(monkeypatch):
    writer = FakeVerifyWriter(templates=[])
    _patch(monkeypatch, writer, probe=[1.0, 0.0])
    assert _verify().status_code == 422


def test_no_face_detected(monkeypatch):
    writer = FakeVerifyWriter(templates=TEMPLATE)
    _patch(monkeypatch, writer, probe=None)
    assert _verify().status_code == 422


# --- concurrency / abuse / config --------------------------------------------
def test_satisfy_race_lost_writes_no_presence(monkeypatch):
    writer = FakeVerifyWriter(templates=TEMPLATE, satisfy_ok=False)
    _patch(monkeypatch, writer, probe=[1.0, 0.0])
    r = _verify()
    assert r.status_code == 409
    assert writer.satisfied == ["win-1"]  # attempted
    assert writer.presence == []  # another satisfier won -> no double presence


def test_rate_limited(monkeypatch):
    writer = FakeVerifyWriter(templates=TEMPLATE)
    _patch(monkeypatch, writer, probe=[1.0, 0.0])
    for _ in range(qr.CLAIM_RATE_MAX):
        assert _verify().status_code == 200
    assert _verify().status_code == 429


def test_oversize_selfie_rejected(monkeypatch):
    writer = FakeVerifyWriter(templates=TEMPLATE)
    _patch(monkeypatch, writer, probe=[1.0, 0.0])
    monkeypatch.setattr("app.qr_api.MAX_SELFIE_BYTES", 4)
    assert _verify().status_code == 400


def test_unreadable_image_rejected(monkeypatch):
    writer = FakeVerifyWriter(templates=TEMPLATE)
    _patch(monkeypatch, writer, probe=[1.0, 0.0])
    assert _verify(body=b"not-an-image").status_code == 400


def test_unconfigured_returns_503(monkeypatch):
    from app.store import SupabaseNotConfigured

    def _raise():
        raise SupabaseNotConfigured("nope")

    monkeypatch.setattr("app.qr_api.require_supabase_writer", _raise)
    monkeypatch.setattr("app.qr_api._verify_user", lambda auth: "uid-1")
    assert _verify().status_code == 503


def test_selfie_is_not_persisted(monkeypatch):
    """The verify path must never write the image to disk (no temp file)."""
    writer = FakeVerifyWriter(templates=TEMPLATE)
    _patch(monkeypatch, writer, probe=[1.0, 0.0])

    def _boom(*a, **k):
        raise AssertionError("verify must not create a temp file")

    monkeypatch.setattr(tempfile, "mkstemp", _boom)
    assert _verify().status_code == 200


# --- real stub embedder (proves the detect+embed wiring) ---------------------
def test_real_stub_embed_returns_vector():
    v = qr._embed_probe(_marker())
    assert v is not None and len(v) > 0
