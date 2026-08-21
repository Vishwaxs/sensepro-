"""Resend Email Notification Service for SensePro+

Provides automated email dispatch for:
- Session completion summaries (attendance, engagement VNEI, proctor flags)
- Proctoring & Cheating alerts (phone detection, extra person in exams)
- Data deletion & privacy requests (student GDPR / DPDP requests)
- Test & diagnostic emails
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger("sensepro.notify")

RESEND_API_URL = "https://api.resend.com/emails"


def is_configured() -> bool:
    """Returns True if the Resend API key is configured."""
    return bool(settings.resend_api_key and settings.resend_api_key.startswith("re_"))


async def send_email(
    to: str | list[str],
    subject: str,
    html: str,
    text: str | None = None,
) -> dict[str, Any]:
    """Sends an email via Resend API.
    
    Returns a dict with success boolean and resend message id or error message.
    """
    if not is_configured():
        logger.warning("Resend API key not configured. Skipping email to %s", to)
        return {"success": False, "error": "Resend API key not configured"}

    recipients = [to] if isinstance(to, str) else to
    payload: dict[str, Any] = {
        "from": settings.resend_from_email,
        "to": recipients,
        "subject": subject,
        "html": html,
    }
    if text:
        payload["text"] = text

    headers = {
        "Authorization": f"Bearer {settings.resend_api_key}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.post(RESEND_API_URL, headers=headers, json=payload)
            if res.status_code in (200, 201):
                data = res.json()
                logger.info("Email sent successfully to %s, id: %s", recipients, data.get("id"))
                return {"success": True, "id": data.get("id")}
            else:
                error_msg = f"Resend API error ({res.status_code}): {res.text}"
                logger.error(error_msg)
                return {"success": False, "error": error_msg}
    except Exception as e:
        logger.exception("Failed to send email via Resend: %s", e)
        return {"success": False, "error": str(e)}


def _brand_wrapper(title: str, content_html: str) -> str:
    """Wraps notification content in a modern, responsive HTML email template."""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <style>
    body {{
      margin: 0;
      padding: 0;
      background-color: #07070A;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #EDEDED;
    }}
    .container {{
      max-width: 600px;
      margin: 30px auto;
      background: #111116;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }}
    .header {{
      background: linear-gradient(135deg, #1C1917, #0C0A09);
      border-bottom: 1px solid rgba(245, 158, 11, 0.2);
      padding: 24px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }}
    .logo {{
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: #EDEDED;
    }}
    .logo span {{
      color: #F59E0B;
    }}
    .badge {{
      display: inline-block;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      background: rgba(245, 158, 11, 0.15);
      color: #F59E0B;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }}
    .content {{
      padding: 32px;
    }}
    .stat-grid {{
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin: 24px 0;
    }}
    .stat-card {{
      background: #18181E;
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      padding: 16px;
    }}
    .stat-label {{
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #888891;
      margin-bottom: 6px;
    }}
    .stat-val {{
      font-size: 24px;
      font-weight: 800;
      color: #EDEDED;
    }}
    .stat-val.ok {{
      color: #10B981;
    }}
    .stat-val.accent {{
      color: #F59E0B;
    }}
    .footer {{
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding: 20px 32px;
      font-size: 12px;
      color: #666670;
      text-align: center;
      background: #0D0D11;
    }}
    .btn {{
      display: inline-block;
      background: #F59E0B;
      color: #07070A !important;
      font-weight: 700;
      text-decoration: none;
      padding: 12px 24px;
      border-radius: 6px;
      margin-top: 20px;
      font-size: 13px;
      letter-spacing: 0.05em;
    }}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">SensePro<span>+</span></div>
      <div class="badge">Notification</div>
    </div>
    <div class="content">
      {content_html}
    </div>
    <div class="footer">
      Automated system dispatch from SensePro+ Vision &amp; Attendance Platform.<br>
      © 2026 SensePro+. All rights reserved.
    </div>
  </div>
</body>
</html>"""


async def send_session_summary_notification(
    session_id: str,
    class_section: str,
    subject: str,
    mode: str,
    present_count: int,
    total_enrolled: int = 53,
    attended_count: int | None = None,
    vnei_pct: float | None = None,
    flags_count: int = 0,
    to_email: str | None = None,
) -> dict[str, Any]:
    """Dispatches a session summary email when a classroom or exam session ends."""
    recipient = to_email or settings.admin_notify_email
    if not recipient:
        return {"success": False, "error": "No recipient email configured"}

    att_count = attended_count if attended_count is not None else present_count
    attendance_pct = round((att_count / max(total_enrolled, 1)) * 100, 1)
    vnei_display = f"{int(vnei_pct * 100)}%" if vnei_pct is not None else "N/A"
    proctor_status = f"{flags_count} flag(s)" if flags_count > 0 else "0 flags (Clean)"
    proctor_color = "#EF4444" if flags_count > 0 else "#10B981"

    body_html = f"""
      <h2 style="margin:0 0 8px 0; font-size:22px; font-weight:800; color:#EDEDED;">Session Completed</h2>
      <p style="margin:0 0 20px 0; font-size:14px; color:#A0A0AA;">
        Session for <strong>{class_section}</strong> — <strong>{subject}</strong> ({mode.capitalize()}) has ended.
      </p>

      <div class="stat-grid" style="display:flex; flex-wrap:wrap; gap:12px;">
        <div class="stat-card" style="flex:1 1 45%; min-width:180px;">
          <div class="stat-label">Attended Headcount</div>
          <div class="stat-val ok">{att_count} <span style="font-size:14px; color:#888891; font-weight:normal;">/ {total_enrolled} ({attendance_pct}%)</span></div>
        </div>
        <div class="stat-card" style="flex:1 1 45%; min-width:180px;">
          <div class="stat-label">Session Mode</div>
          <div class="stat-val accent" style="font-size:20px; text-transform:uppercase;">{mode}</div>
        </div>
        <div class="stat-card" style="flex:1 1 45%; min-width:180px;">
          <div class="stat-label">Class Attention (VNEI)</div>
          <div class="stat-val">{vnei_display}</div>
        </div>
        <div class="stat-card" style="flex:1 1 45%; min-width:180px;">
          <div class="stat-label">Proctor Flags</div>
          <div class="stat-val" style="font-size:18px; color:{proctor_color};">{proctor_status}</div>
        </div>
      </div>

      <p style="margin:20px 0 0 0; font-size:13px; color:#888891; line-height:1.6;">
        All presence records and biometric hashes have been synchronized with the encrypted audit store.
      </p>
    """

    subject_line = f"SensePro+ Session Summary: {class_section} · {subject} ({att_count}/{total_enrolled} Attended)"
    html = _brand_wrapper("Session Summary", body_html)
    return await send_email(to=recipient, subject=subject_line, html=html)


async def send_proctor_alert_notification(
    session_id: str,
    flag_type: str,
    student_name: str | None = None,
    student_reg: str | None = None,
    timestamp_str: str | None = None,
    to_email: str | None = None,
) -> dict[str, Any]:
    """Dispatches an urgent alert email when a cheating flag (e.g. mobile phone) is recorded."""
    recipient = to_email or settings.admin_notify_email
    if not recipient:
        return {"success": False, "error": "No recipient email configured"}

    ts = timestamp_str or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    name_display = student_name or "Unassigned / Extra Person"
    reg_display = f"({student_reg})" if student_reg else ""

    body_html = f"""
      <h2 style="margin:0 0 8px 0; font-size:22px; font-weight:800; color:#EF4444;">⚠️ Exam Proctoring Alert</h2>
      <p style="margin:0 0 20px 0; font-size:14px; color:#A0A0AA;">
        A suspicious proctoring event has been flagged during an active examination session.
      </p>

      <div style="background:#18181E; border-left:4px solid #EF4444; border-radius:6px; padding:16px; margin:20px 0;">
        <div style="font-size:12px; color:#888891; text-transform:uppercase; letter-spacing:0.1em;">Flag Type</div>
        <div style="font-size:18px; font-weight:700; color:#EDEDED; margin-top:4px;">{flag_type.replace('_', ' ').title()}</div>
        
        <div style="font-size:12px; color:#888891; text-transform:uppercase; letter-spacing:0.1em; margin-top:12px;">Candidate</div>
        <div style="font-size:16px; font-weight:600; color:#EDEDED; margin-top:4px;">{name_display} {reg_display}</div>
        
        <div style="font-size:12px; color:#888891; text-transform:uppercase; letter-spacing:0.1em; margin-top:12px;">Logged At</div>
        <div style="font-size:14px; font-family:monospace; color:#A0A0AA; margin-top:4px;">{ts}</div>
      </div>

      <p style="margin:16px 0 0 0; font-size:13px; color:#888891;">
        Status is currently <strong>PENDING HUMAN REVIEW</strong>. Please review this item in the Proctor Queue console.
      </p>
    """

    subject_line = f"🚨 SensePro+ Proctor Alert: {flag_type.replace('_', ' ').title()} ({name_display})"
    html = _brand_wrapper("Proctoring Alert", body_html)
    return await send_email(to=recipient, subject=subject_line, html=html)


async def send_deletion_request_notification(
    student_id: str,
    student_name: str,
    student_reg: str,
    reason: str | None = None,
    to_email: str | None = None,
) -> dict[str, Any]:
    """Dispatches a notification when a student submits a facial template deletion request."""
    recipient = to_email or settings.admin_notify_email
    if not recipient:
        return {"success": False, "error": "No recipient email configured"}

    reason_display = reason or "Standard DPDP compliance / consent revocation request"

    body_html = f"""
      <h2 style="margin:0 0 8px 0; font-size:22px; font-weight:800; color:#F59E0B;">Facial Data Deletion Request</h2>
      <p style="margin:0 0 20px 0; font-size:14px; color:#A0A0AA;">
        A student has exercised their right to erasure under privacy compliance policies.
      </p>

      <div style="background:#18181E; border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:18px; margin:20px 0;">
        <div style="font-size:11px; text-transform:uppercase; color:#888891; letter-spacing:0.1em;">Student Name</div>
        <div style="font-size:17px; font-weight:700; color:#EDEDED; margin-top:4px;">{student_name}</div>

        <div style="font-size:11px; text-transform:uppercase; color:#888891; letter-spacing:0.1em; margin-top:12px;">Registration Number</div>
        <div style="font-size:15px; font-family:monospace; color:#F59E0B; margin-top:4px;">{student_reg}</div>

        <div style="font-size:11px; text-transform:uppercase; color:#888891; letter-spacing:0.1em; margin-top:12px;">Reason / Notes</div>
        <div style="font-size:14px; color:#A0A0AA; margin-top:4px; font-style:italic;">"{reason_display}"</div>
      </div>

      <p style="font-size:13px; color:#888891;">
        Action required: Open the Admin Console Deletion Queue to execute cryptographic purge and resolve this request.
      </p>
    """

    subject_line = f"SensePro+ Privacy Request: Erasure Request from {student_name} ({student_reg})"
    html = _brand_wrapper("Data Erasure Request", body_html)
    return await send_email(to=recipient, subject=subject_line, html=html)


async def send_test_notification(to_email: str | None = None) -> dict[str, Any]:
    """Sends a verification test email."""
    recipient = to_email or settings.admin_notify_email
    if not recipient:
        return {"success": False, "error": "No recipient email configured"}

    body_html = f"""
      <h2 style="margin:0 0 8px 0; font-size:22px; font-weight:800; color:#10B981;">Resend Integration Active</h2>
      <p style="margin:0 0 20px 0; font-size:14px; color:#A0A0AA;">
        SensePro+ email notification services are operational and verified.
      </p>
      <div style="background:#18181E; border-radius:8px; padding:16px; font-size:13px; color:#A0A0AA; line-height:1.6;">
        <div><strong>Sender:</strong> {settings.resend_from_email}</div>
        <div style="margin-top:6px;"><strong>Recipient:</strong> {recipient}</div>
        <div style="margin-top:6px;"><strong>Timestamp:</strong> {datetime.now().strftime("%Y-%m-%d %H:%M:%S UTC")}</div>
        <div style="margin-top:6px;"><strong>Status:</strong> Connected &amp; Delivering</div>
      </div>
    """

    subject_line = "SensePro+ Notification Channel Verified"
    html = _brand_wrapper("Channel Verification", body_html)
    return await send_email(to=recipient, subject=subject_line, html=html)


# In-memory rate limiter state for admin role request alerts
_last_role_request_email_time: datetime | None = None
ROLE_REQUEST_EMAIL_MIN_INTERVAL_SECONDS = 180  # 3 minutes cooldown between admin emails


async def notify_admin_role_request_with_rate_limit(
    requester_email: str,
    requester_name: str | None,
    requested_role: str,
    reason: str | None,
    pending_count: int,
    force: bool = False,
    to_email: str | None = None,
) -> dict[str, Any]:
    """Dispatches a role request notification email to the administrator, protected
    by rate limiting (minimum 3 minutes cooldown between email blasts to prevent spam).
    Includes the specific requester info and the exact count of pending requests remaining in the queue."""
    global _last_role_request_email_time
    now = datetime.now()

    if not force and _last_role_request_email_time is not None:
        elapsed = (now - _last_role_request_email_time).total_seconds()
        if elapsed < ROLE_REQUEST_EMAIL_MIN_INTERVAL_SECONDS:
            logger.info(
                "Role request email suppressed by rate limit (elapsed %.1fs < %ds). Pending in queue: %d",
                elapsed,
                ROLE_REQUEST_EMAIL_MIN_INTERVAL_SECONDS,
                pending_count,
            )
            return {
                "success": True,
                "rate_limited": True,
                "cooldown_remaining_s": int(ROLE_REQUEST_EMAIL_MIN_INTERVAL_SECONDS - elapsed),
                "pending_count": pending_count,
            }

    recipient = to_email or settings.admin_notify_email
    if not recipient:
        return {"success": False, "error": "No recipient email configured"}

    name_display = requester_name or "New User"
    reason_display = reason or "Standard access request"
    role_display = requested_role.upper()

    body_html = f"""
      <h2 style="margin:0 0 8px 0; font-size:22px; font-weight:800; color:#F59E0B;">New Role Access Request</h2>
      <p style="margin:0 0 20px 0; font-size:14px; color:#A0A0AA;">
        A user has signed in and requested role permissions to access SensePro+.
      </p>

      <div style="background:#18181E; border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:18px; margin:20px 0;">
        <div style="font-size:11px; text-transform:uppercase; color:#888891; letter-spacing:0.1em;">Requester</div>
        <div style="font-size:17px; font-weight:700; color:#EDEDED; margin-top:4px;">{name_display} &lt;{requester_email}&gt;</div>

        <div style="font-size:11px; text-transform:uppercase; color:#888891; letter-spacing:0.1em; margin-top:12px;">Requested Role</div>
        <div style="font-size:16px; font-weight:700; color:#F59E0B; margin-top:4px;">{role_display}</div>

        <div style="font-size:11px; text-transform:uppercase; color:#888891; letter-spacing:0.1em; margin-top:12px;">Reason / Department</div>
        <div style="font-size:14px; color:#A0A0AA; margin-top:4px; font-style:italic;">"{reason_display}"</div>
      </div>

      <div style="background:rgba(245, 158, 11, 0.1); border:1px solid rgba(245, 158, 11, 0.3); border-radius:8px; padding:16px; margin:20px 0; text-align:center;">
        <div style="font-size:12px; text-transform:uppercase; color:#F59E0B; font-weight:600; letter-spacing:0.1em;">Queue Status</div>
        <div style="font-size:28px; font-weight:800; color:#EDEDED; margin:4px 0;">{pending_count} Pending Request{"" if pending_count == 1 else "s"} Remaining</div>
        <div style="font-size:12px; color:#A0A0AA;">Awaiting administrator review in the SensePro+ Admin Console</div>
      </div>

      <div style="text-align:center; margin-top:24px;">
        <a href="{settings.app_url}/admin" class="btn" style="background:#F59E0B; color:#07070A; padding:12px 28px; font-weight:700; text-decoration:none; border-radius:6px; display:inline-block;">
          Open Admin Console &rarr;
        </a>
      </div>
    """

    subject_line = f"🔔 SensePro+ Role Request: {requester_email} ({role_display}) · {pending_count} Pending"
    html = _brand_wrapper("Role Access Request", body_html)
    res = await send_email(to=recipient, subject=subject_line, html=html)
    if res.get("success"):
        _last_role_request_email_time = now
    return res


async def notify_user_role_resolved(
    user_email: str,
    user_name: str | None,
    role: str,
    approved: bool = True,
) -> dict[str, Any]:
    """Dispatches a confirmation email to the user when an admin approves or rejects their role request."""
    if not user_email:
        return {"success": False, "error": "No user email provided"}

    name_display = user_name or "User"
    role_display = role.upper()

    if approved:
        body_html = f"""
          <h2 style="margin:0 0 8px 0; font-size:22px; font-weight:800; color:#10B981;">Access Request Approved</h2>
          <p style="margin:0 0 20px 0; font-size:14px; color:#A0A0AA;">
            Hello {name_display}, your SensePro+ access request has been reviewed and approved by an administrator.
          </p>

          <div style="background:#18181E; border:1px solid rgba(16, 185, 129, 0.3); border-radius:8px; padding:18px; margin:20px 0;">
            <div style="font-size:11px; text-transform:uppercase; color:#888891; letter-spacing:0.1em;">Assigned Role</div>
            <div style="font-size:18px; font-weight:700; color:#10B981; margin-top:4px;">{role_display}</div>
            <div style="font-size:12px; color:#A0A0AA; margin-top:8px;">You now have full permissions for your designated console workspace.</div>
          </div>

          <div style="text-align:center; margin-top:24px;">
            <a href="{settings.app_url}/login" class="btn" style="background:#10B981; color:#07070A; padding:12px 28px; font-weight:700; text-decoration:none; border-radius:6px; display:inline-block;">
              Launch SensePro+ Console &rarr;
            </a>
          </div>
        """
        subject_line = f"🎉 SensePro+ Access Approved: {role_display} Workspace Ready"
    else:
        body_html = f"""
          <h2 style="margin:0 0 8px 0; font-size:22px; font-weight:800; color:#EF4444;">Access Request Update</h2>
          <p style="margin:0 0 20px 0; font-size:14px; color:#A0A0AA;">
            Hello {name_display}, your request for the <strong>{role_display}</strong> role was reviewed and declined by an administrator.
          </p>
          <p style="font-size:13px; color:#888891;">
            If you believe this is an error or need different permissions, please reach out to your institution's SensePro+ administrator.
          </p>
        """
        subject_line = f"SensePro+ Access Request Update ({role_display})"

    html = _brand_wrapper("Access Status Update", body_html)
    return await send_email(to=user_email, subject=subject_line, html=html)
