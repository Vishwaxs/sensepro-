"""Presence write-path to Supabase (service role, RLS-bypassing).

The frontend reads Postgres directly via RLS + Realtime; the backend ONLY
writes inference results. This module is that write side and nothing else — it
never reads roster/attendance back, and it never persists a raw frame.

Design:
- `PresenceWriter` is a protocol. `NoopWriter` (default when Supabase is not
  configured) keeps the dev/stub/CI loop fully offline; `SupabaseWriter`
  talks to PostgREST with the server key over one shared HTTP client.
- Intervals get a client-generated id: opening an interval INSERTs the row,
  closing it PATCHes ended_at onto the same id — never a second insert.
- A failed presence write is logged and dropped; it must never crash or stall
  the capture loop. (A retry queue was considered and rejected: writes are
  sparse — one burst per re-ID pass — and a queue that only drains on the
  next write adds code without changing outcomes at this scale.)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Protocol
from uuid import uuid4

logger = logging.getLogger("sensepro.store")


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


@dataclass
class PresenceInterval:
    """One presence_intervals row; id is generated client-side so a close can
    address the exact row its open created."""

    session_id: str
    student_id: str
    state: str
    started_at: datetime
    ended_at: datetime | None = None
    id: str = field(default_factory=lambda: str(uuid4()))

    def open_payload(self) -> dict:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "student_id": self.student_id,
            "state": self.state,
            "started_at": _iso(self.started_at),
        }


class PresenceWriter(Protocol):
    def create_session(
        self, class_section: str, subject: str | None, mode: str
    ) -> tuple[str, datetime]: ...
    def end_session(self, session_id: str, ends_at: datetime) -> None: ...
    def open_interval(self, row: PresenceInterval) -> None: ...
    def close_interval(self, row: PresenceInterval) -> None: ...


class NoopWriter:
    """Offline default: records intent in logs, persists nothing."""

    def create_session(
        self, class_section: str, subject: str | None, mode: str
    ) -> tuple[str, datetime]:
        logger.info("noop create_session section=%s mode=%s", class_section, mode)
        return "noop-session", datetime.now(timezone.utc)

    def end_session(self, session_id: str, ends_at: datetime) -> None:
        logger.info("noop end_session id=%s", session_id)

    def open_interval(self, row: PresenceInterval) -> None:
        logger.debug("noop open %s %s", row.student_id, row.state)

    def close_interval(self, row: PresenceInterval) -> None:
        logger.debug("noop close %s %s", row.student_id, row.state)


class SupabaseWriter:
    """PostgREST writer using the server (service-role) key.

    One shared httpx.Client for the writer's lifetime. Presence writes swallow
    and log their own errors — the capture loop must survive a DB outage.
    Session lifecycle calls raise instead, so the HTTP endpoint can return a
    clean 502: a session that never persisted has no id to attach presence to.
    """

    def __init__(self, url: str, key: str) -> None:
        import httpx  # lazy: the offline path never needs it

        self._client = httpx.Client(
            base_url=url.rstrip("/") + "/rest/v1",
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            timeout=10.0,
        )

    def create_session(
        self, class_section: str, subject: str | None, mode: str
    ) -> tuple[str, datetime]:
        device_id = self._ensure_default_device()
        starts_at = datetime.now(timezone.utc)
        r = self._client.post(
            "/class_sessions",
            headers={"Prefer": "return=representation"},
            json={
                "device_id": device_id,
                "class_section": class_section,
                "subject": subject,
                "mode": mode,
                "starts_at": _iso(starts_at),
            },
        )
        r.raise_for_status()
        return r.json()[0]["id"], starts_at

    def end_session(self, session_id: str, ends_at: datetime) -> None:
        r = self._client.patch(
            "/class_sessions",
            params={"id": f"eq.{session_id}"},
            json={"ends_at": _iso(ends_at)},
        )
        r.raise_for_status()

    def open_interval(self, row: PresenceInterval) -> None:
        try:
            r = self._client.post("/presence_intervals", json=row.open_payload())
            r.raise_for_status()
        except Exception as exc:  # noqa: BLE001 — never crash the capture loop
            logger.warning("presence open dropped: %s %s (%s)", row.student_id, row.state, exc)

    def close_interval(self, row: PresenceInterval) -> None:
        if row.ended_at is None:
            return
        try:
            r = self._client.patch(
                "/presence_intervals",
                params={"id": f"eq.{row.id}"},
                json={"ended_at": _iso(row.ended_at)},
            )
            r.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            logger.warning("presence close dropped: %s %s (%s)", row.student_id, row.state, exc)

    def _ensure_default_device(self) -> str:
        """class_sessions.device_id is NOT NULL but browser capture has no
        hardware row; reuse a single 'browser-capture' device."""
        got = self._client.get(
            "/devices",
            params={"device_key": "eq.browser-capture", "select": "id", "limit": "1"},
        )
        got.raise_for_status()
        rows = got.json()
        if rows:
            return rows[0]["id"]
        made = self._client.post(
            "/devices",
            headers={"Prefer": "return=representation"},
            json={"device_key": "browser-capture", "label": "Browser capture client"},
        )
        made.raise_for_status()
        return made.json()[0]["id"]


def build_writer() -> PresenceWriter:
    """Real writer when Supabase is configured, else the no-op. Callers hold
    the writer for their own lifetime (one per WS connection / HTTP request)."""
    from app.config import settings

    if settings.supabase_enabled:
        return SupabaseWriter(url=settings.supabase_url, key=settings.supabase_secret_key)
    logger.info("presence write-path: Supabase not configured, using no-op writer")
    return NoopWriter()


@dataclass
class SessionRecorder:
    """Bridges FSM transitions to presence_intervals rows: a state change
    closes the student's open interval (PATCH) and opens the new one (INSERT).
    Converts the FSM's relative seconds to absolute timestamps."""

    writer: PresenceWriter
    session_id: str
    session_start: datetime
    _open: dict[str, PresenceInterval] = field(default_factory=dict)

    def _abs(self, rel_ts: float) -> datetime:
        return self.session_start + timedelta(seconds=rel_ts)

    def record(self, transitions: list[tuple[str, str]], rel_ts: float) -> None:
        at = self._abs(rel_ts)
        for student_id, state in transitions:
            prev = self._open.pop(student_id, None)
            if prev is not None:
                prev.ended_at = at
                self.writer.close_interval(prev)
            new = PresenceInterval(
                session_id=self.session_id, student_id=student_id, state=state, started_at=at
            )
            self._open[student_id] = new
            self.writer.open_interval(new)

    def close(self, rel_ts: float) -> None:
        at = self._abs(rel_ts)
        for row in self._open.values():
            row.ended_at = at
            self.writer.close_interval(row)
        self._open.clear()
