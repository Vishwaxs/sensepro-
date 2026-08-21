"""Admin video-enrollment endpoint tests (stub backend, fake writer, no network)."""

from __future__ import annotations

import base64
import json
import os

import cv2
import numpy as np
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _jwt(role: str | None) -> str:
    claims = {"app_role": role} if role is not None else {}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"header.{payload}.sig"


def _admin_headers() -> dict:
    return {"Authorization": f"Bearer {_jwt('admin')}"}


def _marker_frames(n: int) -> list:
    """Saturated red block (a 'face' for the stub) + noise so the crop has
    enough Laplacian texture to pass the enrolment blur gate."""
    frames = []
    for _ in range(n):
        img = np.full((240, 320, 3), 255, dtype=np.uint8)
        cv2.rectangle(img, (130, 90), (190, 170), (0, 0, 255), -1)
        noise = np.random.randint(0, 50, (240, 320, 3), dtype=np.uint8)
        frames.append(cv2.add(img, noise))
    return frames


class FakeWriter:
    def __init__(self, existing: set | None = None):
        self.existing = set(existing or [])
        self.inserted: list = []
        self.deleted: list = []
        self.closed = False

    def assert_source_column(self) -> None:
        pass

    def has_source_rows(self, student_id: str, source: str) -> bool:
        return (student_id, source) in self.existing

    def delete_source_rows(self, student_id: str, source: str) -> int:
        self.deleted.append((student_id, source))
        self.existing.discard((student_id, source))
        return 1

    def insert_embeddings(self, student_id: str, source: str, records: list) -> int:
        self.inserted.append((student_id, source, len(records)))
        return len(records)

    def close(self) -> None:
        self.closed = True


def _patch_writer(monkeypatch, writer: FakeWriter) -> None:
    monkeypatch.setattr("enroll.embeddings_writer.build_embeddings_writer", lambda: writer)


def _patch_frames(monkeypatch, n: int) -> None:
    monkeypatch.setattr(
        "enroll.pipeline.frames_from_video", lambda path, fps=5.0: _marker_frames(n)
    )


def _post(**kw):
    data = {"student_id": kw.get("student_id", "stud-1"), "framing": kw.get("framing", "knee")}
    if "replace" in kw:
        data["replace"] = str(kw["replace"])
    ctype = kw.get("content_type", "video/mp4")
    files = {"video": ("clip.mp4", kw.get("body", b"fake-video"), ctype)}
    headers = kw.get("headers", _admin_headers())
    return client.post("/v1/enroll/video", data=data, files=files, headers=headers)


# --- auth --------------------------------------------------------------------
def test_missing_auth_rejected():
    assert _post(headers={}).status_code == 401


def test_non_admin_rejected():
    r = _post(headers={"Authorization": f"Bearer {_jwt('teacher')}"})
    assert r.status_code == 403


# --- validation --------------------------------------------------------------
def test_invalid_framing_rejected():
    assert _post(framing="face").status_code == 400


def test_wrong_mime_rejected():
    assert _post(content_type="text/plain").status_code == 400


def test_oversize_rejected(monkeypatch):
    monkeypatch.setattr("app.enroll_api.MAX_FILE_BYTES", 4)
    assert _post(body=b"much-larger-than-four-bytes").status_code == 400


def test_over_duration_rejected(monkeypatch):
    _patch_writer(monkeypatch, FakeWriter())
    monkeypatch.setattr("app.enroll_api._video_duration_s", lambda p: 999.0)
    r = _post()
    assert r.status_code == 400
    assert "too long" in r.json()["detail"].lower()


def test_supabase_unconfigured_returns_503(monkeypatch):
    from enroll.embeddings_writer import EmbeddingsWriterError

    def _raise():
        raise EmbeddingsWriterError("not configured")

    monkeypatch.setattr("enroll.embeddings_writer.build_embeddings_writer", _raise)
    assert _post().status_code == 503


# --- idempotency -------------------------------------------------------------
def test_existing_framing_without_replace_conflicts(monkeypatch):
    _patch_writer(monkeypatch, FakeWriter(existing={("stud-1", "video_knee")}))
    assert _post(framing="knee").status_code == 409


def test_existing_other_framing_does_not_block(monkeypatch):
    # A waist enrollment must not block a knee upload.
    writer = FakeWriter(existing={("stud-1", "video_waist")})
    _patch_writer(monkeypatch, writer)
    _patch_frames(monkeypatch, 6)
    r = _post(framing="knee")
    assert r.status_code == 200


# --- happy path --------------------------------------------------------------
def test_framing_tags_source_and_persists(monkeypatch):
    writer = FakeWriter()
    _patch_writer(monkeypatch, writer)
    _patch_frames(monkeypatch, 6)

    r = _post(framing="knee")
    assert r.status_code == 200
    body = r.json()
    assert body["framing"] == "knee"
    assert body["source"] == "video_knee"
    assert body["verdict"] in ("PASS", "RETRY")
    assert body["embeddings_created"] >= 1
    assert isinstance(body["reject_reasons"], dict)
    assert isinstance(body["pose_bins"], list)
    # Exactly one insert, tagged with the framing source, matching the count.
    assert writer.inserted == [("stud-1", "video_knee", body["embeddings_created"])]
    assert writer.deleted == []
    assert writer.closed is True


def test_replace_clears_only_this_framing(monkeypatch):
    writer = FakeWriter(existing={("stud-1", "video_knee"), ("stud-1", "video_waist")})
    _patch_writer(monkeypatch, writer)
    _patch_frames(monkeypatch, 6)

    r = _post(framing="knee", replace=True)
    assert r.status_code == 200
    assert writer.deleted == [("stud-1", "video_knee")]  # waist untouched
    assert ("stud-1", "video_waist") in writer.existing
    assert len(writer.inserted) == 1


def test_temp_video_is_deleted(monkeypatch):
    import app.enroll_api as api

    _patch_writer(monkeypatch, FakeWriter())
    _patch_frames(monkeypatch, 6)

    created: list[str] = []
    real_mkstemp = api.tempfile.mkstemp

    def _rec(*a, **k):
        fd, path = real_mkstemp(*a, **k)
        created.append(path)
        return fd, path

    monkeypatch.setattr(api.tempfile, "mkstemp", _rec)

    r = _post()
    assert r.status_code == 200
    assert created and not os.path.exists(created[0])  # no raw video left on disk
