"""Session lifecycle endpoints (write-path only), per the frozen openapi.yaml.

POST /v1/sessions          -> create a class session, return it
POST /v1/sessions/{id}/end -> mark it ended

These are the only REST routes the backend implements; everything else the UI
needs it reads directly from Postgres via RLS/Realtime. Writes go through the
same PresenceWriter (service role) used by the capture loop.
"""

from __future__ import annotations

from datetime import datetime, timezone
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
    writer = build_writer()
    try:
        session_id, starts_at = writer.create_session(body.class_section, body.subject, body.mode)
    except Exception as exc:  # noqa: BLE001 — surface as a clean 502, don't 500-trace
        raise HTTPException(status_code=502, detail=f"session persistence failed: {exc}") from exc
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
        writer.end_session(session_id, datetime.now(timezone.utc))
    except Exception as exc:  # noqa: BLE001
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
        writer.override_presence(
            session_id, body.student_id, body.state, datetime.now(timezone.utc)
        )
    except Exception as exc:  # noqa: BLE001
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
            writer.override_presence(
                session_id, student["id"], "UNVERIFIED", datetime.now(timezone.utc)
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"request failed: {exc}") from exc
    finally:
        writer.close()
    return {"session_id": session_id, "student_id": student["id"], "state": "UNVERIFIED"}
