# Chapter 1 — Introduction & Problem Statement

## 1.1 Context

Classroom attendance tracking in Indian universities remains overwhelmingly manual — handwritten registers, sign-in sheets, or proxy-prone biometric terminals. These methods waste 5–10 minutes per session, are vulnerable to impersonation, and generate no actionable data about engagement patterns.

## 1.2 Problem Statement

Design and implement a **privacy-preserving, camera-based classroom attendance and engagement analytics system** that:

1. Identifies enrolled students via face embeddings (no model training — enrollment only).
2. Produces per-student attendance records with PRESENT / UNVERIFIED / ABSENT state.
3. Reports aggregate engagement (VNEI) per spatial zone — never per-student.
4. Supports exam-mode proctoring with human-in-the-loop review.
5. Complies with India's DPDP Act 2023 and avoids EU AI Act emotion-inference red lines.

## 1.3 Objectives

- **O1:** Automate attendance capture with ≥85% recognition hit-rate at classroom distances (2–6m).
- **O2:** Report zone-level engagement with explicit coverage and bias disclosure.
- **O3:** Reduce proctor false positives via gaze-down suppression, measured honestly.
- **O4:** Enforce privacy invariants structurally: embeddings-only, no raw frames stored, no per-student engagement tracking.

## 1.4 Scope

**In scope:** Single-classroom deployment, DSLR + webcam + RTSP capture, Supabase backend, TanStack Start web UI, four roles (teacher, management, admin, student).

**Out of scope:** Multi-building deployment, liveness detection, self-enrollment kiosk, QR→face-verify flow (reserved for Phase 5 per §18 of the PRD).

## 1.5 Report Organisation

Chapters 2–8 follow: literature review, system design, implementation, privacy & compliance, testing & evaluation, results & discussion, conclusion & future work.
