"""WebSocket capture endpoint.

Client -> server messages (JSON):
  {"type":"frame","ts":<float>,"jpg_b64":"<base64 jpeg>"}
  {"type":"end"}
Server -> client (JSON): the pipeline result dict (faces, transitions, present).

One SessionPipeline per connection (= per class session) for this starter.
Multi-board fan-in to a shared session is a Phase-2 extension.
"""

from __future__ import annotations

import base64
import binascii
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import settings
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
    try:
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "end":
                ts = float(msg.get("ts", 0.0))
                pipe.fsm.end_session(ts)
                await ws.send_json({"type": "session_ended", "ts": ts})
                break
            if msg.get("type") != "frame":
                await ws.send_json({"type": "error", "detail": "unknown message type"})
                continue
            frame = _decode_jpg(msg.get("jpg_b64", ""))
            if frame is None:
                await ws.send_json({"type": "error", "detail": "bad frame"})
                continue
            result = pipe.process_frame(frame, float(msg.get("ts", 0.0)))
            await ws.send_json(result)
    except WebSocketDisconnect:
        return
