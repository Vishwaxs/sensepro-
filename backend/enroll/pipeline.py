"""Enrollment (NOT training).

video/frames -> detect -> quality-gate -> pose-bin select -> embed -> purge.
Produces per-student embeddings; raw frames are deleted unless --keep is set.
Target ~10-20 quality frames/student (50 is overkill).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

import cv2
import numpy as np

from vision.pipeline import build_backend
from vision.types import Detection


@dataclass
class GateConfig:
    min_face_px: int = 60
    min_blur_var: float = 40.0  # Laplacian variance; higher = sharper
    min_brightness: int = 40
    max_brightness: int = 220
    per_bin: int = 3  # keep best N per pose bin


@dataclass
class EmbeddingRecord:
    """One enrolled template with the metadata the embeddings table needs.

    ``vec`` is the L2-normalised 512-d embedding; ``pose_bin`` is the horizontal
    bin the source frame fell in (matches the DB CHECK); ``quality`` is the
    Laplacian blur variance of the crop that produced this embedding (a degraded
    variant is blurrier, so it carries a lower value honestly); ``variant`` marks
    provenance ('clean' or 'degrade_<height>')."""

    vec: list[float]
    pose_bin: str
    quality: float
    variant: str


@dataclass
class EnrollReport:
    """Outcome of enrolling a batch of frames, with per-reason reject tallies.

    ``frames_accepted`` counts distinct source frames that passed the gate;
    the number of embeddings (``len(records)``) differs because of the
    per-bin cap and degrade variants."""

    frames_seen: int
    frames_accepted: int
    reject_reasons: dict[str, int]
    pose_bins: list[str]
    records: list[EmbeddingRecord]


def blur_var(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def pose_bin(det: Detection, frame_w: int) -> str:
    cx = (det.x1 + det.x2) / 2
    r = cx / max(1, frame_w)
    if r < 0.40:
        return "left"
    if r > 0.60:
        return "right"
    return "center"


def degrade_crop(
    crop: np.ndarray,
    target_h: int,
    jpeg_quality: int = 40,
    blur_sigma: float = 0.6,
) -> np.ndarray | None:
    """Simulate the board-camera view of an enrolment crop, entirely in memory.

    Downscale the crop to ``target_h`` (keep aspect), re-encode as a low-quality
    JPEG, apply a mild Gaussian blur, then upscale back. Returns a uint8 BGR
    image, or None when the crop is already at/below ``target_h`` (nothing to
    degrade down to). No frame ever touches disk.
    """
    h, w = crop.shape[:2]
    if h <= target_h or w == 0:
        return None
    new_w = max(1, int(round(w * target_h / h)))
    small = cv2.resize(crop, (new_w, target_h), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", small, [int(cv2.IMWRITE_JPEG_QUALITY), int(jpeg_quality)])
    if ok:
        small = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if blur_sigma and blur_sigma > 0:
        small = cv2.GaussianBlur(small, (0, 0), blur_sigma)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)


class Enroller:
    def __init__(
        self,
        cfg: GateConfig | None = None,
        *,
        degrade: bool = True,
        degrade_heights: tuple[int, ...] = (96, 64),
        jpeg_quality: int = 40,
        blur_sigma: float = 0.6,
    ) -> None:
        self.cfg = cfg or GateConfig()
        self.degrade = degrade
        self.degrade_heights = degrade_heights
        self.jpeg_quality = jpeg_quality
        self.blur_sigma = blur_sigma
        self.detector, self.embedder = build_backend()

    def _accept_reason(self, frame: np.ndarray, det: Detection) -> tuple[bool, str]:
        """Gate one detected face; return (accepted, reason). The reason is a
        stable slug so callers can tally why frames were dropped."""
        if det.face_px_height < self.cfg.min_face_px:
            return False, "too_small"
        x1, y1, x2, y2 = det.box
        crop = frame[max(0, y1) : max(1, y2), max(0, x1) : max(1, x2)]
        if crop.size == 0:
            return False, "empty_crop"
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        if blur_var(gray) < self.cfg.min_blur_var:
            return False, "blurry"
        b = float(gray.mean())
        if b < self.cfg.min_brightness:
            return False, "too_dark"
        if b > self.cfg.max_brightness:
            return False, "too_bright"
        return True, "ok"

    def _accept(self, frame: np.ndarray, det: Detection) -> bool:
        return self._accept_reason(frame, det)[0]

    def _detect_embed(self, img: np.ndarray) -> list[float] | None:
        """Detect on ``img`` then embed the single face, L2-normalised.

        Re-detecting immediately before embedding keeps both backends correct:
        InsightFace returns the embedding of the most recently detected face, so
        the detect and embed must run on the same image. Returns None unless
        exactly one face is found and its embedding is non-degenerate.
        """
        dets = self.detector.detect(img)
        if len(dets) != 1:
            return None
        vec = self.embedder.embed(img, dets[0])
        n = float(np.linalg.norm(vec))
        if n <= 0:
            return None
        return (vec / n).astype(float).tolist()

    def enroll_frames_detailed(self, frames: list[np.ndarray]) -> list[EmbeddingRecord]:
        """Return per-template records (vector + pose_bin + quality + variant).

        ``enroll_frames`` is the vectors-only view of this. Candidates are bucketed
        per pose bin and the sharpest ``per_bin`` are embedded clean, then (when
        degrade is on) as board-camera-like degraded variants — clean first, then
        variants, preserving the original output order."""
        # Bucket the best candidates per pose bin by sharpness.
        buckets: dict[str, list[tuple[float, np.ndarray, Detection]]] = {}
        for fr in frames:
            dets = self.detector.detect(fr)
            if len(dets) != 1:  # enrolment expects exactly one face
                continue
            det = dets[0]
            if not self._accept(fr, det):
                continue
            x1, y1, x2, y2 = det.box
            gray = cv2.cvtColor(
                fr[max(0, y1) : max(1, y2), max(0, x1) : max(1, x2)], cv2.COLOR_BGR2GRAY
            )
            buckets.setdefault(pose_bin(det, fr.shape[1]), []).append((blur_var(gray), fr, det))

        records: list[EmbeddingRecord] = []
        for bin_name, cands in buckets.items():
            cands.sort(key=lambda t: t[0], reverse=True)
            for clean_q, fr, det in cands[: self.cfg.per_bin]:
                clean = self._detect_embed(fr)
                if clean is not None:
                    records.append(
                        EmbeddingRecord(
                            vec=clean, pose_bin=bin_name, quality=clean_q, variant="clean"
                        )
                    )
                if not self.degrade:
                    continue
                x1, y1, x2, y2 = det.box
                crop = fr[max(0, y1) : max(1, y2), max(0, x1) : max(1, x2)]
                if crop.size == 0:
                    continue
                for h in self.degrade_heights:
                    variant = degrade_crop(crop, h, self.jpeg_quality, self.blur_sigma)
                    if variant is None:
                        continue
                    emb = self._detect_embed(variant)
                    if emb is None:
                        continue
                    vgray = cv2.cvtColor(variant, cv2.COLOR_BGR2GRAY)
                    records.append(
                        EmbeddingRecord(
                            vec=emb,
                            pose_bin=bin_name,
                            quality=blur_var(vgray),
                            variant=f"degrade_{h}",
                        )
                    )
        return records

    def enroll_frames(self, frames: list[np.ndarray]) -> list[list[float]]:
        """Return a list of L2-normalised embeddings (as lists) for one student."""
        return [r.vec for r in self.enroll_frames_detailed(frames)]

    def enroll_frames_report(self, frames: list[np.ndarray]) -> EnrollReport:
        """Gate every frame with per-reason tallies, then embed the survivors.

        Used by the admin upload endpoint so an operator sees WHY frames were
        dropped (e.g. 'only frontal pose captured — ask them to turn their
        head') rather than a bare count."""
        reasons: Counter[str] = Counter()
        accepted: list[np.ndarray] = []
        for fr in frames:
            dets = self.detector.detect(fr)
            if len(dets) == 0:
                reasons["no_face"] += 1
                continue
            if len(dets) > 1:
                reasons["multiple_faces"] += 1
                continue
            ok, reason = self._accept_reason(fr, dets[0])
            if ok:
                accepted.append(fr)
            else:
                reasons[reason] += 1
        records = self.enroll_frames_detailed(accepted)
        return EnrollReport(
            frames_seen=len(frames),
            frames_accepted=len(accepted),
            reject_reasons=dict(reasons),
            pose_bins=sorted({r.pose_bin for r in records}),
            records=records,
        )


def frames_from_video(path: str, fps: float = 5.0) -> list[np.ndarray]:
    cap = cv2.VideoCapture(path)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(src_fps / fps)))
    frames, i = [], 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step == 0:
            frames.append(frame)
        i += 1
    cap.release()
    return frames


def frames_from_dir(path: str) -> list[np.ndarray]:
    import glob
    import os

    out = []
    for p in sorted(glob.glob(os.path.join(path, "*"))):
        img = cv2.imread(p)
        if img is not None:
            out.append(img)
    return out
