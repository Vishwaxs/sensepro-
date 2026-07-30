# Chapter 4 — Implementation

## 4.1 Vision Pipeline

The core inference pipeline processes each frame through four stages:

### 4.1.1 Detection (SCRFD)

SCRFD detects faces in each frame, returning bounding boxes with confidence scores. Configuration:

- Model: `buffalo_l` (InsightFace model pack) — SCRFD-10GF with GN.
- Input resolution: 640×640 (auto-padded).
- Confidence threshold: 0.5.
- Face size floor: 60px height (below this, quality gate rejects).

### 4.1.2 Tracking (ByteTrack)

ByteTrack maintains identity persistence across frames:

- **High-confidence matching:** IoU-based association for detections above 0.6 confidence.
- **Low-confidence recovery:** Second pass for partially occluded faces.
- **Track lifecycle:** New track after 3 consecutive detections; lost after `miss_threshold` (default 3) consecutive misses.

### 4.1.3 Re-Identification (ArcFace)

Periodic re-ID matches tracked faces against the enrollment gallery:

- Embedding: 512-dimensional ArcFace vector, L2-normalised.
- Distance metric: Cosine similarity.
- Threshold: 0.45 (configurable via `COSINE_THRESHOLD`).
- Re-ID interval: Every 30 seconds per track (configurable via `REID_INTERVAL_S`).
- Gallery: pgvector with IVFFlat index (50 lists) for O(√n) search.

### 4.1.4 Presence FSM

Each student's attendance state is managed by a finite state machine:

| Current State | Event | Next State |
|--------------|-------|------------|
| ABSENT | Face matched | PRESENT |
| PRESENT | Track lost for `miss_threshold` re-ID cycles | UNVERIFIED |
| UNVERIFIED | Face re-matched within session | PRESENT |
| UNVERIFIED | Session ends | ABSENT (if never re-confirmed) |

State transitions are written to `presence_intervals` via the service role (RLS-bypassing).

## 4.2 Enrollment Pipeline

Enrollment converts DSLR photos or video into embeddings — this is **not training**:

1. **Frame extraction:** 5 fps from video, or all images from a directory.
2. **Quality gate:** Face size ≥60px, blur variance ≥40, brightness 40–220.
3. **Pose binning:** Left / centre / right based on face centroid position. Top 3 sharpest per bin.
4. **Degrade-augmentation:** Each accepted crop is downscaled to 96px and 64px, JPEG-compressed at Q40, blurred at σ=0.6, then upscaled back. This simulates the board-camera view and is critical for bridging the DSLR→classroom quality gap.
5. **Embedding:** ArcFace on each variant; L2-normalised.
6. **Purge:** Raw frames/video deleted immediately. Only embeddings persist.

Typical yield: 2-3 photos → ~9-15 embeddings per student (3 pose bins × 3 variants each).

## 4.3 Proctoring Engine

Exam-mode proctoring detects policy violations with human-in-the-loop review:

### 4.3.1 Phone Detection

- YOLOv8n-based detector (or stub in dev mode).
- Each detection becomes a `proctor_flag` row with status `awaiting_review`.
- Cooldown period: 30s per track to avoid flag flooding.

### 4.3.2 Gaze-Down Suppression

The gaze-down filter reduces false positives from students looking at their desks:

- Head pose estimation extracts pitch angle.
- If a track's pitch has been below −25° for the past 10 seconds, phone flags for that track are suppressed.
- This is the measurable improvement: the eval harness compares FP counts with filter ON vs OFF.

### 4.3.3 Review Queue

- Flags appear in the `/proctor` dashboard for teacher/admin.
- Staff may only change `review_status` — never delete flags or modify detection metadata.
- Enforced by a Postgres trigger (`proctor_flags_review_only_trg`).

## 4.4 Engagement Analytics (VNEI)

Visual Non-verbal Engagement Index, reported per zone:

- **Zone assignment:** Frame height divided into front (bottom 34%), mid (34-66%), back (top 34%).
- **Engagement window:** 60-second sliding window.
- **k-anonymity floor:** Zones with fewer than 5 tracked faces are suppressed — no number reported.
- **Coverage:** `tracked ÷ enrolled_in_zone`. Below 50% = low-confidence (hatched); below 70% = caution.
- **Structural guarantee:** No `student_id` column exists in `engagement_zone_aggregates`. Individual engagement tracking is architecturally impossible.

## 4.5 Frontend

TanStack Start (React 19, Vite) with:

- **Routing:** File-based routes with `beforeLoad` guards for role enforcement.
- **State management:** Supabase Realtime subscriptions for live data.
- **Design system:** Custom CSS tokens, glassmorphism panels, dark/light theme.
- **Charts:** Recharts for VNEI trend and zone visualisation.

## 4.6 Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend | TanStack Start + React | 19.x |
| Bundler | Vite | 8.x |
| Backend | Python + FastAPI | 3.11 / 0.115 |
| Detection | SCRFD (InsightFace) | buffalo_l |
| Tracking | ByteTrack (custom) | — |
| Recognition | ArcFace (InsightFace) | buffalo_l |
| Database | Supabase (Postgres 15) | — |
| Vector search | pgvector | 0.7 |
| Auth | Supabase GoTrue | — |
| Camera | CP Plus RTSP | H.264 |
