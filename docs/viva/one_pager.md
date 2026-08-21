# SensePro+ — One Pager

## Problem

Classroom attendance in Indian universities is manual, time-consuming (5–10 min/session), and vulnerable to proxy. Existing automated solutions store raw face images, track individual engagement, and lack bias/coverage disclosure.

## Approach

SensePro+ is a **privacy-preserving, camera-based attendance and engagement analytics system** that:

- Identifies enrolled students via ArcFace embeddings (no model training)
- Tracks PRESENT / UNVERIFIED / ABSENT state via a finite state machine
- Reports aggregate zone-level engagement (VNEI) — never per-student
- Supports exam-mode proctoring with human-in-the-loop review

## Architecture

```
Camera (RTSP/Webcam) → FastAPI (SCRFD→ByteTrack→ArcFace→FSM) → Supabase (RLS) → Dashboard
                        ↑ frames in memory only; never stored
```

- **Source-agnostic capture:** RTSP, webcam, and browser all produce `(frame, ts)` tuples
- **Database-centric reads:** Dashboards query Supabase directly via RLS; the backend only writes
- **Four roles:** teacher, management, admin, student — enforced at DB, router, and UI levels

## Results

| Metric | Value |
|--------|-------|
| Recognition hit rate | [TODO: from eval harness] |
| Presence duration error | [TODO: from eval harness] min/60min |
| Proctor FP reduction (gaze filter) | [TODO: from eval harness]% |
| Frame → result latency (p50) | [TODO: from eval harness] ms |

## Differentiators

1. **Embeddings-only:** No raw face images are ever stored — data minimisation by design.
2. **VNEI fairness:** Aggregate engagement with explicit coverage disclosure and k≥5 suppression.
3. **Degrade-augmentation:** Bridges the DSLR→board-camera quality gap without retraining.
4. **Security-first:** Face is convenience, not auth. RLS on every table. Hash-chained audit log.

## Technology Stack

Python 3.11 · FastAPI · SCRFD/ArcFace (InsightFace) · ByteTrack · Supabase (Postgres 15 + pgvector) · TanStack Start (React 19 + Vite) · CP Plus RTSP Camera

## Team

[TODO: Your name and guide]

## Status

Single-classroom prototype validated with [TODO: N] enrolled students. Phase 5 roadmap: self-enrollment kiosk, QR→face-verify, liveness detection, multi-classroom scaling.
