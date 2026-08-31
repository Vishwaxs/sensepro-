"""Authenticated session lifecycle, history, and review endpoints.

Writes share the persistence adapter used by the capture loop. Bounded reads
serve browser views that authenticate with Clerk or Supabase without exposing
the service-role key to the client.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from app import auth as app_auth
from app.store import SupabaseNotConfigured, build_writer, require_supabase_writer

router = APIRouter(prefix="/v1/sessions", tags=["sessions"])

STAFF_ROLES = {"teacher", "admin"}
VALID_STATES = {"PRESENT", "UNVERIFIED", "ABSENT"}


def _verify_user(authorization: str | None) -> str:
    return app_auth.verified_uid(authorization)


def _require_staff(authorization: str | None) -> dict:
    return app_auth.require_role(authorization, STAFF_ROLES)


class SessionCreate(BaseModel):
    class_section: str
    subject: str | None = None
    mode: Literal["lecture", "exam", "workshop"] = "lecture"


class SessionOut(BaseModel):
    id: str
    class_section: str
    subject: str | None = None
    mode: str
    starts_at: str
    ends_at: str | None = None


class ProctorReviewBody(BaseModel):
    review_status: Literal["dismissed", "upheld"]


@router.get("", response_model=list[dict])
def list_sessions(
    limit: int = 50,
    class_section: str | None = None,
    mode: str | None = None,
    authorization: str | None = Header(None),
) -> list[dict]:
    """Read session history with presence summary (staff & management)."""
    app_auth.require_role(authorization, app_auth.STAFF_AND_MANAGEMENT)
    try:
        writer = require_supabase_writer()
    except SupabaseNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc
    try:
        sessions = writer.list_sessions_history(limit=limit, class_section=class_section, mode=mode)
    finally:
        writer.close()
    return sessions


@router.get("/active")
def get_active_session(
    mode: str | None = None,
    authorization: str | None = Header(None),
) -> dict:
    app_auth.require_role(authorization, app_auth.STAFF_AND_MANAGEMENT)
    try:
        writer = require_supabase_writer()
    except SupabaseNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc
    try:
        session = writer.get_active_session(mode=mode)
    finally:
        writer.close()
    return {"session": session}


@router.get("/{session_id}/intervals")
def get_session_intervals(
    session_id: str,
    authorization: str | None = Header(None),
) -> list[dict]:
    app_auth.require_role(authorization, app_auth.STAFF_AND_MANAGEMENT)
    try:
        writer = require_supabase_writer()
    except SupabaseNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc
    try:
        intervals = writer.list_presence_intervals(session_id)
    finally:
        writer.close()
    return intervals


@router.get("/{session_id}/proctor-flags", response_model=list[dict])
def get_proctor_flags(
    session_id: str,
    authorization: str | None = Header(None),
) -> list[dict]:
    """Return the human-review queue for one persisted examination."""
    _require_staff(authorization)
    try:
        writer = require_supabase_writer()
    except SupabaseNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc
    try:
        session = writer.get_session(session_id)
        if session is None or session.get("mode") != "exam":
            raise HTTPException(404, "Examination session not found")
        return writer.list_proctor_flags(session_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"proctor queue read failed: {exc}") from exc
    finally:
        writer.close()


@router.patch("/{session_id}/proctor-flags/{flag_id}", response_model=dict)
def review_proctor_flag(
    session_id: str,
    flag_id: str,
    body: ProctorReviewBody,
    authorization: str | None = Header(None),
) -> dict:
    """Persist a verified teacher/admin decision; never create a penalty."""
    reviewer = _require_staff(authorization)
    try:
        writer = require_supabase_writer()
    except SupabaseNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc
    try:
        session = writer.get_session(session_id)
        if session is None or session.get("mode") != "exam":
            raise HTTPException(404, "Examination session not found")
        row = writer.review_proctor_flag(
            session_id,
            flag_id,
            body.review_status,
            reviewer["sub"],
            datetime.now(UTC),
        )
        if row is None:
            raise HTTPException(409, "This event was already reviewed or is unavailable")
        return row
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"proctor review failed: {exc}") from exc
    finally:
        writer.close()


@router.post("", status_code=201, response_model=SessionOut)
def create_session(
    body: SessionCreate,
    authorization: str | None = Header(None),
) -> SessionOut:
    # Staff-only. This endpoint (and /end below) previously took no
    # Authorization at all, so ANY unauthenticated caller who could reach the
    # backend could open or close a class session — the write that anchors all
    # presence rows. The sibling mutations in this same file (/override,
    # /request-check) were already gated; these two were simply missed.
    _require_staff(authorization)
    try:
        # Lecture retains its documented offline/no-op development path.
        # Exam flags and workshop aggregates have no honest offline equivalent:
        # both must attach to a real persisted session or fail before capture.
        writer = build_writer() if body.mode == "lecture" else require_supabase_writer()
    except SupabaseNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc
    try:
        session_id, starts_at = writer.create_session(body.class_section, body.subject, body.mode)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"session persistence failed: {exc}") from exc
    finally:
        if hasattr(writer, "close"):
            writer.close()
    return SessionOut(
        id=session_id,
        class_section=body.class_section,
        subject=body.subject,
        mode=body.mode,
        starts_at=starts_at.isoformat(),
    )


@router.post("/{session_id}/end", response_model=dict)
def end_session(
    session_id: str,
    authorization: str | None = Header(None),
) -> dict:
    _require_staff(authorization)
    writer = build_writer()
    try:
        writer.end_session(session_id, datetime.now(UTC))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"session end failed: {exc}") from exc
    return {"id": session_id, "ended": True}


class OverrideBody(BaseModel):
    student_id: str
    state: str


@router.post("/{session_id}/override", response_model=dict)
def override_presence(
    session_id: str,
    body: OverrideBody,
    authorization: str | None = Header(None),
) -> dict:
    """A teacher manually corrects one student's presence state. Persisted
    (tagged via='override', migration 0012) — not a client-side-only edit."""
    _require_staff(authorization)
    if body.state not in VALID_STATES:
        raise HTTPException(400, f"state must be one of {sorted(VALID_STATES)}")

    try:
        writer = require_supabase_writer()
    except SupabaseNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc
    try:
        writer.override_presence(session_id, body.student_id, body.state, datetime.now(UTC))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"override failed: {exc}") from exc
    finally:
        writer.close()
    return {"session_id": session_id, "student_id": body.student_id, "state": body.state}


@router.post("/{session_id}/request-check", response_model=dict)
async def request_presence_check(
    session_id: str,
    authorization: str | None = Header(None),
) -> dict:
    """A student flags themselves UNVERIFIED for a live session so the
    teacher double-checks — self-service, and ONLY ever for the caller's own
    record. Identity comes from a verified Supabase session (GoTrue), never a
    client-sent student_id — a student can never request-check anyone else.
    Reuses via='override' (migration 0012): the row wasn't camera/QR-derived
    either way; who triggered it is a separate concern from how it happened."""
    uid = _verify_user(authorization)
    try:
        writer = require_supabase_writer()
    except SupabaseNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc
    try:
        student = writer.student_by_auth_uid(uid)
        if student is None:
            raise HTTPException(403, "Not linked to a student record")
        try:
            writer.override_presence(session_id, student["id"], "UNVERIFIED", datetime.now(UTC))
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"request failed: {exc}") from exc
    finally:
        writer.close()
    return {"session_id": session_id, "student_id": student["id"], "state": "UNVERIFIED"}
