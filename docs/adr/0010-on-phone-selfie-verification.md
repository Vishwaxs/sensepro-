# ADR 0010 — On-phone selfie verification for the QR absentee fallback

**Status.** Accepted. Extends ADR 0009 (it does not replace the token/claim/window
machinery; it adds a second way to satisfy the window).

**Context.** ADR 0009 gave the QR fallback its security spine: a rotating, single-use,
session-bound token proves *in the room*; a GoTrue-verified session proves *who*; and the
face proves *this person*. But 0009 satisfied the verification window **only** by the
classroom camera recognising the student's face — the student had to walk into the ceiling
camera's view. Two facts from the actual deployment break that:

1. The fallback is **for students the ceiling camera cannot see** — back corners, out of frame,
   occluded. Requiring them to walk to the camera defeats the exact case it exists for.
2. Classroom connectivity is **weak phone internet**; a wired/LAN option was considered and
   dropped (the campus LAN is bound to a Wi-Fi login that students are not reliably on). So the
   student device cannot be assumed to hold a live WebSocket/Realtime connection, and must not
   need to stream video.

**Decision.** Add a **single-still, on-phone self-verification** path as the primary satisfier
of a verification window. The student's own phone does the face capture; the server does the
1:1 match. The classroom-camera satisfier from 0009 is **retained** and stays additive — either
can satisfy a window, whichever happens first.

Flow (the token → claim → window steps are unchanged from 0009):

1. After a successful claim, the phone captures **one selfie** from the front camera, downscales
   it client-side (≤480 px wide, JPEG q≈0.7 ⇒ ~40 KB) and POSTs it once to `POST /v1/qr/verify`
   with the `window_id`. One small upload, one JSON response — no stream, no Realtime dependency
   on the phone.
2. The backend verifies the caller against Supabase GoTrue (`/auth/v1/user`), maps to the student
   row via `auth_uid`, and loads the window. It rejects unless the window **belongs to that
   student**, is **unsatisfied**, is **unexpired**, and its **session is still active**.
3. The selfie is decoded **in memory** (`cv2.imdecode`, never written to disk), embedded through
   the same quality-gated enrolment embedder (a blurry/dark/faceless selfie is rejected exactly
   as an enrolment frame would be), and matched **1:1 against only that student's own enrolled
   templates** at the recognition `COSINE_THRESHOLD`.
4. A match atomically satisfies the window (`satisfy_window` is single-winner, so it cannot
   double-count against the camera path), writes the `via='qr'` presence row through the existing
   path, and appends `qr_verified` (payload `via='selfie'`) to the hash-chained audit log. A
   non-match writes nothing and returns `verified:false` so the phone can retry within the window.

**Consequences.**
- (+) **Solves the corner-seat case:** verification no longer requires the ceiling camera to see
  the student. The phone sees the face; presence is still gated on the enrolled face matching.
- (+) **Robust on weak internet:** one ~40 KB round-trip. The verify *result* is the HTTP
  response, so the phone no longer depends on Realtime staying connected (Realtime is kept only as
  a bonus listener, in case the classroom camera satisfies the window first).
- (+) **Same anti-proxy model as 0009:** rotating in-room QR (must see the class screen) +
  verified session identity + a **1:1** match to the claimed student. A friend's face will not
  match the claimant's enrolment; a printed photo cannot scan a rotating single-use QR; a shared
  screenshot is single-use and short-lived. Identity still comes from the JWT, never the QR.
- (+) **No schema change and nothing to run on live:** reuses `verification_windows` and
  `presence_intervals.via='qr'` from migration 0010. Additive to 0009's endpoints and to the
  capture-loop satisfier; both remain.
- (−) **Liveness gap, and now without a human watching the capture.** 0009 already recorded that a
  printed photo held to a camera during an open window would pass; moving capture to the phone
  removes the teacher's incidental oversight of that moment, so the gap is slightly wider. It is
  bounded by the in-room QR requirement and the short single-use window, and the honest mitigation
  is procedural (the teacher opens the window for a handful of known-in-room students). A
  challenge–response check — server-issued "turn left / look up", verified across two frames' head
  pose — is the documented next step and is deliberately **not** built yet (module ceiling; final
  push). We state this plainly rather than overclaim.
- (−) **`getUserMedia` needs a secure context.** The phone must reach the web app over HTTPS (or
  `localhost`); a plain-HTTP LAN IP will not grant camera access. This is a deployment note, not a
  code gap.
- (−) The claim/verify **rate-limit is in-memory, per-process** (as in 0009) — correct for the
  single-instance demo; a multi-instance deployment would need a shared limiter.
