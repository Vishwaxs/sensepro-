# SensePro+

Browser-based attendance + exam proctoring + fairness-aware engagement analytics.
MCA major project · CHRIST University · team of 3 · ~1 month.

**Architecture:** the classroom browser captures the camera (getUserMedia) and streams frames over
a WebSocket to a Python/FastAPI backend that runs face detection, tracking, and recognition, then
streams the live roster back. Frames are processed in memory and never stored. Data lives in
Supabase (Postgres + pgvector + Auth/RLS + Realtime).

## What works in this starter (verified)
- Enrolment CLI: video/frames → quality-gate → embeddings → purge raw (no training; embeddings only).
- WebSocket capture loop: frame → detect → track → re-ID → **presence state machine** (PRESENT →
  UNVERIFIED → ABSENT) → live roster, streamed back to the browser.
- Browser capture client (`web/capture.html`): camera + live recognition overlay + present list.
- Supabase schema with pgvector, k≥5 engagement CHECK, hash-chained audit, cascade delete.
- Full pytest suite (FSM, matcher, tracker, WS loop) — passes with the dependency-free stub backend.

## Quick start (dev, no ML models)
```bash
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
pytest -q                                   # all green
uvicorn app.main:app --reload --port 8000   # start the server (VISION_BACKEND=stub)
```
Enrol a "student" and run recognition with a solid-colour card:
```bash
sensepro-enroll --student-id s1 --video clip.mp4 --out enrollments.json
# open web/capture.html, set server = ws://localhost:8000/ws/capture, Start, hold up the card
```

## Production vision (real faces)
```bash
pip install -e ".[insightface]"            # SCRFD + ArcFace (buffalo_l)
VISION_BACKEND=insightface uvicorn app.main:app --port 8000
```

## Full stack (Phase 2 — persistence, auth, live roster)
```bash
# Backend: copy backend/.env.example -> backend/.env, set SUPABASE_URL +
# SUPABASE_SECRET_KEY (server key; leave blank to run offline with a no-op writer)
cd backend && uvicorn app.main:app --reload --port 8000

# Frontend: copy apps/web/.env.example -> apps/web/.env.local, set
# VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (anon key only, never the secret)
cd apps/web && npm install && npm run dev     # http://localhost:5173
```
Flow: sign in (roles come from the JWT via the access-token hook, migration 0003) →
`POST /v1/sessions` starts a class session → `/capture?session_id=...` streams frames and the
backend persists presence intervals → the teacher roster updates live over Supabase Realtime →
Export PDF. Reads go browser→Postgres under RLS; the backend only writes (ADR 0004/0006).

## Phase 3 — camera, proctor mode, VNEI engagement
```bash
# RTSP camera -> live pipeline (session id from POST /v1/sessions)
python -m capture.run_session --rtsp "rtsp://admin:PW@192.168.1.15:554/cam/realmonitor?channel=1&subtype=0" \
  --session <id> --mode lecture

# Exam mode: adds phone/extra-person proctoring (flags land in the teacher
# review queue as "awaiting review" — humans decide, nothing auto-penalises)
python -m capture.run_session --rtsp "rtsp://..." --session <id> --mode exam
# Real object detection: pip install -e '.[proctor]' && PROCTOR_BACKEND=yolo

# Both modes aggregate VNEI engagement to zones (front/mid/back), k>=5 only.

# Honest numbers from a recorded clip + ground truth (see eval/harness.py
# for the truth JSON shape); reports recognition, duration error, and the
# proctor FP rate with the gaze-down filter ON vs OFF:
python -m eval.run --clip exam.mp4 --truth truth.json --mode exam
```

## Next (per the PRD)
Admin live data, seat-zone mapping, student logins (`students.auth_uid`).
See `docs/SensePro_PRD_v1.md` and `CLAUDE.md`.
