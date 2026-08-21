# Chapter 3 — System Design & Architecture

## 3.1 High-Level Architecture

SensePro+ follows a **browser-capture → server-inference → database-centric read** architecture:

```
┌──────────────┐       WebSocket/RTSP        ┌────────────────────┐
│  Capture      │ ──── frames (in memory) ──→ │  FastAPI Backend    │
│  (Browser/    │                             │  (detect → track → │
│   RTSP/       │ ←── roster + VNEI JSON ──── │   re-ID → presence) │
│   Webcam)     │                             └──────────┬─────────┘
└──────────────┘                                         │ service role writes
                                                         ▼
                                              ┌────────────────────┐
                                              │  Supabase           │
                                              │  (Postgres+pgvector │
                                              │   RLS, Realtime)    │
                                              └──────────┬─────────┘
                                                         │ RLS-scoped reads
                                                         ▼
                                              ┌────────────────────┐
                                              │  TanStack Start    │
                                              │  Web UI (4 roles)  │
                                              └────────────────────┘
```

**Key invariant:** Frames flow from capture source → server → inference → discard. No frame or raw image is ever persisted to disk or database. Only mathematical embeddings (enrollment) and structured presence/engagement results are written.

## 3.2 Source-Agnostic Capture (ADR 0008)

The system accepts frames from three sources through a unified interface:

| Source | Transport | Latency | Use Case |
|--------|-----------|---------|----------|
| Browser webcam | WebSocket (base64 JPEG) | ~50ms | Development, backup |
| USB/DSLR webcam | Browser getUserMedia | ~50ms | Enrollment capture |
| CP Plus RTSP camera | Backend cv2.VideoCapture | ~100ms | Production classroom |

All sources produce `(frame: ndarray, ts: float)` tuples. The pipeline sees no difference.

## 3.3 Database-Centric Read Path

The frontend **never** calls the backend for data reads. All dashboards consume Supabase directly:

- Teacher dashboard → `class_sessions`, `presence_intervals` (RLS: own sessions)
- Management dashboard → `engagement_zone_aggregates` (RLS: staff)
- Student `/me` → `presence_intervals` (RLS: own rows via `auth_uid`)
- Admin → all tables

Supabase Realtime pushes row changes to open dashboard connections; no polling.

## 3.4 Role-Based Access Control

Four application roles enforced at three levels:

1. **Database (RLS):** `app_role` JWT claim drives Postgres policies on every table.
2. **Router (beforeLoad guards):** TanStack Router `beforeLoad` rejects unauthorised navigation.
3. **UI (conditional rendering):** Secondary; never the sole enforcement.

| Route | Roles |
|-------|-------|
| `/capture`, `/teacher`, `/sessions`, `/proctor` | teacher, admin |
| `/management`, `/trends` | management, admin |
| `/admin`, `/enrollment` | admin |
| `/me` | any authenticated |

## 3.5 Deployment Topology

Single-server deployment suitable for one classroom:

- **Backend:** Python 3.11 + FastAPI + uvicorn (GPU optional — CPU inference viable at 2 fps).
- **Database:** Supabase Cloud (Postgres 15, pgvector, PostgREST, GoTrue).
- **Frontend:** TanStack Start (Vite + React 19) served via npm dev server or static build.
- **Camera:** CP Plus RTSP camera at 10.101.40.189 (1080p, H.264).

See `docs/report/figures/architecture.mmd` for the Mermaid diagram.
