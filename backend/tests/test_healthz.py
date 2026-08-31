"""Preflight /healthz diagnostic: reports demo readiness, never raises."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from vision.pipeline import configured_backend
from vision.stub import StubDetector, StubEmbedder

client = TestClient(app)


def test_healthz_unconfigured(monkeypatch):
    """With no Supabase creds it reports honestly and makes no network call."""
    monkeypatch.setattr(settings, "supabase_url", "")
    monkeypatch.setattr(settings, "supabase_secret_key", "")
    r = client.get("/healthz")
    assert r.status_code == 200
    b = r.json()
    assert b["status"] == "ok"
    # vision_backend reports what the pipeline ACTUALLY loaded, which is the
    # whole point of the field — it previously echoed the configured string and
    # so happily reported "insightface" while the 64-dim stub was running.
    assert b["vision_backend"] == configured_backend()
    assert b["vision_backend"] == "stub"  # pinned by tests/conftest.py
    assert b["vision_backend_class"] == "StubDetector"
    assert b["supabase_configured"] is False
    assert b["embeddings_count"] is None
    assert "not configured" in b["note"].lower()


def test_healthz_flags_backend_drift(monkeypatch):
    """Configured != actually-loaded must surface as degraded, not a green 'ok'.

    This is the exact condition that made a total recognition outage invisible:
    /healthz said "insightface" while the stub was live, so the only symptom was
    the capture socket dying on the first frame containing a face."""
    monkeypatch.setattr(settings, "supabase_url", "")
    monkeypatch.setattr(settings, "supabase_secret_key", "")
    monkeypatch.setenv("VISION_BACKEND", "insightface")  # ask for one...
    monkeypatch.setattr(  # ...but load the other
        "vision.pipeline.build_backend", lambda: (StubDetector(), StubEmbedder())
    )
    b = client.get("/healthz").json()
    assert b["status"] == "degraded"
    assert b["vision_backend"] == "stub"
    assert b["vision_backend_configured"] == "insightface"
    assert "insightface" in b["warning"]


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
    assert b["session_tables_ready"] is True
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


def test_readyz_rejects_unconfigured_persistence(monkeypatch):
    monkeypatch.setattr(settings, "supabase_url", "")
    monkeypatch.setattr(settings, "supabase_secret_key", "")

    r = client.get("/readyz")

    assert r.status_code == 503
    body = r.json()
    assert body["ready"] is False
    assert "persistence_not_configured" in body["blockers"]


def test_readyz_passes_when_models_persistence_and_schema_are_ready(monkeypatch):
    monkeypatch.setattr(settings, "supabase_url", "http://x")
    monkeypatch.setattr(settings, "supabase_secret_key", "k")
    monkeypatch.setattr(settings, "clerk_secret_key", "sk_test_example")

    class FakeW:
        def count_rows(self, table, params=None):
            return {"embeddings": 120, "students": 53}.get(table, 0)

        def close(self):
            pass

    monkeypatch.setattr("app.store.require_supabase_writer", lambda: FakeW())

    r = client.get("/readyz")

    assert r.status_code == 200
    assert r.json()["ready"] is True
    assert r.json()["blockers"] == []


def test_readyz_rejects_missing_exam_schema(monkeypatch):
    monkeypatch.setattr(settings, "supabase_url", "http://x")
    monkeypatch.setattr(settings, "supabase_secret_key", "k")
    monkeypatch.setattr(settings, "clerk_secret_key", "sk_test_example")

    class FakeW:
        def count_rows(self, table, params=None):
            if table == "proctor_flags":
                raise RuntimeError("relation missing")
            return 0

        def close(self):
            pass

    monkeypatch.setattr("app.store.require_supabase_writer", lambda: FakeW())

    r = client.get("/readyz")

    assert r.status_code == 503
    assert "session_schema_unavailable" in r.json()["blockers"]


def test_readyz_rejects_missing_clerk_backend_configuration(monkeypatch):
    monkeypatch.setattr(settings, "supabase_url", "http://x")
    monkeypatch.setattr(settings, "supabase_secret_key", "k")
    monkeypatch.setattr(settings, "clerk_secret_key", "")

    class FakeW:
        def count_rows(self, table, params=None):
            return 0

        def close(self):
            pass

    monkeypatch.setattr("app.store.require_supabase_writer", lambda: FakeW())

    r = client.get("/readyz")

    assert r.status_code == 503
    assert "clerk_backend_not_configured" in r.json()["blockers"]
