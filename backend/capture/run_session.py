"""Run a class session from an RTSP camera (or any frame source).

    python -m capture.run_session --rtsp "rtsp://..." --session <id> --mode lecture

The pipeline is transport-agnostic: the WS endpoint feeds it browser frames,
this runner feeds it camera frames, and both drive the SAME
SessionPipeline.process_frame + SessionRecorder write-path. The runner depends
only on the FrameSource protocol below — anything with latest()/stop() works,
which is how tests drive it with synthetic frames and zero network.

Timestamps: the pipeline and recorder use seconds-relative-to-session-start
(the WS path gets them from the client; here they come from a monotonic
clock). The recorder converts them to absolute times against session_start.

The runner samples — it processes the newest frame at SAMPLE_FPS_* and lets
the source discard everything in between. It never creates or ends the
class_sessions row: the session id comes from POST /v1/sessions, same as the
browser path. Frames stay in memory, always.
"""

from __future__ import annotations

import argparse
import logging
import time
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

import numpy as np

from app.config import settings
from app.store import SessionRecorder, build_writer
from capture.rtsp_source import RtspSource
from engagement.signals import SignalExtractor
from engagement.vnei import ZONES, ZoneAggregator, live_engagement_view
from proctor.detector import ObjectDetection, build_proctor_detector
from proctor.engine import ProctorEngine
from proctor.suppression import GazeSuppressor
from vision.embedding_store import EmbeddingStore
from vision.pipeline import SessionPipeline

logger = logging.getLogger("sensepro.capture")

FrameObserver = Callable[[np.ndarray, float], None]
TelemetrySink = Callable[[dict], None]
SESSION_MODES = frozenset({"lecture", "exam", "workshop"})


class FrameSource(Protocol):
    def latest(self) -> tuple[np.ndarray, float] | None: ...
    def stop(self) -> None: ...


def _load_store() -> EmbeddingStore:
    """Load Supabase embeddings in production, JSON in offline/dev runs."""

    if settings.supabase_enabled:
        try:
            store = EmbeddingStore.from_supabase(
                settings.supabase_url,
                settings.supabase_postgrest_key,
                threshold=settings.cosine_threshold,
            )
            if store.roster:
                return store
            logger.warning(
                "Supabase embeddings are empty; RTSP falling back to %s",
                settings.enrollment_json,
            )
        except Exception as exc:  # noqa: BLE001 - keep the camera usable offline
            logger.warning(
                "Supabase gallery load failed (%s); RTSP falling back to %s",
                exc,
                settings.enrollment_json,
            )
    path = Path(settings.enrollment_json)
    if path.exists():
        return EmbeddingStore.from_json(path, threshold=settings.cosine_threshold)
    return EmbeddingStore(threshold=settings.cosine_threshold)


def run_loop(
    source: FrameSource,
    pipeline: SessionPipeline,
    recorder: SessionRecorder | None,
    sample_fps: float,
    *,
    observers: Sequence[FrameObserver] = (),
    clock=time.monotonic,
    sleep=time.sleep,
    max_frames: int | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> int:
    """Sample the newest frame at sample_fps and drive the pipeline.

    Observers (proctor engine, engagement aggregation) run after each
    processed frame and may read `pipeline.last_tracks` — so all Phase-3
    analysis happens at the sampled rate, never the camera rate. Returns the
    number of frames processed. Always closes open presence intervals and
    stops the source on the way out — including on Ctrl+C. `clock`/`sleep`/
    `max_frames` are injectable so tests run deterministically and instantly.
    """
    period = 1.0 / sample_fps
    t0 = clock()
    last_frame_ts: float | None = None
    processed = 0
    try:
        while (max_frames is None or processed < max_frames) and not (
            should_stop is not None and should_stop()
        ):
            tick = clock()
            got = source.latest()
            if got is not None:
                frame, frame_ts = got
                if frame_ts != last_frame_ts:  # skip if the source has nothing new
                    last_frame_ts = frame_ts
                    rel_ts = clock() - t0
                    result = pipeline.process_frame(frame, rel_ts)
                    if recorder is not None and result["transitions"]:
                        transitions = [(t["student_id"], t["state"]) for t in result["transitions"]]
                        recorder.record(transitions, rel_ts)
                    for observe in observers:
                        observe(frame, rel_ts)
                    processed += 1
            remaining = period - (clock() - tick)
            if remaining > 0:
                sleep(remaining)
    finally:
        if recorder is not None:
            recorder.close(clock() - t0)
        source.stop()
    return processed


def _parse_enrolled(spec: str, roster_size: int) -> dict[str, int]:
    """Per-zone enrolment for coverage. students.seat_zone is not populated
    yet, so the default is an even split of the enrolled roster — a documented
    approximation, not a claim."""
    if spec:
        pairs = (part.split("=", 1) for part in spec.split(","))
        return {zone.strip(): int(count) for zone, count in pairs}
    q, r = divmod(roster_size, 3)
    return {zone: q + (1 if i < r else 0) for i, zone in enumerate(ZONES)}


def build_observers(
    mode: str,
    pipeline: SessionPipeline,
    writer,
    session_id: str,
    session_start: datetime,
    enrolled_by_zone: dict[str, int],
    *,
    telemetry_sink: TelemetrySink | None = None,
) -> tuple[list[FrameObserver], ZoneAggregator]:
    """Build mode-aware observers for one capture session.

    Exam adds review-only proctoring. Workshop shares the detector only for
    engagement evidence; lecture keeps its existing attendance path and marks
    phone evidence unavailable because no object-detector pass runs.
    """
    if mode not in SESSION_MODES:
        raise ValueError(f"unsupported session mode: {mode}")

    engine = None
    object_detector = None
    detector_error: str | None = None
    if mode in {"exam", "workshop"}:
        # The detector factory owns process-level model caching. Call it once
        # and share the returned instance with every observer in this session.
        try:
            object_detector = build_proctor_detector()
        except Exception as exc:
            detector_error = f"{type(exc).__name__}: object detector unavailable"
            logger.exception("%s object detector failed to initialise", mode)
    if mode == "exam" and object_detector is not None:
        engine = ProctorEngine(
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
    extractor = SignalExtractor()
    aggregator = ZoneAggregator(
        session_id=session_id,
        writer=writer,
        session_start=session_start,
        enrolled_by_zone=enrolled_by_zone,
        window_s=settings.engagement_window_s,
        front_band=settings.zone_front_band,
        back_band=settings.zone_back_band,
    )

    def frame_observer(frame: np.ndarray, rel_ts: float) -> None:
        tracks = pipeline.last_tracks
        phone_dets: list[ObjectDetection] | None = None
        detections: list[ObjectDetection] = []
        written: list = []
        detection_available = object_detector is not None
        if engine is not None:
            try:
                detections = engine.detector.detect(frame)
                written = engine.observe(frame, tracks, rel_ts, detections=detections)
                accepted = getattr(engine, "confirmed_detections", detections)
                phone_dets = [d for d in accepted if d.label == "cell phone"]
            except Exception as exc:  # noqa: BLE001 - preserve pose telemetry
                logger.warning("exam object detection unavailable for frame: %s", exc)
                detection_available = False
                written = engine.observe(frame, tracks, rel_ts, detections=[])
        elif object_detector is not None:
            try:
                detections = object_detector.detect(frame)
                phone_dets = [d for d in detections if d.label == "cell phone"]
            except Exception as exc:  # noqa: BLE001 - optional signal, not the session
                # None means unavailable; [] means measured and clear.
                logger.warning("workshop object detection unavailable for frame: %s", exc)
                detection_available = False
        signals = extractor.extract(tracks, phone_dets, frame.shape[:2])
        emitted = aggregator.observe(
            [(track, signals[track.track_id]) for track in tracks],
            frame.shape[0],
            rel_ts,
        )
        if telemetry_sink is not None:
            engagement = live_engagement_view(signals, aggregator, rel_ts)
            if object_detector is not None:
                metadata = object_detector.metadata
                engagement["phone_detector"] = {
                    "backend": metadata.backend_name,
                    "ready": metadata.ready and detection_available,
                    "production": metadata.production,
                }
            elif mode in {"exam", "workshop"}:
                engagement["phone_detector"] = {
                    "backend": None,
                    "ready": False,
                    "production": False,
                    "error": detector_error,
                }
            view: dict = {
                "type": "rtsp_telemetry",
                "ts": rel_ts,
                "engagement": engagement,
                "reported_zones": [row.zone for row in emitted],
            }
            if mode == "exam":
                if engine is None:
                    view["proctor"] = {
                        "detections": [],
                        "flags": [],
                        "backend": None,
                        "ready": False,
                        "poses": [],
                        "error": detector_error,
                    }
                    telemetry_sink(view)
                    return
                confirmed = getattr(engine, "confirmed_detections", detections)
                poses = getattr(engine, "pose_observations", {})
                metadata = engine.detector.metadata
                view["proctor"] = {
                    "detections": [
                        {
                            "label": detection.label,
                            "box": list(detection.box),
                            "confidence": detection.confidence,
                            "student_id": (
                                track.student_id
                                if (
                                    track := ProctorEngine._nearest_track(
                                        detection,
                                        tracks,
                                    )
                                )
                                is not None
                                else None
                            ),
                        }
                        for detection in confirmed
                    ],
                    "flags": [
                        {
                            "id": flag.id,
                            "flag_type": flag.flag_type,
                            "student_id": flag.student_id,
                            "flagged_at": flag.flagged_at.isoformat(),
                        }
                        for flag in written
                    ],
                    "backend": metadata.backend_name,
                    "ready": metadata.ready and detection_available,
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
            telemetry_sink(view)

    return [frame_observer], aggregator


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="capture.run_session",
        description="Feed an RTSP camera into the live presence pipeline.",
    )
    parser.add_argument("--rtsp", default="", help="RTSP URL (default: RTSP_URL from env)")
    parser.add_argument("--session", required=True, help="class_sessions id to attach to")
    parser.add_argument("--mode", choices=tuple(sorted(SESSION_MODES)), default="lecture")
    parser.add_argument(
        "--max-seconds", type=float, default=None, help="stop after ~N seconds (default: Ctrl+C)"
    )
    parser.add_argument(
        "--enrolled",
        default="",
        help="per-zone enrolment, e.g. front=18,mid=18,back=17 (default: even roster split)",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    url = args.rtsp or settings.rtsp_url
    if not url:
        parser.error("no RTSP URL: pass --rtsp or set RTSP_URL")

    fps = settings.sample_fps_exam if args.mode == "exam" else settings.sample_fps_lecture
    store = _load_store()
    pipeline = SessionPipeline(
        store=store,
        reid_interval_s=settings.reid_interval_s,
        miss_threshold=settings.miss_threshold,
        attendance_threshold=settings.attendance_sighting_threshold,
    )
    writer = build_writer()
    session_start = datetime.now(UTC)
    recorder = (
        SessionRecorder(writer=writer, session_id=args.session, session_start=session_start)
        if args.mode == "lecture"
        else None
    )
    observers, aggregator = build_observers(
        mode=args.mode,
        pipeline=pipeline,
        writer=writer,
        session_id=args.session,
        session_start=session_start,
        enrolled_by_zone=_parse_enrolled(args.enrolled, len(store.roster)),
    )
    source = RtspSource(url)
    source.start()
    max_frames = int(args.max_seconds * fps) if args.max_seconds else None
    try:
        n = run_loop(source, pipeline, recorder, fps, observers=observers, max_frames=max_frames)
        logger.info("session done: %d frames processed", n)
    except KeyboardInterrupt:
        logger.info("interrupted — open intervals closed, source stopped")
    finally:
        aggregator.flush()  # close the trailing engagement window


if __name__ == "__main__":
    main()
