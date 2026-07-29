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


@dataclass
class ProctorFlagRow:
    """One proctor_flags row: a candidate event for HUMAN review (Phase 3).
    The DB status enum is pending/dismissed/upheld — 'pending' is what every
    UI renders as "awaiting review"; only a reviewer changes it. No verdict
    or score lives on this row."""

    session_id: str
    flag_type: str  # 'phone' | 'extra_person' | 'head_pose' | 'other' (DB CHECK)
    flagged_at: datetime
    student_id: str | None = None
    review_status: str = "pending"
    id: str = field(default_factory=lambda: str(uuid4()))

    def payload(self) -> dict:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "student_id": self.student_id,
            "flag_type": self.flag_type,
            "flagged_at": _iso(self.flagged_at),
            "review_status": self.review_status,
        }


@dataclass
class ZoneAggregateRow:
    """One engagement_zone_aggregates row (Tier 2). Zone-level by design:
    there is NO student or track identifier on this row, and none may ever
    be added — that would break the k>=5 aggregate-only privacy tier."""

    session_id: str
    window_start: datetime
    window_s: int
    zone: str  # 'front' | 'mid' | 'back' | 'class' (DB CHECK)
    n_tracked: int  # DB CHECK n_tracked >= 5; suppressed in code before that
    enrolled_in_zone: int
    coverage: float  # 0..1: distinct tracks seen / enrolled in the zone
    vnei: float  # 0..1: visibility-normalised engagement index
    signals: dict = field(default_factory=dict)  # rates only, e.g. phone_rate
    id: str = field(default_factory=lambda: str(uuid4()))

    def payload(self) -> dict:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "window_start": _iso(self.window_start),
            "window_s": self.window_s,
            "zone": self.zone,
            "n_tracked": self.n_tracked,
            "enrolled_in_zone": self.enrolled_in_zone,
            "coverage": self.coverage,
            "vnei": self.vnei,
            "signals": self.signals,
        }


class PresenceWriter(Protocol):
    def create_session(
        self, class_section: str, subject: str | None, mode: str
    ) -> tuple[str, datetime]: ...
    def end_session(self, session_id: str, ends_at: datetime) -> None: ...
    def open_interval(self, row: PresenceInterval) -> None: ...
    def close_interval(self, row: PresenceInterval) -> None: ...
    def create_flag(self, row: ProctorFlagRow) -> None: ...
    def create_zone_aggregate(self, row: ZoneAggregateRow) -> None: ...


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

    def create_flag(self, row: ProctorFlagRow) -> None:
        logger.debug("noop flag %s %s", row.flag_type, row.student_id)

    def create_zone_aggregate(self, row: ZoneAggregateRow) -> None:
        logger.debug("noop zone aggregate %s vnei=%s", row.zone, row.vnei)


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

    def close(self) -> None:
        self._client.close()

    def count_rows(self, table: str, params: dict | None = None) -> int | None:
        """Exact row count via PostgREST's Content-Range header. Diagnostic use
        (the /healthz preflight) — every table we count has an id column."""
        r = self._client.get(
            f"/{table}",
            params={"select": "id", **(params or {})},
            headers={"Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"},
        )
        r.raise_for_status()
        total = r.headers.get("content-range", "").split("/")[-1]
        return int(total) if total.isdigit() else None

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

    def create_flag(self, row: ProctorFlagRow) -> None:
        """Proctor flags are assistive review items — like presence, a lost
        write is logged and dropped rather than stalling the capture loop."""
        try:
            r = self._client.post("/proctor_flags", json=row.payload())
            r.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            logger.warning("proctor flag dropped: %s %s (%s)", row.flag_type, row.student_id, exc)

    def create_zone_aggregate(self, row: ZoneAggregateRow) -> None:
        """Zone aggregates are periodic and reproducible from a re-run — like
        the other inference writes, log-and-drop on failure."""
        try:
            r = self._client.post("/engagement_zone_aggregates", json=row.payload())
            r.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            logger.warning("zone aggregate dropped: %s (%s)", row.zone, exc)

    # ---------- QR absentee fallback (service-role) ----------
    def issue_qr_token(self, session_id: str, ttl_s: int) -> dict:
        """Invalidate any outstanding unused token for the session, then mint a
        fresh single-use one. Only one token is ever live at a time (rotation)."""
        self._invalidate_tokens(session_id)
        expires = datetime.now(timezone.utc) + timedelta(seconds=ttl_s)
        r = self._client.post(
            "/qr_tokens",
            headers={"Prefer": "return=representation"},
            json={"session_id": session_id, "expires_at": _iso(expires)},
        )
        r.raise_for_status()
        row = r.json()[0]
        return {"token": row["token"], "expires_at": row["expires_at"]}

    def _invalidate_tokens(self, session_id: str) -> None:
        """Expire all still-claimable tokens for the session (rotation / close)."""
        self._client.patch(
            "/qr_tokens",
            params={"session_id": f"eq.{session_id}", "used_at": "is.null"},
            json={"expires_at": _iso(datetime.now(timezone.utc))},
        ).raise_for_status()

    def close_qr(self, session_id: str) -> None:
        """Teacher closes the absentee window: no outstanding token stays claimable."""
        self._invalidate_tokens(session_id)

    def get_token(self, token: str) -> dict | None:
        r = self._client.get(
            "/qr_tokens",
            params={
                "token": f"eq.{token}",
                "select": "session_id,expires_at,used_at",
                "limit": "1",
            },
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def claim_qr_token(self, token: str, student_id: str, window_ttl_s: int) -> dict | None:
        """Atomic single-winner claim: mark the token used only if it is still
        unused and unexpired, in one UPDATE. Returns the opened verification
        window, or None if the token was already used / expired / unknown.

        Postgres serialises concurrent UPDATEs on the row, so exactly one caller
        can flip used_at from NULL — the WHERE re-checks under the row lock."""
        now = datetime.now(timezone.utc)
        r = self._client.patch(
            "/qr_tokens",
            params={
                "token": f"eq.{token}",
                "used_at": "is.null",
                "expires_at": f"gt.{_iso(now)}",
            },
            headers={"Prefer": "return=representation"},
            json={"used_at": _iso(now), "used_by": student_id},
        )
        r.raise_for_status()
        rows = r.json()
        if not rows:
            return None  # lost the race, expired, or unknown token
        session_id = rows[0]["session_id"]
        expires = now + timedelta(seconds=window_ttl_s)
        w = self._client.post(
            "/verification_windows",
            headers={"Prefer": "return=representation"},
            json={
                "session_id": session_id,
                "student_id": student_id,
                "expires_at": _iso(expires),
            },
        )
        w.raise_for_status()
        win = w.json()[0]
        return {"window_id": win["id"], "session_id": session_id, "expires_at": win["expires_at"]}

    def open_verification_targets(self, session_id: str) -> dict[str, str]:
        """student_id -> window_id for windows open and unexpired right now."""
        now = datetime.now(timezone.utc)
        r = self._client.get(
            "/verification_windows",
            params={
                "session_id": f"eq.{session_id}",
                "satisfied_at": "is.null",
                "expires_at": f"gt.{_iso(now)}",
                "select": "id,student_id",
            },
        )
        r.raise_for_status()
        return {row["student_id"]: row["id"] for row in r.json()}

    def get_window(self, window_id: str) -> dict | None:
        """One verification window by id — for the on-phone selfie path to check
        ownership and expiry before it satisfies the window."""
        r = self._client.get(
            "/verification_windows",
            params={
                "id": f"eq.{window_id}",
                "select": "id,session_id,student_id,expires_at,satisfied_at",
                "limit": "1",
            },
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def student_templates(self, student_id: str) -> list[dict]:
        """Every enrolled embedding for one student ({'student_id','vec'} rows),
        for a 1:1 self-verification match. Service-role read of the gallery the
        backend owns — never a browser read path."""
        r = self._client.get(
            "/embeddings",
            params={"student_id": f"eq.{student_id}", "select": "student_id,vec"},
        )
        r.raise_for_status()
        return r.json()

    def satisfy_window(self, window_id: str) -> bool:
        """Close one window (single-winner). True if this call satisfied it."""
        r = self._client.patch(
            "/verification_windows",
            params={"id": f"eq.{window_id}", "satisfied_at": "is.null"},
            headers={"Prefer": "return=representation"},
            json={"satisfied_at": _iso(datetime.now(timezone.utc))},
        )
        r.raise_for_status()
        return bool(r.json())

    def write_qr_presence(self, session_id: str, student_id: str, at: datetime) -> None:
        """Presence row from the QR fallback — tagged via='qr' for the audit trail."""
        self._client.post(
            "/presence_intervals",
            json={
                "session_id": session_id,
                "student_id": student_id,
                "state": "PRESENT",
                "started_at": _iso(at),
                "via": "qr",
            },
        ).raise_for_status()

    def close_open_qr_presence(self, session_id: str, at: datetime) -> None:
        """Close any still-open via='qr' rows at session end (the FSM recorder
        only closes the intervals it opened, not these fallback rows)."""
        try:
            self._client.patch(
                "/presence_intervals",
                params={
                    "session_id": f"eq.{session_id}",
                    "via": "eq.qr",
                    "ended_at": "is.null",
                },
                json={"ended_at": _iso(at)},
            ).raise_for_status()
        except Exception as exc:  # noqa: BLE001 — best-effort at teardown
            logger.warning("close qr presence failed: %s (%s)", session_id, exc)

    def student_by_auth_uid(self, auth_uid: str) -> dict | None:
        r = self._client.get(
            "/students",
            params={
                "auth_uid": f"eq.{auth_uid}",
                "select": "id,reg_no,class_section",
                "limit": "1",
            },
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def active_session(self, session_id: str) -> dict | None:
        r = self._client.get(
            "/class_sessions",
            params={
                "id": f"eq.{session_id}",
                "ends_at": "is.null",
                "select": "id,class_section,mode",
                "limit": "1",
            },
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def has_open_present(self, session_id: str, student_id: str) -> bool:
        r = self._client.get(
            "/presence_intervals",
            params={
                "session_id": f"eq.{session_id}",
                "student_id": f"eq.{student_id}",
                "state": "eq.PRESENT",
                "ended_at": "is.null",
                "select": "id",
                "limit": "1",
            },
        )
        r.raise_for_status()
        return bool(r.json())

    def append_audit(self, actor: str, action: str, payload: dict) -> None:
        """Append to the hash-chained audit_log. Best-effort: a failed audit
        write is logged, never blocks the action it records."""
        try:
            self._client.post(
                "/audit_log", json={"actor": actor, "action": action, "payload": payload}
            ).raise_for_status()
        except Exception as exc:  # noqa: BLE001
            logger.warning("audit append failed: %s (%s)", action, exc)

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
    the writer for their own lifetime (one per WS connection / HTTP request).

    If the credentials are present but fail a quick health check (e.g. 401),
    fall back to the no-op writer so the capture loop is never blocked."""
    from app.config import settings

    if settings.supabase_enabled:
        try:
            writer = SupabaseWriter(url=settings.supabase_url, key=settings.supabase_secret_key)
            # Quick connectivity check — hit a lightweight endpoint
            writer._client.get("/", params={"limit": "0"})
            return writer
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Supabase auth failed (%s); falling back to no-op writer. "
                "Check SUPABASE_SECRET_KEY — PostgREST needs the service_role JWT, "
                "not the sb_secret_ management key.",
                exc,
            )
            return NoopWriter()
    logger.info("presence write-path: Supabase not configured, using no-op writer")
    return NoopWriter()


class SupabaseNotConfigured(RuntimeError):
    """Raised when a Supabase-only path (e.g. QR fallback) has no credentials."""


def require_supabase_writer() -> SupabaseWriter:
    """A real service-role writer, or raise. Unlike build_writer, this never
    falls back to the no-op writer: the QR fallback has no offline meaning."""
    from app.config import settings

    if not settings.supabase_enabled:
        raise SupabaseNotConfigured(
            "This endpoint needs SUPABASE_URL + SUPABASE_SECRET_KEY (service role)."
        )
    return SupabaseWriter(url=settings.supabase_url, key=settings.supabase_secret_key)


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
