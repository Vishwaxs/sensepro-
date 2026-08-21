"""GET/PATCH /v1/settings/{key} tests (fake writer, no network, no DB)."""

from __future__ import annotations

import base64
import json

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _jwt(role: str | None) -> str:
    claims = {"app_role": role} if role is not None else {}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"h.{payload}.s"


def _hdr(role: str) -> dict:
    return {"Authorization": f"Bearer {_jwt(role)}"}


class FakeSettingsWriter:
    def __init__(self, *, row=None, db_role=None):
        self.row = row if row is not None else {"key": "qr_checkin_enabled", "value": True}
        self.db_role = db_role
        self.updates: list[tuple] = []
        self.audits: list = []

    def role_for_auth_uid(self, auth_uid):
        return self.db_role

    def get_setting(self, key):
        return self.row if self.row.get("key") == key else None

    def set_setting(self, key, value, admin_uid):
        if self.row.get("key") != key:
            return None
        self.updates.append((key, value, admin_uid))
        self.row = {**self.row, "value": value}
        return self.row

    def append_audit(self, actor, action, payload):
        self.audits.append((action, payload))

    def close(self):
        pass


def _patch(monkeypatch, writer):
    monkeypatch.setattr("app.settings_api.require_supabase_writer", lambda: writer)


# --- GET -------------------------------------------------------------------
def test_get_setting_requires_auth_header():
    r = client.get("/v1/settings/qr_checkin_enabled")
    assert r.status_code == 401


def test_get_setting_requires_staff_role(monkeypatch):
    _patch(monkeypatch, FakeSettingsWriter())
    r = client.get("/v1/settings/qr_checkin_enabled", headers=_hdr("student"))
    assert r.status_code == 403


def test_get_setting_ok_for_teacher(monkeypatch):
    _patch(monkeypatch, FakeSettingsWriter())
    r = client.get("/v1/settings/qr_checkin_enabled", headers=_hdr("teacher"))
    assert r.status_code == 200
    assert r.json()["value"] is True


def test_get_setting_unknown_key_404(monkeypatch):
    _patch(monkeypatch, FakeSettingsWriter())
    r = client.get("/v1/settings/nonexistent", headers=_hdr("admin"))
    assert r.status_code == 404


# --- PATCH -------------------------------------------------------------------
def test_update_setting_requires_admin_not_teacher(monkeypatch):
    _patch(monkeypatch, FakeSettingsWriter())
    r = client.patch(
        "/v1/settings/qr_checkin_enabled", json={"value": False}, headers=_hdr("teacher")
    )
    assert r.status_code == 403


def test_update_setting_unknown_key_404(monkeypatch):
    _patch(monkeypatch, FakeSettingsWriter())
    r = client.patch("/v1/settings/nonexistent", json={"value": False}, headers=_hdr("admin"))
    assert r.status_code == 404


def test_update_setting_ok_and_audits(monkeypatch):
    writer = FakeSettingsWriter()
    _patch(monkeypatch, writer)
    r = client.patch(
        "/v1/settings/qr_checkin_enabled", json={"value": False}, headers=_hdr("admin")
    )
    assert r.status_code == 200
    assert r.json()["value"] is False
    assert writer.updates == [("qr_checkin_enabled", False, "")]
    assert any(a[0] == "setting_update" for a in writer.audits)
