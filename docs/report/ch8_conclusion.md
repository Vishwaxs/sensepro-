# Chapter 8 — Conclusion & Future Work

## 8.1 Conclusion

SensePro+ demonstrates that a privacy-preserving, camera-based classroom attendance and engagement analytics system is technically feasible within the constraints of India's DPDP Act and the EU AI Act's emotion-inference prohibition.

**Key contributions:**

1. **Embeddings-only architecture:** No raw face images are ever persisted, achieving data minimisation by design rather than policy.
2. **Aggregate-only engagement:** VNEI reports zone-level engagement with explicit coverage and bias disclosure, structurally preventing per-student scoring.
3. **Degrade-augmentation:** Bridging the DSLR→board-camera quality gap through synthetic degradation at enrollment time, improving cross-domain recognition without additional training.
4. **Source-agnostic capture:** A unified `(frame, ts)` interface supports webcam, RTSP, and browser capture without pipeline changes.
5. **Measurable proctor improvement:** The gaze-down suppression filter provides a quantifiable false-positive reduction, evaluated honestly on the same clip with filter ON vs OFF.

**Key limitation:** The system has been validated in a single-classroom setting with [TODO: N] enrolled students. Recognition accuracy degrades at distances beyond ~6m, and camera coverage is inherently uneven across zones.

## 8.2 Future Work (Section18 Roadmap)

The following features are explicitly deferred to Phase 5 to maintain the current system's stability and integrity:

### 8.2.1 Self-Enrollment Kiosk

A supervised kiosk where students record their own enrollment video under admin observation. This reduces the enrollment bottleneck from "admin captures each student individually" to "admin supervises a queue." The quality gate and degrade-augmentation pipeline remain unchanged.

### 8.2.2 QR→Face-Verify Flow

A two-factor attendance mechanism:

1. Student scans a classroom-specific QR code (proves "in room").
2. Camera detects the student's face within N seconds (proves "this specific person").

This addresses proxy attendance more robustly than face-only: a printed photo cannot scan a QR code, and a QR screenshot from a friend doesn't have the matching face.

### 8.2.3 Face as Convenience Layer

Long-term, face recognition becomes a convenience (no tap-in, no QR scan needed) rather than a primary authentication mechanism. Login remains email/password via Supabase GoTrue. This reflects the architectural principle that **face is never the auth gate**.

### 8.2.4 Liveness Detection

Anti-spoofing measures to detect printed photos and screens. This would require a depth camera or a challenge-response protocol (e.g., "blink" or "turn left"). Deferred because it adds hardware requirements and the current threat model (supervised classroom) has low spoofing risk.

### 8.2.5 Multi-Classroom Scaling

Supporting multiple classrooms requires:
- Multiple RTSP camera sources per session.
- Session-to-camera mapping in the database.
- Cross-camera re-identification (same student seen from different angles).
- Load distribution across inference workers.

This is an engineering challenge, not a research problem — the pipeline architecture supports it, but it hasn't been tested at scale.

## 8.3 Reproducibility

All code, configuration, and evaluation scripts are included in the repository. The evaluation harness produces its results from a recorded clip and a hand-labelled ground truth JSON, ensuring that any reviewer can reproduce the reported numbers.

The repository includes:
- `CLAUDE.md`: all invariants, non-negotiables, and role mappings.
- `docs/adr/`: Architecture Decision Records for every major design choice.
- `supabase/migrations/`: The complete database schema, reproducible via `supabase db push`.
- `backend/eval/`: The evaluation harness with CLI runner.
- `backend/tests/`: Unit and integration tests.
