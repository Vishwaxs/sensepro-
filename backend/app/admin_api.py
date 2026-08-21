"""Admin-only actions that don't fit the per-feature routers.

POST /v1/admin/deletion-requests/{id}/resolve
  - Admin-only (not teacher — an irreversible biometric purge is a stricter
    bar than the staff-role actions elsewhere). Approve deletes the
    student's embeddings and withdraws their consent (app/store.py); deny
    leaves everything untouched. Backs the "Deletion queue" tab in
    apps/web/src/routes/_shell.admin.tsx and the request flow in
    apps/web/src/routes/_shell.me.tsx (migration 0013).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from app import auth as app_auth
from app.store import SupabaseNotConfigured, require_supabase_writer

logger = logging.getLogger("sensepro.admin_api")
router = APIRouter(prefix="/v1/admin", tags=["admin"])


def _verify_user(authorization: str | None) -> str:
    return app_auth.verified_uid(authorization)


def _require_admin(authorization: str | None) -> dict:
    return app_auth.require_role(authorization, app_auth.ADMIN_ONLY)


def _writer():
    try:
        return require_supabase_writer()
    except SupabaseNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc


class DeletionResolveBody(BaseModel):
    approve: bool


@router.post("/deletion-requests/{request_id}/resolve")
def resolve_deletion(
    request_id: str,
    body: DeletionResolveBody,
    authorization: str | None = Header(None),
) -> dict:
    """Approve purges the student's embeddings + withdraws consent — the
    actions _shell.me.tsx's copy promises the student. Deny leaves the
    student's data untouched. Purge runs BEFORE the status flip: if it fails,
    the request stays 'pending' and is safely retryable rather than marked
    resolved with nothing actually purged. The status flip itself is a
    guarded single-winner PATCH, so two admins resolving the same request
    concurrently can't both succeed."""
    claims = _require_admin(authorization)
    admin_uid = claims.get("sub") or ""
    writer = _writer()
    try:
        req = writer.get_deletion_request(request_id)
        if req is None:
            raise HTTPException(404, "Unknown deletion request")
        if req["status"] != "pending":
            raise HTTPException(409, f"Already {req['status']}")

        if body.approve:
            try:
                writer.delete_student_embeddings(req["student_id"])
                writer.withdraw_consent(req["student_id"], datetime.now(timezone.utc))
            except httpx.HTTPStatusError as exc:
                raise HTTPException(502, f"Purge failed, request left pending: {exc}") from exc

        resolved = writer.resolve_deletion_request(
            request_id, "approved" if body.approve else "denied", admin_uid
        )
        if resolved is None:
            raise HTTPException(409, "Already resolved by another admin")
        writer.append_audit(
            "api:admin",
            "deletion_resolve",
            {
                "request_id": request_id,
                "student_id": req["student_id"],
                "approved": body.approve,
            },
        )
    finally:
        writer.close()
    return resolved


# ---------- Role access requests ----------
class RoleRequestSubmitBody(BaseModel):
    email: str
    full_name: str | None = None
    requested_role: str = "teacher"
    reason: str | None = None
    user_id: str | None = None


class RoleRequestResolveBody(BaseModel):
    approve: bool
    role: str | None = None


VALID_ROLES = {"teacher", "management", "admin", "student"}


@router.post("/role-requests/submit", tags=["auth"])
async def submit_role_request(body: RoleRequestSubmitBody) -> dict:
    """Submit or update a role access request from the unassigned /no-role page.
    Automatically calculates remaining pending requests and notifies admin with rate-limiting."""
    email = body.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, "Valid email address required")

    requested_role = body.requested_role.strip().lower()
    if requested_role not in VALID_ROLES:
        raise HTTPException(400, f"Invalid requested_role. Must be one of: {', '.join(VALID_ROLES)}")

    user_id = body.user_id or email
    writer = _writer()
    try:
        req = writer.create_role_request(
            user_id=user_id,
            email=email,
            full_name=body.full_name,
            requested_role=requested_role,
            reason=body.reason,
        )
        pending_count = writer.count_pending_role_requests()
    finally:
        writer.close()

    # Dispatch email to admin with rate-limiting & queue count
    from app import notify
    email_res = await notify.notify_admin_role_request_with_rate_limit(
        requester_email=email,
        requester_name=body.full_name,
        requested_role=requested_role,
        reason=body.reason,
        pending_count=pending_count,
    )

    return {
        "success": True,
        "request": req,
        "pending_count": pending_count,
        "notification": email_res,
    }


@router.get("/role-requests/my-status", tags=["auth"])
def get_my_role_request_status(
    email: str | None = None,
    user_id: str | None = None,
) -> dict:
    """Check the latest role request status for the signed-in user."""
    if not email and not user_id:
        raise HTTPException(400, "email or user_id query parameter required")

    writer = _writer()
    try:
        req = writer.get_user_role_request(user_id=user_id, email=email)
    finally:
        writer.close()

    return {"request": req}


@router.get("/role-requests")
def list_role_requests(
    status: str | None = None,
    limit: int = 50,
    authorization: str | None = Header(None),
) -> dict:
    """Admin-only list of all role requests with pending queue count."""
    _require_admin(authorization)
    writer = _writer()
    try:
        items = writer.list_role_requests(status=status, limit=limit)
        pending_count = writer.count_pending_role_requests()
    finally:
        writer.close()

    return {"items": items, "pending_count": pending_count}


@router.post("/role-requests/{request_id}/resolve")
async def resolve_role_request(
    request_id: str,
    body: RoleRequestResolveBody,
    authorization: str | None = Header(None),
) -> dict:
    """Admin-only approval or rejection of a role request.
    On approval, updates user role in Clerk and Supabase user_roles table, and dispatches confirmation email."""
    claims = _require_admin(authorization)
    admin_uid = claims.get("sub") or ""

    writer = _writer()
    try:
        # Fetch existing request
        requests = writer.list_role_requests(limit=100)
        target = next((r for r in requests if str(r.get("id")) == str(request_id)), None)
        if not target:
            raise HTTPException(404, "Unknown role request")

        if target["status"] != "pending":
            raise HTTPException(409, f"Request already {target['status']}")

        assigned_role = body.role or target["requested_role"]
        if assigned_role not in VALID_ROLES:
            assigned_role = "teacher"

        user_id = target.get("user_id") or target.get("email")
        user_email = target.get("email") or ""
        user_name = target.get("full_name")

        if body.approve:
            # 1. Assign role in Supabase user_roles
            writer.assign_user_role(
                user_id=user_id,
                email=user_email,
                role=assigned_role,
                admin_uid=admin_uid,
            )

            # 2. Update Clerk user metadata if clerk_secret_key is configured
            from app.config import settings
            if settings.clerk_secret_key and user_id.startswith("user_"):
                try:
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        clerk_url = f"https://api.clerk.com/v1/users/{user_id}/metadata"
                        clerk_headers = {
                            "Authorization": f"Bearer {settings.clerk_secret_key}",
                            "Content-Type": "application/json",
                        }
                        await client.patch(
                            clerk_url,
                            headers=clerk_headers,
                            json={"public_metadata": {"role": assigned_role}},
                        )
                        logger.info("Updated Clerk role metadata for %s -> %s", user_id, assigned_role)
                except Exception as exc:
                    logger.warning("Clerk role update failed for %s: %s", user_id, exc)

        # 3. Resolve row atomically
        resolved_status = "approved" if body.approve else "rejected"
        resolved = writer.resolve_role_request(
            request_id=request_id,
            status=resolved_status,
            admin_uid=admin_uid,
            resolved_role=assigned_role if body.approve else None,
        )

        writer.append_audit(
            "api:admin",
            "role_request_resolve",
            {
                "request_id": request_id,
                "email": user_email,
                "approved": body.approve,
                "assigned_role": assigned_role if body.approve else None,
            },
        )
    finally:
        writer.close()

    # 4. Dispatch user notification email
    from app import notify
    await notify.notify_user_role_resolved(
        user_email=user_email,
        user_name=user_name,
        role=assigned_role,
        approved=body.approve,
    )

    return {"success": True, "request": resolved}


@router.post("/role-requests/send-digest")
async def send_role_requests_digest(
    authorization: str | None = Header(None),
) -> dict:
    """Manually dispatch a pending role requests digest to the admin email."""
    _require_admin(authorization)
    writer = _writer()
    try:
        pending = writer.list_role_requests(status="pending", limit=50)
        pending_count = len(pending)
    finally:
        writer.close()

    if pending_count == 0:
        return {"success": True, "message": "No pending role requests in queue", "pending_count": 0}

    from app import notify
    latest = pending[0]
    res = await notify.notify_admin_role_request_with_rate_limit(
        requester_email=latest["email"],
        requester_name=latest.get("full_name"),
        requested_role=latest["requested_role"],
        reason=f"Queue digest requested by admin ({pending_count} pending)",
        pending_count=pending_count,
        force=True,
    )
    return {"success": True, "pending_count": pending_count, "result": res}
