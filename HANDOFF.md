# SensePro+ — Handoff (latest: 2026-08-15, round 3)

Working state on branch `experiment/namratha-integration`. This file is the
single current source of truth for what's done and what's deliberately
deferred — supersedes anything said in chat that isn't reflected here.

## Round 3: "it did not start" — the real root cause (FIXED)

Round 2 fixed the *symptoms* on the capture screen. It did not fix the cause,
because the cause was never in the frontend. Found this round by driving a real
headless Chromium over CDP (signed in as `teacher@sensepro.demo` via a
service-key magiclink) and tracing the capture socket frame by frame.

**Root cause — recognition had never actually run.**

`vision/pipeline.py`'s `build_backend()` read `os.getenv("VISION_BACKEND")` and
defaulted to `"stub"`. It did **not** read `backend/.env`. So with
`VISION_BACKEND=insightface` sitting in `.env`:

- `/healthz` reported `"insightface"` — it reads `settings`, which *does* read
  `.env`. Everything looked correct.
- The pipeline actually built `StubDetector`/`StubEmbedder`, whose embeddings
  are **64-dim** (`vision/stub.py: EMB_DIM = 64`).
- The gallery loads the real **512-dim** ArcFace vectors from Supabase pgvector.
- The moment a frame contained a detected face, `EmbeddingStore.match()` hit
  `matmul: size 64 is different from 512`. The exception escaped the WebSocket
  handler, killing the socket with a **1006** (abnormal close, no close frame).
- `capture.tsx` saw the drop, showed OFFLINE, and reconnected every 2.5s —
  forever. Every real classroom frame has faces, so this happened on the *first*
  frame, every single time. That is the "I waited 3 minutes and it did not
  start". No amount of waiting could ever have fixed it.

Why it hid for so long: `/healthz` was green, Supabase was fine, the WS
handshake returned 101, and a frame with **no** face round-tripped perfectly —
so every check short of "send a real face through it" passed.

**Fixed (four layers):**
1. `vision/pipeline.py` — new `configured_backend()` resolves `VISION_BACKEND`
   as *live env var → `.env` via settings → "stub"*, and `build_backend()` uses
   it. `.env` now works as documented; an explicit env var still wins.
2. `vision/embedding_store.py` — `match()` checks probe width against the
   gallery and raises a plain-English dimension-mismatch error naming the
   backend/dim conflict, instead of an opaque numpy matmul failure.
3. `app/ws.py` — `process_frame` is wrapped: one bad frame reports
   `{"type":"error","fatal":true}` on the socket and the session survives.
   A single frame can no longer take down a whole class session.
4. `app/main.py` `/healthz` — now reports the backend **actually loaded**
   (`vision_backend`, `vision_backend_class`) alongside what was configured
   (`vision_backend_configured`), and returns `status: "degraded"` with a
   warning when they disagree. Regression-tested by
   `tests/test_healthz.py::test_healthz_flags_backend_drift`.

**Verified in a real browser, after the fix:** one socket, handshake 101, frames
streaming continuously, **no close, no reconnect loop**, connection badge
reads **LIVE**, engagement panel renders its k≥5 privacy-floor message, zero
unhandled page errors. Before the fix the identical run showed 5 sockets
created-and-dropped and a permanent OFFLINE.

### Also fixed this round

- **Camera on a non-secure origin.** Vite runs `host: true` (the phone needs the
  QR page), so it advertises `http://192.168.x.x:5173`. Browsers only expose
  `navigator.mediaDevices` on a secure origin, so on that URL `start()` died on
  its first line with "Cannot read properties of undefined (reading
  'getUserMedia')" — while the API and socket still connected, making the page
  look healthy. New `apps/web/src/lib/camera.ts` detects this before touching
  the API and says exactly which URL to open instead; the kiosk idle screen
  shows it up front rather than after a failed click. Verified in-browser at
  `localhost` (allowed) and `192.168.1.19` (blocked, correct message).
- **Camera errors are now human.** `NotAllowedError` / `NotReadableError` /
  `NotFoundError` / `OverconstrainedError` map to what to actually do. A stale
  remembered `deviceId` now retries without the `exact` constraint instead of
  dead-ending.
- **`Lightfall.tsx` crashed without WebGL.** `new Renderer()` threw an unhandled
  error on every page load where WebGL is unavailable (GPU blocklist, RDP,
  software rendering). Now degrades to no backdrop. Page errors on load went
  from 3 to 0.
- **Removed the `?demo=stale` block** in `capture.tsx`. It seeded five invented
  students ("Aarav Sharma", …) and forced running+RECONNECTING+stale *without
  ever opening a socket* — a state that never resolves and is indistinguishable
  from a real outage, plus fabricated names on screen.
- **`dev.ps1` (new, repo root)** — one command for the whole stack. Waits for
  `/healthz` (the model load blocks all connections for ~30s, which reads as an
  outage), prints the URL that actually works, and warns off the LAN address.
  It also clears a **stale port 8000**: the vision pipeline spawns a
  `multiprocessing` child that inherits the listening socket and can outlive its
  parent, so after a Ctrl+C the port stays held by an orphan that answers
  nothing and a fresh uvicorn cannot bind — another way the app "won't start".
  (Hit this for real this round.)
- **Frontend typecheck is clean for the first time** — the 4 long-standing
  errors (3× framer-motion `Variants` easing in `landing.tsx`, 1× ogl `Mesh`
  cast in `Lightfall.tsx`) are fixed. `tsc` 0 errors, `eslint` 0 errors.
- **`tests/conftest.py` (new)** pins `VISION_BACKEND=stub` for the suite. The
  tests previously got the stub *by accident* (nobody had exported the var);
  once `.env` was honoured they'd have silently depended on a developer's
  private `.env`. 201 passed, ruff clean.

**Test data:** 8 `class_sessions` rows created by these browser runs were
deleted afterwards (all had 0 presence_intervals). Nothing else was written.

**Note on the `§` corruption from round 2:** did not recur. `eslint --fix` ran
again this round and both `§` characters survived intact, so the formatter was
not the cause.

## Round 2 (same day, later): reported capture-screen bugs + a full sweep

Triggered by a screenshot of `/capture` showing overlapping text, an
"INFERENCE SOCKET UNREACHABLE" banner, no visible session mode, and a request
to audit every route/endpoint twice.

**Fixed, confirmed root cause:**
- `capture.tsx`: the "Roster frozen · awaiting inference" stale-data banner
  was absolutely-positioned inside the same `inset-0` layer as the decorative
  diagonal watermark, landing directly on top of the "Present now / Attended"
  KPI header — that's the garbled overlapping text in the screenshot.
  Restructured so the watermark stays a decorative absolute background (z-0,
  pointer-events-none) and the alert banner is normal-flow content that pushes
  the header down instead of covering it.
- `sessionInfo.mode` was previously only ever shown as an "exam" badge (see
  `examMode` conditional) — opening `/capture` in the default lecture mode (or
  via `?mode=workshop`) showed **no mode indicator at all**, which is what
  "I could not see what module we want to choose" meant. Ported Namratha's
  pattern (her capture.tsx always renders `{sessionInfo.mode}`, just recolors
  it) and extended it to 3-way lecture/exam/workshop. Also added a mode +
  "Change" link to the idle/pre-start screen for anyone who lands on
  `/capture` directly instead of through `/start`.
- WS reconnect banner didn't distinguish "backend still loading its vision
  model" (uvicorn's lifespan blocks ALL connections, including this one,
  until `build_backend()` finishes — see `main.py`'s lifespan comment; can
  take up to ~30s) from "actually unreachable". Added an attempt counter:
  first 3 failed attempts show "Backend still starting up"; only sustained
  failure escalates to the red "unreachable" state.

**Verified, not a bug (checked twice, live):**
- `/capture`'s login guard (`guardRoute(["teacher","admin"])`) is present and
  correctly wired — confirmed by direct code read AND cross-checked against
  `auth-guard.ts`'s `ROUTE_ROLES` map (exact match). If it isn't prompting for
  login, the browser almost certainly already has a persisted Supabase
  session from an earlier sign-in (expected SPA behavior) — try an incognito
  window to confirm.
- Every backend endpoint has exactly one frontend caller and vice versa (grepped
  both directions) — no orphaned endpoints, no frontend calls to nonexistent
  routes.
- Supabase confirmed reachable end-to-end from both sides: backend `/healthz`
  (service-role) and a direct anon-key REST call from the shell (correctly
  RLS-rejected, proving the key + connectivity are both valid, not that
  something's broken).
- QR flow (`claim.tsx` re-read in full) — no flaws found; token
  rotation/expiry/race handling all check out.
- `qr_api.py`'s `issue_token` genuinely respects the admin QR toggle
  (live-tested: setting `qr_checkin_enabled=false` blocks new tokens).

**Cleaned up:**
- Deleted `apps/web/src/lib/data/mock.ts` and its barrel `index.ts` — fully
  dead code (zero imports anywhere, confirmed before deleting), the last
  `Math.random()`-driven fake data in the tree.
- Found and fixed a strange, unexplained corruption: every `§` character in
  the repo had silently become the word "Section" (e.g. `qr_api.py`'s
  docstring read "Section18" instead of "§18"; `_shell.sessions.tsx`'s
  eyebrow label read "Section sessions" instead of "§ sessions"). This was
  NOT an intentional edit by me — restored both, and reworded a third instance
  in `students_api.py` in plain English to avoid depending on the symbol at
  all. If this happens again, it's worth checking for a VS Code
  extension/format-on-save rule doing Unicode-to-ASCII substitution in this
  workspace.
- Live-tested `POST /v1/sessions` without auth (confirming the known P0 gap)
  — this wrote a real `SMOKE-TEST` row to production `class_sessions`;
  deleted it immediately after.

**Re-verified after all of the above:** backend 200/200 pytest, ruff clean;
frontend tsc/lint/build clean (same 4 pre-existing, untouched
`landing.tsx`/`Lightfall.tsx` issues as before).

**Still not done** (a full click-through in an actual browser, by a person —
I fixed based on the reported screenshot + live endpoint/DB checks, but
haven't driven the UI myself):
- The smoke-test checklist from round 1 (sessions tabs, teacher QR panel,
  delete-my-data → admin approve, global toggle) — still pending, now with
  the mode-badge and stale-banner fixes to also verify visually.
- P0 auth-hardening pass — still deferred, unchanged, listed below.

## Done this session

**Namratha comparison gap-closing** (cross-checked `report.md`'s 12 items
against the actual tree — most were already ported in an earlier session;
these were the genuine remaining gaps):
- `_shell.sessions.tsx`: mode-filter tabs (Attendance / Exam proctoring / Workshop).
- `_shell.teacher.tsx`: Absentee-QR panel now reachable from the live dashboard,
  not just the capture kiosk (reuses the existing `qr_api.py` endpoints).
- `_shell.me.tsx` "Delete my data" was a client-side-only stub
  (`setDeleted(true)`, nothing persisted) — now posts a real
  `POST /v1/students/me/deletion-request`.
- `_shell.admin.tsx` "Deletion queue" was an honest "not available yet"
  placeholder — now lists real requests and lets an admin approve (purges
  embeddings + withdraws consent, `backend/app/admin_api.py`) or deny, behind
  a two-step confirm.
- Global "QR check-in enabled" toggle — new `app_settings` table,
  `GET/PATCH /v1/settings/{key}`, enforced server-side in `qr_api.py`'s
  `issue_token` (not just a UI switch).

**Deliberately NOT ported** — Namratha's `verify.tsx` / `QrVerification.tsx`
and login's "Student" tab both key off `signInStudent(regNo)`, which calls
`supabase.auth.signInWithPassword({ email, password: regNo })` — the
student's public registration number as their login password. Confirmed via
direct grep of her repo. Our existing `claim.tsx` + `AbsenteeQR.tsx` +
`qr_api.py` (rotating single-use token + face-match verification) already
covers the same use case without the vulnerability.

**Backend:** migrations `0013_deletion_requests.sql`, `0014_app_settings.sql`;
new `app/admin_api.py`, `app/settings_api.py`; additions to `app/students_api.py`
and `app/qr_api.py`. 200/200 pytest, ruff clean.

**Frontend:** tsc/build/lint clean (only 4 pre-existing errors/warnings in
`landing.tsx` / `Lightfall.tsx` / the pre-existing `history` useMemo warning in
`_shell.me.tsx` — confirmed via `git diff` these files/lines were untouched).

**Migration validation:** Docker-validated 0013/0014's RLS against a
disposable Postgres before touching production. Caught a real bug this way —
both migrations had RLS policies but were missing
`grant select ... to authenticated`; RLS and GRANTs are additive layers in
Postgres, so without the grant PostgREST returns "permission denied" before
RLS is even evaluated. Fixed in both files before applying live.

## Live Supabase state (project `bwjrnkledjjpcvnzykqc`) — verified directly via MCP, 2026-08-15

- Migrations 0001–0006 were tracked as applied. **0007 was only partially
  applied**: its two `SELECT` grants and the realtime publication had landed,
  but `grant update (review_status, reviewed_by, reviewed_at) on proctor_flags
  to authenticated` was missing — meaning the teacher's proctor-review
  dismiss/uphold buttons were broken in production. Fixed today.
- 0008/0009/0010's DDL (embeddings.source, presence_intervals.via,
  qr_tokens, verification_windows) was already live via undocumented drift —
  applied outside the tracked migration history at some earlier point.
  Verified column-by-column against the migration files: matches exactly, no
  action needed.
- **0011, 0012, 0013, 0014 — applied today** via the connected Supabase MCP.
  Verified post-apply: policies, table grants, and column grants all present;
  `get_advisors` shows zero new security findings.
- Real data as of today: 53 students, 102 embeddings, 115 class_sessions,
  129 presence_intervals, 12 user_roles, 18 qr_tokens.
- `consent_records` was 0 rows for all 53 students — imported today from
  `Edited Images/sensepro-enrollment/sensepro-enrollment/_consent/consent_log.csv`
  (53/53 reg_nos matched the roster exactly, verified before inserting).
  `consent_version='v2.1'`, `signed_at` from the CSV date (noon UTC),
  `signature_hash` = sha256 of `reg_no|name|date|Y` per row — this is a hash
  of the CSV log row, **not** a scanned signed form (no scans exist to hash;
  documenting this precisely rather than implying otherwise).
  `_shell.me.tsx`'s Consent status panel now reads this real record instead
  of the previous hardcoded "Active · v2.1" string.
- `students.auth_uid`: only 1 of 53 students is linked to a login account.
  **Intentional per Vishwas** — only he and teammates need login access right
  now, not the full roster. Not a bug, not scheduled for backfill.
- Access Token Hook: **confirmed enabled** by Vishwas, 2026-08-15.

## Explicitly deferred (Vishwas's call, 2026-08-15) — do these next

### 1. Full smoke test as real roles (not yet run in a browser)
- `/sessions` as teacher — filter by Attendance/Exam/Workshop, confirm counts.
- `/teacher` — start or join a live session, click "Absentee QR", confirm the
  panel opens and mints a token.
- Sign in as the one linked student → `/me` → "Request deletion" → confirm it
  appears on `/admin` → "Deletion queue" → "Approve & purge" → confirm the
  student's embeddings are actually gone (`select count(*) from embeddings
  where student_id = '<id>'` should drop to 0) and consent shows withdrawn.
- `/admin` → flip the global QR toggle off → confirm `/teacher`'s Absentee QR
  panel now shows "QR check-in is currently disabled by admin" instead of
  minting a token. Flip back on before a real demo.

### 2. P0 auth-hardening pass — confirmed gaps, precise as of 2026-08-15
Verified by reading each file directly (not repeating old claims):
- `backend/app/enroll_api.py`'s `_verify_admin` (line 49) only base64-decodes
  the JWT payload — it never calls GoTrue to verify the signature (unlike
  `_verify_user` in `qr_api.py`/`students_api.py`/`sessions.py`/`admin_api.py`/
  `settings_api.py`, which does). **Anyone can forge a `{"app_role":"admin"}`
  JWT-shaped string with no valid signature and call `POST /v1/enroll/video`**
  to enroll arbitrary biometric data as any student.
- `backend/app/sessions.py`'s `create_session`/`end_session` — zero
  `authorization` parameter at all. Anyone can start/end class sessions.
- `backend/app/rtsp_api.py`'s `/start`, `/stop`, `/feed` — zero auth.
- `backend/app/roster_api.py`'s `GET /roster` — zero auth; the full roster
  (names + reg_nos) is publicly readable.
- `backend/app/ws.py` (the `/ws/capture` WebSocket) — no authorization
  handling at all.

This was flagged independently during the earlier Namratha-comparison work
and deliberately scoped out of both that integration and this session, per
Vishwas's explicit choice ("separate pass").

## Not yet done
- **git commit** — nothing in this session is committed. Vishwas runs tests
  himself first, then commits under his own name (CLAUDE.md rule 3: GIT IS MINE).
- Migration history reconciliation (`supabase migration repair`) — cosmetic
  only; matters solely if `supabase db push` needs to work cleanly later. The
  live schema is correct regardless.
