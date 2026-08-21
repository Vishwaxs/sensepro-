from __future__ import annotations

from unittest.mock import AsyncMock, patch
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_submit_role_request_and_check_status():
    with patch("app.notify.notify_admin_role_request_with_rate_limit", new_callable=AsyncMock) as mock_notify:
        mock_notify.return_value = {"success": True, "id": "msg_123"}

        res = client.post(
            "/v1/admin/role-requests/submit",
            json={
                "email": "teacher.new@sensepro.demo",
                "full_name": "New Teacher",
                "requested_role": "teacher",
                "reason": "Joined CS department",
                "user_id": "user_teacher_new_123",
            },
        )
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["success"] is True
        assert data["request"]["email"] == "teacher.new@sensepro.demo"
        assert data["request"]["requested_role"] == "teacher"
        assert data["request"]["status"] == "pending"

        # Check status endpoint
        status_res = client.get(
            "/v1/admin/role-requests/my-status",
            params={"email": "teacher.new@sensepro.demo"},
        )
        assert status_res.status_code == 200
        status_data = status_res.json()
        assert status_data["request"]["email"] == "teacher.new@sensepro.demo"
        assert status_data["request"]["status"] == "pending"


def test_admin_list_and_resolve_role_request():
    # Submit first
    with patch("app.notify.notify_admin_role_request_with_rate_limit", new_callable=AsyncMock) as mock_notify:
        mock_notify.return_value = {"success": True}
        submit_res = client.post(
            "/v1/admin/role-requests/submit",
            json={
                "email": "management.new@sensepro.demo",
                "full_name": "New Manager",
                "requested_role": "management",
                "reason": "Auditing exam sessions",
                "user_id": "user_mgt_456",
            },
        )
        req_id = submit_res.json()["request"]["id"]

    # List as admin
    with patch("app.auth.require_role") as mock_role:
        mock_role.return_value = {"sub": "admin-1", "app_role": "admin"}
        list_res = client.get(
            "/v1/admin/role-requests",
            headers={"Authorization": "Bearer admin-token"},
        )
        assert list_res.status_code == 200
        items = list_res.json()["items"]
        assert any(r["id"] == req_id for r in items)

        # Resolve as approved
        with patch("app.notify.notify_user_role_resolved", new_callable=AsyncMock) as mock_user_notify:
            mock_user_notify.return_value = {"success": True}
            resolve_res = client.post(
                f"/v1/admin/role-requests/{req_id}/resolve",
                headers={"Authorization": "Bearer admin-token"},
                json={"approve": True, "role": "management"},
            )
            assert resolve_res.status_code == 200
            assert resolve_res.json()["success"] is True


@pytest.mark.anyio
async def test_notify_admin_role_request_rate_limiting():
    from app import notify

    with patch("app.notify.send_email", new_callable=AsyncMock) as mock_send:
        mock_send.return_value = {"success": True, "id": "msg_test_1"}

        # First call -> sends email
        res1 = await notify.notify_admin_role_request_with_rate_limit(
            requester_email="user1@sensepro.demo",
            requester_name="User 1",
            requested_role="teacher",
            reason="Test",
            pending_count=1,
            force=False,
            to_email="admin@sensepro.demo",
        )
        assert res1.get("success") is True
        assert res1.get("rate_limited") is not True

        # Second immediate call -> rate-limited without spamming
        res2 = await notify.notify_admin_role_request_with_rate_limit(
            requester_email="user2@sensepro.demo",
            requester_name="User 2",
            requested_role="teacher",
            reason="Test 2",
            pending_count=2,
            force=False,
            to_email="admin@sensepro.demo",
        )
        assert res2.get("success") is True
        assert res2.get("rate_limited") is True
        assert res2.get("pending_count") == 2
