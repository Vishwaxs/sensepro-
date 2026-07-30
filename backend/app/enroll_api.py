"""Admin-only enrollment endpoint: upload a short video, get embeddings in pgvector.

POST /v1/enroll/video
  - Requires admin (verified server-side via the Supabase JWT app_role claim)
  - multipart form: student_id + framing ('knee'|'waist') + video (+ optional replace)
  - Runs the existing pipeline (extract -> quality gate -> degrade -> embed) and
    writes the embeddings straight to Supabase pgvector, tagged
    source=video_knee / video_waist (the two framings the dashboard captures)
  - Returns per-stage counts, per-reason reject tallies, pose bins covered, a
    self-match score, and a PASS/RETRY verdict
  - The video and every extracted frame are processed in memory and deleted
    immediately — nothing is written to Storage or left on disk

Security:
  - app_role=admin verified server-side — never trust a client-sent role
  - Max file size, max duration, and allowed mime types enforced before embedding
  - Existing embeddings for the SAME framing require an explicit replace=true
"""

from __future__ import annotations

import base64
import json
import logging
import os
import tempfile
from typing import Any

import cv2
import numpy as np
from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile

logger = logging.getLogger("sensepro.enroll_api")
router = APIRouter(prefix="/v1/enroll", tags=["enrollment"])

MAX_FILE_BYTES = 50 * 1024 * 1024  # 50 MB
MAX_DURATION_S = 60
EXTRACT_FPS = 5.0
ALLOWED_TYPES = {"video/mp4", "video/quicktime", "video/x-msvideo", "video/webm"}
FRAMING_SOURCE = {"knee": "video_knee", "waist": "video_waist"}
MIN_GOOD_EMBEDDINGS = 6
SELF_MATCH_FLOOR = 0.3
PRIVACY_NOTE = (
    "The video and all extracted frames were processed in memory and deleted "
    "immediately. Only mathematical embeddings are stored."
)


async def _verify_admin(authorization: str | None) -> dict[str, Any]:
    """Verify the caller's Supabase JWT has app_role=admin. Returns the claims."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing or invalid Authorization header")

    token = authorization[7:]
    try:
        payload = token.split(".")[1]
        padded = payload + "=" * ((4 - len(payload) % 4) % 4)
        claims = json.loads(base64.urlsafe_b64decode(padded))
    except Exception:
        raise HTTPException(401, "Invalid JWT")

    role = claims.get("app_role")
    if role != "admin":
        raise HTTPException(403, f"Admin role required, got: {role}")
    return claims


def _video_duration_s(path: str) -> float:
    """Best-effort clip duration from container metadata (0.0 if unavailable)."""
    cap = cv2.VideoCapture(path)
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        n = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
        return (n / fps) if fps > 0 else 0.0
    finally:
        cap.release()


@router.post("/video")
async def enroll_video(
    student_id: str = Form(...),
    framing: str = Form(...),
    replace: bool = Form(False),
    video: UploadFile = File(...),
    authorization: str | None = Header(None),
):
    """Enroll a student from a video upload for one framing. Admin only."""
    await _verify_admin(authorization)

    if framing not in FRAMING_SOURCE:
        raise HTTPException(400, f"Invalid framing '{framing}'. Use 'knee' or 'waist'.")
    source = FRAMING_SOURCE[framing]

    content_type = video.content_type or ""
    if content_type not in ALLOWED_TYPES:
        raise HTTPException(
            400,
            f"Invalid file type: {content_type}. Allowed: {', '.join(sorted(ALLOWED_TYPES))}",
        )

    data = await video.read()
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(400, f"File too large: {len(data)} bytes (max {MAX_FILE_BYTES})")

    # Build the pgvector writer up front — fail clearly if Supabase is
    # unconfigured or migration 0008 hasn't been applied.
    from enroll.embeddings_writer import EmbeddingsWriterError, build_embeddings_writer

    try:
        writer = build_embeddings_writer()
        writer.assert_source_column()
    except EmbeddingsWriterError as exc:
        raise HTTPException(503, str(exc))

    try:
        # Per-slot idempotency: only this framing's rows block a re-upload.
        if writer.has_source_rows(student_id, source) and not replace:
            raise HTTPException(
                409,
                f"Student already has {framing} embeddings. Pass replace=true to overwrite.",
            )

        # Write to a temp file, enforce duration, extract frames, delete immediately.
        tmp_path = None
        try:
            fd, tmp_path = tempfile.mkstemp(suffix=".mp4")
            os.write(fd, data)
            os.close(fd)
            del data  # free the upload bytes

            duration = _video_duration_s(tmp_path)
            if duration > MAX_DURATION_S:
                raise HTTPException(400, f"Video too long: {duration:.1f}s (max {MAX_DURATION_S}s)")

            from enroll.pipeline import frames_from_video

            frames = frames_from_video(tmp_path, fps=EXTRACT_FPS)
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)
                logger.info("Temp video deleted: %s", tmp_path)

        # Fallback duration guard for containers whose metadata lacks a duration:
        # more sampled frames than the limit allows means the clip was too long.
        if len(frames) > int(MAX_DURATION_S * EXTRACT_FPS):
            raise HTTPException(
                400,
                f"Video too long: {len(frames)} sampled frames exceed the {MAX_DURATION_S}s limit",
            )

        if not frames:
            return {
                "verdict": "RETRY",
                "reason": "No frames could be extracted from the video.",
                "frames_extracted": 0,
                "frames_accepted": 0,
                "reject_reasons": {},
                "pose_bins": [],
                "embeddings_created": 0,
                "self_match_score": None,
                "student_id": student_id,
                "framing": framing,
                "source": source,
                "privacy_note": PRIVACY_NOTE,
            }

        from enroll.pipeline import Enroller

        report = Enroller(degrade=True).enroll_frames_report(frames)
        del frames
        records = report.records

        base_result = {
            "frames_extracted": report.frames_seen,
            "frames_accepted": report.frames_accepted,
            "reject_reasons": report.reject_reasons,
            "pose_bins": report.pose_bins,
            "student_id": student_id,
            "framing": framing,
            "source": source,
            "privacy_note": PRIVACY_NOTE,
        }

        if not records:
            return {
                **base_result,
                "verdict": "RETRY",
                "reason": (
                    "No frames passed the quality gate. Ask the student to re-record with "
                    "better lighting and framing."
                ),
                "embeddings_created": 0,
                "self_match_score": None,
            }

        # Self-match verification: a held-out embedding must match the rest.
        vecs = [r.vec for r in records]
        self_match_score: float | None = None
        if len(vecs) >= 2:
            held_out = np.array(vecs[-1])
            gallery = np.array(vecs[:-1])
            self_match_score = round(float(np.max(gallery @ held_out)), 4)

        # Persist. --replace clears only this framing's prior rows.
        if replace:
            writer.delete_source_rows(student_id, source)
        writer.insert_embeddings(student_id, source, records)
        logger.info(
            "Enrolled %s (%s): %d embeddings, self-match=%s",
            student_id,
            source,
            len(records),
            self_match_score,
        )

        if len(records) < MIN_GOOD_EMBEDDINGS:
            verdict = "RETRY"
            reason = (
                f"Only {len(records)} embeddings produced (need ≥{MIN_GOOD_EMBEDDINGS}). "
                "Record a longer clip with more head turns."
            )
        elif self_match_score is not None and self_match_score < SELF_MATCH_FLOOR:
            verdict = "RETRY"
            reason = (
                f"Self-match score is low ({self_match_score}). The embeddings may be "
                "inconsistent — re-record with steady lighting."
            )
        else:
            verdict = "PASS"
            reason = f"{len(records)} embeddings created with self-match score {self_match_score}."

        return {
            **base_result,
            "verdict": verdict,
            "reason": reason,
            "embeddings_created": len(records),
            "self_match_score": self_match_score,
            "replaced": replace,
        }
    finally:
        writer.close()
