"""Production-detector boundaries without loading real YOLO weights."""

from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import numpy as np

import proctor.detector as detector_module
from proctor.detector import YoloProctorDetector


class _FakeBox:
    def __init__(self, class_id: int, confidence: float, box: tuple[float, ...]) -> None:
        self.cls = np.array([class_id], dtype=float)
        self.conf = np.array([confidence], dtype=float)
        self.xyxy = np.array([box], dtype=float)


class _FakeYolo:
    loads = 0

    def __init__(self, model_path: str) -> None:
        type(self).loads += 1
        self.model_path = model_path
        self.last_kwargs = {}

    def predict(self, _frame, **kwargs):
        self.last_kwargs = kwargs
        boxes = [
            _FakeBox(0, 0.90, (10, 10, 110, 190)),
            _FakeBox(67, 0.80, (120, 100, 150, 150)),
            _FakeBox(67, 0.39, (170, 100, 200, 150)),  # low confidence
            _FakeBox(67, 0.95, (210, 100, 212, 102)),  # too small
            _FakeBox(67, 0.95, (0, 0, 320, 240)),  # implausibly large
            _FakeBox(2, 0.99, (20, 20, 100, 100)),  # unrelated COCO class
        ]
        names = {0: "person", 2: "car", 67: "cell phone"}
        return [SimpleNamespace(boxes=boxes, names=names)]


def test_yolo_is_cached_class_restricted_and_box_filtered(monkeypatch) -> None:
    fake_ultralytics = ModuleType("ultralytics")
    fake_ultralytics.YOLO = _FakeYolo
    monkeypatch.setitem(sys.modules, "ultralytics", fake_ultralytics)
    monkeypatch.setattr(detector_module, "_YOLO_MODEL_CACHE", {})
    detector_module._cached_yolo_detector.cache_clear()
    _FakeYolo.loads = 0
    weights = str(Path(__file__).with_name("fake-yolov8n.pt"))

    try:
        first = detector_module._cached_yolo_detector(weights)
        second = detector_module._cached_yolo_detector(weights)
        another_wrapper = YoloProctorDetector(model_path=weights)

        assert first is second
        assert first._model is another_wrapper._model
        assert _FakeYolo.loads == 1
        assert first.metadata.backend_name == "yolo"
        assert first.metadata.ready and first.metadata.production

        frame = np.zeros((240, 320, 3), dtype=np.uint8)
        detections = first.detect(frame)
        assert [(d.label, d.box) for d in detections] == [
            ("person", (10, 10, 110, 190)),
            ("cell phone", (120, 100, 150, 150)),
        ]
        assert first._model.last_kwargs["classes"] == [0, 67]
        assert first._model.last_kwargs["conf"] == 0.35
        assert first._model.last_kwargs["iou"] == 0.50
        assert first._model.last_kwargs["max_det"] == 64
    finally:
        detector_module._cached_yolo_detector.cache_clear()
