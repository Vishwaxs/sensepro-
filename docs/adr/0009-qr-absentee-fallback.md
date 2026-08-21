# ADR 0009 — Rotating-QR absentee fallback, bound to in-room face verification

**Context.** Passive recognition marks a student PRESENT only while the classroom camera
actually sees their enrolled face. Back-row, briefly-occluded, or late students can therefore
read as ABSENT even though they are in the room. The obvious fix — let a student tap a code to
mark themselves present — reopens the exact proxy hole the whole system exists to close: a code
can be screenshotted and shared. The Section18 / Phase-5 design (report ch8 Section8.2, viva Q&A) resolves
this with two factors: **the QR proves _in the room_; the face proves _this person_; presence
requires both.** This ADR records the mechanism that realises that intent. (The detailed token /
window design here is our implementation of the documented high-level design, not a verbatim
PRD spec.)

**Decision.** The QR **never** marks attendance. It grants a short, single-use permission to
verify by face, in the room.

1. A teacher opens an absentee window on the capture screen. The backend mints a token that is
   bound to the session, single-use, short-lived (`QR_TOKEN_TTL_S`, 75 s), and **rotating** —
   minting a new token expires the previous unused one, so only one is ever live.
2. An absent student scans it **from their authenticated app session** (`/claim`). Identity is
   **verified against Supabase GoTrue** (`/auth/v1/user`) — not a bare JWT decode — then mapped
   to their student row via `auth_uid`. A student can only ever claim for themselves.
3. The claim is an **atomic single-winner** operation: one `UPDATE qr_tokens SET used_at … WHERE
   used_at IS NULL AND expires_at > now`. Postgres serialises concurrent updates under the row
   lock, so exactly one caller wins; losers get "already used — ask for a new one."
4. Validated before the claim: token exists, session active, caller enrolled in that class,
   caller not already present. A win opens a `verification_windows` row (`QR_WINDOW_TTL_S`, 30 s).
   **It does not mark presence.**
5. The normal capture loop, on recognising a face whose student has an open window, writes the
   presence row through the **existing** write-path — tagged `via='qr'` — and satisfies the
   window. This is additive: it is disabled unless a real Supabase writer is present, refreshes
   open windows on an interval (not per frame), and swallows its own errors so passive
   recognition is never affected. Window expiry writes nothing.
6. Every action appends to the hash-chained `audit_log` (`qr_window_open/close`, `qr_claim`,
   `qr_verified`). Closing the window invalidates outstanding tokens. The claim endpoint is
   rate-limited per user.

**Consequences.**
- (+) **Proxy defeated where it matters:** presence still requires the enrolled face in front of
  the classroom camera. A friend holding the phone cannot produce the student's face; a printed
  photo cannot scan a QR; a shared screenshot is single-use and short-lived.
- (+) Identity cannot be spoofed at claim time — it comes from a verified session, not the QR
  payload.
- (+) The mechanism is a bolt-on: no change to the presence FSM, and it no-ops entirely offline.
- (−) **Honest residual risk — the liveness gap:** a printed photo held to the camera *during*
  an open window would satisfy it. Mitigation for now is procedural (the teacher opens the window
  and verification happens in front of the class); liveness detection is explicit future work and
  out of the module ceiling. We state this plainly rather than overclaim.
- (−) The **claim rate-limit is in-memory, per-process** — correct for the single-instance demo,
  but a multi-instance deployment would need a shared limiter.
- (−) Teacher/admin QR endpoints authorise on a **decoded** `app_role` claim (matching the rest
  of the API), not a signature check; only the student claim is signature-verified. Tightening
  the teacher side (and binding it to session ownership) is a noted follow-up.
- (−) A QR-verified student who is *also* passively visible could hold overlapping `via='qr'` and
  `via='camera'` intervals, double-counting duration; in the fallback's intended use (students the
  camera does not reliably see) this does not arise. Open `via='qr'` rows are closed at session end.
