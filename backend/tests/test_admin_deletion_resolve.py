"""POST /v1/admin/deletion-requests/{id}/resolve tests (fake writer, no network).

Core invariants under test:
  - admin-only (not teacher — an irreversible biometric purge is a stricter
    bar than the staff-role actions elsewhere).
  - approve purges embeddings + withdraws consent BEFORE the status flip, so
    a purge failure leaves the request retryable instead of falsely resolved.
  - the status flip is a guarded single-winner PATCH: resolving an
    already-resolved request is a 409, never a silent double-purge.
"""

from __future__ import annotations

import base64
import json

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

REQUEST = {"id": "req-1", "student_id": "stud-1", "status": "pending"}


def _jwt(role: str | None) -> str:
    claims = {"app_role": role} if role is not None else {}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"h.{payload}.s"


def _hdr(role: str) -> dict:
    return {"Authorization": f"Bearer {_jwt(role)}"}


class FakeAdminWriter:
    def __init__(self, *, request=REQUEST, db_role=None, purge_fails=False, resolve_returns=None):
        self.request = request
        self.db_role = db_role
        self.purge_fails = purge_fails
        self._resolve_returns = resolve_returns
        self.purged: list[str] = []
        self.withdrawn: list[str] = []
        self.resolved: list[tuple] = []
        self.audits: list = []

    def role_for_auth_uid(self, auth_uid):
        return self.db_role

    def get_deletion_request(self, request_id):
        return self.request

    def delete_student_embeddings(self, student_id):
        if self.purge_fails:
            import httpx

            resp = httpx.Response(502, request=httpx.Request("DELETE", "https://x/embeddings"))
            raise httpx.HTTPStatusError("boom", request=resp.request, response=resp)
        self.purged.append(student_id)
        return 3

    def withdraw_consent(self, student_id, at):
        self.withdrawn.append(student_id)

    def resolve_deletion_request(self, request_id, status, admin_uid):
        self.resolved.append((request_id, status, admin_uid))
        if self._resolve_returns is False:
            return None
        return {"id": request_id, "status": status}

    def append_audit(self, actor, action, payload):
        self.audits.append((action, payload))

    def close(self):
        pass


def _patch_writer(monkeypatch, writer):
    monkeypatch.setattr("app.admin_api.require_supabase_writer", lambda: writer)


def _resolve(request_id="req-1", approve=True, headers=None):
    return client.post(
        f"/v1/admin/deletion-requests/{request_id}/resolve",
        json={"approve": approve},
        headers=headers or _hdr("admin"),
    )


def test_resolve_requires_auth_header():
    r = client.post("/v1/admin/deletion-requests/req-1/resolve", json={"approve": True})
    assert r.status_code == 401


def test_resolve_requires_admin_not_teacher(monkeypatch):
    _patch_writer(monkeypatch, FakeAdminWriter())
    r = _resolve(headers=_hdr("teacher"))
    assert r.status_code == 403


def test_resolve_unknown_request_404(monkeypatch):
    _patch_writer(monkeypatch, FakeAdminWriter(request=None))
    r = _resolve()
    assert r.status_code == 404


def test_resolve_already_resolved_409(monkeypatch):
    _patch_writer(monkeypatch, FakeAdminWriter(request={**REQUEST, "status": "approved"}))
    r = _resolve()
    assert r.status_code == 409


def test_approve_purges_embeddings_and_withdraws_consent(monkeypatch):
    writer = FakeAdminWriter()
    _patch_writer(monkeypatch, writer)
    r = _resolve(approve=True)
    assert r.status_code == 200
    assert writer.purged == ["stud-1"]
    assert writer.withdrawn == ["stud-1"]
    assert writer.resolved == [("req-1", "approved", "")]
    assert any(a[0] == "deletion_resolve" for a in writer.audits)


def test_deny_does_not_purge_anything(monkeypatch):
    writer = FakeAdminWriter()
    _patch_writer(monkeypatch, writer)
    r = _resolve(approve=False)
    assert r.status_code == 200
    assert writer.purged == []
    assert writer.withdrawn == []
    assert writer.resolved == [("req-1", "denied", "")]


def test_purge_failure_returns_502_and_leaves_request_unresolved(monkeypatch):
    """A failed purge must NEVER be silently treated as a successful deletion:
    the status flip must not run, so the request stays retryable."""
    writer = FakeAdminWriter(purge_fails=True)
    _patch_writer(monkeypatch, writer)
    r = _resolve(approve=True)
    assert r.status_code == 502
    assert writer.resolved == []  # status flip never attempted


def test_concurrent_resolve_race_returns_409(monkeypatch):
    """Two admins resolving the same request: the guarded PATCH returns None
    for the loser, which must surface as 409, not a fabricated success."""
    writer = FakeAdminWriter(resolve_returns=False)
    _patch_writer(monkeypatch, writer)
    r = _resolve(approve=True)
    assert r.status_code == 409
