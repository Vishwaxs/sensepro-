# SensePro+ Live Demo Script

**Total time:** ~8 minutes | **Fallback:** Pre-recorded backup video

---

## Pre-demo Checklist (5 min before)

- [ ] Backend running: `python -m uvicorn app.main:app --reload --port 8000`
- [ ] Frontend running: `npm run dev` (port 5173)
- [ ] RTSP camera powered on and accessible
- [ ] At least 2 students enrolled in `enrollments.json`
- [ ] Browser logged in as admin (can switch roles via Supabase dashboard)

---

## Step 1 — Login as Teacher (~30s)

1. Navigate to `http://localhost:5173/login`
2. Enter teacher credentials
3. **Expected:** Redirected to `/teacher` dashboard
4. **Show:** The shell sidebar with role-appropriate navigation (no admin/management tabs)

**Fallback:** If login fails, clear cookies and retry. If Supabase is down, demo mode still redirects to `/teacher`.

---

## Step 2 — Start a Live Session (~1 min)

1. Click **Capture** in the sidebar → navigate to `/capture`
2. Select the RTSP camera source (CP Plus RTSP · 10.101.40.189)
3. Click **Start** → live feed appears
4. **Show:** Connection badge turns green, frame counter increments

**Fallback:** If RTSP fails, switch to browser webcam. Point camera at a printed photo of an enrolled student.

---

## Step 3 — Enrolled Student Marked PRESENT (~1 min)

1. With the session running, position an enrolled student in front of the camera
2. Wait ~30 seconds for the re-ID cycle
3. **Show:** On the `/teacher` roster, the student's chip transitions from ABSENT → PRESENT
4. **Show:** The aggregate stats update (present count, VNEI gauge)

**Fallback:** If re-ID doesn't trigger, explain the 30-second interval and show the roster mock data.

---

## Step 4 — Exam Mode + Phone Detection (~1 min)

1. In the capture settings panel, switch mode to **Exam**
2. Hold a phone visibly in the camera view
3. **Show:** A proctor flag appears in the bottom of the capture panel
4. Navigate to `/proctor` → the flag is in the review queue

**Fallback:** If phone detection doesn't trigger (stub backend), show the proctor queue with existing flags.

---

## Step 5 — Review a Proctor Flag (~30s)

1. On `/proctor`, click on a flag
2. **Show:** The flag detail with timestamp, type, and status
3. Click **Dismiss** or **Uphold**
4. **Explain:** "Staff review is mandatory — the system never auto-penalises. This is enforced by a database trigger."

---

## Step 6 — Management VNEI Dashboard (~1 min)

1. Log in as management (or switch role in Supabase dashboard)
2. Navigate to `/management`
3. **Show:** VNEI by zone panel with live data
4. **Show:** Coverage badges on each zone card
5. **Show:** The k<5 suppressed zone (if applicable)
6. **Explain:** "Every number declares its coverage. If we can't see enough students, we say so rather than guessing."

**Fallback:** Mock data sections are labelled "Sample data" — point this out as honest disclosure.

---

## Step 7 — Student Self-View (~30s)

1. Log in as a student account
2. Navigate to `/me`
3. **Show:** Attendance heat strip, detailed history table
4. **Show:** Consent status panel
5. **Show:** The two-step "Delete my data" flow
6. **Explain:** "Students see only their own data. Right-to-erasure is a structural feature."

---

## Step 8 — Enrollment (~1 min)

1. Log in as admin
2. Navigate to `/enrollment`
3. **Show:** Student search, video upload zone, capture guide
4. **Explain:** "The video is processed in memory and deleted immediately. Only mathematical embeddings are stored."

---

## Closing Points (~30s)

1. "No raw images are ever stored — only 512-d embeddings."
2. "Engagement is aggregate-only — we cannot score individual students."
3. "The proctor queue requires human review — no automated penalties."
4. "All numbers in our evaluation come from the real pipeline, not fabricated."

---

## If Everything Fails

Switch to the pre-recorded backup video (see `backup_video_shotlist.md`). Explain each step as it plays. The backup covers the same 8-step flow.
