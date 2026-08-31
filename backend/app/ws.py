"""WebSocket capture endpoint.

Client -> server messages (JSON):
  {"type":"frame","ts":<float>,"jpg_b64":"<base64 jpeg>"}
  {"type":"end"}
Optionally the client sends session_id in the first frame (or as a query param
?session_id=...) so presence writes attach to a real class_sessions row.
Server -> client (JSON): the pipeline result dict (faces, transitions, present),
plus — once a session_id is attached — a live exam-only review view and a
mode-aware engagement view. Unknown model output remains unknown, and VNEI is
suppressed unless both the visibility and pose-observability floors are met.

One SessionPipeline per connection (= per class session) for this starter.
Multi-board fan-in to a shared session is a Phase-2 extension.
"""

from __future__ import annotations

import base64
import binascii
import logging
from datetime import UTC, datetime
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool

from app import auth as app_auth
from app.config import settings
from app.store import (
    SessionRecorder,
    SupabaseNotConfigured,
    build_writer,
    require_supabase_writer,
)
from engagement.signals import SignalExtractor
from engagement.vnei import ZONES, ZoneAggregator, live_engagement_view
from proctor.detector import ObjectDetection, ObjectDetector, build_proctor_detector
from proctor.engine import ProctorEngine
from proctor.suppression import GazeSuppressor
from vision.embedding_store import EmbeddingStore
from vision.pipeline import SessionPipeline

logger = logging.getLogger("sensepro.ws")

router = APIRouter()
CAPTURE_MODES = frozenset({"lecture", "exam", "workshop"})


def _load_store() -> EmbeddingStore:
    """Load the recognition gallery: Supabase pgvector when configured (the
    real photo + video templates), else the enrolment JSON (dev/stub loop).

    A Supabase load that fails or comes back empty falls back to JSON so a
    misconfigured DB never leaves the capture page unable to recognise anyone."""
    if settings.supabase_enabled:
        try:
            store = EmbeddingStore.from_supabase(
                settings.supabase_url,
                settings.supabase_postgrest_key,
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
    # Staff only. This socket drives the attendance write path: whatever
    # session_id it is handed gets presence rows, and every frame costs a
    # detector pass plus ArcFace forward passes. Unauthenticated, anyone who
    # could reach the port could mark a class present or simply exhaust the
    # inference budget. A browser cannot set headers on a WebSocket, so the
    # access token travels as a query parameter — the same approach the MJPEG
    # feed uses, and it is a short-lived token, not a long-lived secret.
    token = ws.query_params.get("token")
    try:
        await run_in_threadpool(
            app_auth.require_role,
            f"Bearer {token}" if token else None,
            app_auth.STAFF_ROLES,
        )
    except HTTPException as exc:
        # 1008 = policy violation. Close BEFORE accept so an unauthorised client
        # never gets a live socket, not even briefly.
        await ws.close(code=1008, reason=str(exc.detail)[:120])
        logger.info("capture socket rejected: %s", exc.detail)
        return

    mode = ws.query_params.get("mode", "lecture")
    if mode not in CAPTURE_MODES:
        await ws.close(code=1008, reason="mode must be lecture, exam, or workshop")
        logger.info("capture socket rejected: unsupported mode %s", mode)
        return

    requested_session_id = ws.query_params.get("session_id")
    validated_writer = None
    if mode in {"exam", "workshop"}:
        if not requested_session_id:
            await ws.close(code=1008, reason=f"{mode} capture requires a persisted session")
            logger.info("capture socket rejected: %s session_id missing", mode)
            return
        try:
            validated_writer = await run_in_threadpool(require_supabase_writer)
            persisted_session = await run_in_threadpool(
                validated_writer.get_session,
                requested_session_id,
            )
        except SupabaseNotConfigured:
            await ws.close(code=1013, reason="session persistence unavailable")
            logger.warning("capture socket rejected: persistence unavailable for %s", mode)
            return
        except Exception as exc:  # noqa: BLE001 - fail the handshake closed
            if validated_writer is not None:
                await run_in_threadpool(validated_writer.close)
            await ws.close(code=1013, reason="session validation unavailable")
            logger.warning("capture session validation failed: %s", exc)
            return
        if (
            persisted_session is None
            or persisted_session.get("mode") != mode
            or persisted_session.get("ends_at") is not None
        ):
            await run_in_threadpool(validated_writer.close)
            await ws.close(
                code=1008, reason="session is missing, ended, or belongs to another mode"
            )
            logger.info(
                "capture socket rejected: invalid %s session %s",
                mode,
                requested_session_id,
            )
            return

    await ws.accept()
    pipe = SessionPipeline(
        store=_load_store(),
        reid_interval_s=settings.reid_interval_s,
        miss_threshold=settings.miss_threshold,
        attendance_threshold=settings.attendance_sighting_threshold,
        max_reid_per_frame=settings.max_reid_per_frame,
    )

    # A session_id (query param or in a message) attaches presence writes to a
    # real class_sessions row. Without one, recognition still runs but nothing
    # persists — useful for the offline stub loop.
    session_writer = validated_writer
    attached_session_id: str | None = None
    recorder: SessionRecorder | None = None
    qr: _QRVerifier | None = None
    session_start = datetime.now(UTC)

    # ---- Proctor + engagement (Phase 3) — same pattern as run_session.py ----
    # These run on every processed frame AFTER the pipeline, reusing last_tracks.
    # Exam writes review-only proctor flags. Workshop shares the object detector
    # solely for phone-nearby engagement evidence; lecture intentionally reports
    # that signal as unavailable and preserves its existing QR attendance path.
    proctor_engine: ProctorEngine | None = None
    object_detector: ObjectDetector | None = None
    detector_error: str | None = None
    signal_extractor = SignalExtractor()
    aggregator: ZoneAggregator | None = None

    def _init_observers(session_id: str, writer) -> None:
        nonlocal proctor_engine, object_detector, detector_error, aggregator
        roster_size = len(pipe.store.roster) if pipe.store.roster else 35
        # Even-split enrolment approximation (no seat_zone data yet)
        q, r = divmod(roster_size, 3)
        enrolled_by_zone = {zone: q + (1 if i < r else 0) for i, zone in enumerate(ZONES)}

        if mode in {"exam", "workshop"}:
            # The detector factory owns process-level caching. Build it once
            # and share that instance with every consumer in this session.
            try:
                object_detector = build_proctor_detector()
            except Exception as exc:
                detector_error = f"{type(exc).__name__}: object detector unavailable"
                logger.exception("%s object detector failed to initialise", mode)
        if mode == "exam" and object_detector is not None:
            proctor_engine = ProctorEngine(
                detector=object_detector,
                suppressor=GazeSuppressor(
                    window_s=settings.gaze_window_s,
                    pitch_down_deg=settings.gaze_pitch_down_deg,
                ),
                writer=writer,
                session_id=session_id,
                session_start=session_start,
                cooldown_s=settings.proctor_cooldown_s,
            )
        aggregator = ZoneAggregator(
            session_id=session_id,
            writer=writer,
            session_start=session_start,
            enrolled_by_zone=enrolled_by_zone,
            window_s=settings.engagement_window_s,
            front_band=settings.zone_front_band,
            back_band=settings.zone_back_band,
        )

    def _observe_frame(frame: np.ndarray, rel_ts: float) -> dict:
        """Run proctor + engagement on the latest processed frame, and return
        a live view (attached to the WS result below) so the capture UI can
        show the exam-mode overlay and class-engagement panel without waiting
        for the DB-persisted flags/aggregates."""
        tracks = pipe.last_tracks
        phone_dets: list[ObjectDetection] | None = None
        detections: list[ObjectDetection] = []
        written: list = []
        if object_detector is not None:
            try:
                detections = object_detector.detect(frame)
                if proctor_engine is not None:
                    written = proctor_engine.observe(
                        frame,
                        tracks,
                        rel_ts,
                        detections=detections,
                    )
                    # Prefer temporally confirmed phone boxes when the current
                    # engine provides them. The fallback keeps old test doubles
                    # and third-party engines source-compatible.
                    accepted = getattr(
                        proctor_engine,
                        "confirmed_detections",
                        detections,
                    )
                    phone_dets = [d for d in accepted if d.label == "cell phone"]
                else:
                    # Workshop measures phones but never creates proctor flags.
                    phone_dets = [d for d in detections if d.label == "cell phone"]
            except Exception as exc:  # noqa: BLE001 - optional signal, not the socket
                logger.warning("%s object detection unavailable for frame: %s", mode, exc)
                # Preserve pose processing in exam mode while leaving the
                # unavailable phone signal unknown rather than inventing zero.
                if proctor_engine is not None:
                    written = proctor_engine.observe(frame, tracks, rel_ts, detections=[])
        signals = signal_extractor.extract(tracks, phone_dets, frame.shape[:2])
        emitted = []
        if aggregator is not None:
            emitted = aggregator.observe(
                [(t, signals[t.track_id]) for t in tracks if t.track_id in signals],
                frame.shape[0],
                rel_ts,
            )

        view: dict = {}
        if mode == "exam":
            if proctor_engine is None:
                view["proctor"] = {
                    "detections": [],
                    "flags": [],
                    "backend": None,
                    "ready": False,
                    "poses": [],
                    "error": detector_error,
                }
            else:
                display_detections = getattr(
                    proctor_engine,
                    "confirmed_detections",
                    detections,
                )
                metadata = object_detector.metadata if object_detector is not None else None
                poses = getattr(proctor_engine, "pose_observations", {})
                view["proctor"] = {
                    "detections": [
                        {
                            "label": d.label,
                            "box": list(d.box),
                            "confidence": d.confidence,
                            "student_id": (
                                t.student_id
                                if (t := ProctorEngine._nearest_track(d, tracks)) is not None
                                else None
                            ),
                        }
                        for d in display_detections
                    ],
                    "flags": [
                        {
                            "id": f.id,
                            "flag_type": f.flag_type,
                            "student_id": f.student_id,
                            "flagged_at": f.flagged_at.isoformat(),
                        }
                        for f in written
                    ],
                    "backend": metadata.backend_name if metadata is not None else None,
                    "ready": metadata.ready if metadata is not None else False,
                    "poses": [
                        {
                            "track_id": track_id,
                            "student_id": next(
                                (
                                    track.student_id
                                    for track in tracks
                                    if track.track_id == track_id
                                ),
                                None,
                            ),
                            "yaw": pose.yaw_deg,
                            "pitch": pose.pitch_deg,
                            "state": (
                                "sustained_away"
                                if pose.sustained
                                else "away"
                                if pose.is_away
                                else "neutral"
                            ),
                        }
                        for track_id, pose in poses.items()
                    ],
                }
        if aggregator is not None:
            engagement = live_engagement_view(signals, aggregator, rel_ts)
            if mode in {"exam", "workshop"}:
                if object_detector is None:
                    engagement["phone_detector"] = {
                        "backend": None,
                        "ready": False,
                        "production": False,
                        "error": detector_error,
                    }
                else:
                    metadata = object_detector.metadata
                    engagement["phone_detector"] = {
                        "backend": metadata.backend_name,
                        "ready": metadata.ready and phone_dets is not None,
                        "production": metadata.production,
                    }
            engagement["reported_zones"] = [row.zone for row in emitted]
            view["engagement"] = engagement
        return view

    def _attach(session_id: str | None) -> None:
        nonlocal session_writer, attached_session_id, recorder, qr
        if not session_id or attached_session_id is not None:
            return
        if session_writer is None:
            session_writer = build_writer()
        attached_session_id = session_id
        # Exam and workshop need recognition/tracks for their own signals,
        # but they are not attendance modules and must not write presence.
        if mode == "lecture":
            recorder = SessionRecorder(
                writer=session_writer,
                session_id=session_id,
                session_start=session_start,
            )
        # Rotating QR is an attendance fallback for lectures only. Exam
        # and workshop sessions never open or close QR presence windows.
        qr = _QRVerifier(session_writer, session_id) if mode == "lecture" else None
        _init_observers(session_id, session_writer)

    _attach(requested_session_id)

    last_ts = 0.0
    ended_explicitly = False
    try:
        while True:
            msg = await ws.receive_json()
            _attach(msg.get("session_id"))  # allow first frame to carry it
            if msg.get("type") == "end":
                ts = float(msg.get("ts", 0.0))
                last_ts = ts
                pipe.fsm.end_session(ts)
                if recorder is not None:
                    # DB writes are sync httpx — keep them off the event loop
                    await run_in_threadpool(recorder.close, ts)
                if qr is not None:
                    await run_in_threadpool(qr.close, datetime.now(UTC))
                if aggregator is not None:
                    await run_in_threadpool(aggregator.flush)
                end_persisted = False
                end_warning = None
                if session_writer is not None and attached_session_id is not None:
                    try:
                        await run_in_threadpool(
                            session_writer.end_session,
                            attached_session_id,
                            datetime.now(UTC),
                        )
                        end_persisted = True
                    except Exception as exc:  # noqa: BLE001 - acknowledge with truthful warning
                        end_warning = "session end could not be persisted"
                        logger.warning("class session end write failed: %s", exc)
                ended_explicitly = True
                await ws.send_json(
                    {
                        "type": "session_ended",
                        "ts": ts,
                        "mode": mode,
                        "persisted": end_persisted,
                        "warning": end_warning,
                    }
                )
                break
            if msg.get("type") != "frame":
                await ws.send_json({"type": "error", "detail": "unknown message type"})
                continue
            frame = _decode_jpg(msg.get("jpg_b64", ""))
            if frame is None:
                await ws.send_json({"type": "error", "detail": "bad frame"})
                continue
            ts = float(msg.get("ts", 0.0))
            last_ts = ts
            # Run detect+track+re-ID in a worker thread. It is CPU-bound (SCRFD +
            # ArcFace) and would otherwise block the event loop for hundreds of ms
            # per real (face-bearing) frame, starving the WebSocket keepalive until
            # the socket drops. Off the loop, the connection stays healthy under load.
            # A single frame must never take the whole session down. Anything
            # thrown in here (a misconfigured backend, a corrupt frame, a model
            # hiccup) used to escape and kill the socket with a 1006, which the
            # kiosk could only show as a permanently "reconnecting" OFFLINE
            # state — indistinguishable from the backend being down. Report the
            # failure on the socket and keep the session alive instead.
            try:
                result = await run_in_threadpool(pipe.process_frame, frame, ts)
            except Exception as exc:
                logger.exception("frame processing failed")
                await ws.send_json(
                    {"type": "error", "detail": f"frame processing failed: {exc}", "fatal": True}
                )
                continue
            if recorder is not None and result["transitions"]:
                transitions = [(t["student_id"], t["state"]) for t in result["transitions"]]
                await run_in_threadpool(recorder.record, transitions, ts)
            # Proctor + engagement observer (same thread-pool as the pipeline).
            # Its return value (live detections/flags/engagement counts) is
            # attached to the result the client already gets — see the type
            # docstring at the top of this file.
            if aggregator is not None:
                view = await run_in_threadpool(_observe_frame, frame, ts)
                result.update(view)
            if mode == "workshop":
                # Workshop transport is anonymous, not merely workshop UI.
                # The shared face pipeline supplies boxes/tracks needed for
                # aggregate signals, but identity and attendance-shaped fields
                # must not cross the socket boundary for this mode.
                anonymous_faces = [
                    {**face, "student_id": None, "score": 0.0} for face in result.get("faces", [])
                ]
                result["faces"] = anonymous_faces
                result["present"] = [f"participant-{face['track_id']}" for face in anonymous_faces]
                result["attended"] = []
                result["transitions"] = []
            if qr is not None:
                recognized = {f["student_id"] for f in result["faces"] if f.get("student_id")}
                if recognized:
                    await run_in_threadpool(qr.observe, recognized, datetime.now(UTC), ts)
            await ws.send_json(result)
    except WebSocketDisconnect:
        logger.info("capture socket disconnected: mode=%s", mode)
    except RuntimeError as exc:
        # The socket dropped mid-processing (tab throttle, proxy hiccup, reload),
        # so a send landed after the close — starlette raises RuntimeError. That
        # is an expected end-of-connection, not a fault: log and exit cleanly so
        # it never surfaces as an unhandled 500-style error. The client's
        # auto-reconnect re-establishes the session.
        logger.info("capture socket closed mid-frame: %s", exc)
    finally:
        if session_writer is not None and not ended_explicitly:
            # A transport drop is not a class-session end: leave ends_at open
            # for reconnect. Close only this socket's presence intervals and
            # flush its partial aggregate window so no in-memory state leaks.
            if recorder is not None:
                try:
                    await run_in_threadpool(recorder.close, last_ts)
                except Exception as exc:  # noqa: BLE001 - best-effort disconnect cleanup
                    logger.warning("disconnect presence cleanup failed: %s", exc)
            if aggregator is not None:
                try:
                    await run_in_threadpool(aggregator.flush)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("disconnect engagement flush failed: %s", exc)
        if session_writer is not None and hasattr(session_writer, "close"):
            try:
                await run_in_threadpool(session_writer.close)
            except Exception as exc:  # noqa: BLE001
                logger.warning("capture writer close failed: %s", exc)
