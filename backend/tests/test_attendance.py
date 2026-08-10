"""Tests for the cumulative attendance layer (presence/attendance.py).

Coverage: never-seen, below-threshold, seen-then-left (never flips back),
flickering, threshold-exact, best_score tracking, attended_ids, summary.
"""

from __future__ import annotations

from presence.attendance import CumulativeAttendance


def test_never_seen() -> None:
    """A student in the roster but never observed is not attended."""
    att = CumulativeAttendance(threshold=3)
    assert not att.is_attended("s1")
    assert att.record_of("s1") is None
    assert att.attended_ids() == set()


def test_below_threshold() -> None:
    """Fewer sightings than threshold -> not attended."""
    att = CumulativeAttendance(threshold=3)
    att.observe("s1", 0.8, ts=1.0)
    att.observe("s1", 0.85, ts=2.0)
    assert not att.is_attended("s1")
    rec = att.record_of("s1")
    assert rec is not None
    assert rec.total_sightings == 2


def test_threshold_exact() -> None:
    """Exactly threshold sightings -> attended."""
    att = CumulativeAttendance(threshold=3)
    for i in range(3):
        att.observe("s1", 0.7, ts=float(i))
    assert att.is_attended("s1")


def test_seen_then_left_never_flips_back() -> None:
    """Once attended, the student stays attended even without further sightings.
    (ATTENDED never flips back — this is the key design property.)"""
    att = CumulativeAttendance(threshold=2)
    att.observe("s1", 0.9, ts=1.0)
    att.observe("s1", 0.88, ts=2.0)
    assert att.is_attended("s1")

    # No more observations for s1 — still attended
    att.observe("s2", 0.7, ts=10.0)
    att.observe("s2", 0.7, ts=11.0)
    assert att.is_attended("s1"), "ATTENDED must never flip back"


def test_flickering() -> None:
    """Alternating present/absent observations eventually accumulate past threshold."""
    att = CumulativeAttendance(threshold=3)
    # Simulate: seen at t=1, missed at t=2, seen at t=3, missed at t=4, seen at t=5
    att.observe("s1", 0.6, ts=1.0)  # sighting 1
    # t=2: not observed (miss)
    att.observe("s1", 0.65, ts=3.0)  # sighting 2
    assert not att.is_attended("s1")
    # t=4: not observed (miss)
    att.observe("s1", 0.7, ts=5.0)  # sighting 3 -> threshold crossed
    assert att.is_attended("s1")


def test_best_score_tracking() -> None:
    """Best match score is correctly tracked across sightings."""
    att = CumulativeAttendance(threshold=1)
    att.observe("s1", 0.6, ts=1.0)
    att.observe("s1", 0.9, ts=2.0)
    att.observe("s1", 0.75, ts=3.0)
    rec = att.record_of("s1")
    assert rec is not None
    assert rec.best_score == 0.9


def test_first_last_seen() -> None:
    """first_seen and last_seen track the correct timestamps."""
    att = CumulativeAttendance(threshold=1)
    att.observe("s1", 0.8, ts=5.0)
    att.observe("s1", 0.85, ts=15.0)
    rec = att.record_of("s1")
    assert rec is not None
    assert rec.first_seen == 5.0
    assert rec.last_seen == 15.0


def test_attended_ids() -> None:
    """attended_ids returns exactly the set that crossed the threshold."""
    att = CumulativeAttendance(threshold=2)
    att.observe("s1", 0.8, ts=1.0)
    att.observe("s1", 0.8, ts=2.0)
    att.observe("s2", 0.7, ts=1.0)  # only 1 sighting
    att.observe("s3", 0.9, ts=1.0)
    att.observe("s3", 0.9, ts=2.0)
    assert att.attended_ids() == {"s1", "s3"}


def test_summary() -> None:
    """Summary returns a serialisable list with correct attended flags."""
    att = CumulativeAttendance(threshold=2)
    att.observe("s1", 0.8, ts=1.0)
    att.observe("s1", 0.85, ts=3.0)
    att.observe("s2", 0.6, ts=2.0)
    summaries = att.summary()
    by_id = {s["student_id"]: s for s in summaries}
    assert by_id["s1"]["attended"] is True
    assert by_id["s1"]["sightings"] == 2
    assert by_id["s1"]["best_score"] == 0.85
    assert by_id["s2"]["attended"] is False
    assert by_id["s2"]["sightings"] == 1


def test_multiple_students_independent() -> None:
    """Each student's attendance is tracked independently."""
    att = CumulativeAttendance(threshold=3)
    for i in range(5):
        att.observe("s1", 0.8, ts=float(i))
    for i in range(2):
        att.observe("s2", 0.7, ts=float(i))
    assert att.is_attended("s1")
    assert not att.is_attended("s2")
    assert att.record_of("s1").total_sightings == 5
    assert att.record_of("s2").total_sightings == 2
