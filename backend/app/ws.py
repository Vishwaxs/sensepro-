"""WebSocket capture endpoint.

Client -> server messages (JSON):
  {"type":"frame","ts":<float>,"jpg_b64":"<base64 jpeg>"}
  {"type":"end"}
Optionally the client sends session_id in the first frame (or as a query param
?session_id=...) so presence writes attach to a real class_sessions row.
Server -> client (JSON): the pipeline result dict (faces, transitions, present).

One SessionPipeline per connection (= per class session) for this starter.
Multi-board fan-in to a shared session is a Phase-2 extension.
"""

from __future__ import annotations

import base64
import binascii
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool

from app.config import settings
from app.store import SessionRecorder, build_writer
from vision.embedding_store import EmbeddingStore
from vision.pipeline import SessionPipeline

router = APIRouter()


def _load_store() -> EmbeddingStore:
    path = Path(settings.enrollment_json)
    if path.exists():
        return EmbeddingStore.from_json(path, threshold=settings.cosine_threshold)
    return EmbeddingStore(threshold=settings.cosine_threshold)


def _decode_jpg(b64: str) -> np.ndarray | None:
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        return None
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return img


@router.websocket("/ws/capture")
async def capture(ws: WebSocket) -> None:
    await ws.accept()
    pipe = SessionPipeline(
        store=_load_store(),
        reid_interval_s=settings.reid_interval_s,
        miss_threshold=settings.miss_threshold,
    )

    # A session_id (query param or in a message) attaches presence writes to a
    # real class_sessions row. Without one, recognition still runs but nothing
    # persists — useful for the offline stub loop.
    recorder: SessionRecorder | None = None
    session_start = datetime.now(timezone.utc)

    def _attach(session_id: str | None) -> None:
        nonlocal recorder
        if session_id and recorder is None:
            recorder = SessionRecorder(
                writer=build_writer(),
                session_id=session_id,
                session_start=session_start,
            )

    _attach(ws.query_params.get("session_id"))

    try:
        while True:
            msg = await ws.receive_json()
            _attach(msg.get("session_id"))  # allow first frame to carry it
            if msg.get("type") == "end":
                ts = float(msg.get("ts", 0.0))
                pipe.fsm.end_session(ts)
                if recorder is not None:
                    # DB writes are sync httpx — keep them off the event loop
                    await run_in_threadpool(recorder.close, ts)
                await ws.send_json({"type": "session_ended", "ts": ts})
                break
            if msg.get("type") != "frame":
                await ws.send_json({"type": "error", "detail": "unknown message type"})
                continue
            frame = _decode_jpg(msg.get("jpg_b64", ""))
            if frame is None:
                await ws.send_json({"type": "error", "detail": "bad frame"})
                continue
            ts = float(msg.get("ts", 0.0))
            result = pipe.process_frame(frame, ts)
            if recorder is not None and result["transitions"]:
                transitions = [(t["student_id"], t["state"]) for t in result["transitions"]]
                await run_in_threadpool(recorder.record, transitions, ts)
            await ws.send_json(result)
    except WebSocketDisconnect:
        return
