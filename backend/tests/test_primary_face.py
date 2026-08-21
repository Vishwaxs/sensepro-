"""Enrolment uses primary-face (max_num=1) detection, so it enrols the single
main subject even when the detector reports extra boxes. (SCRFD over-fires on
very high-res single portraits; app.get(max_num=1) returns just the main face.)"""

from __future__ import annotations

import cv2
import numpy as np

from enroll.pipeline import Enroller
from vision.stub import StubDetector


def _frame_two_markers() -> np.ndarray:
    img = np.full((240, 320, 3), 255, dtype=np.uint8)
    cv2.rectangle(img, (40, 60), (150, 200), (0, 0, 255), -1)  # large marker (primary)
    cv2.rectangle(img, (250, 30), (300, 80), (255, 0, 0), -1)  # small marker
    noise = np.random.randint(0, 50, (240, 320, 3), dtype=np.uint8)
    return cv2.add(img, noise)


def test_stub_detect_max_num_limits_to_primary():
    det = StubDetector()
    fr = _frame_two_markers()
    assert len(det.detect(fr)) == 2  # all faces by default (live capture)
    top = det.detect(fr, max_num=1)
    assert len(top) == 1  # only the primary
    assert (top[0].x2 - top[0].x1) * (top[0].y2 - top[0].y1) > 100 * 100  # the larger one


def test_enroller_enrolls_primary_face_despite_extra_boxes():
    # Raw detect sees 2 faces and would reject (len != 1); primary-face detection
    # enrols the single main subject.
    recs = Enroller(degrade=False).enroll_frames_detailed([_frame_two_markers()])
    assert len(recs) >= 1
