"""Cumulative attendance — the session-level answer to "was this student here?"

This layer sits ON TOP of the existing PresenceFSM. The FSM models instantaneous
visibility ("is this face in the current frame?"), which is what the live roster
needs. Cumulative attendance answers the session question: "was this student seen
confidently enough times that we can call them attended?"

Key property: ATTENDED never flips back. Once a student crosses the sighting
threshold, they stay attended for the rest of the session regardless of later
detection misses. This is deliberately robust to the flickering that imperfect
detection at distance causes — a student who was reliably seen 5 times in the
first 10 minutes is attended even if they sit in a blind spot later.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class AttendanceRecord:
    """Per-student, per-session attendance evidence."""

    student_id: str
    first_seen: float | None = None  # relative seconds into session
    last_seen: float | None = None
    total_sightings: int = 0
    best_score: float = 0.0


@dataclass
class CumulativeAttendance:
    """Accumulates sightings across a session. Thread-safe for the single-writer
    pipeline (one process_frame at a time, same as the FSM).

    threshold: number of confident sightings required to mark a student ATTENDED.
    """

    threshold: int = 3
    _records: dict[str, AttendanceRecord] = field(default_factory=dict)

    def observe(self, student_id: str, score: float, ts: float) -> None:
        """Record one confident sighting of a student at time ts."""
        rec = self._records.get(student_id)
        if rec is None:
            rec = AttendanceRecord(student_id=student_id)
            self._records[student_id] = rec
        rec.total_sightings += 1
        if rec.first_seen is None:
            rec.first_seen = ts
        rec.last_seen = ts
        if score > rec.best_score:
            rec.best_score = score

    def is_attended(self, student_id: str) -> bool:
        """True once the student has been seen >= threshold times this session."""
        rec = self._records.get(student_id)
        return rec is not None and rec.total_sightings >= self.threshold

    def record_of(self, student_id: str) -> AttendanceRecord | None:
        return self._records.get(student_id)

    def attended_ids(self) -> set[str]:
        """All student_ids that have crossed the attendance threshold."""
        return {
            sid
            for sid, rec in self._records.items()
            if rec.total_sightings >= self.threshold
        }

    def summary(self) -> list[dict]:
        """Serialisable summary of all records for API/debug output."""
        return [
            {
                "student_id": rec.student_id,
                "attended": rec.total_sightings >= self.threshold,
                "sightings": rec.total_sightings,
                "first_seen": rec.first_seen,
                "last_seen": rec.last_seen,
                "best_score": round(rec.best_score, 4),
            }
            for rec in self._records.values()
        ]
