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

## Next (per the PRD)
Supabase persistence of presence + auth/RLS roles + the four dashboards (Week 2); proctor mode +
VNEI engagement aggregation (Week 3). See `docs/SensePro_PRD_v1.md` and `CLAUDE.md`.
