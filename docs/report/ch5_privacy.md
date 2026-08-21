# Chapter 5 — Privacy, Ethics & Compliance

## 5.1 Design Philosophy

SensePro+ treats privacy as a **structural constraint**, not an afterthought. Every design decision is filtered through six invariants (from CLAUDE.md):

1. **No training.** The system enrols students (stores embeddings); it never trains or fine-tunes a model.
2. **Embeddings-only.** Raw frames and images are processed in memory and deleted immediately. No face image is ever written to disk, database, or log.
3. **No per-student engagement.** The `engagement_zone_aggregates` table has no `student_id` column — individual engagement tracking is architecturally impossible.
4. **No emotion labels.** The system never infers, stores, or displays emotion categories.
5. **Human-in-the-loop.** Proctor flags are reviewed by staff; no automated penalty is applied.
6. **Consent is logged.** Every enrolled student has a signed `consent_record` with version and timestamp.

## 5.2 DPDP Act 2023 Compliance

| DPDP Requirement | SensePro+ Implementation |
|-----------------|-------------------------|
| Informed consent | Digital consent form; `consent_records` table with version tracking |
| Purpose limitation | Embeddings used only for attendance matching; VNEI is aggregate-only |
| Data minimisation | Only 512-d embeddings stored; no raw biometric data persists |
| Right to erasure | `CASCADE DELETE` from `students` purges embeddings, presence, and consent |
| Security safeguards | RLS on every table; service-role writes only; JWT-based auth |

## 5.3 EU AI Act Alignment

**Article 5 — Prohibited Practices:**
- Emotion inference in educational settings is explicitly prohibited.
- SensePro+ performs no emotion recognition. VNEI measures aggregate head-pose engagement, never individual emotional state.

**High-Risk Classification (Article 6):**
- Biometric categorisation systems in education may be classified as high-risk.
- SensePro+ mitigates this through: transparency (explicit consent), human oversight (proctor review), and data minimisation (embeddings-only).

## 5.4 Aggregate-Only Engagement (VNEI)

The VNEI system is designed to report *zone-level* classroom engagement:

- **What it measures:** In a 60-second window, the proportion of tracked faces in a zone that maintain an engaged head pose.
- **What it never reports:** Which specific student is engaged or disengaged.
- **k-anonymity floor:** If a zone has fewer than 5 tracked faces, the metric is suppressed entirely.
- **Coverage disclosure:** Every VNEI number is accompanied by its coverage fraction, so a teacher knows "this number represents 70% of the zone, not all of it."

This design ensures that VNEI cannot be weaponised for individual performance assessment — it's a tool for the teacher to notice "the back row seems disengaged today" and adjust their teaching, not to penalise specific students.

## 5.5 Security Architecture

### 5.5.1 Authentication Boundary

Authentication is handled by Supabase GoTrue (email/password). Face recognition is a **convenience layer** for attendance, never an authentication gate.

### 5.5.2 Row-Level Security

Every table has explicit RLS policies:

- Students see only their own rows (via `auth_uid`).
- Teachers see sessions they created.
- Management sees aggregate data.
- Admin sees all.
- The service role (backend) bypasses RLS for inference writes.

### 5.5.3 Audit Trail

The `audit_log` table uses a hash-chain trigger: each row contains `sha256(prev_hash + action)`, making tampering detectable. Admin can read the log but never write to it — entries are appended only by database triggers on service-role operations.

## 5.6 Right to Erasure

When a student requests data deletion:

1. Admin deletes the `students` row.
2. `CASCADE DELETE` automatically purges: embeddings, consent_records, presence_intervals (student_id set null via `ON DELETE SET NULL` for proctor flags).
3. Aggregate analytics (already de-identified) are retained.
4. The deletion itself is logged in the audit chain.

## 5.7 Honest Limitations

- **Spoofing:** Face recognition is spoofable (printed photos, screens). This is why it's not the auth gate. The Section18 roadmap includes liveness detection.
- **Distance:** Recognition accuracy degrades beyond ~6m. The eval harness measures this honestly.
- **Coverage:** Not all students in a zone may be visible to the camera. Coverage is always disclosed.
- **Bias:** ArcFace has known demographic performance variations. We do not claim equal accuracy across all demographics and flag this as a limitation.
