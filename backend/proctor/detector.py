"""Object detection for exam-mode proctoring, behind the same kind of
abstraction as the vision backends: a protocol, a deterministic stub for
dev/CI, and the real pretrained model behind a lazy import. No training —
YOLOv8n ships with COCO weights and we only read two of its classes.

Stub convention (mirrors vision/stub.py's colour markers): a saturated BLUE
block is a "cell phone", a saturated GREEN block is a "person". The vision
stub treats any saturated block as a face, so proctor tests hand the engine
their tracks explicitly rather than routing markers through both stubs.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol

import cv2
import numpy as np

# COCO class names, hue centres for the stub markers (OpenCV hue is 0-179:
# blue = 120, green = 60; the vision stub's red face marker = 0 matches neither).
_STUB_MARKERS = (("cell phone", 120), ("person", 60))
_COCO_PERSON_CLASS = 0
_COCO_PHONE_CLASS = 67
_YOLO_CLASSES = (_COCO_PERSON_CLASS, _COCO_PHONE_CLASS)


@dataclass(frozen=True)
class DetectorMetadata:
    """Operational identity surfaced to session/health integrations."""

    backend_name: str
    ready: bool
    model_name: str
    production: bool


@dataclass(frozen=True)
class ObjectDetection:
    label: str  # COCO name: "cell phone" | "person"
    box: tuple[int, int, int, int]  # x1, y1, x2, y2
    confidence: float


class ObjectDetector(Protocol):
    metadata: DetectorMetadata

    def detect(self, frame_bgr: np.ndarray) -> list[ObjectDetection]: ...


class StubProctorDetector:
    """Deterministic, dependency-free: colour markers stand in for objects."""

    def __init__(self, min_area: int = 400, hue_tol: int = 15) -> None:
        self.min_area = min_area
        self.hue_tol = hue_tol
        self.metadata = DetectorMetadata(
            backend_name="stub",
            ready=True,
            model_name="colour-marker-test-double",
            production=False,
        )

    def detect(self, frame_bgr: np.ndarray) -> list[ObjectDetection]:
        hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
        hue = hsv[:, :, 0].astype(int)
        saturated = hsv[:, :, 1] > 120
        out: list[ObjectDetection] = []
        for label, centre in _STUB_MARKERS:
            mask = ((np.abs(hue - centre) <= self.hue_tol) & saturated).astype(np.uint8)
            contours, _ = cv2.findContours(mask * 255, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for c in contours:
                if cv2.contourArea(c) < self.min_area:
                    continue
                x, y, w, h = cv2.boundingRect(c)
                out.append(ObjectDetection(label, (x, y, x + w, y + h), 0.9))
        return out


def _weights_path() -> str:
    """Absolute path to the YOLO weights, under a writable cache directory.

    Order: PROCTOR_MODEL_PATH (explicit, what the deploy sets), else
    <YOLO_CACHE_DIR or ~/.cache/sensepro>/yolov8n.pt. Ultralytics downloads to
    this path if it is missing, so a warm image simply finds it already there.
    """
    explicit = os.getenv("PROCTOR_MODEL_PATH")
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    cache = os.getenv("YOLO_CACHE_DIR") or os.path.join(
        os.path.expanduser("~"), ".cache", "sensepro"
    )
    os.makedirs(cache, exist_ok=True)
    return os.path.abspath(os.path.join(cache, "yolov8n.pt"))


# YOLO's predictor mutates internal state while running. A process-wide model
# handle and lock both avoid duplicate weight loads and keep concurrent camera
# sessions from entering the shared predictor at the same time.
_YOLO_MODEL_CACHE: dict[str, tuple[Any, threading.Lock]] = {}
_YOLO_CACHE_LOCK = threading.Lock()


def _shared_yolo_model(model_path: str) -> tuple[Any, threading.Lock]:
    with _YOLO_CACHE_LOCK:
        cached = _YOLO_MODEL_CACHE.get(model_path)
        if cached is not None:
            return cached

        from ultralytics import YOLO  # lazy: stub/test paths never need it

        loaded = (YOLO(model_path), threading.Lock())
        _YOLO_MODEL_CACHE[model_path] = loaded
        return loaded


class YoloProctorDetector:
    """Pretrained YOLOv8n (COCO) filtered to the two labels proctoring needs.
    Lazy import keeps ultralytics optional: pip install -e '.[proctor]'."""

    LABELS = frozenset({"cell phone", "person"})

    def __init__(
        self,
        model_path: str | None = None,
        conf: float = 0.35,
        phone_conf: float = 0.40,
        person_conf: float = 0.45,
    ) -> None:
        # Resolve to an ABSOLUTE path under a writable cache dir. Ultralytics
        # treats a bare "yolov8n.pt" as relative to the CWD and downloads it
        # there on first use — which in a container means re-fetching 6 MB on
        # every cold start, a hard failure if the working directory is
        # read-only, and a ~45 s stall on the first exam session while it
        # downloads. PROCTOR_MODEL_PATH lets the deploy bake the weights in at
        # build time (see render.yaml) so runtime never reaches the network.
        resolved_path = os.path.abspath(model_path or _weights_path())
        self._model, self._predict_lock = _shared_yolo_model(resolved_path)
        self._conf = conf
        self._phone_conf = max(conf, phone_conf)
        self._person_conf = max(conf, person_conf)
        self.metadata = DetectorMetadata(
            backend_name="yolo",
            ready=True,
            model_name=resolved_path,
            production=True,
        )

    def detect(self, frame_bgr: np.ndarray) -> list[ObjectDetection]:
        with self._predict_lock:
            result = self._model.predict(
                frame_bgr,
                verbose=False,
                conf=self._conf,
                classes=list(_YOLO_CLASSES),
                iou=0.50,
                max_det=64,
            )[0]
        out: list[ObjectDetection] = []
        for b in result.boxes:
            class_id = int(np.asarray(b.cls).reshape(-1)[0])
            if class_id not in _YOLO_CLASSES:
                continue
            label = result.names[class_id]
            if label not in self.LABELS:
                continue
            confidence = float(np.asarray(b.conf).reshape(-1)[0])
            coords = np.asarray(b.xyxy[0], dtype=float).reshape(-1)
            detection = self._validated_detection(
                label, coords, confidence, frame_bgr.shape[:2]
            )
            if detection is not None:
                out.append(detection)
        return out

    def _validated_detection(
        self,
        label: str,
        coords: np.ndarray,
        confidence: float,
        frame_shape: tuple[int, int],
    ) -> ObjectDetection | None:
        """Clip and reject implausible COCO boxes before temporal processing."""

        if coords.size != 4 or not np.isfinite(coords).all() or not np.isfinite(confidence):
            return None
        frame_h, frame_w = frame_shape
        if frame_h <= 0 or frame_w <= 0:
            return None
        x1, y1, x2, y2 = coords
        x1 = float(np.clip(x1, 0, frame_w))
        x2 = float(np.clip(x2, 0, frame_w))
        y1 = float(np.clip(y1, 0, frame_h))
        y2 = float(np.clip(y2, 0, frame_h))
        width = x2 - x1
        height = y2 - y1
        if width <= 0 or height <= 0:
            return None

        frame_area = float(frame_w * frame_h)
        box_area = width * height
        aspect = max(width / height, height / width)
        threshold = self._phone_conf if label == "cell phone" else self._person_conf
        if confidence < threshold:
            return None

        if label == "cell phone":
            min_area = max(36.0, frame_area * 0.00001)
            if min(width, height) < 4.0 or box_area < min_area:
                return None
            if box_area > frame_area * 0.18 or aspect > 5.0:
                return None
        else:
            min_area = max(100.0, frame_area * 0.0002)
            if width < 6.0 or height < 10.0 or box_area < min_area or aspect > 6.0:
                return None

        box = (round(x1), round(y1), round(x2), round(y2))
        return ObjectDetection(label, box, confidence)


@lru_cache(maxsize=1)
def _cached_yolo_detector(model_path: str) -> YoloProctorDetector:
    return YoloProctorDetector(model_path=model_path)


def build_proctor_detector() -> ObjectDetector:
    """Factory selected by PROCTOR_BACKEND (stub | yolo); concrete classes are
    never imported outside this module."""
    from app.config import settings

    if settings.proctor_backend.lower() == "yolo":
        return _cached_yolo_detector(_weights_path())
    return StubProctorDetector()
