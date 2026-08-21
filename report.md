# Front-End Screen Comparison: SensePro vs Namratha's SensePro

## Executive Summary

Namratha's SensePro branch introduces a significantly polished, production-ready frontend compared to the original SensePro. The main additions revolve around **Session Modularity**, **Manual Fallbacks (QR Check-in)**, **Detailed Analytics & Recharts Integrations**, **Data Privacy Controls**, and **Cryptographic Audit UI**.

This document serves as a strict technical audit of the UI/UX changes for other AI agents to locate and understand the delta between the two codebases.

---

## Detailed Screen-by-Screen Analysis

### 1. The Landing Page (`src/routes/landing.tsx`)

**Status:** `[MAJOR UPGRADE] (-50 lines churn, completely rewritten)`

* **Namratha's Version:** A polished marketing-grade landing page using `framer-motion` and `lucide-react`.
* **Key UI Additions:**

  * **Dynamic Backgrounds:** Uses a custom `Lightfall` visual effect from `src/components/fx/`.
  * **Spotlight Bento Grid:** Three pillar cards ("Browser-based capture", "Fairness-aware analytics", "Privacy by design") utilizing a `SpotlightCard` component that follows the user's mouse.
  * **Role Breakdown:** Visually maps out the four different roles (Teacher, Management, Admin, Student) and their specific capabilities in the app.

### 2. The Login Page (`src/routes/login.tsx`)

**Status:** `[MAJOR UPGRADE] (-20 lines churn, completely rewritten)`

* **Namratha's Version:** A highly interactive, dual-tab sign-in portal.
* **Key UI Additions:**

  * **Visual Polish:** Uses `ClickSpark`, `ShimmerButton`, and `GlowBorder` components.
  * **Dual Tabs:** Separated tabs for "Staff" (Email/Password via Supabase auth) vs "Student" (Name/Register Number via a custom backend verify function).
  * **Quick Demo Login:** A massive productivity boost for development—a one-click login block that reads credentials from `.env.local` to instantly sign in as Teacher, Management, or Admin without typing passwords.

### 3. The Start Session Flow (`src/routes/_shell.start.tsx`)

**Status:** `[NEW FILE]`

* **Original:** N/A.
* **Namratha's Version:** Introduces a dedicated 2-step setup page (`/start`) before the camera launches.
* **Key UI Additions:**

  * **Session Modes:** 3 selectable tiles for Lecture (Attendance + class engagement), Exam (Attendance + proctoring flags), and Workshop (Attendance + engagement).
  * **Contextual Inputs:** Text fields for Class/Section, Examination name / Subject, and Room.
  * **Visuals:** Uses Framer Motion animations with Lucide icons (Camera, GraduationCap, ShieldAlert) to set up the context.

### 4. The Teacher Dashboard (`src/routes/_shell.teacher.tsx`)

**Status:** `[MAJOR UPGRADE] (+5.5KB churn)`

* **Original:** Basic roster list with read-only states.
* **Namratha's Version:** Transforms into a comprehensive live-management dashboard.
* **Key UI Additions:**

  * **KPI Cards:** Top row highlights "Present", "Total roster", "Attendance %", and "Open flags".
  * **Live Connection State:** Shows a pulsing "realtime live" or "reconnecting..." indicator.
  * **Manual Overrides:** The state chip (Present/Absent) is now a dropdown allowing teachers to manually override a student's presence state (`StateOverride` component).
  * **QR Check-in Integration:** A specific "Issue QR check-in" action exists per-student to surface a manual fallback if face-detection fails.
  * **PDF Export:** A "Export session report (PDF)" button dumps the live roster to a document.

### 5. Sessions History (`src/routes/_shell.sessions.tsx`)

**Status:** `[MAJOR UPGRADE] (+7KB churn)`

* **Original:** Likely a simple list.
* **Namratha's Version:** A fully tabulated, rich historical log.
* **Key UI Additions:**

  * **Tabs by Mode:** Three distinct tabs to filter sessions: "Attendance", "Exam proctoring", and "Workshop".
  * **Status Indicators:** Clear indicators for "Live" vs "Ended" sessions, complete with relative timestamps.
  * **Session Controls:** Ability to manually "End" a live session (stamps end time) directly from the table.
  * **Deep Reporting:** Clicking "PDF" exports attendance, engagement (VNEI), peak/low metrics, and proctoring flags.

### 6. Student Dashboard (`src/routes/_shell.me.tsx`)

**Status:** `[MAJOR UPGRADE] (+2.4KB churn)`

* **Original:** Basic view of the student's status.
* **Namratha's Version:** A rich analytics and consent-management hub for the student.
* **Key UI Additions:**

  * **GitHub-style Heatmap:** A 21-session heat strip showing visually if they were Present (Green), Unverified (Yellow), or Absent (Gray).
  * **Attendance by Type:** Distinct progress bars for Class, Exam, and Workshop attendance percentages.
  * **"Request Presence Check":** A dedicated button allowing the student to ping the teacher if the camera didn't pick them up.
  * **Data Control:** Clear UI panels for "Consent status" and a multi-step "Delete my data" flow (to purge biometric templates).

### 7. Management Analytics Hub (`src/routes/_shell.management.tsx`)

**Status:** `[MAJOR UPGRADE] (+285 lines churn)`

* **Original:** Basic aggregate view.
* **Namratha's Version:** A dense analytics dashboard powered by Recharts for cohort trends and fairness.
* **Key UI Additions:**

  * **Attendance Trend Line Chart:** Plotted across historical sessions using a gradient line chart via `recharts`.
  * **Zone Engagement & Coverage Grid:** Visual cards for each seating zone. Handles suppression UI beautifully (e.g., if tracked faces < 5, it renders a "Suppressed" dashed box; if coverage < 50%, it renders a hatched warning background for low confidence).
  * **Session Compare Widget:** Two dropdowns to select sessions side-by-side, displaying mini-stats comparing their overall Attendance and VNEI scores.

### 8. Admin System Console (`src/routes/_shell.admin.tsx`)

**Status:** `[MAJOR UPGRADE] (+145 lines churn)`

* **Original:** Basic system state views.
* **Namratha's Version:** A tabulated power-user interface for platform control.
* **Key UI Additions:**

  * **Global Feature Toggles:** A massive switch component to globally enable or disable "QR check-in for unverified students".
  * **Tabbed interface:** Splits into Devices, Users & Roles, Consent, Deletion queue, and Audit chain.
  * **Deletion Queue:** A list of biometric purge requests from students. Requires the admin to click "Approve & purge" which triggers a two-step destructive confirmation block.
  * **Cryptographic Audit UI:** A table that visually links `prev_hash` to `hash` to show if the audit chain is intact, rendering a green "Linked" badge or a red "Broken" badge.

### 9. QR Code Verification (`src/routes/verify.tsx` & `src/components/sp/QrVerification.tsx`)

**Status:** `[NEW FLOW]` (Replaced `AbsenteeQR.tsx`)

* **Key UI Additions:**

  * **Mobile-First Form:** Students scan the teacher's screen, opening `/verify` where they input their register number.
  * **Visual Feedback:** Shows clear "Check in" (ShieldCheck) or "You're checked in" (Check) screens with smooth transitions.

### 10. Global Routing & Access Control (`src/routes/_shell.tsx`)

**Status:** `[MODIFIED]`

* **Key UI Additions:**

  * Dynamic page titles per route (e.g., "Management · Cohort Analytics").
  * Strict role-based redirect logic mapping roles to specific allowed routes.

### 11. The Camera / Capture Interface (`src/routes/capture.tsx`)

**Status:** `[MODIFIED] (+4.1KB churn)`

* **Key UI Additions:**

  * Now receives mode, title, and section via URL params from `/start`.
  * Integrates `QrVerification.tsx` directly into the live projector UI, displaying a rotating QR code for unverified students to scan.
  * Tightly coupled with the new VNEI and Lightfall component architectures in `src/components/fx/`.

---

## AI Actionable File Map (For Locating Changes)

*Use this mapping to port features from Namratha's branch into the main repository.*

| Feature Area                | File Path                                       | Change Type               |
| --------------------------- | ----------------------------------------------- | ------------------------- |
| **Marketing Landing Page**  | `apps/web/src/routes/landing.tsx`               | Rewritten                 |
| **Auth & Login Flow**       | `apps/web/src/routes/login.tsx`                 | Rewritten                 |
| **Start Session Flow**      | `apps/web/src/routes/_shell.start.tsx`          | New                       |
| **Mobile QR Verify Flow**   | `apps/web/src/routes/verify.tsx`                | New                       |
| **Teacher Live Dashboard**  | `apps/web/src/routes/_shell.teacher.tsx`        | Heavy Modification        |
| **Sessions Log / History**  | `apps/web/src/routes/_shell.sessions.tsx`       | Heavy Modification        |
| **Student Hub / Analytics** | `apps/web/src/routes/_shell.me.tsx`             | Heavy Modification        |
| **Management Cohort UI**    | `apps/web/src/routes/_shell.management.tsx`     | Heavy Modification        |
| **Admin System Console**    | `apps/web/src/routes/_shell.admin.tsx`          | Heavy Modification        |
| **QR Code Component**       | `apps/web/src/components/sp/QrVerification.tsx` | Replaces `AbsenteeQR.tsx` |
| **Global Routing Shell**    | `apps/web/src/routes/_shell.tsx`                | Modified                  |
| **Camera Kiosk View**       | `apps/web/src/routes/capture.tsx`               | Modified                  |
