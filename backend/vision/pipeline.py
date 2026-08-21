"""Per-session vision pipeline.

detect (every frame) -> track (every frame) -> re-identify (per track, on an
interval) -> drive the presence FSM. One SessionPipeline per active class
session, but the InsightFace model itself is a process-wide singleton (see
build_backend) — loading the ~300MB pack once instead of per session avoids
freezing the event loop for 5-10s on every new capture connection.
"""

from __future__ import annotations

import os
import threading

import numpy as np

from presence.attendance import CumulativeAttendance
from presence.fsm import PresenceFSM
from vision.embedding_store import EmbeddingStore
from vision.tracker import IoUTracker
from vision.types import Track

_insightface_singleton = None
_singleton_lock = threading.Lock()


def configured_backend() -> str:
    """The vision backend that SHOULD be running: "stub" or "insightface".

    Live env var first (so a per-process override and monkeypatch.setenv both
    still work), then backend/.env via settings. Same precedence pydantic-settings
    uses, just evaluated at call time instead of import time. /healthz compares
    this against what actually loaded, so the two must resolve identically.
    """
    from app.config import settings

    return (os.getenv("VISION_BACKEND") or settings.vision_backend or "stub").lower()


def build_backend():
    """Factory selected by VISION_BACKEND (stub | insightface).

    Resolved through app.config.settings, so `VISION_BACKEND=insightface` in
    backend/.env works — exactly like every other setting. A real process env
    var still wins, because pydantic-settings ranks the environment above .env,
    so `VISION_BACKEND=stub uvicorn ...` and the CI default both still hold.

    This used to read os.getenv directly and ignore .env entirely, which was a
    silent, total failure of recognition: /healthz reported "insightface" (it
    reads settings) while the pipeline actually built the 64-dim StubEmbedder.
    Against a real 512-dim pgvector gallery, the first frame containing a face
    raised a matmul dimension error inside the WebSocket handler, killing the
    capture socket with a 1006 and leaving the kiosk stuck on OFFLINE forever.

    The insightface backend is a process-wide singleton, ideally warmed once at
    startup (see app/main.py's lifespan) rather than lazily on the first
    session. Sharing one InsightFaceBackend across concurrent sessions is safe
    because it keeps its per-call state thread-local, not on self — see
    insightface_backend.py."""
    backend = configured_backend()
    if backend == "insightface":
        global _insightface_singleton
        if _insightface_singleton is None:
            with _singleton_lock:
                if _insightface_singleton is None:
                    from app.config import settings
                    from vision.insightface_backend import InsightFaceBackend

                    _insightface_singleton = InsightFaceBackend(
                        det_size=settings.det_size,
                        det_thresh=settings.det_thresh,
                        min_face_px=settings.min_face_px,
                    )
        return (
            _insightface_singleton,
            _insightface_singleton,
        )  # detector, embedder are the same object
    from vision.stub import StubDetector, StubEmbedder

    return StubDetector(), StubEmbedder()


class SessionPipeline:
    def __init__(
        self,
        store: EmbeddingStore,
        reid_interval_s: float = 30.0,
        miss_threshold: int = 3,
        attendance_threshold: int = 3,
        max_reid_per_frame: int = 5,
    ) -> None:
        self.detector, self.embedder = build_backend()
        self.tracker = IoUTracker()
        self.store = store
        self.fsm = PresenceFSM(miss_threshold=miss_threshold)
        self.attendance = CumulativeAttendance(threshold=attendance_threshold)
        self.reid_interval_s = reid_interval_s
        # ArcFace costs ~134 ms per face (measured, CPU). A full classroom is
        # ~25 tracks, so embedding every due track in one frame is a ~3.4 s
        # blocking pass — at 1 fps that stalls the capture socket and lets
        # frames pile up behind it. Cap the per-frame embedding work instead:
        # the same total work spreads over a few frames, each returning in
        # roughly its budget, and nothing queues. Unidentified tracks are
        # always served first, so a newly-seen face is still named within a
        # second or two rather than waiting a whole re-ID interval.
        self.max_reid_per_frame = max(1, max_reid_per_frame)
        self._last_reid_pass = -1e9
        self.last_tracks: list[Track] = []

    def process_frame(self, frame_bgr: np.ndarray, ts: float) -> dict:
        dets = self.detector.detect(frame_bgr)
        tracks = self.tracker.update(dets)
        # Exposed for frame observers (proctor/engagement) so they can reuse
        # this frame's tracks instead of re-running detection.
        self.last_tracks = tracks

        # Identify any track with no identity yet immediately, rather than
        # waiting for the next periodic re-ID pass — otherwise a track that
        # just appeared (e.g. a new track after the previous one was lost)
        # reads "unknown" for up to reid_interval_s. Tracked in
        # reidentified_this_frame so the do_reid pass below never re-embeds
        # the same track on the same frame (that would double-count the
        # sighting in self.attendance, not just waste a match).
        reidentified_this_frame: set[int] = set()
        budget = self.max_reid_per_frame
        for tr in tracks:
            if tr.student_id is None:
                if budget <= 0:
                    break  # next frame picks it up — it is still unidentified
                vec = self.embedder.embed(frame_bgr, tr.det)
                sid, score = self.store.match(vec)
                tr.student_id, tr.match_score, tr.last_reid_ts = sid, score, ts
                reidentified_this_frame.add(tr.track_id)
                budget -= 1
                if sid is not None:
                    self.attendance.observe(sid, score, ts)

        do_reid = (ts - self._last_reid_pass) >= self.reid_interval_s
        transitions: list[tuple[str, str]] = []
        if do_reid:
            for tr in tracks:
                if budget <= 0:
                    break  # remaining tracks stay due; the next frame continues
                if tr.track_id in reidentified_this_frame:
                    continue
                if (tr.last_reid_ts is None) or (ts - tr.last_reid_ts >= self.reid_interval_s):
                    vec = self.embedder.embed(frame_bgr, tr.det)
                    sid, score = self.store.match(vec)
                    tr.student_id, tr.match_score, tr.last_reid_ts = sid, score, ts
                    budget -= 1
                    if sid is not None:
                        self.attendance.observe(sid, score, ts)
            # FSM runs on every pass regardless of how many tracks were
            # re-embedded this frame: `seen` is built from the identities the
            # tracks already carry, which persist across frames, so throttling
            # the embedding work never makes a present student look absent.
            seen = {t.student_id for t in tracks if t.student_id}
            transitions = self.fsm.observe(seen, self.store.roster, ts)
            self._last_reid_pass = ts

        return {
            "type": "result",
            "ts": ts,
            "faces": [self._face_json(t) for t in tracks],
            "transitions": [{"student_id": s, "state": st} for s, st in transitions],
            "present": sorted(s for s in self.store.roster if self.fsm.state_of(s) == "PRESENT"),
            "attended": sorted(self.attendance.attended_ids()),
        }

    @staticmethod
    def _face_json(t: Track) -> dict:
        x1, y1, x2, y2 = t.det.box
        return {
            "track_id": t.track_id,
            "box": [x1, y1, x2, y2],
            "student_id": t.student_id,
            "score": round(t.match_score, 3),
        }
