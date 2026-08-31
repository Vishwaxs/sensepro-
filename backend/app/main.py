"""SensePro+ backend — browser-capture + server-side inference.

The classroom browser streams frames over the /ws/capture WebSocket; the server
runs detect -> track -> re-ID -> presence and streams results back. Frames are
processed in memory and never persisted (CLAUDE.md privacy invariant).
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.admin_api import router as admin_router
from app.config import settings
from app.enroll_api import router as enroll_router
from app.notify_api import router as notify_router
from app.qr_api import router as qr_router
from app.roster_api import router as roster_router
from app.rtsp_api import router as rtsp_router
from app.sessions import router as sessions_router
from app.settings_api import router as settings_router
from app.students_api import router as students_router
from app.ws import router as ws_router

logger = logging.getLogger("sensepro.main")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Warm the vision model ONCE at startup, off the event loop, so the first
    # capture WebSocket connects instantly instead of blocking ~5-10s on model
    # load. build_backend() decides stub vs insightface itself (VISION_BACKEND
    # env var — see its own docstring on why that's os.getenv, not settings)
    # and caches the result as a process-wide singleton; calling it here just
    # pays that cost before traffic arrives instead of on a live session's
    # first frame. Cheap no-op for the stub backend used in dev/CI.
    from vision.pipeline import build_backend

    detector, _ = await run_in_threadpool(build_backend)
    logger.info("vision backend ready: %s", type(detector).__name__)
    if settings.proctor_backend.lower() == "yolo":
        from proctor.detector import build_proctor_detector

        proctor = await run_in_threadpool(build_proctor_detector)
        logger.info("proctor backend ready: %s", proctor.metadata.model_name)
    yield


app = FastAPI(title="SensePro+ API", version="0.1.0", lifespan=lifespan)
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
app.include_router(roster_router)
app.include_router(students_router)
app.include_router(admin_router)
app.include_router(settings_router)
app.include_router(notify_router)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "sensepro-backend",
        "vision_backend": settings.vision_backend,
        "proctor_backend": settings.proctor_backend,
    }


@app.get("/healthz")
def healthz() -> dict:
    """Preflight readiness for a live demo: is the vision backend the real one,
    is Supabase reachable, are embeddings/roster present, and are the QR tables
    live? Best-effort and never raises — a diagnostic safe to curl any time."""
    # Report the backend that is ACTUALLY loaded, not the configured string.
    # These disagreeing is precisely what hid a total recognition outage: the
    # config said "insightface" while the pipeline had built the 64-dim stub,
    # and every face-bearing frame then killed the capture socket. If they ever
    # differ again, say so here rather than reporting a comfortable "ok".
    from vision.pipeline import build_backend, configured_backend

    wanted = configured_backend()
    try:
        detector, _ = build_backend()
        loaded = type(detector).__name__
        active = "stub" if loaded.startswith("Stub") else "insightface"
    except Exception as exc:  # noqa: BLE001 — a diagnostic must never raise
        loaded, active = f"unavailable ({exc})", "unknown"

    try:
        from proctor.detector import build_proctor_detector

        proctor = build_proctor_detector()
        proctor_meta = {
            "backend": proctor.metadata.backend_name,
            "ready": proctor.metadata.ready,
            "model": proctor.metadata.model_name,
            "production": proctor.metadata.production,
        }
    except Exception as exc:  # noqa: BLE001
        proctor_meta = {
            "backend": settings.proctor_backend,
            "ready": False,
            "model": None,
            "production": False,
            "error": str(exc),
        }

    out: dict = {
        "status": "ok",
        "vision_backend": active,
        "vision_backend_configured": wanted,
        "vision_backend_class": loaded,
        "cosine_threshold": settings.cosine_threshold,
        "clerk_configured": bool(settings.clerk_secret_key),
        "supabase_configured": settings.supabase_enabled,
        "embeddings_count": None,
        "roster_count": None,
        "session_tables_ready": None,
        "qr_tables_ready": None,
        "engagement_aggregates_ready": None,
        "proctor": proctor_meta,
    }
    if not proctor_meta["ready"] or (
        settings.proctor_backend.lower() == "yolo" and not proctor_meta["production"]
    ):
        out["status"] = "degraded"
    if active != wanted:
        out["status"] = "degraded"
        out["warning"] = (
            f"VISION_BACKEND resolves to {wanted!r} but the pipeline loaded "
            f"{loaded}. Recognition will fail against a gallery enrolled with "
            f"the other backend."
        )
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
            writer.count_rows("class_sessions")
            writer.count_rows("proctor_flags")
            out["session_tables_ready"] = True
        except Exception:  # noqa: BLE001
            out["session_tables_ready"] = False
            out["status"] = "degraded"
        try:
            writer.count_rows("qr_tokens")
            writer.count_rows("verification_windows")
            out["qr_tables_ready"] = True
        except Exception:  # noqa: BLE001 — migration 0010 likely not applied yet
            out["qr_tables_ready"] = False
        try:
            writer.count_rows("engagement_zone_aggregates")
            out["engagement_aggregates_ready"] = True
        except Exception:  # noqa: BLE001
            out["engagement_aggregates_ready"] = False
            out["status"] = "degraded"
    except Exception as exc:  # noqa: BLE001 — a diagnostic must never raise
        out["status"] = "degraded"
        out["note"] = f"Supabase check failed: {exc}"
    finally:
        if writer is not None:
            writer.close()
    return out


@app.get("/readyz")
def readyz() -> JSONResponse:
    """Strict deployment gate for model, persistence, and schema readiness.

    ``/health`` remains the inexpensive liveness probe and ``/healthz`` remains
    a 200-returning diagnostic. Hosts should route traffic only after this
    endpoint returns 200.
    """
    diagnostic = healthz()
    blockers: list[str] = []

    if diagnostic["vision_backend"] != diagnostic["vision_backend_configured"]:
        blockers.append("vision_backend_mismatch")

    proctor = diagnostic["proctor"]
    if not proctor["ready"]:
        blockers.append("proctor_backend_unavailable")
    elif settings.proctor_backend.lower() == "yolo" and not proctor["production"]:
        blockers.append("production_proctor_not_loaded")

    if not diagnostic["supabase_configured"]:
        blockers.append("persistence_not_configured")
    elif diagnostic["embeddings_count"] is None or diagnostic["roster_count"] is None:
        blockers.append("persistence_unreachable")

    required_schema = {
        "session_tables_ready": "session_schema_unavailable",
        "engagement_aggregates_ready": "engagement_schema_unavailable",
        "qr_tables_ready": "attendance_qr_schema_unavailable",
    }
    for check, blocker in required_schema.items():
        if diagnostic[check] is not True:
            blockers.append(blocker)

    if not diagnostic["clerk_configured"]:
        blockers.append("clerk_backend_not_configured")

    payload = {
        "ready": not blockers,
        "blockers": blockers,
        "checks": diagnostic,
    }
    return JSONResponse(status_code=200 if not blockers else 503, content=payload)
