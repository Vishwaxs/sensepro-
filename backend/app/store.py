"""SensePro persistence adapter for Supabase (service role, RLS-bypassing).

Inference results are written here, while authenticated API endpoints also use
bounded reads for rosters, session summaries, and review queues. Live frames
never enter this adapter and are never persisted.

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

# In-memory store fallback for role requests when Supabase table is not yet migrated
_IN_MEMORY_ROLE_REQUESTS: dict[str, dict] = {}


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _summarise_zone_aggregates(rows: list[dict]) -> dict[str, dict]:
    """Build one honest workshop summary per session.

    Prefer the class row when a window has one; otherwise combine its zones.
    VNEI is weighted by pose observations when available (with a duration-aware
    legacy fallback), and coverage by enrolled participant-seconds. This keeps
    a short final window from carrying the same weight as a complete window.
    """
    windows: dict[tuple[str, str], list[dict]] = {}
    for row in rows:
        session_id = row.get("session_id")
        window_start = row.get("window_start")
        if not session_id or not window_start:
            continue
        windows.setdefault((session_id, window_start), []).append(row)

    totals: dict[str, dict[str, float | int]] = {}
    for (session_id, _), window_rows in windows.items():
        class_rows = [row for row in window_rows if row.get("zone") == "class"]
        report_rows = class_rows or window_rows
        total = totals.setdefault(
            session_id,
            {
                "vnei_sum": 0.0,
                "vnei_weight": 0,
                "coverage_sum": 0.0,
                "coverage_weight": 0,
                "reportable_windows": 0,
            },
        )
        total["reportable_windows"] += 1
        for row in report_rows:
            visible = max(int(row.get("n_tracked") or 0), 0)
            enrolled = max(int(row.get("enrolled_in_zone") or 0), 0)
            duration = max(int(row.get("window_s") or 60), 1)
            signals = row.get("signals") if isinstance(row.get("signals"), dict) else {}
            pose_observations = max(int(signals.get("pose_observations") or 0), 0)
            vnei_weight = pose_observations or visible * duration
            if row.get("vnei") is not None and vnei_weight > 0:
                total["vnei_sum"] += float(row["vnei"]) * vnei_weight
                total["vnei_weight"] += vnei_weight
            if row.get("coverage") is not None and enrolled > 0:
                coverage_weight = enrolled * duration
                total["coverage_sum"] += float(row["coverage"]) * coverage_weight
                total["coverage_weight"] += coverage_weight

    summaries: dict[str, dict] = {}
    for session_id, total in totals.items():
        vnei_weight = int(total["vnei_weight"])
        coverage_weight = int(total["coverage_weight"])
        summaries[session_id] = {
            "vnei": float(total["vnei_sum"]) / vnei_weight if vnei_weight else None,
            "coverage": (
                float(total["coverage_sum"]) / coverage_weight if coverage_weight else None
            ),
            "reportable_windows": int(total["reportable_windows"]),
            "vnei_weight": vnei_weight,
            "coverage_weight": coverage_weight,
        }
    return summaries


@dataclass
class PresenceInterval:
    """One presence_intervals row; id is generated client-side so a close can
    address the exact row its open created."""

    session_id: str
    student_id: str
    state: str
    started_at: datetime
    ended_at: datetime | None = None
    via: str = "camera"  # 'camera' | 'qr' | 'override' (DB CHECK, migration 0012)
    id: str = field(default_factory=lambda: str(uuid4()))

    def open_payload(self) -> dict:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "student_id": self.student_id,
            "state": self.state,
            "started_at": _iso(self.started_at),
            "via": self.via,
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
    def end_session(self, session_id: str, ends_at: datetime) -> bool | None: ...
    def open_interval(self, row: PresenceInterval) -> None: ...
    def close_interval(self, row: PresenceInterval) -> None: ...
    def create_flag(self, row: ProctorFlagRow) -> bool | None: ...
    def create_zone_aggregate(self, row: ZoneAggregateRow) -> bool | None: ...

    def list_zone_aggregates(self, session_id: str) -> list[dict]: ...


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

    def create_flag(self, row: ProctorFlagRow) -> bool:
        logger.debug("noop flag %s %s", row.flag_type, row.student_id)
        return False

    def create_zone_aggregate(self, row: ZoneAggregateRow) -> bool:
        logger.debug("noop zone aggregate %s vnei=%s", row.zone, row.vnei)
        return False

    def list_zone_aggregates(self, session_id: str) -> list[dict]:
        return []


class SupabaseWriter:
    """PostgREST writer using the server (service-role) key.

    One shared httpx.Client for the writer's lifetime. Presence writes swallow
    and log their own errors — the capture loop must survive a DB outage.
    Session lifecycle calls raise instead, so the HTTP endpoint can return a
    clean 502: a session that never persisted has no id to attach presence to.
    """

    def __init__(self, url: str, key: str) -> None:
        import httpx  # lazy: the offline path never needs it

        headers = {
            "apikey": key,
            "Content-Type": "application/json",
        }
        # New sb_secret_/sb_publishable_ keys are opaque, not JWTs. Supabase
        # rejects them in Authorization; legacy service_role/anon JWTs still
        # require the Bearer header for their role claims.
        if not key.startswith(("sb_secret_", "sb_publishable_")):
            headers["Authorization"] = f"Bearer {key}"
        self._client = httpx.Client(
            base_url=url.rstrip("/") + "/rest/v1",
            headers=headers,
            timeout=10.0,
        )

    def close(self) -> None:
        self._client.close()

    def count_rows(self, table: str, params: dict | None = None) -> int | None:
        """Exact row count via PostgREST's Content-Range header. Diagnostic use
        (the /healthz preflight). Uses a HEAD request with count=exact so no
        column name assumption is needed (qr_tokens has PK=token, not id)."""
        r = self._client.request(
            "HEAD",
            f"/{table}",
            params={**(params or {})},
            headers={"Prefer": "count=exact"},
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

    def end_session(self, session_id: str, ends_at: datetime) -> bool:
        r = self._client.patch(
            "/class_sessions",
            params={"id": f"eq.{session_id}"},
            headers={"Prefer": "return=representation"},
            json={"ends_at": _iso(ends_at)},
        )
        r.raise_for_status()
        return bool(r.json())

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

    def create_flag(self, row: ProctorFlagRow) -> bool:
        """Proctor flags are assistive review items — like presence, a lost
        write is logged and dropped rather than stalling the capture loop."""
        try:
            r = self._client.post("/proctor_flags", json=row.payload())
            r.raise_for_status()
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("proctor flag dropped: %s %s (%s)", row.flag_type, row.student_id, exc)
            return False

    def create_zone_aggregate(self, row: ZoneAggregateRow) -> bool:
        """Zone aggregates are periodic and reproducible from a re-run — like
        the other inference writes, log-and-drop on failure."""
        try:
            r = self._client.post("/engagement_zone_aggregates", json=row.payload())
            r.raise_for_status()
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("zone aggregate dropped: %s (%s)", row.zone, exc)
            return False

    def list_zone_aggregates(self, session_id: str) -> list[dict]:
        """Return retained Tier-2 rows for one workshop, oldest window first."""
        response = self._client.get(
            "/engagement_zone_aggregates",
            params={
                "session_id": f"eq.{session_id}",
                "select": (
                    "id,session_id,window_start,window_s,zone,n_tracked,"
                    "enrolled_in_zone,coverage,vnei,signals"
                ),
                "order": "window_start.asc,zone.asc",
            },
        )
        response.raise_for_status()
        return response.json()

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
                "select": "session_id,issued_at,expires_at,used_at",
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

    def has_verification_attempt(self, session_id: str, student_id: str) -> bool:
        """True if this student already has ANY verification window for the session
        (regardless of expiry or satisfaction). One attempt per session."""
        try:
            r = self._client.get(
                "/verification_windows",
                params={
                    "session_id": f"eq.{session_id}",
                    "student_id": f"eq.{student_id}",
                    "select": "id",
                    "limit": "1",
                },
            )
            r.raise_for_status()
            return bool(r.json())
        except Exception as exc:
            logger.warning("has_verification_attempt lookup failed: %s", exc)
            return False

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

    def open_present_interval(self, session_id: str, student_id: str) -> dict | None:
        """The student's currently-open interval in this session (any state),
        or None. Used by override_presence to close it before opening the
        overridden state."""
        r = self._client.get(
            "/presence_intervals",
            params={
                "session_id": f"eq.{session_id}",
                "student_id": f"eq.{student_id}",
                "ended_at": "is.null",
                "select": "id,state,started_at",
                "order": "started_at.desc",
                "limit": "1",
            },
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def override_presence(self, session_id: str, student_id: str, state: str, at: datetime) -> None:
        """A teacher's manual correction, tagged via='override' for the audit
        trail (migration 0012). Unlike open_interval/close_interval — which
        log-and-drop so the automated capture loop survives a DB outage —
        this RAISES on failure: a manual override the UI reports as saved
        must actually have saved, or the caller must know it didn't."""
        current = self.open_present_interval(session_id, student_id)
        if current is not None:
            self._client.patch(
                "/presence_intervals",
                params={"id": f"eq.{current['id']}"},
                json={"ended_at": _iso(at)},
            ).raise_for_status()
        row = PresenceInterval(
            session_id=session_id, student_id=student_id, state=state, started_at=at, via="override"
        )
        self._client.post("/presence_intervals", json=row.open_payload()).raise_for_status()

    def student_by_auth_uid(self, auth_uid: str) -> dict | None:
        import httpx

        try:
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
        except httpx.HTTPStatusError as exc:
            # When auth_uid is non-UUID (such as Clerk user_...) and the DB column
            # is uuid, PostgREST returns 400. Catch it and return None safely
            # so the caller can return a clean 403 instead of a crashing 500.
            logger.warning("student_by_auth_uid HTTP error for %s: %s", auth_uid, exc)
            return None
        except Exception as exc:
            logger.error("student_by_auth_uid error for %s: %s", auth_uid, exc)
            return None

    def role_for_auth_uid(self, auth_uid: str) -> str | None:
        """The user's app_role from user_roles — the source of truth, read with
        the service key (which bypasses RLS). Lets staff endpoints authorise a
        caller even when the Access Token Hook isn't injecting app_role into the
        JWT (hook disabled, or the token predates the user's role)."""
        r = self._client.get(
            "/user_roles",
            params={"user_id": f"eq.{auth_uid}", "select": "app_role", "limit": "1"},
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0]["app_role"] if rows else None

    def list_students(self, class_section: str | None = None) -> list[dict]:
        """All students (optionally one class), read with the service key so the
        capture UI can resolve recognised ids -> names + reg_nos WITHOUT the
        browser's RLS app_role (the kiosk session may not carry it). `id` is the
        students.id the embeddings and live recognition key on."""
        params = {"select": "id,reg_no,full_name", "order": "reg_no"}
        if class_section:
            params["class_section"] = f"eq.{class_section}"
        r = self._client.get("/students", params=params)
        r.raise_for_status()
        return r.json()

    def create_student(
        self, reg_no: str, full_name: str, class_section: str, seat_zone: str | None
    ) -> dict:
        """Create a new roster identity row (no embeddings — that's the
        separate /v1/enroll/* step). Raises httpx.HTTPStatusError on failure,
        including 409 on a duplicate reg_no (the students table's unique
        constraint) — the caller turns that into a clean HTTP response."""
        r = self._client.post(
            "/students",
            headers={"Prefer": "return=representation"},
            json={
                "reg_no": reg_no,
                "full_name": full_name,
                "class_section": class_section,
                "seat_zone": seat_zone,
            },
        )
        r.raise_for_status()
        return r.json()[0]

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

    def get_active_session(self, mode: str | None = None) -> dict | None:
        params = {
            "select": "id,class_section,subject,mode,starts_at",
            "ends_at": "is.null",
            "order": "starts_at.desc",
            "limit": "1",
        }
        if mode:
            params["mode"] = f"eq.{mode}"
        r = self._client.get("/class_sessions", params=params)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def get_session(self, session_id: str) -> dict | None:
        """Return one persisted session for capture attachment validation."""
        r = self._client.get(
            "/class_sessions",
            params={
                "id": f"eq.{session_id}",
                "select": "id,class_section,subject,mode,starts_at,ends_at",
                "limit": "1",
            },
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def list_presence_intervals(self, session_id: str) -> list[dict]:
        params = {
            "session_id": f"eq.{session_id}",
            "select": "id,session_id,student_id,state,started_at,ended_at,via",
            "order": "started_at.asc",
        }
        r = self._client.get("/presence_intervals", params=params)
        r.raise_for_status()
        return r.json()

    def list_sessions_history(
        self, limit: int = 50, class_section: str | None = None, mode: str | None = None
    ) -> list[dict]:
        params = {
            "select": "id,class_section,subject,mode,starts_at,ends_at",
            "order": "starts_at.desc",
            "limit": str(limit),
        }
        if class_section:
            params["class_section"] = f"eq.{class_section}"
        if mode:
            params["mode"] = f"eq.{mode}"
        r = self._client.get("/class_sessions", params=params)
        r.raise_for_status()
        sessions = r.json()
        if not sessions:
            return []

        lecture_sessions = [s for s in sessions if s.get("mode", "lecture") == "lecture"]
        exam_sessions = [s for s in sessions if s.get("mode") == "exam"]
        workshop_sessions = [s for s in sessions if s.get("mode") == "workshop"]

        presence: list[dict] = []
        roster: list[dict] = []
        if lecture_sessions:
            lecture_ids = [s["id"] for s in lecture_sessions]
            lecture_sections = list({s["class_section"] for s in lecture_sessions})
            try:
                p_res = self._client.get(
                    "/presence_intervals",
                    params={
                        "session_id": f"in.({','.join(lecture_ids)})",
                        "state": "eq.PRESENT",
                        "select": "session_id,student_id",
                    },
                )
                presence = p_res.json() if p_res.status_code == 200 else []
            except Exception:
                presence = []

            try:
                r_res = self._client.get(
                    "/students",
                    params={
                        "class_section": f"in.({','.join(lecture_sections)})",
                        "select": "id,class_section",
                    },
                )
                roster = r_res.json() if r_res.status_code == 200 else []
            except Exception:
                roster = []

        flags: list[dict] = []
        if exam_sessions:
            exam_ids = [s["id"] for s in exam_sessions]
            try:
                f_res = self._client.get(
                    "/proctor_flags",
                    params={
                        "session_id": f"in.({','.join(exam_ids)})",
                        "select": "session_id,review_status",
                    },
                )
                flags = f_res.json() if f_res.status_code == 200 else []
            except Exception:
                flags = []

        zones: list[dict] = []
        if workshop_sessions:
            workshop_ids = [s["id"] for s in workshop_sessions]
            try:
                z_res = self._client.get(
                    "/engagement_zone_aggregates",
                    params={
                        "session_id": f"in.({','.join(workshop_ids)})",
                        "select": (
                            "session_id,window_start,window_s,zone,n_tracked,"
                            "enrolled_in_zone,vnei,coverage,signals"
                        ),
                    },
                )
                zones = z_res.json() if z_res.status_code == 200 else []
            except Exception:
                zones = []

        present_by_session: dict[str, set] = {}
        for p in presence:
            sid = p.get("session_id")
            present_by_session.setdefault(sid, set()).add(p.get("student_id"))

        roster_by_section: dict[str, int] = {}
        for s in roster:
            sec = s.get("class_section")
            roster_by_section[sec] = roster_by_section.get(sec, 0) + 1

        flags_by_session: dict[str, int] = {}
        pending_flags_by_session: dict[str, int] = {}
        for f in flags:
            sid = f.get("session_id")
            flags_by_session[sid] = flags_by_session.get(sid, 0) + 1
            if f.get("review_status") == "pending":
                pending_flags_by_session[sid] = pending_flags_by_session.get(sid, 0) + 1

        aggregate_by_session = _summarise_zone_aggregates(zones)

        out = []
        for s in sessions:
            sid = s["id"]
            sec = s["class_section"]
            session_mode = s.get("mode", "lecture")
            aggregate = aggregate_by_session.get(sid, {})
            out.append(
                {
                    "id": sid,
                    "class_section": sec,
                    "subject": s.get("subject"),
                    "mode": session_mode,
                    "starts_at": s.get("starts_at"),
                    "ends_at": s.get("ends_at"),
                    "present_count": (
                        len(present_by_session.get(sid, set())) if session_mode == "lecture" else 0
                    ),
                    "total_count": roster_by_section.get(sec, 0)
                    if session_mode == "lecture"
                    else 0,
                    "flag_count": flags_by_session.get(sid, 0) if session_mode == "exam" else 0,
                    "pending_flag_count": (
                        pending_flags_by_session.get(sid, 0) if session_mode == "exam" else 0
                    ),
                    "vnei": aggregate.get("vnei") if session_mode == "workshop" else None,
                    "coverage": (aggregate.get("coverage") if session_mode == "workshop" else None),
                    "reportable_windows": (
                        aggregate.get("reportable_windows", 0) if session_mode == "workshop" else 0
                    ),
                    "vnei_weight": (
                        aggregate.get("vnei_weight", 0) if session_mode == "workshop" else 0
                    ),
                    "coverage_weight": (
                        aggregate.get("coverage_weight", 0) if session_mode == "workshop" else 0
                    ),
                }
            )
        return out

    def list_proctor_flags(self, session_id: str) -> list[dict]:
        """Return retained, unsuppressed review items for one examination."""
        r = self._client.get(
            "/proctor_flags",
            params={
                "session_id": f"eq.{session_id}",
                "suppressed": "eq.false",
                "select": (
                    "id,session_id,student_id,flag_type,suppressed,flagged_at,"
                    "review_status,reviewed_by,reviewed_at"
                ),
                "order": "flagged_at.desc",
            },
        )
        r.raise_for_status()
        return r.json()

    def review_proctor_flag(
        self,
        session_id: str,
        flag_id: str,
        review_status: str,
        reviewed_by: str,
        reviewed_at: datetime,
    ) -> dict | None:
        """Record one human decision without changing captured event evidence."""
        r = self._client.patch(
            "/proctor_flags",
            params={
                "id": f"eq.{flag_id}",
                "session_id": f"eq.{session_id}",
                "review_status": "eq.pending",
                "suppressed": "eq.false",
            },
            headers={"Prefer": "return=representation"},
            json={
                "review_status": review_status,
                "reviewed_by": reviewed_by,
                "reviewed_at": _iso(reviewed_at),
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

    # ---------- deletion requests (service-role) ----------
    def get_pending_deletion_request(self, student_id: str) -> dict | None:
        r = self._client.get(
            "/deletion_requests",
            params={
                "student_id": f"eq.{student_id}",
                "status": "eq.pending",
                "select": "id,status,requested_at",
                "limit": "1",
            },
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def latest_deletion_request(self, student_id: str) -> dict | None:
        r = self._client.get(
            "/deletion_requests",
            params={
                "student_id": f"eq.{student_id}",
                "select": "id,status,requested_at,resolved_at",
                "order": "requested_at.desc",
                "limit": "1",
            },
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def create_deletion_request(self, student_id: str) -> dict:
        """Idempotent: returns the existing pending request instead of
        creating a duplicate if the student already has one outstanding."""
        existing = self.get_pending_deletion_request(student_id)
        if existing is not None:
            return existing
        r = self._client.post(
            "/deletion_requests",
            headers={"Prefer": "return=representation"},
            json={"student_id": student_id},
        )
        r.raise_for_status()
        return r.json()[0]

    def get_deletion_request(self, request_id: str) -> dict | None:
        r = self._client.get(
            "/deletion_requests",
            params={"id": f"eq.{request_id}", "select": "id,student_id,status", "limit": "1"},
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def delete_student_embeddings(self, student_id: str) -> int:
        """Purge every enrolled template for a student — the biometric-purge
        half of a deletion approval. Idempotent: deleting an already-empty
        set just returns 0."""
        r = self._client.delete(
            "/embeddings",
            params={"student_id": f"eq.{student_id}"},
            headers={"Prefer": "return=representation"},
        )
        r.raise_for_status()
        return len(r.json())

    def withdraw_consent(self, student_id: str, at: datetime) -> None:
        """Marks the student's active consent record withdrawn — the
        consent-half of a deletion approval. Idempotent: the
        `withdrawn_at is.null` filter means a repeat call touches no rows."""
        self._client.patch(
            "/consent_records",
            params={"student_id": f"eq.{student_id}", "withdrawn_at": "is.null"},
            json={"withdrawn_at": _iso(at)},
        ).raise_for_status()

    def resolve_deletion_request(self, request_id: str, status: str, admin_uid: str) -> dict | None:
        """Atomic status transition guarded on status='pending' — mirrors
        satisfy_window/claim_qr_token's single-winner PATCH pattern, so two
        admins resolving the same request concurrently can't both succeed.
        Returns None if the request was already resolved."""
        from uuid import UUID

        payload: dict[str, object] = {
            "status": status,
            "resolved_at": _iso(datetime.now(timezone.utc)),
        }
        try:
            UUID(admin_uid)
            payload["resolved_by"] = admin_uid
        except (ValueError, TypeError):
            pass
        r = self._client.patch(
            "/deletion_requests",
            params={"id": f"eq.{request_id}", "status": "eq.pending"},
            headers={"Prefer": "return=representation"},
            json=payload,
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    # ---------- app settings (service-role) ----------
    def get_setting(self, key: str) -> dict | None:
        r = self._client.get(
            "/app_settings",
            params={"key": f"eq.{key}", "select": "key,value,updated_at", "limit": "1"},
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def set_setting(self, key: str, value: object, admin_uid: str) -> dict | None:
        from uuid import UUID

        payload: dict[str, object] = {
            "value": value,
            "updated_at": _iso(datetime.now(timezone.utc)),
        }
        try:
            UUID(admin_uid)
            payload["updated_by"] = admin_uid
        except (ValueError, TypeError):
            pass
        r = self._client.patch(
            "/app_settings",
            params={"key": f"eq.{key}"},
            headers={"Prefer": "return=representation"},
            json=payload,
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    # ---------- role access requests (service-role + offline fallback) ----------
    def create_role_request(
        self,
        user_id: str,
        email: str,
        full_name: str | None,
        requested_role: str,
        reason: str | None = None,
    ) -> dict:
        """Submit a role request. If a pending request exists for this user/email,
        update it; otherwise insert a new pending request."""
        try:
            existing = self.get_user_role_request(user_id=user_id, email=email)
            if existing and existing.get("status") == "pending":
                r = self._client.patch(
                    "/role_requests",
                    params={"id": f"eq.{existing['id']}"},
                    headers={"Prefer": "return=representation"},
                    json={
                        "requested_role": requested_role,
                        "reason": reason,
                        "full_name": full_name,
                    },
                )
                r.raise_for_status()
                rows = r.json()
                return rows[0] if rows else existing

            r = self._client.post(
                "/role_requests",
                headers={"Prefer": "return=representation"},
                json={
                    "user_id": user_id,
                    "email": email,
                    "full_name": full_name,
                    "requested_role": requested_role,
                    "reason": reason,
                    "status": "pending",
                },
            )
            r.raise_for_status()
            return r.json()[0]
        except Exception as exc:
            logger.warning("Supabase role_requests write failed (%s); using in-memory store", exc)
            req_id = str(uuid4())
            row = {
                "id": req_id,
                "user_id": user_id,
                "email": email,
                "full_name": full_name,
                "requested_role": requested_role,
                "reason": reason,
                "status": "pending",
                "created_at": _iso(datetime.now(timezone.utc)),
                "resolved_at": None,
                "resolved_by": None,
                "resolved_role": None,
            }
            _IN_MEMORY_ROLE_REQUESTS[req_id] = row
            return row

    def get_user_role_request(
        self, user_id: str | None = None, email: str | None = None
    ) -> dict | None:
        try:
            params: dict[str, str] = {
                "select": "id,user_id,email,full_name,requested_role,reason,status,created_at,resolved_at,resolved_role",
                "order": "created_at.desc",
                "limit": "1",
            }
            if user_id:
                params["user_id"] = f"eq.{user_id}"
            elif email:
                params["email"] = f"eq.{email}"
            else:
                return None

            r = self._client.get("/role_requests", params=params)
            r.raise_for_status()
            rows = r.json()
            return rows[0] if rows else None
        except Exception:
            # Check in-memory store
            for r in reversed(list(_IN_MEMORY_ROLE_REQUESTS.values())):
                if (user_id and r.get("user_id") == user_id) or (email and r.get("email") == email):
                    return r
            return None

    def list_role_requests(self, status: str | None = None, limit: int = 50) -> list[dict]:
        try:
            params: dict[str, str] = {
                "select": "id,user_id,email,full_name,requested_role,reason,status,created_at,resolved_at,resolved_by,resolved_role",
                "order": "created_at.desc",
                "limit": str(limit),
            }
            if status and status != "all":
                params["status"] = f"eq.{status}"
            r = self._client.get("/role_requests", params=params)
            r.raise_for_status()
            return r.json()
        except Exception:
            items = list(_IN_MEMORY_ROLE_REQUESTS.values())
            if status and status != "all":
                items = [r for r in items if r.get("status") == status]
            return sorted(items, key=lambda x: x.get("created_at", ""), reverse=True)[:limit]

    def count_pending_role_requests(self) -> int:
        try:
            r = self._client.request(
                "HEAD",
                "/role_requests",
                params={"status": "eq.pending"},
                headers={"Range-Unit": "items", "Prefer": "count=exact"},
            )
            r.raise_for_status()
            cr = r.headers.get("Content-Range", "")
            if "/" in cr:
                try:
                    return int(cr.split("/")[-1])
                except ValueError:
                    pass
            return len(self.list_role_requests(status="pending", limit=100))
        except Exception:
            return sum(1 for r in _IN_MEMORY_ROLE_REQUESTS.values() if r.get("status") == "pending")

    def resolve_role_request(
        self,
        request_id: str,
        status: str,
        admin_uid: str,
        resolved_role: str | None = None,
    ) -> dict | None:
        """Atomic status flip guarded on status='pending'."""
        try:
            json_data: dict[str, object] = {
                "status": status,
                "resolved_at": _iso(datetime.now(timezone.utc)),
                "resolved_by": admin_uid,
            }
            if resolved_role:
                json_data["resolved_role"] = resolved_role

            r = self._client.patch(
                "/role_requests",
                params={"id": f"eq.{request_id}", "status": "eq.pending"},
                headers={"Prefer": "return=representation"},
                json=json_data,
            )
            r.raise_for_status()
            rows = r.json()
            return rows[0] if rows else None
        except Exception:
            if request_id in _IN_MEMORY_ROLE_REQUESTS:
                row = _IN_MEMORY_ROLE_REQUESTS[request_id]
                row["status"] = status
                row["resolved_at"] = _iso(datetime.now(timezone.utc))
                row["resolved_by"] = admin_uid
                if resolved_role:
                    row["resolved_role"] = resolved_role
                return row
            return None

    def assign_user_role(self, user_id: str, email: str, role: str, admin_uid: str) -> dict | None:
        """Assign role in user_roles table (upsert on user_id)."""
        try:
            r = self._client.post(
                "/user_roles",
                headers={
                    "Prefer": "resolution=merge-duplicates,return=representation",
                },
                json={
                    "user_id": user_id,
                    "email": email,
                    "role": role,
                    "created_at": _iso(datetime.now(timezone.utc)),
                    "updated_at": _iso(datetime.now(timezone.utc)),
                },
            )
            r.raise_for_status()
            rows = r.json()
            return rows[0] if rows else None
        except Exception as exc:
            logger.warning("assign_user_role Supabase call failed (%s); noted in audit", exc)
            return {"user_id": user_id, "email": email, "role": role}

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
            writer = SupabaseWriter(url=settings.supabase_url, key=settings.supabase_postgrest_key)
            # Quick connectivity check — hit a lightweight endpoint
            response = writer._client.get("/", params={"limit": "0"})
            response.raise_for_status()
            return writer
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Supabase auth failed (%s); falling back to no-op writer. "
                "Check SUPABASE_SECRET_KEY or the legacy service_role JWT.",
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
    return SupabaseWriter(url=settings.supabase_url, key=settings.supabase_postgrest_key)


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
