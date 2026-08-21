"""Rotating-QR absentee fallback endpoints (§18 / Phase-5 design; ADR 0009, 0010).

The QR NEVER marks attendance. A teacher opens an absentee window and the
backend mints a short-lived, single-use, rotating token. A student scans it
FROM THEIR AUTHENTICATED APP SESSION and claims it; a successful claim opens a
brief verification window. The window is satisfied by a 1:1 face match — EITHER
the classroom capture pipeline recognising that student's enrolled face, OR the
student's own phone posting a single selfie to /verify (the corner-seat path,
for students the ceiling camera cannot see; ADR 0010). Both write the presence
row (via='qr'). Presence still requires the enrolled face, live, in the room.

Auth:
  - Teacher/admin endpoints: app_role read from the JWT claims.
  - Student claim/verify: identity is VERIFIED against Supabase GoTrue
    (/auth/v1/user), not a bare decode, then bound to the student row via
    auth_uid — a student can only ever claim/verify for themselves.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict, deque
from datetime import datetime, timezone

import cv2
import numpy as np
from fastapi.concurrency import run_in_threadpool
from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel

from app import auth as app_auth
from app.config import settings
from app.store import SupabaseNotConfigured, require_supabase_writer
from vision.embedding_store import EmbeddingStore

logger = logging.getLogger("sensepro.qr_api")
router = APIRouter(prefix="/v1/qr", tags=["qr"])

QR_TOKEN_TTL_S = 75  # tokens rotate before this; single-use regardless
QR_WINDOW_TTL_S = 30  # seconds to reach the camera after a claim
CLAIM_RATE_MAX = 6  # token claims per user per window (in-memory, per-process)
CLAIM_RATE_WINDOW_S = 60
# Selfie retries get their OWN, larger budget. Claim and verify used to share
# one 6-per-minute counter, so a student who claimed a token (1) and then retook
# their selfie a few times — the normal outcome in poor light — hit 429 and was
# locked out for a minute, inside a 30-second verification window. Retrying is
# the student cooperating, not abusing: it costs one face match and can only
# ever satisfy a window they already hold.
VERIFY_RATE_MAX = 20
VERIFY_RATE_WINDOW_S = 60
MAX_SELFIE_BYTES = 4 * 1024 * 1024  # one downscaled still frame — not a video

_claim_hits: dict[str, deque] = defaultdict(deque)
_prober = None  # lazily-built enrolment embedder, reused across verify calls


def _require_role(authorization: str | None, allowed: set[str]) -> dict:
    """Verify the caller and assert their role — signature checked by Supabase."""
    return app_auth.require_role(authorization, allowed)


def _verify_user(authorization: str | None) -> str:
    """Verified auth uid. Delegates to app.auth (see that module on why nothing
    here may read a role out of an unverified token)."""
    return app_auth.verified_uid(authorization)


def _rate_limit(
    key: str,
    *,
    bucket: str = "claim",
    limit: int = CLAIM_RATE_MAX,
    window_s: int = CLAIM_RATE_WINDOW_S,
    message: str = "Too many attempts — wait a moment and rescan.",
) -> None:
    now = time.monotonic()
    hits = _claim_hits[f"{bucket}:{key}"]
    while hits and now - hits[0] > window_s:
        hits.popleft()
    if len(hits) >= limit:
        raise HTTPException(429, message)
    hits.append(now)


def _writer():
    try:
        return require_supabase_writer()
    except SupabaseNotConfigured as exc:
        raise HTTPException(503, str(exc))


def _parse_ts(value: str) -> datetime:
    """Parse a PostgREST timestamp (accepts a trailing 'Z') as tz-aware UTC."""
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _require_qr_mode(session: dict) -> None:
    """QR is an attendance fallback, never an exam/workshop mechanism."""
    if session.get("mode") != "lecture":
        raise HTTPException(409, "QR check-in is available only for attendance sessions.")


def _embed_probe(img: np.ndarray) -> list[float] | None:
    """L2-normalised embedding of the single face in a still selfie, or None if
    no usable face is found. Reuses the quality-gated enrolment embedder, so a
    blurry, dark, or faceless selfie is rejected exactly as an enrolment frame
    would be. The enroller is built once and reused (it may load vision models)."""
    global _prober
    if _prober is None:
        from enroll.pipeline import Enroller

        _prober = Enroller(degrade=False)
    records = _prober.enroll_frames_detailed([img])
    return records[0].vec if records else None


class SessionBody(BaseModel):
    session_id: str


class ClaimBody(BaseModel):
    token: str


@router.post("/token")
def issue_token(body: SessionBody, authorization: str | None = Header(None)) -> dict:
    """Teacher/admin: mint (or rotate) the live token for a session's window."""
    _require_role(authorization, {"teacher", "admin"})
    writer = _writer()
    try:
        setting = writer.get_setting("qr_checkin_enabled")
        if setting is not None and setting["value"] is False:
            raise HTTPException(403, "QR check-in is currently disabled by admin.")
        session = writer.active_session(body.session_id)
        if session is None:
            raise HTTPException(409, "Session is not active")
        _require_qr_mode(session)
        tok = writer.issue_qr_token(body.session_id, QR_TOKEN_TTL_S)
        writer.append_audit("api:teacher", "qr_window_open", {"session_id": body.session_id})
        return {**tok, "ttl_s": QR_TOKEN_TTL_S}
    finally:
        writer.close()


@router.post("/close")
def close_window(body: SessionBody, authorization: str | None = Header(None)) -> dict:
    """Teacher/admin: close the absentee window — outstanding tokens stop working."""
    _require_role(authorization, {"teacher", "admin"})
    writer = _writer()
    try:
        writer.close_qr(body.session_id)
        writer.append_audit("api:teacher", "qr_window_close", {"session_id": body.session_id})
        return {"closed": True}
    finally:
        writer.close()


@router.post("/claim")
def claim(body: ClaimBody, authorization: str | None = Header(None)) -> dict:
    """Student: claim the current token from their authenticated session. Opens
    a verification window; does NOT mark presence (the camera does that)."""
    auth_uid = _verify_user(authorization)
    _rate_limit(auth_uid)
    writer = _writer()
    try:
        student = writer.student_by_auth_uid(auth_uid)
        if student is None:
            raise HTTPException(403, "Your account is not linked to a student record.")

        tok = writer.get_token(body.token)
        if tok is None:
            raise HTTPException(404, "Unknown code — ask for a new one.")
        session = writer.active_session(tok["session_id"])
        if session is None:
            raise HTTPException(409, "That session is not active.")
        _require_qr_mode(session)
        if student["class_section"] != session["class_section"]:
            raise HTTPException(403, "You are not enrolled in this class.")
        if writer.has_open_present(session["id"], student["id"]):
            raise HTTPException(409, "You are already marked present.")

        win = writer.claim_qr_token(body.token, student["id"], QR_WINDOW_TTL_S)
        if win is None:
            raise HTTPException(409, "This code was already used — ask for a new one.")

        writer.append_audit(
            "api:student",
            "qr_claim",
            {
                "session_id": session["id"],
                "student_id": student["id"],
                "window_id": win["window_id"],
            },
        )
        return {
            "window_id": win["window_id"],
            "expires_at": win["expires_at"],
            "seconds": QR_WINDOW_TTL_S,
            "message": (
                "Verify with a quick selfie — you have "
                f"{QR_WINDOW_TTL_S} seconds. Face the camera in good light."
            ),
        }
    finally:
        writer.close()


@router.post("/verify")
async def verify(
    window_id: str = Form(...),
    selfie: UploadFile = File(...),
    authorization: str | None = Header(None),
) -> dict:
    """Student: satisfy an open verification window with a single on-phone selfie.

    The rotating QR proved 'in the room' and the signed-in session proved 'who';
    this proves 'this live person' by a 1:1 face match against the caller's OWN
    enrolled templates. On a match we write the via='qr' presence row through the
    existing path and close the window. This is the corner-seat path — no walk to
    the classroom camera, one small still upload (works on weak phone internet).
    The selfie is decoded in memory and discarded; nothing touches disk."""
    data = await selfie.read()
    # Everything below is blocking: a GoTrue round-trip, several PostgREST
    # calls, a JPEG decode and an ArcFace forward pass. Running it inline in an
    # `async def` pins the event loop for the whole request, which stalls EVERY
    # other connection on the process — including the classroom capture
    # WebSocket that is meanwhile streaming frames. One student's selfie must
    # not freeze the room's attendance. FastAPI would have run this in a
    # threadpool automatically had it been a plain `def`; it is async only to
    # await the upload, so read the upload here and hand the rest to a worker.
    return await run_in_threadpool(_verify_sync, window_id, data, authorization)


def _verify_sync(window_id: str, data: bytes, authorization: str | None) -> dict:
    auth_uid = _verify_user(authorization)
    _rate_limit(
        auth_uid,
        bucket="verify",
        limit=VERIFY_RATE_MAX,
        window_s=VERIFY_RATE_WINDOW_S,
        message="Too many selfie attempts — wait a moment, then try again.",
    )
    writer = _writer()
    try:
        student = writer.student_by_auth_uid(auth_uid)
        if student is None:
            raise HTTPException(403, "Your account is not linked to a student record.")

        win = writer.get_window(window_id)
        if win is None:
            raise HTTPException(404, "Unknown verification window — rescan the code.")
        if win["student_id"] != student["id"]:
            raise HTTPException(403, "That verification window is not yours.")
        if win.get("satisfied_at") is not None:
            raise HTTPException(409, "You are already verified for this window.")
        if _parse_ts(win["expires_at"]) <= datetime.now(timezone.utc):
            raise HTTPException(410, "This window has expired — ask for a new code.")
        session = writer.active_session(win["session_id"])
        if session is None:
            raise HTTPException(409, "That session has ended.")
        _require_qr_mode(session)

        if len(data) > MAX_SELFIE_BYTES:
            raise HTTPException(
                400, f"Image too large: {len(data)} bytes (max {MAX_SELFIE_BYTES})."
            )
        img = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        del data
        if img is None:
            raise HTTPException(400, "Could not read the image — retake the selfie.")

        probe = _embed_probe(img)
        del img
        if probe is None:
            raise HTTPException(
                422, "No clear face detected — face the camera in better light and retry."
            )

        rows = writer.student_templates(student["id"])
        if not rows:
            raise HTTPException(422, "No enrolment on file for you — see the admin to enrol first.")
        store = EmbeddingStore.from_rows(rows, threshold=settings.cosine_threshold)
        sid, score = store.match(np.asarray(probe, dtype=np.float32))
        score = round(float(score), 4)

        # A negative match is a normal outcome, not an error: let the phone retry
        # within the window. Nothing is written.
        if sid is None:
            return {
                "verified": False,
                "score": score,
                "reason": "Face didn't match your enrolment — move into better light and try again.",
            }

        # Atomic single-winner: the camera path may also be satisfying this window.
        if not writer.satisfy_window(window_id):
            raise HTTPException(409, "You are already verified for this window.")
        writer.write_qr_presence(win["session_id"], student["id"], datetime.now(timezone.utc))
        writer.append_audit(
            "api:student",
            "qr_verified",
            {
                "session_id": win["session_id"],
                "student_id": student["id"],
                "window_id": window_id,
                "score": score,
                "via": "selfie",
            },
        )
        return {
            "verified": True,
            "score": score,
            "message": "You're marked present — your face was verified in the room.",
        }
    finally:
        writer.close()
