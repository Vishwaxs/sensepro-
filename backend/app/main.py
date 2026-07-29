"""SensePro+ backend — browser-capture + server-side inference.

The classroom browser streams frames over the /ws/capture WebSocket; the server
runs detect -> track -> re-ID -> presence and streams results back. Frames are
processed in memory and never persisted (CLAUDE.md privacy invariant).
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.enroll_api import router as enroll_router
from app.qr_api import router as qr_router
from app.rtsp_api import router as rtsp_router
from app.sessions import router as sessions_router
from app.ws import router as ws_router

app = FastAPI(title="SensePro+ API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.allow_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(ws_router)
app.include_router(sessions_router)
app.include_router(rtsp_router)
app.include_router(enroll_router)
app.include_router(qr_router)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "sensepro-backend",
        "vision_backend": settings.vision_backend,
    }


@app.get("/healthz")
def healthz() -> dict:
    """Preflight readiness for a live demo: is the vision backend the real one,
    is Supabase reachable, are embeddings/roster present, and are the QR tables
    live? Best-effort and never raises — a diagnostic safe to curl any time."""
    out: dict = {
        "status": "ok",
        "vision_backend": settings.vision_backend,
        "cosine_threshold": settings.cosine_threshold,
        "supabase_configured": settings.supabase_enabled,
        "embeddings_count": None,
        "roster_count": None,
        "qr_tables_ready": None,
    }
    if not settings.supabase_enabled:
        out["note"] = "Supabase not configured — set SUPABASE_URL + SUPABASE_SECRET_KEY."
        return out

    from app.store import require_supabase_writer

    writer = None
    try:
        writer = require_supabase_writer()
        out["embeddings_count"] = writer.count_rows("embeddings")
        out["roster_count"] = writer.count_rows("students")
        try:
            writer.count_rows("qr_tokens")
            writer.count_rows("verification_windows")
            out["qr_tables_ready"] = True
        except Exception:  # noqa: BLE001 — migration 0010 likely not applied yet
            out["qr_tables_ready"] = False
    except Exception as exc:  # noqa: BLE001 — a diagnostic must never raise
        out["status"] = "degraded"
        out["note"] = f"Supabase check failed: {exc}"
    finally:
        if writer is not None:
            writer.close()
    return out
