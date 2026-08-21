"""Offline tests for conservative, human-reviewed exam proctor signals."""

from datetime import UTC, datetime

import cv2
import numpy as np

from proctor.detector import ObjectDetection, StubProctorDetector
from proctor.engine import ProctorEngine
from proctor.suppression import (
    GazeSuppressor,
    estimate_head_pose,
    estimate_pitch_deg,
)
from vision.types import Detection, Track

BLUE = (255, 0, 0)  # stub "cell phone"
GREEN = (0, 255, 0)  # stub "person"

# Two-eye landmarks retain the historical writing-posture suppression path.
LEVEL_EYES = [(145.0, 122.0), (175.0, 122.0)]
DOWN_EYES = [(145.0, 134.0), (175.0, 134.0)]

# Five-landmark order: left eye, right eye, nose, mouth corners. These points
# are deterministic geometry for the (130,90)-(190,170) face box.
NEUTRAL_POSE = [
    (145.0, 115.0),
    (175.0, 115.0),
    (160.0, 135.0),
    (148.0, 155.0),
    (172.0, 155.0),
]
YAW_RIGHT_POSE = [*NEUTRAL_POSE[:2], (176.0, 135.0), *NEUTRAL_POSE[3:]]
YAW_LEFT_POSE = [*NEUTRAL_POSE[:2], (144.0, 135.0), *NEUTRAL_POSE[3:]]
DOWN_POSE = [*NEUTRAL_POSE[:2], (160.0, 145.0), *NEUTRAL_POSE[3:]]
UP_POSE = [*NEUTRAL_POSE[:2], (160.0, 125.0), *NEUTRAL_POSE[3:]]


def _frame(
    *blocks: tuple[tuple[int, int, int, int], tuple[int, int, int]]
) -> np.ndarray:
    image = np.full((240, 320, 3), 255, dtype=np.uint8)
    for (x1, y1, x2, y2), colour in blocks:
        cv2.rectangle(image, (x1, y1), (x2, y2), colour, -1)
    return image


def _track(
    landmarks: list[tuple[float, float]] | None = None,
    *,
    track_id: int = 1,
    student_id: str = "s1",
    x_offset: float = 0.0,
) -> Track:
    shifted = [
        (x + x_offset, y) for x, y in (landmarks if landmarks is not None else [])
    ]
    detection = Detection(
        130 + x_offset,
        90,
        190 + x_offset,
        170,
        score=0.99,
        landmarks=shifted,
    )
    return Track(track_id=track_id, det=detection, student_id=student_id)


class FakeFlagWriter:
    def __init__(self) -> None:
        self.flags = []

    def create_flag(self, row) -> None:
        self.flags.append(row)


def _engine(writer: FakeFlagWriter, cooldown_s: float = 30.0) -> ProctorEngine:
    return ProctorEngine(
        detector=StubProctorDetector(),
        suppressor=GazeSuppressor(window_s=10.0, pitch_down_deg=-25.0),
        writer=writer,
        session_id="sess-exam",
        session_start=datetime.now(UTC),
        cooldown_s=cooldown_s,
    )


PHONE_NEAR_TRACK = (((200, 140, 240, 180), BLUE),)


def test_phone_requires_persistence_then_creates_pending_review_flag() -> None:
    writer = FakeFlagWriter()
    engine = _engine(writer)
    frame = _frame(*PHONE_NEAR_TRACK)

    assert engine.observe(frame, [_track(LEVEL_EYES)], 1.0) == []
    assert engine.confirmed_detections == []
    flags = engine.observe(frame, [_track(LEVEL_EYES)], 2.0)

    assert len(flags) == 1 and writer.flags == flags
    assert [d.label for d in engine.confirmed_detections] == ["cell phone"]
    flag = flags[0]
    assert flag.flag_type == "phone"
    assert flag.student_id == "s1"
    assert flag.review_status == "pending"


def test_single_or_stale_phone_observation_never_becomes_candidate() -> None:
    writer = FakeFlagWriter()
    engine = _engine(writer)
    frame = _frame(*PHONE_NEAR_TRACK)

    assert engine.observe(frame, [_track()], 1.0) == []
    assert engine.observe(frame, [_track()], 4.0) == []
    assert engine.confirmed_detections == []
    assert writer.flags == []


def test_duplicate_phone_boxes_in_one_frame_count_as_one_observation() -> None:
    writer = FakeFlagWriter()
    engine = _engine(writer)
    detection = ObjectDetection("cell phone", (200, 140, 240, 180), 0.95)

    flags = engine.observe(
        _frame(), [_track()], 1.0, detections=[detection, detection]
    )
    assert flags == []
    assert engine.confirmed_detections == []
    assert engine.observe(_frame(), [_track()], 1.0, detections=[detection]) == []


def test_writing_posture_does_not_veto_confirmed_phone() -> None:
    writer = FakeFlagWriter()
    engine = _engine(writer)
    frame = _frame(*PHONE_NEAR_TRACK)

    assert engine.observe(frame, [_track(DOWN_EYES)], 1.0) == []
    flags = engine.observe(frame, [_track(DOWN_EYES)], 2.0)

    assert [flag.flag_type for flag in flags] == ["phone"]
    assert flags[0].review_status == "pending"
    assert len(writer.flags) == 1


def test_extra_person_flags_once() -> None:
    writer = FakeFlagWriter()
    frame = _frame(((20, 20, 70, 70), GREEN), ((250, 20, 300, 70), GREEN))
    flags = _engine(writer).observe(frame, [_track()], 1.0)
    assert [flag.flag_type for flag in flags] == ["extra_person"]
    assert flags[0].student_id is None


def test_cooldown_stops_confirmed_phone_reflagging() -> None:
    writer = FakeFlagWriter()
    engine = _engine(writer, cooldown_s=30.0)
    frame = _frame(*PHONE_NEAR_TRACK)

    assert engine.observe(frame, [_track()], 1.0) == []
    assert len(engine.observe(frame, [_track()], 2.0)) == 1
    assert engine.observe(frame, [_track()], 5.0) == []
    assert engine.observe(frame, [_track()], 6.0) == []
    assert engine.observe(frame, [_track()], 40.0) == []
    assert len(engine.observe(frame, [_track()], 41.0)) == 1
    assert len(writer.flags) == 2


def test_face_marker_is_not_a_proctor_object() -> None:
    red_face_only = _frame(((130, 90, 190, 170), (0, 0, 255)))
    assert StubProctorDetector().detect(red_face_only) == []


def test_stub_detector_labels_and_metadata() -> None:
    detector = StubProctorDetector()
    frame = _frame(((10, 10, 60, 60), BLUE), ((100, 100, 150, 150), GREEN))
    detections = detector.detect(frame)
    assert {d.label for d in detections} == {"cell phone", "person"}
    assert {d.confidence for d in detections} == {0.9}
    assert detector.metadata.backend_name == "stub"
    assert detector.metadata.ready
    assert not detector.metadata.production


def test_flag_row_carries_no_verdict_fields() -> None:
    writer = FakeFlagWriter()
    engine = _engine(writer)
    frame = _frame(*PHONE_NEAR_TRACK)
    engine.observe(frame, [_track()], 1.0)
    flags = engine.observe(frame, [_track()], 2.0)
    payload = flags[0].payload()
    assert set(payload) == {
        "id",
        "session_id",
        "student_id",
        "flag_type",
        "flagged_at",
        "review_status",
    }
    assert payload["review_status"] == "pending"


def test_gaze_suppressor_threshold_and_window() -> None:
    suppressor = GazeSuppressor(window_s=10.0, pitch_down_deg=-25.0)
    suppressor.note_pitch(1, -10.0, ts=0.0)
    assert not suppressor.suppressed(1, 1.0)
    suppressor.note_pitch(1, -30.0, ts=2.0)
    assert suppressor.suppressed(1, 11.9)
    assert not suppressor.suppressed(1, 12.1)
    assert not suppressor.suppressed(2, 3.0)


def test_pitch_fallback_and_five_landmark_pose_estimates() -> None:
    assert estimate_pitch_deg(Detection(0, 0, 60, 80, score=1.0)) is None
    level = Detection(130, 90, 190, 170, score=1.0, landmarks=LEVEL_EYES)
    down = Detection(130, 90, 190, 170, score=1.0, landmarks=DOWN_EYES)
    assert abs(estimate_pitch_deg(level)) < 1.0
    assert estimate_pitch_deg(down) < -25.0

    neutral = estimate_head_pose(_track(NEUTRAL_POSE).det)
    yaw_right = estimate_head_pose(_track(YAW_RIGHT_POSE).det)
    yaw_left = estimate_head_pose(_track(YAW_LEFT_POSE).det)
    pitch_down = estimate_head_pose(_track(DOWN_POSE).det)
    assert neutral is not None
    assert abs(neutral.yaw_deg) < 1.0 and abs(neutral.pitch_deg) < 1.0
    assert yaw_right is not None and yaw_right.yaw_deg > 30.0
    assert yaw_left is not None and yaw_left.yaw_deg < -30.0
    assert pitch_down is not None and pitch_down.pitch_deg <= -25.0


def test_neutral_and_brief_natural_head_motion_do_not_flag() -> None:
    writer = FakeFlagWriter()
    engine = _engine(writer)
    blank = _frame()

    assert engine.observe(blank, [_track(NEUTRAL_POSE)], 0.0) == []
    assert engine.observe(blank, [_track(YAW_RIGHT_POSE)], 1.0) == []
    assert engine.pose_observations[1].is_away
    assert engine.observe(blank, [_track(NEUTRAL_POSE)], 1.8) == []
    assert not engine.pose_observations[1].is_away
    assert writer.flags == []


def test_sustained_downward_writing_pose_is_not_head_pose_cheating() -> None:
    writer = FakeFlagWriter()
    engine = _engine(writer)
    blank = _frame()

    assert engine.observe(blank, [_track(DOWN_POSE)], 0.0) == []
    assert engine.observe(blank, [_track(DOWN_POSE)], 2.1) == []
    assert engine.observe(blank, [_track(DOWN_POSE)], 6.0) == []
    observation = engine.pose_observations[1]
    assert observation.pitch_deg <= -25.0
    assert not observation.is_away and not observation.sustained
    assert writer.flags == []


def test_sustained_head_orientation_creates_pending_head_pose_review() -> None:
    writer = FakeFlagWriter()
    engine = _engine(writer)
    blank = _frame()

    assert engine.observe(blank, [_track(YAW_RIGHT_POSE)], 0.0) == []
    assert engine.observe(blank, [_track(YAW_RIGHT_POSE)], 1.0) == []
    flags = engine.observe(blank, [_track(YAW_RIGHT_POSE)], 2.1)

    assert [flag.flag_type for flag in flags] == ["head_pose"]
    assert flags[0].student_id == "s1"
    assert flags[0].review_status == "pending"
    assert engine.pose_observations[1].sustained


def test_sustained_upward_offscreen_orientation_creates_review() -> None:
    writer = FakeFlagWriter()
    engine = _engine(writer)
    blank = _frame()

    assert engine.observe(blank, [_track(UP_POSE)], 0.0) == []
    flags = engine.observe(blank, [_track(UP_POSE)], 2.1)

    assert [flag.flag_type for flag in flags] == ["head_pose"]
    assert engine.pose_observations[1].pitch_deg >= 25.0
    assert engine.pose_observations[1].sustained


def test_missing_landmarks_break_head_pose_duration() -> None:
    writer = FakeFlagWriter()
    engine = _engine(writer)
    blank = _frame()

    assert engine.observe(blank, [_track(YAW_RIGHT_POSE)], 0.0) == []
    assert engine.observe(blank, [_track(YAW_RIGHT_POSE)], 1.5) == []
    assert engine.observe(blank, [_track([])], 2.0) == []
    assert engine.pose_observations == {}
    assert engine.observe(blank, [_track(YAW_RIGHT_POSE)], 3.0) == []
    assert engine.observe(blank, [_track(YAW_RIGHT_POSE)], 4.9) == []
    assert len(engine.observe(blank, [_track(YAW_RIGHT_POSE)], 5.1)) == 1


def test_head_pose_recovers_during_centred_writing_then_rearms() -> None:
    writer = FakeFlagWriter()
    engine = _engine(writer, cooldown_s=3.0)
    blank = _frame()

    engine.observe(blank, [_track(YAW_RIGHT_POSE)], 0.0)
    assert len(engine.observe(blank, [_track(YAW_RIGHT_POSE)], 2.1)) == 1
    assert engine.observe(blank, [_track(YAW_RIGHT_POSE)], 2.5) == []

    # Centred downward posture is an allowed writing state and counts as
    # neutral recovery for the yaw monitor.
    assert engine.observe(blank, [_track(DOWN_POSE)], 3.0) == []
    assert engine.observe(blank, [_track(DOWN_POSE)], 4.1) == []
    assert engine.observe(blank, [_track(YAW_LEFT_POSE)], 5.0) == []
    assert len(engine.observe(blank, [_track(YAW_LEFT_POSE)], 7.1)) == 1
    assert len(writer.flags) == 2


def test_head_pose_duration_is_isolated_per_track() -> None:
    writer = FakeFlagWriter()
    engine = _engine(writer)
    blank = _frame()
    first_away = _track(YAW_RIGHT_POSE)
    first_neutral = _track(NEUTRAL_POSE)
    second_away = _track(
        YAW_LEFT_POSE, track_id=2, student_id="s2", x_offset=100.0
    )
    second_neutral = _track(
        NEUTRAL_POSE, track_id=2, student_id="s2", x_offset=100.0
    )

    assert engine.observe(blank, [first_away, second_neutral], 0.0) == []
    assert engine.observe(blank, [first_neutral, second_away], 1.0) == []
    assert engine.observe(blank, [first_away, second_neutral], 2.0) == []
    assert writer.flags == []


def test_desk_and_hand_reach_attribution_is_bounded() -> None:
    track = _track()
    desk_phone = ObjectDetection("cell phone", (140, 260, 180, 310), 0.95)
    hand_phone = ObjectDetection("cell phone", (220, 180, 260, 230), 0.95)
    far_phone = ObjectDetection("cell phone", (500, 500, 550, 550), 0.95)

    assert ProctorEngine._nearest_track(desk_phone, [track]) is track
    assert ProctorEngine._nearest_track(hand_phone, [track]) is track
    assert ProctorEngine._nearest_track(far_phone, [track]) is None
