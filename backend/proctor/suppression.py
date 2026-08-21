"""Pose estimation and conservative temporal gates for exam proctoring.

The estimates in this module are review signals, not automated verdicts. A
five-landmark face supplies an approximate yaw/pitch observation. A separate
per-track monitor requires the pose to remain outside the neutral envelope
before it can create a review candidate, and requires a stable neutral pose
before it can arm again.

``GazeSuppressor`` remains as backward-compatible posture context. The engine
does not let downward pitch veto a temporally confirmed physical phone: posture
and object evidence are separate facts for a human reviewer.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from vision.types import Detection

# Legacy two-eye pitch calibration. This fallback keeps deterministic stub
# and older detector integrations working when only eye landmarks are present.
_LEVEL_EYE_RATIO = 0.40
_DEG_PER_RATIO = 200.0

# Five-landmark approximation constants. These are deliberately conservative
# and bounded; the resulting values are temporal review signals, not clinical
# or geometric measurements.
_LEVEL_NOSE_RATIO = 0.50
_YAW_DEG_PER_EYE_DISTANCE = 60.0
_PITCH_DEG_PER_NOSE_RATIO = 100.0
_MAX_YAW_DEG = 60.0
_MAX_PITCH_DEG = 45.0


@dataclass(frozen=True)
class HeadPoseObservation:
    """Current approximate pose and its temporal classification.

    ``is_away`` means the current sample crosses an away threshold.
    ``sustained`` means it has crossed that threshold for long enough to be a
    review candidate. Both fields remain false on the raw estimator result.
    """

    yaw_deg: float
    pitch_deg: float
    is_away: bool = False
    sustained: bool = False


def estimate_head_pose(det: Detection) -> HeadPoseObservation | None:
    """Estimate yaw and pitch from InsightFace's five landmark layout.

    Landmark order is left eye, right eye, nose, left mouth and right mouth.
    The estimate is rejected when the geometry is incomplete or degenerate;
    missing landmarks must never become evidence of cheating.
    """

    if len(det.landmarks) < 5:
        return None

    points = det.landmarks[:5]
    if not all(math.isfinite(value) for point in points for value in point):
        return None

    left_eye, right_eye, nose, left_mouth, right_mouth = points
    eye_mid = (
        (left_eye[0] + right_eye[0]) / 2.0,
        (left_eye[1] + right_eye[1]) / 2.0,
    )
    mouth_mid = (
        (left_mouth[0] + right_mouth[0]) / 2.0,
        (left_mouth[1] + right_mouth[1]) / 2.0,
    )
    eye_distance = math.hypot(
        right_eye[0] - left_eye[0], right_eye[1] - left_eye[1]
    )
    mouth_distance = math.hypot(
        right_mouth[0] - left_mouth[0], right_mouth[1] - left_mouth[1]
    )
    eye_to_mouth = mouth_mid[1] - eye_mid[1]

    face_width = max(float(det.x2 - det.x1), 1.0)
    face_height = max(float(det.y2 - det.y1), 1.0)
    if (
        eye_distance < max(2.0, 0.12 * face_width)
        or mouth_distance < max(2.0, 0.10 * face_width)
        or eye_to_mouth < max(3.0, 0.18 * face_height)
    ):
        return None

    # A nose far outside the eye-to-mouth region normally indicates corrupt or
    # mismatched landmarks, so do not manufacture a pose observation from it.
    nose_ratio = (nose[1] - eye_mid[1]) / eye_to_mouth
    if not -0.25 <= nose_ratio <= 1.25:
        return None

    yaw_deg = (nose[0] - eye_mid[0]) / eye_distance
    yaw_deg *= _YAW_DEG_PER_EYE_DISTANCE
    pitch_deg = -(nose_ratio - _LEVEL_NOSE_RATIO) * _PITCH_DEG_PER_NOSE_RATIO
    yaw_deg = max(-_MAX_YAW_DEG, min(_MAX_YAW_DEG, yaw_deg))
    pitch_deg = max(-_MAX_PITCH_DEG, min(_MAX_PITCH_DEG, pitch_deg))
    return HeadPoseObservation(yaw_deg=yaw_deg, pitch_deg=pitch_deg)


def estimate_pitch_deg(det: Detection) -> float | None:
    """Return pitch in degrees (negative = down), if landmarks support it.

    Five landmarks use the more stable eye/nose/mouth estimate. Two-landmark
    inputs retain the historical eye-line fallback for compatibility.
    """

    pose = estimate_head_pose(det)
    if pose is not None:
        return pose.pitch_deg
    if len(det.landmarks) < 2:
        return None
    height = det.face_px_height
    if height <= 0:
        return None
    eye_y = (det.landmarks[0][1] + det.landmarks[1][1]) / 2.0
    eye_ratio = (eye_y - det.y1) / height
    return -(eye_ratio - _LEVEL_EYE_RATIO) * _DEG_PER_RATIO


@dataclass
class _PoseState:
    away_since: float | None = None
    neutral_since: float | None = None
    latched: bool = False


class HeadOrientationMonitor:
    """Require sustained off-screen pose and neutral recovery per track.

    Downward pitch is deliberately allowed by default because five landmarks
    cannot distinguish ordinary desk writing from covert gaze. Horizontal yaw
    and upward pitch still capture sustained looking away from the exam view.
    A caller may opt into downward-pitch monitoring explicitly if its setting
    has a different, validated posture policy.
    """

    def __init__(
        self,
        sustain_s: float = 2.0,
        recovery_s: float = 1.0,
        yaw_away_deg: float = 30.0,
        pitch_down_deg: float | None = None,
        pitch_up_deg: float = 25.0,
        neutral_yaw_deg: float = 20.0,
        neutral_pitch_deg: float = 15.0,
    ) -> None:
        self._sustain_s = sustain_s
        self._recovery_s = recovery_s
        self._yaw_away = yaw_away_deg
        self._pitch_down = pitch_down_deg
        self._pitch_up = pitch_up_deg
        self._neutral_yaw = neutral_yaw_deg
        self._neutral_pitch = neutral_pitch_deg
        self._states: dict[int, _PoseState] = {}

    def observe(
        self, track_id: int, pose: HeadPoseObservation, ts: float
    ) -> tuple[HeadPoseObservation, bool]:
        """Return the classified observation and whether it newly sustained."""

        state = self._states.setdefault(track_id, _PoseState())
        down_is_away = (
            self._pitch_down is not None and pose.pitch_deg <= self._pitch_down
        )
        away = (
            abs(pose.yaw_deg) >= self._yaw_away
            or down_is_away
            or pose.pitch_deg >= self._pitch_up
        )
        neutral_pitch = pose.pitch_deg <= self._neutral_pitch
        if self._pitch_down is not None:
            neutral_pitch = neutral_pitch and pose.pitch_deg >= -self._neutral_pitch
        neutral = (
            abs(pose.yaw_deg) <= self._neutral_yaw
            and neutral_pitch
        )
        triggered = False

        if away:
            state.neutral_since = None
            if state.away_since is None:
                state.away_since = ts
            if not state.latched and (ts - state.away_since) >= self._sustain_s:
                state.latched = True
                triggered = True
        elif neutral:
            state.away_since = None
            if state.neutral_since is None:
                state.neutral_since = ts
            if state.latched and (ts - state.neutral_since) >= self._recovery_s:
                state.latched = False
        else:
            # The hysteresis band neither accumulates away time nor clears a
            # latched event. This avoids both threshold jitter and instant
            # re-arming after a single near-neutral sample.
            state.away_since = None
            state.neutral_since = None

        classified = HeadPoseObservation(
            yaw_deg=pose.yaw_deg,
            pitch_deg=pose.pitch_deg,
            is_away=away,
            sustained=away and state.latched,
        )
        return classified, triggered

    def note_missing(self, track_id: int) -> None:
        """Break an in-progress duration when landmarks are unavailable."""

        state = self._states.get(track_id)
        if state is not None:
            state.away_since = None
            state.neutral_since = None

    def retain(self, track_ids: set[int]) -> None:
        """Discard state for tracks no longer in the current frame."""

        self._states = {
            track_id: state
            for track_id, state in self._states.items()
            if track_id in track_ids
        }


class GazeSuppressor:
    """Remember recent downward pitch as backward-compatible posture context.

    ``suppressed`` is retained for engagement experiments and older callers.
    The exam engine intentionally does not use it to discard a phone that has
    already passed detector, attribution and temporal-confirmation gates.
    """

    def __init__(self, window_s: float = 10.0, pitch_down_deg: float = -25.0) -> None:
        self._window = window_s
        self._threshold = pitch_down_deg
        self._last_down: dict[int, float] = {}

    def note_pitch(self, track_id: int, pitch_deg: float, ts: float) -> None:
        if pitch_deg <= self._threshold:
            self._last_down[track_id] = ts

    def suppressed(self, track_id: int, ts: float) -> bool:
        last = self._last_down.get(track_id)
        return last is not None and (ts - last) <= self._window
