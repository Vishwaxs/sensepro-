"""FastAPI router for Resend Notification System.

Provides REST endpoints for triggering session summaries, proctor alerts,
privacy request notices, and diagnostic test emails.
"""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException
from pydantic import BaseModel, Field

from app import auth as app_auth
from app.config import settings
from app.notify import (
    is_configured,
    send_deletion_request_notification,
    send_proctor_alert_notification,
    send_session_summary_notification,
    send_test_notification,
)

router = APIRouter(prefix="/v1/notifications", tags=["notifications"])


class TestEmailRequest(BaseModel):
    to_email: str | None = None


class SessionSummaryRequest(BaseModel):
    session_id: str
    class_section: str = "MCA-4B"
    subject: str = "Distributed Systems"
    mode: str = "lecture"
    present_count: int
    total_enrolled: int = 53
    attended_count: int | None = None
    vnei_pct: float | None = None
    flags_count: int = 0
    to_email: str | None = None


class ProctorAlertRequest(BaseModel):
    session_id: str
    flag_type: str
    student_name: str | None = None
    student_reg: str | None = None
    timestamp_str: str | None = None
    to_email: str | None = None


class DeletionRequestNotification(BaseModel):
    student_id: str
    student_name: str
    student_reg: str
    reason: str | None = None
    to_email: str | None = None


@router.get("/status")
def notification_status() -> dict:
    """Returns current notification system status."""
    return {
        "configured": is_configured(),
        "provider": "Resend",
        "from_email": settings.resend_from_email,
        "admin_notify_email": settings.admin_notify_email,
    }


@router.post("/test")
async def send_test_email(body: TestEmailRequest) -> dict:
    """Sends a verification email to test the notification channel."""
    res = await send_test_notification(to_email=body.to_email)
    if not res.get("success"):
        raise HTTPException(status_code=500, detail=res.get("error", "Email dispatch failed"))
    return res


@router.post("/session-summary")
async def send_session_summary(
    body: SessionSummaryRequest,
    background_tasks: BackgroundTasks,
) -> dict:
    """Dispatches a summary report email when a class or exam session finishes."""
    if not is_configured():
        return {"success": False, "detail": "Resend not configured"}

    background_tasks.add_task(
        send_session_summary_notification,
        session_id=body.session_id,
        class_section=body.class_section,
        subject=body.subject,
        mode=body.mode,
        present_count=body.present_count,
        total_enrolled=body.total_enrolled,
        attended_count=body.attended_count,
        vnei_pct=body.vnei_pct,
        flags_count=body.flags_count,
        to_email=body.to_email,
    )
    return {"queued": True}


@router.post("/proctor-alert")
async def send_proctor_alert(
    body: ProctorAlertRequest,
    background_tasks: BackgroundTasks,
) -> dict:
    """Dispatches an urgent alert email when a cheating flag is logged."""
    if not is_configured():
        return {"success": False, "detail": "Resend not configured"}

    background_tasks.add_task(
        send_proctor_alert_notification,
        session_id=body.session_id,
        flag_type=body.flag_type,
        student_name=body.student_name,
        student_reg=body.student_reg,
        timestamp_str=body.timestamp_str,
        to_email=body.to_email,
    )
    return {"queued": True}


@router.post("/deletion-request")
async def send_deletion_request_notice(
    body: DeletionRequestNotification,
    background_tasks: BackgroundTasks,
) -> dict:
    """Dispatches a notification when a student files an erasure request."""
    if not is_configured():
        return {"success": False, "detail": "Resend not configured"}

    background_tasks.add_task(
        send_deletion_request_notification,
        student_id=body.student_id,
        student_name=body.student_name,
        student_reg=body.student_reg,
        reason=body.reason,
        to_email=body.to_email,
    )
    return {"queued": True}
