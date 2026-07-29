"""REST endpoints to start/stop an RTSP capture session from the frontend.

POST /v1/rtsp/start  {session_id, mode}  -> kicks off the capture.run_session
                                            pipeline in a background thread
POST /v1/rtsp/stop   {session_id}        -> signals the running loop to stop
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import settings

logger = logging.getLogger("sensepro.rtsp_api")

router = APIRouter(prefix="/v1/rtsp", tags=["rtsp"])

# In-flight RTSP sessions keyed by session_id.
_active: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


class RtspStartRequest(BaseModel):
    session_id: str
    mode: str = "lecture"


class RtspStopRequest(BaseModel):
    session_id: str


@router.post("/start", status_code=200)
def start_rtsp(body: RtspStartRequest) -> dict:
    url = settings.rtsp_url
    if not url:
        raise HTTPException(status_code=400, detail="RTSP_URL not configured in backend .env")

    with _lock:
        if body.session_id in _active:
            raise HTTPException(status_code=409, detail="RTSP session already running")

    stop_event = threading.Event()

    def _run() -> None:
        try:
            # Import here to avoid circular imports and keep the module light
            # when the endpoint isn't used.
            from datetime import datetime, timezone
            from pathlib import Path

            from app.store import SessionRecorder, build_writer
            from capture.rtsp_source import RtspSource
            from capture.run_session import build_observers, run_loop
            from vision.embedding_store import EmbeddingStore
            from vision.pipeline import SessionPipeline

            # Build the pipeline (same as capture.run_session.main)
            path = Path(settings.enrollment_json)
            if path.exists():
                store = EmbeddingStore.from_json(path, threshold=settings.cosine_threshold)
            else:
                store = EmbeddingStore(threshold=settings.cosine_threshold)

            pipeline = SessionPipeline(
                store=store,
                reid_interval_s=settings.reid_interval_s,
                miss_threshold=settings.miss_threshold,
            )
            writer = build_writer()
            session_start = datetime.now(timezone.utc)
            recorder = SessionRecorder(
                writer=writer, session_id=body.session_id, session_start=session_start
            )
            fps = settings.sample_fps_exam if body.mode == "exam" else settings.sample_fps_lecture

            # Build observers (proctor + engagement)
            from capture.run_session import _parse_enrolled

            enrolled_by_zone = _parse_enrolled("", len(store.roster))
            observers, aggregator = build_observers(
                mode=body.mode,
                pipeline=pipeline,
                writer=writer,
                session_id=body.session_id,
                session_start=session_start,
                enrolled_by_zone=enrolled_by_zone,
            )

            source = RtspSource(url)
            source.start()
            with _lock:
                if body.session_id in _active:
                    _active[body.session_id]["source"] = source

            def _stoppable_sleep(secs: float) -> None:
                """Sleep that wakes early if the stop event fires."""
                stop_event.wait(secs)

            try:
                run_loop(
                    source,
                    pipeline,
                    recorder,
                    fps,
                    observers=observers,
                    sleep=_stoppable_sleep,
                )
            except Exception:
                logger.exception("RTSP loop error for session %s", body.session_id)
            finally:
                source.stop()
                aggregator.flush()
                with _lock:
                    _active.pop(body.session_id, None)
                logger.info("RTSP session %s ended", body.session_id)
        except Exception:
            logger.exception("RTSP thread setup failed for session %s", body.session_id)
            with _lock:
                _active.pop(body.session_id, None)

    thread = threading.Thread(target=_run, name=f"rtsp-{body.session_id[:8]}", daemon=True)

    with _lock:
        _active[body.session_id] = {"thread": thread, "stop_event": stop_event, "source": None}

    thread.start()
    logger.info("RTSP session started: %s (mode=%s)", body.session_id, body.mode)
    return {"session_id": body.session_id, "status": "started"}


@router.post("/stop", status_code=200)
def stop_rtsp(body: RtspStopRequest) -> dict:
    with _lock:
        entry = _active.get(body.session_id)
    if not entry:
        raise HTTPException(status_code=404, detail="No active RTSP session with that ID")

    entry["stop_event"].set()
    logger.info("RTSP stop signal sent for session %s", body.session_id)
    return {"session_id": body.session_id, "status": "stopping"}


@router.get("/feed")
def rtsp_feed():
    """Stream live RTSP video feed as MJPEG for the frontend player."""
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
                    h, w = frame.shape[:2]
                    if w > 1280:
                        target_w = 1280
                        target_h = int(h * target_w / w)
                        frame_disp = cv2.resize(
                            frame,
                            (target_w, target_h),
                            interpolation=cv2.INTER_AREA,
                        )
                    else:
                        frame_disp = frame

                    ok, jpeg = cv2.imencode(".jpg", frame_disp, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
                    if ok:
                        yield (
                            b"--frame\r\n"
                            b"Content-Type: image/jpeg\r\n\r\n" + jpeg.tobytes() + b"\r\n"
                        )
                time.sleep(0.05)
        except GeneratorExit:
            pass
        finally:
            if local_source is not None:
                local_source.stop()

    return StreamingResponse(generate(), media_type="multipart/x-mixed-replace; boundary=frame")
