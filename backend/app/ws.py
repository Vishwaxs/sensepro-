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
import logging
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

logger = logging.getLogger("sensepro.ws")

router = APIRouter()


def _load_store() -> EmbeddingStore:
    """Load the recognition gallery: Supabase pgvector when configured (the
    real photo + video templates), else the enrolment JSON (dev/stub loop).

    A Supabase load that fails or comes back empty falls back to JSON so a
    misconfigured DB never leaves the capture page unable to recognise anyone."""
    if settings.supabase_enabled:
        try:
            store = EmbeddingStore.from_supabase(
                settings.supabase_url,
                settings.supabase_secret_key,
                threshold=settings.cosine_threshold,
            )
            if store.roster:
                logger.info(
                    "roster: %d templates for %d students from Supabase pgvector",
                    len(store._ids),
                    len(store.roster),
                )
                return store
            logger.warning(
                "Supabase embeddings table is empty — falling back to %s",
                settings.enrollment_json,
            )
        except Exception as exc:  # noqa: BLE001 — never leave capture without a gallery
            logger.warning(
                "Supabase roster load failed (%s) — falling back to %s",
                exc,
                settings.enrollment_json,
            )

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


class _QRVerifier:
    """Satisfies open QR verification windows when a windowed student's enrolled
    face is recognised, writing a via='qr' presence row through the existing
    write-path. Purely additive to passive recognition: it is disabled unless
    the writer is a real Supabase writer, refreshes open windows on an interval
    (not every frame), and swallows its own errors so the capture loop never
    stalls. Window expiry writes nothing."""

    def __init__(self, writer: object, session_id: str, refresh_s: float = 3.0) -> None:
        self.writer = writer
        self.session_id = session_id
        self.refresh_s = refresh_s
        self._targets: dict[str, str] = {}  # student_id -> window_id
        self._last_refresh = -1e9
        self._enabled = hasattr(writer, "open_verification_targets")

    def observe(self, recognized_ids: set[str], at: datetime, ts: float) -> None:
        if not self._enabled:
            return
        if ts - self._last_refresh >= self.refresh_s:
            self._last_refresh = ts
            try:
                self._targets = self.writer.open_verification_targets(self.session_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning("qr targets refresh failed: %s", exc)
                self._targets = {}
        for sid in recognized_ids & set(self._targets):
            window_id = self._targets.pop(sid)
            try:
                if self.writer.satisfy_window(window_id):
                    self.writer.write_qr_presence(self.session_id, sid, at)
                    self.writer.append_audit(
                        "system:capture",
                        "qr_verified",
                        {"session_id": self.session_id, "student_id": sid, "window_id": window_id},
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning("qr verify write failed: %s (%s)", sid, exc)

    def close(self, at: datetime) -> None:
        if self._enabled and hasattr(self.writer, "close_open_qr_presence"):
            try:
                self.writer.close_open_qr_presence(self.session_id, at)
            except Exception as exc:  # noqa: BLE001
                logger.warning("qr presence close failed: %s", exc)


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
    qr: _QRVerifier | None = None
    session_start = datetime.now(timezone.utc)

    def _attach(session_id: str | None) -> None:
        nonlocal recorder, qr
        if session_id and recorder is None:
            writer = build_writer()
            recorder = SessionRecorder(
                writer=writer,
                session_id=session_id,
                session_start=session_start,
            )
            qr = _QRVerifier(writer, session_id)

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
                if qr is not None:
                    await run_in_threadpool(qr.close, datetime.now(timezone.utc))
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
            if qr is not None:
                recognized = {f["student_id"] for f in result["faces"] if f.get("student_id")}
                if recognized:
                    await run_in_threadpool(qr.observe, recognized, datetime.now(timezone.utc), ts)
            await ws.send_json(result)
    except WebSocketDisconnect:
        return
