"""Turn exam-mode observations into human review-queue items.

This engine assists an invigilator; it never judges. Every candidate event
becomes a ``proctor_flags`` row whose review status is pending, and only a
human can dismiss or uphold it. There is no automatic penalty path here.

Per frame, five face landmarks feed a per-track head-orientation monitor and
writing-posture context. A phone must survive detector filtering, belong to a
plausible nearby face track and persist across frames before it is accepted.
Downward posture never vetoes that physical evidence. A per-key cooldown
prevents a sustained event from flooding review.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.store import PresenceWriter, ProctorFlagRow
from proctor.detector import ObjectDetection, ObjectDetector
from proctor.suppression import (
    GazeSuppressor,
    HeadOrientationMonitor,
    HeadPoseObservation,
    estimate_head_pose,
    estimate_pitch_deg,
)
from vision.types import Track

# A phone belongs to a track when their centres are within this many track
# diagonals. The separate below-face envelope covers a normal desk position.
_ADJACENCY_DIAGONALS = 1.5


def _centre(box: tuple[int, int, int, int]) -> tuple[float, float]:
    x1, y1, x2, y2 = box
    return (x1 + x2) / 2.0, (y1 + y2) / 2.0


@dataclass
class _PhoneEvidence:
    timestamps: list[float]
    box: tuple[int, int, int, int]


@dataclass
class ProctorEngine:
    detector: ObjectDetector
    suppressor: GazeSuppressor
    writer: PresenceWriter
    session_id: str
    session_start: datetime
    cooldown_s: float = 30.0
    phone_confirm_hits: int = 2
    phone_confirm_window_s: float = 2.5
    pose_monitor: HeadOrientationMonitor = field(default_factory=HeadOrientationMonitor)
    confirmed_detections: list[ObjectDetection] = field(default_factory=list, init=False)
    pose_observations: dict[int, HeadPoseObservation] = field(default_factory=dict, init=False)
    _last_flag: dict[tuple[str, int | None], float] = field(default_factory=dict)
    _phone_evidence: dict[int, _PhoneEvidence] = field(default_factory=dict, init=False)

    def observe(
        self,
        frame_bgr,
        tracks: list[Track],
        rel_ts: float,
        detections: list[ObjectDetection] | None = None,
    ) -> list[ProctorFlagRow]:
        """Run one exam-mode pass and return flags actually written.

        Pass ``detections`` to reuse an object-detector pass already run on the
        frame. ``confirmed_detections`` and ``pose_observations`` are replaced
        with this frame's accepted observations after every call.
        """

        self.confirmed_detections = []
        self.pose_observations = {}
        written: list[ProctorFlagRow] = []
        active_track_ids = {track.track_id for track in tracks}

        for track in tracks:
            pose = estimate_head_pose(track.det)
            if pose is None:
                # Retain the historical two-eye pitch path for an older vision
                # integration, but missing five-point geometry cannot produce
                # a head-pose review candidate.
                pitch = estimate_pitch_deg(track.det)
                if pitch is not None:
                    self.suppressor.note_pitch(track.track_id, pitch, rel_ts)
                self.pose_monitor.note_missing(track.track_id)
                continue

            self.suppressor.note_pitch(track.track_id, pose.pitch_deg, rel_ts)
            observation, triggered = self.pose_monitor.observe(track.track_id, pose, rel_ts)
            self.pose_observations[track.track_id] = observation
            if triggered:
                flag = self._flag("head_pose", track, rel_ts)
                if flag is not None:
                    written.append(flag)

        self.pose_monitor.retain(active_track_ids)

        if detections is None:
            detections = self.detector.detect(frame_bgr)

        # At most one phone contributes evidence to a track in one frame.
        # Duplicate overlapping YOLO boxes therefore cannot satisfy temporal
        # confirmation without observations from another frame.
        phones_by_track: dict[int, tuple[ObjectDetection, Track]] = {}
        for detection in detections:
            if detection.label != "cell phone":
                continue
            track = self._nearest_track(detection, tracks)
            if track is None:
                continue
            previous = phones_by_track.get(track.track_id)
            if previous is None or detection.confidence > previous[0].confidence:
                phones_by_track[track.track_id] = (detection, track)

        for detection, track in phones_by_track.values():
            if not self._phone_is_confirmed(detection, track, rel_ts):
                continue
            self.confirmed_detections.append(detection)
            flag = self._phone_candidate(detection, [track], rel_ts)
            if flag is not None:
                written.append(flag)

        self._prune_phone_evidence(active_track_ids, rel_ts)

        n_persons = sum(1 for detection in detections if detection.label == "person")
        if n_persons > len(tracks):
            flag = self._flag("extra_person", None, rel_ts)
            if flag is not None:
                written.append(flag)
        return written

    def _phone_candidate(
        self, detection: ObjectDetection, tracks: list[Track], rel_ts: float
    ) -> ProctorFlagRow | None:
        track = self._nearest_track(detection, tracks)
        # Looking down is compatible with both normal writing and phone use. It
        # is therefore not evidence that can erase a phone which has already
        # passed class/box filters, bounded attribution and temporal confirmation.
        return self._flag("phone", track, rel_ts)

    def _phone_is_confirmed(self, detection: ObjectDetection, track: Track, rel_ts: float) -> bool:
        evidence = self._phone_evidence.get(track.track_id)
        if evidence is None or not self._phone_boxes_compatible(evidence.box, detection.box, track):
            evidence = _PhoneEvidence(timestamps=[], box=detection.box)
            self._phone_evidence[track.track_id] = evidence

        cutoff = rel_ts - self.phone_confirm_window_s
        evidence.timestamps = [ts for ts in evidence.timestamps if ts >= cutoff]
        evidence.box = detection.box

        # A repeated observer call for the same sampled frame must not count as
        # a second temporal observation.
        if not evidence.timestamps or rel_ts > evidence.timestamps[-1]:
            evidence.timestamps.append(rel_ts)

        # Never allow configuration to turn this back into a one-frame gate.
        required_hits = max(2, self.phone_confirm_hits)
        return len(evidence.timestamps) >= required_hits

    def _prune_phone_evidence(self, active_track_ids: set[int], rel_ts: float) -> None:
        cutoff = rel_ts - self.phone_confirm_window_s
        self._phone_evidence = {
            track_id: evidence
            for track_id, evidence in self._phone_evidence.items()
            if track_id in active_track_ids
            and evidence.timestamps
            and evidence.timestamps[-1] >= cutoff
        }

    @staticmethod
    def _phone_boxes_compatible(
        previous: tuple[int, int, int, int],
        current: tuple[int, int, int, int],
        track: Track,
    ) -> bool:
        previous_centre = _centre(previous)
        current_centre = _centre(current)
        shift = math.hypot(
            current_centre[0] - previous_centre[0],
            current_centre[1] - previous_centre[1],
        )
        x1, y1, x2, y2 = track.det.box
        track_diagonal = math.hypot(x2 - x1, y2 - y1)
        return shift <= 1.25 * max(track_diagonal, 1.0)

    def _flag(self, flag_type: str, track: Track | None, rel_ts: float) -> ProctorFlagRow | None:
        key = (flag_type, track.track_id if track else None)
        last = self._last_flag.get(key)
        if last is not None and (rel_ts - last) < self.cooldown_s:
            return None
        row = ProctorFlagRow(
            session_id=self.session_id,
            flag_type=flag_type,
            flagged_at=self.session_start + timedelta(seconds=rel_ts),
            student_id=track.student_id if track else None,
        )
        persisted = self.writer.create_flag(row)
        if persisted is False:
            return None
        self._last_flag[key] = rel_ts
        return row

    @staticmethod
    def _nearest_track(detection: ObjectDetection, tracks: list[Track]) -> Track | None:
        best: tuple[float, Track] | None = None
        cx, cy = _centre(detection.box)
        for track in tracks:
            tx, ty = _centre(track.det.box)
            x1, y1, x2, y2 = track.det.box
            width = max(x2 - x1, 1)
            height = max(y2 - y1, 1)
            diagonal = math.hypot(width, height)
            dx = abs(cx - tx)
            dy = cy - ty
            distance = math.hypot(dx, dy)

            # The below-face envelope covers a hand/desk position without
            # claiming most of the frame for one student. General proximity
            # covers a phone beside or partly overlapping the face.
            in_desk_reach = 0.0 <= dy <= 2.75 * height and dx <= 1.5 * width
            in_proximity = -0.75 * height <= dy and distance <= _ADJACENCY_DIAGONALS * max(
                diagonal, 1.0
            )
            scores: list[float] = []
            if in_desk_reach:
                scores.append(math.hypot(dx / (1.5 * width), dy / (2.75 * height)))
            if in_proximity:
                scores.append(distance / max(diagonal, 1.0))
            if scores:
                score = min(scores)
                if best is None or score < best[0]:
                    best = (score, track)
        return best[1] if best else None
