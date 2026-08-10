"""Read-only roster for the capture UI.

Resolves recognised student ids (the students.id UUIDs the WS returns) to names
and reg_nos, and gives the class headcount for the "present / N" denominator.

Reads through the service-role writer so it works regardless of the browser
session's RLS app_role — the capture kiosk's JWT may not carry one, which would
otherwise make a direct browser `students` read come back empty (and the overlay
fall back to showing raw UUIDs). No frames, no attendance state — just the class
list, reachable through the same trusted origin that serves the capture page.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.store import SupabaseNotConfigured, require_supabase_writer

router = APIRouter(prefix="/v1", tags=["roster"])


@router.get("/roster")
def roster(class_section: str | None = None) -> dict:
    """Class roster (id -> reg_no, full_name) plus the headcount. `class_section`
    scopes it to one class; omitted returns everyone."""
    try:
        writer = require_supabase_writer()
    except SupabaseNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc
    try:
        students = writer.list_students(class_section)
    finally:
        writer.close()
    return {"students": students, "count": len(students)}
