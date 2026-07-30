# Chapter 7 — Results & Discussion

## 7.1 Recognition Performance

[TODO: paste recognition results from Chapter 6 here and discuss]

### 7.1.1 The Quality Gap Problem

DSLR enrollment photos are captured at close range (~0.5m) with good lighting and resolution. The board camera operates at 2–6m with inferior optics. This "quality gap" means that embeddings from the enrollment source may not match the classroom view.

### 7.1.2 Degrade-Augmentation Solution

To bridge the quality gap, the enrollment pipeline generates **degraded variants** of each accepted crop:

1. Downscale to 96px and 64px height (simulating board-camera resolution at distance).
2. JPEG-compress at Q40 (simulating compression artifacts).
3. Apply Gaussian blur at σ=0.6 (simulating motion/focus blur).
4. Upscale back to original dimensions.

Each variant is embedded separately, expanding the gallery from ~3 embeddings/student to ~9-15. This increases recall at the cost of a slightly larger gallery search space.

**Measured impact:** [TODO: compare recognition hit rate with and without degrade augmentation]

## 7.2 Presence Duration

[TODO: paste duration results and discuss]

The presence FSM's design produces conservative estimates: a student must be continuously re-identified to maintain PRESENT status. Brief occlusions (looking away, other students blocking the view) cause temporary UNVERIFIED transitions, which inflate the measured "missed" time.

## 7.3 Proctor False-Positive Reduction

[TODO: paste proctor results and discuss]

The gaze-down suppression filter addresses the most common false positive: a student looking down at their desk is briefly classified as "phone detected" by the YOLOv8 detector when their hand position aligns with typical phone-holding posture.

## 7.4 Engagement Analytics

VNEI provides a honest, aggregate signal:

- **What worked:** Teachers can see at a glance whether the back row is disengaged, enabling real-time pedagogical adjustment.
- **What the k-floor prevents:** With fewer than 5 students in a zone, the metric is suppressed entirely — this prevents re-identification of individuals by elimination.
- **Coverage disclosure:** Every number shows its denominator. A VNEI of 0.8 at 60% coverage means "80% of the 60% we could see appeared engaged" — not "80% of the class."

## 7.5 System Performance

[TODO: latency discussion]

## 7.6 What Didn't Work (Honest Assessment)

1. **Back-row accuracy:** [TODO: measured degradation at distance]
2. **Occlusion:** Students in the middle rows frequently occlude those behind them. The pipeline correctly marks them UNVERIFIED, but this creates gaps in the attendance record.
3. **Lighting variation:** [TODO: measured impact of lighting changes during session]
4. **Single camera:** One camera cannot cover all zones equally. The front zone has near-100% coverage; the back zone may be at 50-70%.

## 7.7 Security-First Design Decisions

Several decisions were made for privacy/security over convenience:

| Decision | Trade-off |
|----------|----------|
| Embeddings-only (no stored images) | Cannot visually review who was detected |
| No per-student engagement | Cannot identify disengaged individuals |
| Human-in-the-loop for proctor | No automatic penalty; requires staff review |
| Face is convenience, not auth | Cannot replace login system |
| k ≥ 5 suppression | Engagement data unavailable for small groups |

These are documented in the project's ADRs and represent deliberate choices, not missing features.
