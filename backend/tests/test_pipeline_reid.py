"""SessionPipeline.process_frame's re-identification behavior: a brand-new
track must be identified immediately (not wait for the next periodic re-ID
pass), and that immediate identification must not be double-counted by the
periodic pass running on the same frame (the failure mode a naive port of
"immediate re-ID" would introduce when reid_interval_s is small)."""

from __future__ import annotations

import cv2
import numpy as np

from vision.embedding_store import EmbeddingStore
from vision.pipeline import SessionPipeline
from vision.stub import StubDetector, StubEmbedder


def _marker_frame() -> np.ndarray:
    img = np.full((240, 320, 3), 255, dtype=np.uint8)
    cv2.rectangle(img, (130, 90), (190, 170), (0, 0, 255), -1)
    return img


def _enrolled_store() -> EmbeddingStore:
    frame = _marker_frame()
    det = StubDetector().detect(frame)[0]
    vec = StubEmbedder().embed(frame, det)
    store = EmbeddingStore(threshold=0.45)
    store.add("s1", vec)
    return store


def test_new_track_identified_on_first_frame_not_next_reid_tick(monkeypatch):
    monkeypatch.setenv("VISION_BACKEND", "stub")
    # A long re-ID interval: if identification waited for the periodic pass,
    # the track would still read as unknown on this very first frame.
    pipe = SessionPipeline(store=_enrolled_store(), reid_interval_s=30.0, miss_threshold=3)
    result = pipe.process_frame(_marker_frame(), ts=0.0)
    assert result["faces"][0]["student_id"] == "s1"


def test_immediate_identification_does_not_double_count_on_reid_interval_zero(monkeypatch):
    monkeypatch.setenv("VISION_BACKEND", "stub")
    # reid_interval_s=0.0 makes do_reid true on every frame — exactly the
    # condition under which the periodic pass would re-process a track the
    # immediate pass already identified this same frame, if not guarded.
    pipe = SessionPipeline(store=_enrolled_store(), reid_interval_s=0.0, miss_threshold=3)
    pipe.process_frame(_marker_frame(), ts=0.0)
    assert pipe.attendance.record_of("s1").total_sightings == 1


def test_attendance_threshold_reached_after_correct_number_of_frames(monkeypatch):
    monkeypatch.setenv("VISION_BACKEND", "stub")
    pipe = SessionPipeline(
        store=_enrolled_store(), reid_interval_s=0.0, miss_threshold=3, attendance_threshold=3
    )
    for i, ts in enumerate([0.0, 1.0, 2.0]):
        pipe.process_frame(_marker_frame(), ts=ts)
        if i < 2:
            assert "s1" not in pipe.attendance.attended_ids()
    assert "s1" in pipe.attendance.attended_ids()
    assert pipe.attendance.record_of("s1").total_sightings == 3


def _multi_marker_frame(n: int) -> np.ndarray:
    """A frame with `n` separate red markers, i.e. `n` detectable stub faces."""
    img = np.full((240, 60 * n + 40, 3), 255, dtype=np.uint8)
    for i in range(n):
        x = 20 + 60 * i
        cv2.rectangle(img, (x, 90), (x + 40, 170), (0, 0, 255), -1)
    return img


def test_reid_work_is_capped_per_frame(monkeypatch):
    """A full classroom must not be embedded in one blocking pass.

    ArcFace costs ~134 ms/face on CPU (measured), so embedding 25 due tracks in
    a single frame is a ~3.4 s stall that backs frames up behind the capture
    socket. The pipeline serves at most max_reid_per_frame faces per call; the
    rest stay unidentified and are picked up on the following frames.
    """
    monkeypatch.setenv("VISION_BACKEND", "stub")
    pipe = SessionPipeline(store=_enrolled_store(), reid_interval_s=30.0, max_reid_per_frame=3)

    calls = {"n": 0}
    inner = pipe.embedder.embed

    def counting(frame, det):
        calls["n"] += 1
        return inner(frame, det)

    monkeypatch.setattr(pipe.embedder, "embed", counting)

    frame = _multi_marker_frame(10)
    pipe.process_frame(frame, ts=0.0)
    assert calls["n"] == 3, f"embedded {calls['n']} faces in one frame; budget was 3"

    # Unserved tracks are still unidentified, so the next frame continues work.
    pipe.process_frame(frame, ts=0.5)
    assert calls["n"] == 6
