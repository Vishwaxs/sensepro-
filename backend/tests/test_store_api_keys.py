"""Supabase Data API header contracts for legacy and opaque keys."""

from __future__ import annotations

import httpx

from app.store import SupabaseWriter


class _Client:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs


def _capture_clients(monkeypatch) -> list[_Client]:
    clients: list[_Client] = []

    def factory(**kwargs):
        client = _Client(**kwargs)
        clients.append(client)
        return client

    monkeypatch.setattr(httpx, "Client", factory)
    return clients


def test_opaque_secret_key_is_not_sent_as_a_bearer_token(monkeypatch):
    clients = _capture_clients(monkeypatch)

    SupabaseWriter("https://project.supabase.co", "sb_secret_example")

    headers = clients[0].kwargs["headers"]
    assert headers["apikey"] == "sb_secret_example"
    assert "Authorization" not in headers


def test_legacy_service_role_jwt_keeps_its_bearer_header(monkeypatch):
    clients = _capture_clients(monkeypatch)

    SupabaseWriter("https://project.supabase.co", "legacy.jwt.signature")

    headers = clients[0].kwargs["headers"]
    assert headers["apikey"] == "legacy.jwt.signature"
    assert headers["Authorization"] == "Bearer legacy.jwt.signature"
