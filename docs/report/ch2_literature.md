# Chapter 2 — Literature & Background

## 2.1 Automated Attendance Systems

Traditional approaches include RFID-based, fingerprint-based, and manual roll-call systems. Each has known weaknesses:

- **RFID/smart cards:** prone to proxy (sharing cards); no presence verification after tap-in.
- **Fingerprint terminals:** queuing delays; hygiene concerns post-COVID; no continuous monitoring.
- **Manual roll-call:** 5–10 min overhead per session; error-prone at scale.

Face-recognition-based attendance has emerged as a contactless alternative. Key references:

- [TODO: cite] — survey of face recognition in classroom attendance systems.
- [TODO: cite] — challenges of unconstrained face recognition at distance.
- [TODO: cite] — comparison of ArcFace, CosFace, and SphereFace for verification tasks.

## 2.2 Face Detection and Recognition

**Detection:** SCRFD (Sample and Computation Redistribution for Face Detection) provides state-of-the-art accuracy at low computational cost, suitable for real-time processing. [TODO: cite SCRFD paper]

**Recognition:** ArcFace introduces an additive angular margin loss that produces highly discriminative 512-dimensional embeddings. Unlike softmax-based classifiers, ArcFace embeddings support open-set verification without retraining — a critical property for our "enrollment-only, never train" invariant. [TODO: cite ArcFace paper]

**Tracking:** ByteTrack associates detections across frames using a two-stage strategy (high-confidence then low-confidence matching), enabling identity persistence even through brief occlusions. [TODO: cite ByteTrack paper]

## 2.3 Engagement Analytics

Classroom engagement measurement through computer vision has been explored via:

- **Head pose estimation:** proxy for attention direction.
- **Emotion recognition:** explicitly prohibited by the EU AI Act (Article 5) when used for inference in educational settings. SensePro+ does not perform emotion recognition.

Our approach: aggregate zone-level metrics (VNEI — Visual Non-verbal Engagement Index) that report *how many* students in a zone appear engaged, never *which* students. This respects the k-anonymity floor (k ≥ 5) and avoids individual scoring entirely.

[TODO: cite] — existing VNEI or similar engagement index in educational literature.

## 2.4 Privacy and Regulatory Context

**India's Digital Personal Data Protection Act 2023 (DPDP):**
- Requires explicit, informed consent for biometric data collection.
- Mandates purpose limitation — data collected for attendance may not be repurposed for behavioural scoring.
- Grants right to erasure — the system must support full deletion of a student's biometric template.

**EU AI Act (2024):**
- Article 5 prohibits emotion-inference AI in educational and workplace settings.
- Attendance systems using biometric categorisation require transparency obligations.

SensePro+ addresses these by: storing only embeddings (never raw images), logging consent, supporting right-to-erasure cascade deletion, and structurally preventing per-student engagement tracking.

[TODO: cite DPDP Act 2023]
[TODO: cite EU AI Act 2024]

## 2.5 Research Gap

Existing classroom face-attendance systems typically:
1. Store raw face images (privacy risk).
2. Report per-student engagement scores (fairness and legal risk).
3. Lack explicit bias/coverage disclosure.
4. Conflate enrollment with training.

SensePro+ addresses each gap with structural design decisions documented in the ADRs.
