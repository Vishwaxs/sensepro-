"""Admin-only endpoint to create a student roster identity row.

POST /v1/students
  - Requires staff (teacher/admin) — app_role from the JWT claim, with a
    DB-verified fallback when the claim is absent (same auth pattern as
    app/qr_api.py's _require_role; stricter than app/enroll_api.py's
    claim-only check).
  - Creates the students row only — no embeddings. Enrol the student's face
    separately via /v1/enroll/video or the bulk photo/video CLI.

This deliberately does NOT go through the presence write-path (app/store.py's
PresenceWriter protocol / build_writer): a misconfigured or unreachable
Supabase must surface as a clear 503 here, not silently succeed against a
no-op writer — a student the UI believes was created but wasn't is worse than
an explicit failure. Matches app/roster_api.py's use of require_supabase_writer.
"""

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app import auth as app_auth
from app.store import SupabaseNotConfigured, require_supabase_writer

logger = logging.getLogger("sensepro.students_api")
router = APIRouter(prefix="/v1/students", tags=["students"])

VALID_ZONES = {"front", "mid", "back"}
STAFF_ROLES = {"teacher", "admin"}


def _verify_user(authorization: str | None) -> str:
    return app_auth.verified_uid(authorization)


def _require_staff(authorization: str | None) -> dict:
    return app_auth.require_role(authorization, STAFF_ROLES)


def _writer():
    try:
        return require_supabase_writer()
    except SupabaseNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc


class StudentCreate(BaseModel):
    reg_no: str = Field(min_length=1)
    full_name: str = Field(min_length=1)
    class_section: str = Field(min_length=1)
    seat_zone: str | None = None


class StudentOut(BaseModel):
    id: str
    reg_no: str
    full_name: str
    class_section: str
    seat_zone: str | None = None


@router.post("", status_code=201, response_model=StudentOut)
async def create_student(
    body: StudentCreate,
    authorization: str | None = Header(None),
) -> dict:
    _require_staff(authorization)

    reg_no = body.reg_no.strip()
    full_name = body.full_name.strip()
    class_section = body.class_section.strip()
    if not reg_no or not full_name or not class_section:
        raise HTTPException(400, "reg_no, full_name, and class_section are required")
    if body.seat_zone is not None and body.seat_zone not in VALID_ZONES:
        raise HTTPException(400, f"seat_zone must be one of {sorted(VALID_ZONES)}")

    writer = _writer()
    try:
        row = writer.create_student(reg_no, full_name, class_section, body.seat_zone)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 409:
            raise HTTPException(409, f"reg_no '{reg_no}' already exists") from exc
        raise HTTPException(502, f"Supabase write failed: {exc}") from exc
    finally:
        writer.close()
    return row


@router.post("/me/deletion-request", status_code=201)
def request_deletion(authorization: str | None = Header(None)) -> dict:
    """Student self-service right-to-erasure request (the landing page's privacy
    invariant: 'Student can withdraw consent + delete all data at any time').
    Identity comes from the verified Supabase session, never a client-sent id
    — a student can only ever request deletion of their own data. Does NOT
    purge anything itself: an admin reviews and approves via
    POST /v1/admin/deletion-requests/{id}/resolve. Resubmitting while a
    request is already pending returns that same request."""
    uid = _verify_user(authorization)
    writer = _writer()
    try:
        student = writer.student_by_auth_uid(uid)
        if student is None:
            raise HTTPException(403, "Your account is not linked to a student record.")
        row = writer.create_deletion_request(student["id"])
        writer.append_audit("api:student", "deletion_request", {"student_id": student["id"]})
    finally:
        writer.close()
    return row


@router.get("/me/deletion-request")
def my_deletion_request(authorization: str | None = Header(None)) -> dict:
    """The caller's most recent deletion request (pending/approved/denied),
    or {"request": null} if they've never asked — lets the UI restore its
    'submitted' state after a page reload instead of forgetting it."""
    uid = _verify_user(authorization)
    writer = _writer()
    try:
        student = writer.student_by_auth_uid(uid)
        if student is None:
            raise HTTPException(403, "Your account is not linked to a student record.")
        row = writer.latest_deletion_request(student["id"])
    finally:
        writer.close()
    return {"request": row}
