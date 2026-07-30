# Examiner Q&A Sheet — Honest Answers

## Q: "Isn't face recognition spoofable?"

**A:** Yes. Printed photos and screens can fool a standard 2D camera system. This is exactly why **face recognition is not our authentication gate** — login is always email/password via Supabase GoTrue. Face recognition is a convenience layer for attendance, used in a supervised classroom where the teacher can see if someone is holding up a printed photo. Our Phase 5 roadmap includes liveness detection for unsupervised scenarios.

---

## Q: "How do you stop proxy attendance?"

**A:** Current version: the enrolled face must be physically in the room and visible to the camera. In Phase 5, we plan a two-factor approach: the student scans a classroom-specific QR code (proves "in room") and the camera matches their face within N seconds (proves "this person"). A QR screenshot from a friend won't have the matching face; a printed photo can't scan a QR code.

---

## Q: "Why aggregate-only engagement? Isn't per-student more useful?"

**A:** Per-student engagement scoring is:
1. **Legally risky** — the EU AI Act (Article 5) prohibits emotion inference in educational settings.
2. **Ethically problematic** — labelling individual students as "disengaged" creates surveillance pressure and assumes head-pose = attention, which is a simplification.
3. **Structurally prevented** — our `engagement_zone_aggregates` table has no `student_id` column. We can't track individual engagement even if we wanted to.

VNEI tells the teacher "the back row seems less engaged today" — a signal to adjust teaching, not to penalise.

---

## Q: "What's the accuracy at the back row?"

**A:** Honestly, it degrades. Our evaluation harness measures recognition hit-rate by zone:
- Front (0–2m): [TODO: measured value]
- Mid (2–4m): [TODO: measured value]  
- Back (4–6m): [TODO: measured value]

We report these numbers explicitly rather than claiming a single headline accuracy. Every VNEI number also discloses its coverage fraction.

---

## Q: "Did you train a model?"

**A:** No. We use pre-trained SCRFD (detection) and ArcFace (recognition) from the InsightFace model zoo. Our enrollment pipeline **stores embeddings**, not training data. The distinction matters: training adjusts model weights using backpropagation; enrollment computes fixed-point embeddings from new faces using an already-trained model. No gradient descent occurs anywhere in our system.

---

## Q: "What about DPDP compliance?"

**A:** We address five key DPDP requirements:
1. **Consent:** Digital consent form with version tracking, stored in `consent_records`.
2. **Purpose limitation:** Embeddings used only for attendance matching.
3. **Data minimisation:** Only 512-d vectors stored; no raw images.
4. **Right to erasure:** CASCADE DELETE from `students` purges all linked data.
5. **Security:** Row-Level Security on every table; service-role writes only.

---

## Q: "How does the system handle occlusion?"

**A:** When a student is occluded (another student blocks the camera view), ByteTrack marks the track as "lost" after `miss_threshold` consecutive frames without a detection match. The presence FSM transitions from PRESENT → UNVERIFIED. If the student becomes visible again within the session, re-identification restores them to PRESENT. This is conservative: brief occlusions create UNVERIFIED gaps, but we prefer under-counting to over-counting.

---

## Q: "What happens if the camera goes offline mid-session?"

**A:** The WebSocket connection badge shows the disconnect immediately. The session's presence data up to that point is already written to Supabase. When the camera reconnects, a new capture session begins. Students who were PRESENT before the disconnect remain in their last state until re-identified. The teacher dashboard shows the connection status.

---

## Q: "Why not use a cloud inference API?"

**A:** Three reasons:
1. **Privacy:** Sending classroom video to a cloud API means frames leave the local network.
2. **Latency:** Round-trip to a cloud API adds 100-500ms per frame.
3. **Cost:** At 2-5 fps, a 50-minute session generates 6,000-15,000 frames. Cloud inference at that volume is expensive.

Local inference (CPU or GPU) keeps everything on-premises and within the institution's data boundary.

---

## Q: "What's your cosine threshold and how did you choose it?"

**A:** 0.45, configured via `COSINE_THRESHOLD`. This was chosen empirically: lower thresholds (0.3-0.4) produced false positives (matching the wrong student); higher thresholds (0.5+) missed legitimate matches, especially at distance. The degrade-augmentation in enrollment helps by populating the gallery with board-camera-like embeddings, which improves recall at this threshold. The eval harness reports both hit-rate and false-accept-rate at this threshold.
