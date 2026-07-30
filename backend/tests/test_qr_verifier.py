"""The capture-loop QR verifier: satisfies open windows on recognition,
writes a via='qr' presence row, and stays disabled/no-op otherwise."""

from __future__ import annotations

from datetime import datetime, timezone

from app.ws import _QRVerifier

AT = datetime(2026, 7, 29, tzinfo=timezone.utc)


class FakeLoopWriter:
    def __init__(self, targets, satisfy_ok=True):
        self._targets = dict(targets)
        self.satisfy_ok = satisfy_ok
        self.refreshes = 0
        self.satisfied: list = []
        self.presence: list = []
        self.audits: list = []

    def open_verification_targets(self, session_id):
        self.refreshes += 1
        return dict(self._targets)

    def satisfy_window(self, window_id):
        self.satisfied.append(window_id)
        return self.satisfy_ok

    def write_qr_presence(self, session_id, student_id, at):
        self.presence.append(student_id)

    def append_audit(self, actor, action, payload):
        self.audits.append(action)

    def close_open_qr_presence(self, session_id, at):
        pass


def test_verifies_windowed_student():
    w = FakeLoopWriter({"stud-1": "win-1"})
    v = _QRVerifier(w, "sess-1")
    v.observe({"stud-1"}, AT, ts=0.0)
    assert w.satisfied == ["win-1"]
    assert w.presence == ["stud-1"]
    assert "qr_verified" in w.audits


def test_ignores_unwindowed_student():
    w = FakeLoopWriter({"stud-1": "win-1"})
    v = _QRVerifier(w, "sess-1")
    v.observe({"stud-2"}, AT, ts=0.0)
    assert w.satisfied == [] and w.presence == []


def test_no_presence_when_satisfy_loses_race():
    w = FakeLoopWriter({"stud-1": "win-1"}, satisfy_ok=False)
    v = _QRVerifier(w, "sess-1")
    v.observe({"stud-1"}, AT, ts=0.0)
    assert w.satisfied == ["win-1"]  # attempted
    assert w.presence == []  # but another satisfier won — no double presence


def test_disabled_for_writer_without_qr_methods():
    class Noop:
        pass

    v = _QRVerifier(Noop(), "sess-1")
    # Must be a safe no-op — no attributes accessed, no error.
    v.observe({"stud-1"}, AT, ts=0.0)
    v.close(AT)


def test_targets_refresh_is_throttled():
    w = FakeLoopWriter({})
    v = _QRVerifier(w, "sess-1", refresh_s=3.0)
    v.observe(set(), AT, ts=0.0)  # first refresh
    v.observe(set(), AT, ts=1.0)  # within window — no refresh
    v.observe(set(), AT, ts=5.0)  # past window — refresh again
    assert w.refreshes == 2
