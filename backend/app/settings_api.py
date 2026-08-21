"""Global feature toggles (migration 0014).

GET   /v1/settings/{key}  -> staff (teacher/management/admin) read
PATCH /v1/settings/{key}  -> admin-only write

First (only, for now) key: qr_checkin_enabled — read by app/qr_api.py's
issue_token before minting a rotating absentee-QR token, so an admin can
disable the QR fallback campus-wide without a redeploy. Backs the "Global
feature toggle" switch in apps/web/src/routes/_shell.admin.tsx.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from app import auth as app_auth
from app.store import SupabaseNotConfigured, require_supabase_writer

logger = logging.getLogger("sensepro.settings_api")
router = APIRouter(prefix="/v1/settings", tags=["settings"])

STAFF_ROLES = {"teacher", "management", "admin"}
KNOWN_KEYS = {"qr_checkin_enabled"}


def _verify_user(authorization: str | None) -> str:
    return app_auth.verified_uid(authorization)


def _require_role(authorization: str | None, allowed: set[str]) -> dict:
    return app_auth.require_role(authorization, allowed)


def _writer():
    try:
        return require_supabase_writer()
    except SupabaseNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc


class SettingUpdate(BaseModel):
    value: bool


@router.get("/{key}")
def get_setting(key: str, authorization: str | None = Header(None)) -> dict:
    _require_role(authorization, STAFF_ROLES)
    writer = _writer()
    try:
        row = writer.get_setting(key)
    finally:
        writer.close()
    if row is None:
        raise HTTPException(404, f"Unknown setting: {key}")
    return row


@router.patch("/{key}")
def update_setting(
    key: str,
    body: SettingUpdate,
    authorization: str | None = Header(None),
) -> dict:
    if key not in KNOWN_KEYS:
        raise HTTPException(404, f"Unknown setting: {key}")
    claims = _require_role(authorization, {"admin"})
    admin_uid = claims.get("sub") or ""
    writer = _writer()
    try:
        row = writer.set_setting(key, body.value, admin_uid)
        if row is None:
            raise HTTPException(404, f"Unknown setting: {key}")
        writer.append_audit("api:admin", "setting_update", {"key": key, "value": body.value})
    finally:
        writer.close()
    return row
