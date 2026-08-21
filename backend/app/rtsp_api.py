"""Authenticated control and telemetry for backend-side RTSP capture.

The RTSP worker uses the same recognition gallery, session pipeline and
mode-aware observers as the browser WebSocket path. Frames remain in memory.
"""

from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.config import settings
from app.settings_api import STAFF_ROLES, _require_role

logger = logging.getLogger("sensepro.rtsp_api")

router = APIRouter(prefix="/v1/rtsp", tags=["rtsp"])

SessionMode = Literal["lecture", "exam", "workshop"]
_TERMINAL_STATES = frozenset({"complete", "error"})
_RECENT_LIMIT = 32

# Runtime objects never leave this module. Public status is copied into
# ``_recent`` when a worker exits so the frontend can observe the final flush.
_active: dict[str, dict[str, Any]] = {}
_recent: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


class RtspStartRequest(BaseModel):
    session_id: str = Field(min_length=1)
    mode: SessionMode = "lecture"


class RtspStopRequest(BaseModel):
    session_id: str = Field(min_length=1)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _public_status(session_id: str, entry: dict[str, Any]) -> dict[str, Any]:
    """Return JSON-safe state without thread, event, source or camera secrets."""

    state = str(entry.get("status", "starting"))
    telemetry = entry.get("telemetry") or {}
    source = entry.get("source")
    return {
        "session_id": session_id,
        "mode": entry.get("mode"),
        "status": state,
        "running": state not in _TERMINAL_STATES,
        "started_at": entry.get("started_at"),
        "updated_at": entry.get("updated_at"),
        "frames_processed": entry.get("frames_processed", 0),
        "source_state": getattr(source, "state", None),
        "error": entry.get("error"),
        "engagement": telemetry.get("engagement"),
        "proctor": telemetry.get("proctor"),
    }


def _remember_status(session_id: str, entry: dict[str, Any]) -> None:
    _recent[session_id] = _public_status(session_id, entry)
    while len(_recent) > _RECENT_LIMIT:
        oldest = next(iter(_recent))
        _recent.pop(oldest, None)


@router.post("/start", status_code=200)
def start_rtsp(body: RtspStartRequest, authorization: str | None = Header(None)) -> dict:
    """Start one mode-aware RTSP worker for an existing class session."""

    _require_role(authorization, STAFF_ROLES)
    url = settings.rtsp_url
    if not url:
        raise HTTPException(status_code=400, detail="RTSP_URL not configured in backend .env")

    with _lock:
        if body.session_id in _active:
            raise HTTPException(status_code=409, detail="RTSP session already running")

    stop_event = threading.Event()

    def _telemetry(payload: dict) -> None:
        with _lock:
            entry = _active.get(body.session_id)
            if entry is None:
                return
            entry["telemetry"] = payload
            entry["frames_processed"] = entry.get("frames_processed", 0) + 1
            entry["updated_at"] = _utc_now()

    def _run() -> None:
        source = None
        aggregator = None
        writer = None
        final_status = "complete"
        error_detail: str | None = None
        processed = 0
        try:
            # Local imports keep API startup cheap and avoid loading vision or
            # camera dependencies until an authenticated operator starts RTSP.
            from app.store import SessionRecorder, build_writer
            from capture.rtsp_source import RtspSource, mask_rtsp_url
            from capture.run_session import (
                _load_store,
                _parse_enrolled,
                build_observers,
                run_loop,
            )
            from vision.pipeline import SessionPipeline

            store = _load_store()
            pipeline = SessionPipeline(
                store=store,
                reid_interval_s=settings.reid_interval_s,
                miss_threshold=settings.miss_threshold,
                attendance_threshold=settings.attendance_sighting_threshold,
                max_reid_per_frame=settings.max_reid_per_frame,
            )
            writer = build_writer()
            session_start = datetime.now(UTC)
            recorder = (
                SessionRecorder(
                    writer=writer,
                    session_id=body.session_id,
                    session_start=session_start,
                )
                if body.mode == "lecture"
                else None
            )
            fps = (
                settings.sample_fps_exam
                if body.mode == "exam"
                else settings.sample_fps_lecture
            )
            observers, aggregator = build_observers(
                mode=body.mode,
                pipeline=pipeline,
                writer=writer,
                session_id=body.session_id,
                session_start=session_start,
                enrolled_by_zone=_parse_enrolled("", len(store.roster)),
                telemetry_sink=_telemetry,
            )

            source = RtspSource(url)
            source.start()
            with _lock:
                entry = _active.get(body.session_id)
                if entry is not None:
                    entry["source"] = source
                    entry["status"] = "running"
                    entry["updated_at"] = _utc_now()

            processed = run_loop(
                source,
                pipeline,
                recorder,
                fps,
                observers=observers,
                sleep=stop_event.wait,
                should_stop=stop_event.is_set,
            )
        except Exception as exc:
            final_status = "error"
            try:
                safe_message = str(exc).replace(url, mask_rtsp_url(url))
            except Exception:  # noqa: BLE001 - error reporting must remain safe
                safe_message = type(exc).__name__
            error_detail = f"{type(exc).__name__}: {safe_message}"[:300]
            logger.exception("RTSP worker failed for session %s", body.session_id)
        finally:
            # run_loop stops the source and closes presence intervals. These
            # calls cover setup/observer failures before run_loop owns cleanup.
            if source is not None:
                try:
                    source.stop()
                except Exception as exc:  # noqa: BLE001
                    logger.warning("RTSP source cleanup failed: %s", exc)

            trailing_rows = []
            if aggregator is not None:
                try:
                    trailing_rows = aggregator.flush()
                except Exception as exc:  # noqa: BLE001
                    if error_detail is None:
                        final_status = "error"
                        error_detail = f"engagement flush failed: {type(exc).__name__}"
                    logger.warning("RTSP engagement flush failed: %s", exc)

            with _lock:
                entry = _active.get(body.session_id)
                if entry is not None:
                    entry["status"] = final_status
                    entry["error"] = error_detail
                    entry["frames_processed"] = max(
                        processed,
                        entry.get("frames_processed", 0),
                    )
                    entry["updated_at"] = _utc_now()
                    telemetry = entry.get("telemetry") or {}
                    if aggregator is not None:
                        engagement = dict(telemetry.get("engagement") or {})
                        last_ts = float(telemetry.get("ts", 0.0))
                        engagement["window"] = aggregator.window_status(last_ts)
                        engagement["reported_zones"] = [row.zone for row in trailing_rows]
                        telemetry["engagement"] = engagement
                        entry["telemetry"] = telemetry
                    _remember_status(body.session_id, entry)
                    _active.pop(body.session_id, None)

            if writer is not None and hasattr(writer, "close"):
                try:
                    writer.close()
                except Exception as exc:  # noqa: BLE001
                    logger.warning("RTSP writer cleanup failed: %s", exc)
            logger.info(
                "RTSP session %s ended: status=%s frames=%d",
                body.session_id,
                final_status,
                processed,
            )

    thread = threading.Thread(
        target=_run,
        name=f"rtsp-{body.session_id[:8]}",
        daemon=True,
    )
    now = _utc_now()
    with _lock:
        # Re-check at the atomic reservation point: two concurrent start
        # requests may both have passed the cheap check above.
        if body.session_id in _active:
            raise HTTPException(status_code=409, detail="RTSP session already running")
        _recent.pop(body.session_id, None)
        _active[body.session_id] = {
            "thread": thread,
            "stop_event": stop_event,
            "source": None,
            "mode": body.mode,
            "status": "starting",
            "started_at": now,
            "updated_at": now,
            "frames_processed": 0,
            "telemetry": {},
            "error": None,
        }

    try:
        thread.start()
    except Exception:
        with _lock:
            _active.pop(body.session_id, None)
        raise
    logger.info("RTSP session started: %s (mode=%s)", body.session_id, body.mode)
    return {
        "session_id": body.session_id,
        "mode": body.mode,
        "status": "started",
        "running": True,
    }


@router.post("/stop", status_code=200)
def stop_rtsp(body: RtspStopRequest, authorization: str | None = Header(None)) -> dict:
    """Signal a worker and return immediately; status reports final flushing."""

    _require_role(authorization, STAFF_ROLES)
    with _lock:
        entry = _active.get(body.session_id)
        if entry is None:
            raise HTTPException(status_code=404, detail="No active RTSP session with that ID")
        entry["status"] = "stopping"
        entry["updated_at"] = _utc_now()
        entry["stop_event"].set()
    logger.info("RTSP stop signal sent for session %s", body.session_id)
    return {"session_id": body.session_id, "status": "stopping", "running": True}


@router.get("/status/{session_id}")
def rtsp_status(session_id: str, authorization: str | None = Header(None)) -> dict:
    """Return the latest inference telemetry without exposing camera internals."""

    _require_role(authorization, STAFF_ROLES)
    with _lock:
        entry = _active.get(session_id)
        if entry is not None:
            return _public_status(session_id, entry)
        recent = _recent.get(session_id)
        if recent is not None:
            return dict(recent)
    raise HTTPException(status_code=404, detail="No RTSP status for that session")


@router.get("/feed")
def rtsp_feed(authorization: str | None = Header(None), token: str | None = None):
    """Stream a staff-authenticated live RTSP view as in-memory MJPEG."""

    if authorization is None and token:
        authorization = f"Bearer {token}"
    _require_role(authorization, STAFF_ROLES)

    import time

    import cv2
    from fastapi.responses import StreamingResponse

    url = settings.rtsp_url
    if not url:
        raise HTTPException(status_code=400, detail="RTSP_URL not configured")

    def generate():
        active_source = None
        with _lock:
            for entry in _active.values():
                if entry.get("source"):
                    active_source = entry["source"]
                    break

        local_source = None
        source_to_use = active_source
        if source_to_use is None:
            from capture.rtsp_source import RtspSource

            local_source = RtspSource(url)
            local_source.start()
            source_to_use = local_source

        try:
            while True:
                data = source_to_use.latest()
                if data is not None:
                    frame, _ = data
                    height, width = frame.shape[:2]
                    if width > 1280:
                        target_width = 1280
                        target_height = int(height * target_width / width)
                        frame = cv2.resize(
                            frame,
                            (target_width, target_height),
                            interpolation=cv2.INTER_AREA,
                        )

                    ok, jpeg = cv2.imencode(
                        ".jpg",
                        frame,
                        [int(cv2.IMWRITE_JPEG_QUALITY), 75],
                    )
                    if ok:
                        yield (
                            b"--frame\r\n"
                            b"Content-Type: image/jpeg\r\n\r\n"
                            + jpeg.tobytes()
                            + b"\r\n"
                        )
                time.sleep(0.05)
        except GeneratorExit:
            pass
        finally:
            if local_source is not None:
                local_source.stop()

    return StreamingResponse(generate(), media_type="multipart/x-mixed-replace; boundary=frame")
