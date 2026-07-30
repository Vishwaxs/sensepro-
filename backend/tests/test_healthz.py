"""Preflight /healthz diagnostic: reports demo readiness, never raises."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app

client = TestClient(app)


def test_healthz_unconfigured(monkeypatch):
    """With no Supabase creds it reports honestly and makes no network call."""
    monkeypatch.setattr(settings, "supabase_url", "")
    monkeypatch.setattr(settings, "supabase_secret_key", "")
    r = client.get("/healthz")
    assert r.status_code == 200
    b = r.json()
    assert b["status"] == "ok"
    assert b["vision_backend"] == settings.vision_backend
    assert b["supabase_configured"] is False
    assert b["embeddings_count"] is None
    assert "not configured" in b["note"].lower()


def test_healthz_reports_counts(monkeypatch):
    monkeypatch.setattr(settings, "supabase_url", "http://x")
    monkeypatch.setattr(settings, "supabase_secret_key", "k")

    class FakeW:
        def count_rows(self, table, params=None):
            return {"embeddings": 120, "students": 53}.get(table, 0)

        def close(self):
            pass

    monkeypatch.setattr("app.store.require_supabase_writer", lambda: FakeW())
    r = client.get("/healthz")
    assert r.status_code == 200
    b = r.json()
    assert b["supabase_configured"] is True
    assert b["embeddings_count"] == 120
    assert b["roster_count"] == 53
    assert b["qr_tables_ready"] is True


def test_healthz_degrades_when_supabase_unreachable(monkeypatch):
    monkeypatch.setattr(settings, "supabase_url", "http://x")
    monkeypatch.setattr(settings, "supabase_secret_key", "k")

    def _boom():
        raise RuntimeError("connection refused")

    monkeypatch.setattr("app.store.require_supabase_writer", _boom)
    r = client.get("/healthz")
    assert r.status_code == 200  # diagnostic never 500s
    assert r.json()["status"] == "degraded"
