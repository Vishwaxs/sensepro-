"""Production vision backend: InsightFace (SCRFD detector + ArcFace embedder).

Imported lazily and only when VISION_BACKEND=insightface, so the stub path has
zero heavy dependencies. Install with:  pip install -e '.[insightface]'

NOTE (CLAUDE.md invariant): no training here. We load the pretrained buffalo_l
pack and compute embeddings only.
"""

from __future__ import annotations

import threading

import numpy as np

from vision.types import Detection

EMB_DIM = 512


class InsightFaceBackend:
    """A single instance is shared process-wide (see vision/pipeline.py's
    singleton) so the ~300MB model pack loads once instead of per session.

    detect() and embed() are called back-to-back for one frame inside a single
    run_in_threadpool call, so they always run on the SAME OS thread for a
    given session — but two sessions' frames can run concurrently on
    DIFFERENT threads. The per-call face list is therefore kept thread-local
    rather than on self, so one session's embed() can never read another
    session's detect() output."""

    def __init__(
        self,
        det_size: int = 640,
        det_thresh: float = 0.5,
        min_face_px: int = 0,
    ) -> None:
        from insightface.app import FaceAnalysis  # lazy

        # Load ONLY the two nets this pipeline reads. buffalo_l also ships
        # genderage and two landmark models that FaceAnalysis runs on every
        # face by default, at a real per-frame cost we never use — the 5-point
        # kps used for head pose come from the detector, so they survive this.
        self.app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition"])
        self.app.prepare(ctx_id=0, det_size=(det_size, det_size), det_thresh=det_thresh)
        self._min_face_px = min_face_px
        self._local = threading.local()

    def detect(self, frame_bgr: np.ndarray, max_num: int = 0) -> list[Detection]:
        # max_num=0 -> all faces (live capture); max_num=1 -> the single main
        # subject (enrolment). SCRFD over-fires on very high-res single portraits;
        # app.get's max_num post-processing returns just the primary face.
        faces = self.app.get(frame_bgr, max_num=max_num)
        self._local.faces_cache = faces
        dets: list[Detection] = []
        for f in faces:
            x1, y1, x2, y2 = f.bbox
            face_h = abs(y2 - y1)
            if self._min_face_px > 0 and face_h < self._min_face_px:
                continue
            lmk = [(float(p[0]), float(p[1])) for p in getattr(f, "kps", [])]
            dets.append(
                Detection(
                    float(x1),
                    float(y1),
                    float(x2),
                    float(y2),
                    score=float(f.det_score),
                    landmarks=lmk,
                )
            )
        return dets

    def embed(self, frame_bgr: np.ndarray, det: Detection) -> np.ndarray:
        # Match the detection back to this THREAD's most recent detect() call
        # (see class docstring — never a shared/self-owned cache).
        faces = getattr(self._local, "faces_cache", [])
        best, best_d = None, 1e9
        for f in faces:
            fx = (f.bbox[0] + f.bbox[2]) / 2
            fy = (f.bbox[1] + f.bbox[3]) / 2
            cx = (det.x1 + det.x2) / 2
            cy = (det.y1 + det.y2) / 2
            d = (fx - cx) ** 2 + (fy - cy) ** 2
            if d < best_d:
                best, best_d = f, d
        if best is None:
            return np.zeros(EMB_DIM, dtype=np.float32)
        v = np.asarray(best.normed_embedding, dtype=np.float32)
        return v
