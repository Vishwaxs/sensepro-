# SensePro+ — Deployment Guide

Everything below runs on **free tiers only**. Follow §0 → §6 in order and the whole
system is live: dashboards, QR check-in, role-based access, and live capture.

Verified at time of writing: 211 backend tests pass, ruff clean, web typecheck 0 errors,
ESLint 0 errors, production build clean, all 14 routes serve, forged tokens rejected on
10/10 staff endpoints.

---

## 0. What you need (all free, no card except where noted)

| Piece | Host | Free tier | Card? |
|---|---|---|---|
| Database + Auth | **Supabase** | 500 MB DB, 50k MAU | no |
| Inference API | **Google Cloud Run** | ~60 h/month at 2 GiB (see §6) | yes¹ |
| Web app | **Vercel** (Hobby) | 100 GB bandwidth | no |

¹ Cloud Run requires a card on the account, but stays **within the always-free tier** at
this usage. See §6 for the arithmetic and how to cap spend at zero.

**Why not Render's free tier?** Measured peak resident memory for this backend:

| Configuration | Peak RSS |
|---|---|
| InsightFace det+rec, one 1080p frame | 402 MB |
| + YOLOv8n proctor pass | **718 MB** |

Render and Koyeb free instances are 512 MB, so the process is OOM-killed during model
load — before it serves a single request. Render free is also 0.1 vCPU, roughly 10× slower
than the measurements in §7. It is a fine host for this app at the **Standard** plan, and
usable free *only* with `VISION_BACKEND=stub` (API and dashboards work; no real
recognition). Cloud Run's free tier is the only one of the three that fits the real models.

---

## 1. Supabase — one-time setup

Already correct on the current project (`bwjrnkledjjpcvnzykqc`). Do this only for a new one.

### 1.1 Apply migrations
```bash
supabase link --project-ref <your-ref>
supabase db push          # applies supabase/migrations/0001 … 0018
```

### 1.2 Enable the Access Token Hook ← the whole role system depends on this
Dashboard → **Authentication → Hooks → Customize Access Token (JWT) Claims**
→ enable, select `public.custom_access_token_hook`.

Without it no JWT carries `app_role`, every RLS policy denies, and every user lands on
`/no-role`. There is deliberately no `user_roles` fallback in the client — migration 0003
revokes that table from `authenticated`, so a client query could only ever return empty.

Verify:
```sql
select public.custom_access_token_hook(
  jsonb_build_object('user_id','<a real user id>','claims','{}'::jsonb)
);
-- must return  "claims": { "app_role": "admin" }
```

### 1.3 Assign roles
Every user needs a `user_roles` row; there is no default role. **A brand-new signup — by
password or by Google — has no role and correctly lands on `/no-role` until you run this.**

```sql
insert into public.user_roles (user_id, app_role)
values ('<auth.users.id>', 'admin')   -- teacher | management | admin | student
on conflict (user_id) do update set app_role = excluded.app_role;
```

Roles take effect on the user's **next sign-in** (the claim is baked into the JWT). To find
accounts still waiting on one:
```sql
select u.id, u.email from auth.users u
left join public.user_roles r on r.user_id = u.id
where r.user_id is null;
```

### 1.4 Link student accounts
A `student` role also needs their auth account joined to their roster row, or `/me` shows
"Not linked to a student record":
```sql
update public.students set auth_uid = '<auth.users.id>' where reg_no = '2547201';
```

### 1.5 Google sign-in (optional but recommended)

1. **Google Cloud Console** → *APIs & Services → Credentials → Create credentials → OAuth
   client ID → Web application*.
2. Under **Authorized redirect URIs** add exactly:
   ```
   https://<your-project-ref>.supabase.co/auth/v1/callback
   ```
   This is Supabase's callback, not your app's — Google talks to Supabase, Supabase talks
   to your app.
3. Copy the **Client ID** and **Client secret** into Supabase →
   *Authentication → Providers → Google* → enable → save.
4. Supabase → *Authentication → URL Configuration*:
   - **Site URL**: `https://<your-app>.vercel.app`
   - **Redirect URLs**: add both
     ```
     https://<your-app>.vercel.app/auth/callback
     http://localhost:5173/auth/callback
     ```
   Miss this step and Google sign-in returns to the site root with the session dropped.

The app handles the rest: `/auth/callback` waits for the session, then routes by role.
A first-time Google user is a normal new account — give it a role with §1.3.

### 1.6 Who signs in, and how

There is **no self-serve access**. Anyone can create an account, but an account with no
`user_roles` row can reach nothing — it lands on `/no-role` and stays there. An admin
grants the role. That is the whole access model, and it is why a leaked signup page is not
a breach.

Three ways in, all landing in the same place:

| Method | Who uses it | Notes |
|---|---|---|
| Email + password | Staff, and students without a Google account | Signup enforces 8+ chars, upper, lower, digit, symbol |
| **Continue with Google** | Anyone with a campus or personal Google account | No password to forget. Needs §1.5 configured |
| QR scan → phone | Students marking themselves present | Still requires a signed-in student account; the QR carries a one-shot token, not a login |

After sign-in the app reads `app_role` from the JWT and sends the user to their home:

| Role | Lands on | Can do |
|---|---|---|
| `admin` | `/admin` | Everything: enrol students, roster, deletion requests, settings, plus all teacher and management screens |
| `teacher` | `/teacher` | Start sessions, run `/capture`, proctoring, session history, mint absentee QR |
| `management` | `/management` | Analytics and trends only. Class/zone aggregates, never a per-student engagement score |
| `student` | `/me` | Own attendance only, and QR check-in. Needs `students.auth_uid` linked (§1.4) or the page says "Not linked to a student record" |

**For a whole class of students**, do not create 53 accounts by hand. Students only need an
account to *view* their own attendance — attendance itself is recorded by the camera without
any student action. So either:

- **Recommended for the demo:** link only the two or three students you will actually show.
  Everyone else is still marked present by the camera and appears on the teacher's roster.
- **For real use:** have students sign up with Google using their campus address, then
  bulk-assign in one statement — this matches accounts to roster rows by email local-part,
  and touches only exact matches:

```sql
-- give every signed-up campus account the student role
insert into public.user_roles (user_id, app_role)
select u.id, 'student' from auth.users u
where u.email like '%@mca.christuniversity.in'
  and not exists (select 1 from public.user_roles r where r.user_id = u.id)
on conflict (user_id) do nothing;

-- then link each to its roster row (adjust the join to your email convention)
update public.students s set auth_uid = u.id
from auth.users u
where s.auth_uid is null
  and lower(s.full_name) = lower(u.raw_user_meta_data->>'full_name');
```

Verify no account is attached to the wrong person before a demo — this exact mistake was
present on this project (one account was linked to a different student's roster row, so
`/me` showed someone else's attendance):

```sql
select u.email, s.reg_no, s.full_name
from public.students s join auth.users u on u.id = s.auth_uid;
-- every row must be the same human on both sides
```

### 1.7 Turn on leaked-password protection
*Authentication → Policies → Password security* → enable "Check against HaveIBeenPwned".
The signup form already enforces 8+ characters with upper, lower, digit and symbol; this
adds a breach-corpus check the client cannot do.

---

## 2. Backend → Google Cloud Run

`backend/Dockerfile` bakes both model caches at build time, so no cold start ever downloads
a 275 MB model. Read its comments before changing the layer order — the user-creation step
is load-bearing.

### 2.1 One-time
```bash
gcloud auth login
gcloud config set project <your-gcp-project>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

### 2.2 Deploy
Run from the repo root. The first build compiles InsightFace from source (~10 min); later
ones reuse the cached dependency layer.

```bash
gcloud run deploy sensepro-api \
  --source backend \
  --region asia-south1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 1 \
  --timeout 3600 \
  --concurrency 20 \
  --min-instances 0 \
  --max-instances 1 \
  --no-cpu-throttling \
  --session-affinity \
  --set-env-vars '^;^VISION_BACKEND=insightface;PROCTOR_BACKEND=yolo;CAPTURE_SEND_WIDTH=1920;REID_INTERVAL_S=30;MAX_REID_PER_FRAME=5;ENGAGEMENT_WINDOW_S=60;ALLOW_ORIGINS=https://<your-app>.vercel.app'
```

Then set the secrets (kept out of the command above so they stay out of your shell history
and the deploy log):
```bash
gcloud run services update sensepro-api --region asia-south1 \
  --set-env-vars SUPABASE_URL=https://<ref>.supabase.co
# paste the keys interactively:
gcloud run services update sensepro-api --region asia-south1 \
  --update-secrets SUPABASE_SECRET_KEY=sensepro-secret-key:latest
```
(or paste them in the Cloud Console → *Cloud Run → sensepro-api → Edit → Variables*.)

Every flag above is doing a job:

| Flag | Why |
|---|---|
| `--memory 2Gi` | 718 MB peak (§0) plus headroom. 1 GiB survives attendance but not a proctor pass. |
| `--timeout 3600` | A WebSocket counts as one long request. At the 300 s default, capture drops every 5 minutes. |
| `--no-cpu-throttling` | Default Cloud Run only gives CPU *during a request*; a WS connection would freeze between frames. Also switches to instance-based billing, which has its own free tier. |
| `--session-affinity` | Keeps a reconnecting capture client on the same instance. |
| `--max-instances 1` | One classroom, and it caps spend. |
| `--min-instances 0` | Scale to zero so you are billed only while it runs. Costs a ~20 s cold start. |
| `--concurrency 20` | Inference is CPU-bound; more concurrency just queues. |

### 2.3 Verify
```bash
API=$(gcloud run services describe sensepro-api --region asia-south1 --format='value(status.url)')
curl $API/healthz
# expect vision_backend == vision_backend_configured == "insightface",
#        supabase_configured true, embeddings_count and roster_count > 0
```

---

## 3. Frontend → Vercel

1. Vercel → **Add New → Project** → import the GitHub repo.
2. **Root Directory**: `apps/web`. `vercel.json` supplies build command, output directory
   and the SPA rewrite; leave the rest at defaults.
3. Environment variables:

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | publishable key — safe in the browser, RLS protects data |
| `VITE_API_BASE` | the Cloud Run URL from §2.3, e.g. `https://sensepro-api-xxxx.a.run.app` |
| `VITE_WS_URL` | **`wss://sensepro-api-xxxx.a.run.app/ws/capture`** — see §4 |
| `VITE_CLASS_SECTION` | `MCA-4B` (must equal the students' `class_section`, or QR claim 403s) |
| `VITE_CLASS_SUBJECT` | e.g. `Distributed Systems` |

Never put the secret or service-role key in a `VITE_*` variable: everything prefixed
`VITE_` is compiled into the browser bundle.

4. Deploy, then go back to §2.2 and set `ALLOW_ORIGINS` to the real Vercel URL, and §1.5
   step 4 to add the real redirect URL.

---

## 4. `/capture` in production — what makes it work

This used to be the one screen that broke on a static deploy. The cause: `resolveWsUrl()`
always opened the socket **same-origin** (`wss://<site>/api/ws/capture`), which works in dev
because the Vite dev server proxies `/api` including WS upgrades — and fails in production
because a CDN cannot forward an Upgrade request to another host. Vercel, Netlify and
Cloudflare Pages rewrites all proxy plain HTTP but **not** WebSockets, so "just add a
rewrite" does not fix it.

The fix is to stop proxying: `resolveWsUrl()` now accepts an absolute URL, and the browser
opens the socket straight at the API host. That is why `VITE_WS_URL` must be the **absolute
`wss://` URL** of the Cloud Run service.

Requirements, all already handled above:

- **`wss://`, not `ws://`.** An insecure socket on an HTTPS page is blocked as mixed
  content. If you set `ws://` anyway the app upgrades it and logs a console warning rather
  than failing silently.
- **`--timeout 3600` and `--no-cpu-throttling`** on Cloud Run (§2.2), or the socket dies.
- **The token is in the query string**, not a header — WebSocket handshakes cannot carry
  custom headers. `/ws/capture` is staff-gated *before* `accept()`; an unauthenticated or
  student token is closed with 1008.
- **CORS does not apply to WebSockets**, so `ALLOW_ORIGINS` is not what gates the socket —
  the token is. `ALLOW_ORIGINS` still matters for every plain HTTP call.

**Best performance option.** Cloud Run's free tier gives 1 vCPU; the engine timings in §7
were measured on a full desktop core. For a real class, run the capture station's backend
**locally** on the classroom laptop (`VITE_WS_URL=ws://localhost:8000/ws/capture`) and point
everything else at the deployed API. Same code, no cold start, several times the throughput.
The deployed socket is the right choice for demos and remote evaluation.

---

## 5. Post-deploy smoke test

```bash
API=https://sensepro-api-xxxx.a.run.app
curl $API/health            # 200
curl $API/healthz           # vision + supabase + counts

# staff-gated — these MUST be 401
curl -o /dev/null -w '%{http_code}\n' -X POST $API/v1/sessions \
  -H 'Content-Type: application/json' -d '{"class_section":"X","subject":"Y","mode":"lecture"}'
curl -o /dev/null -w '%{http_code}\n' $API/v1/roster
```

A forged token must be rejected everywhere. This is not hypothetical: every staff endpoint
used to base64-decode the JWT payload and trust its `app_role` without checking the
signature, so the string below authenticated as an admin and could create sessions, mint QR
tokens, and enrol biometric templates.

```bash
FORGED="AAAA.$(printf '{"app_role":"admin"}' | base64 | tr -d '=' | tr '/+' '_-').BBBB"
for p in /v1/sessions /v1/qr/token /v1/students /v1/roster; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $FORGED" -H 'Content-Type: application/json' \
    -d '{}' "$API$p")
  echo "$code $p"
done   # every line must be 401 or 403 — never 200/201
```

In the browser:

1. Sign in with a password → land on your role's home (`/teacher`, `/management`, `/admin`,
   `/me`), **not** `/no-role`. If everyone hits `/no-role`, the hook (§1.2) is off.
2. Sign up → the password checklist ticks green as you type; submit is blocked until all
   five rules pass; the eye toggle reveals the field.
3. **Continue with Google** → Google consent → back to `/auth/callback` → your role's home.
4. `/capture` → allow camera → status reads **live**, boxes and names appear.
5. Scan the absentee QR on a phone → `/claim` → selfie → marked present.

---

## 6. What the free tiers actually give you

**Cloud Run.** With `--no-cpu-throttling` the always-free allowance is 240,000 vCPU-seconds
and 450,000 GiB-seconds per month. At 1 vCPU and 2 GiB that is the smaller of
240,000 s and 450,000 ÷ 2 = 225,000 s — about **62 hours of running instance per month**.
Because `--min-instances 0` scales to zero, you burn that only while someone is using it;
a few classes a week is comfortably inside it.

To make overspend impossible: *Billing → Budgets & alerts* → budget of ₹0 with alerts at
50/90/100%, and keep `--max-instances 1`.

**Cold starts.** From zero, the container starts and loads ~400 MB of models: expect
**15–25 s** on the first request. The models are already in the image, so this is load time,
not download time. Open `/healthz` a minute before class to warm it.

**Vercel Hobby.** Non-commercial projects only — a university project qualifies. 100 GB
bandwidth/month; this app's bundle is a few hundred KB.

**Supabase free.** Pauses after 7 days with no activity; open the dashboard to resume.
Sign in once a week during the project and it never pauses.

---

## 7. Engine configuration — why these numbers

**Combined effect, measured end to end on the 44 real 4K classroom frames in
`Edited_Images/` against the live gallery:**

| | Before | After |
|---|---|---|
| send width / JPEG quality / gallery | 1280 / 0.60 / clean-only | 1920 / 0.85 / degrade-augmented |
| faces matched | 40 / 208 (**19.2%**) | 85 / 207 (**41.1%**) |
| distinct students identified | 24 | **35** |
| median cosine score | 0.277 | 0.397 |

| Setting | Was | Now | Why |
|---|---|---|---|
| `CAPTURE_SEND_WIDTH` | 1280 | **1920** | At 1280 the median classroom face is 23 px tall and 13 of 25 faces fall below 24 px, which ArcFace cannot identify reliably. At 1920 the median is 35 px and only 1 face is under 24 px. Costs +114 ms detection per frame (167→281 ms); total frame cost is dominated by re-ID, not resolution. |
| Browser JPEG quality | 0.60 | **0.85** | Compression artefacts hit small faces hardest. Same frames, same detector, quality alone: q60 → 38.9% matched, q75 → 46.1%, q85 → **48.9%**, q95 → 48.9%. q85 is where the curve flattens — roughly 265 KB/frame, ~2 Mbit/s at 1 fps. |
| `MAX_REID_PER_FRAME` | (unbounded) | **5** | ArcFace costs ~134 ms/face on CPU. Embedding a 25-track classroom in one pass blocks ~3.4 s and backs frames up behind the capture socket. The budget spreads the same work over a few frames; unidentified faces are always served first. |
| `REID_INTERVAL_S` | — | **30** | Detection runs every frame (cheap); identity refresh is the expensive part and 30 s amortises a full class. |

Detection resolution and identity are separate knobs: raising `det_size` without raising the
send width changes nothing, because SCRFD only ever sees what the browser shipped.

### Enrolment quality matters more than any of the above

`enroll/pipeline.py` degrades each enrolment crop to 96 px and 64 px face heights and enrols
those too, so the gallery holds board-camera-like templates rather than only DSLR close-ups.
That augmentation was silently producing **zero** extra templates: it re-detects before
embedding, and a face box cropped tight then downscaled to 64 px is no longer detectable, so
every variant was dropped. The crop now keeps 60% context margin on each side. Effect on the
live gallery: 102 templates → 306.

**Videos are now enrolled too.** The knee/waist framing clips add multi-scale, multi-angle
templates on top of the DSLR anchors:

```bash
cd backend
VISION_BACKEND=insightface python -m enroll.bulk_videos \
  --videos-dir "<path>/sensepro-enrollment/Videos" --supabase --source video
```
Six students had clips; that added **80 templates** (gallery 306 → 386). The command is
idempotent per source — re-running skips students who already have `source='video'` rows
unless you pass `--replace` — and it reads the clips in memory, copying and deleting nothing.

Measured effect, live gallery with vs without the video rows, all 44 frames (837 faces):

| | photo-only (306) | photo+video (386) |
|---|---|---|
| overall faces matched | 328 (39.2%) | 339 (**40.5%**) |
| recognition events for the 6 enrolled students | 30 | **41 (+37%)** |
| distinct students identified | 43 | 43 |
| regressions | — | none (no student lost) |

Read that carefully before generalising it. The overall rate barely moves because only 6 of
51 students gained templates; what actually changed is that those six are now recognised
**37% more often** across the same frames — more frames in which they are matched at all,
which is what drives a stable PRESENT state rather than a flickering one. No student was
newly identified, because all six were already findable from photos alone, and none
regressed. Videos for the remaining 45 students are the single biggest accuracy gain still
on the table; on this evidence the gain is in robustness and time-to-present, not in the
headline match rate.

---

## 8. Why still YOLOv8n and not YOLOv26

`yolo26` ships in the installed ultralytics (8.4.121) and loads fine, so the switch is a
one-line change to `PROCTOR_MODEL_PATH`. It was benchmarked against v8n on the real
classroom frames at 1920×1080, interleaved so CPU contention hit both models equally:

| | yolov8n | yolo26n |
|---|---|---|
| latency (min / median) | 185 ms / 409 ms | 180 ms / 552 ms |
| persons found @ conf 0.35 | **26** | 13 |
| @ conf 0.25 / 0.15 / 0.05 | 35 / 54 / 136 | 15 / 33 / 78 |

Same speed, but v26n finds roughly **half** the people at every confidence threshold on this
footage — it is systematically more conservative on the small, partially-occluded, back-row
figures a classroom is made of, and that gap does not close by lowering `conf`. Proctoring
needs recall (every flag is human-reviewed anyway, so a false positive is cheap and a miss is
not), so v8n stays. Worth re-testing if a later release changes the small-object behaviour.

Note: neither model detected a single `cell phone` in this set at any threshold — these are
lecture frames with no visible handsets, so that is not evidence either way about phone
detection. Validate that separately with staged footage before relying on exam-mode flags.

---

## 9. Security notes

- `embeddings` and `user_roles` are never granted to `authenticated`. Enrolment counts reach
  the UI through the `enrollment_coverage` view + `embedding_counts()` function, which expose
  counts only — never a vector.
- `ALLOW_ORIGINS` must list real origins, never `*`. This service holds the Supabase server key.
- `backend/.dockerignore` excludes `.env`; without it `COPY . .` would bake the service-role
  key and the RTSP camera password into a readable image layer.
### Supabase advisor notices — all reviewed, none blocking

There are no ERROR-level advisories. The remaining notices, and why each stands:

| Notice | Verdict |
|---|---|
| `qr_tokens` RLS enabled, no policy | **Intentional.** Service-role only; the token travels in the QR payload and is never read back by a client. A policy would imply client access that must not exist. |
| `embedding_counts()` is SECURITY DEFINER, callable by `authenticated` | **Intentional and load-bearing.** It is the only way the UI learns enrolment coverage without `embeddings` being granted to `authenticated`. It returns counts, never a vector. |
| `rls_auto_enable()` is SECURITY DEFINER, callable by `anon` | **Benign, and not ours.** Supabase-managed (it appears in no migration here) and it returns `event_trigger`, so it cannot be invoked outside a DDL event — `pg_event_trigger_ddl_commands()` errors anywhere else. Do not modify a platform-managed object to silence a linter. |
| `vector` extension in `public` | Pre-existing. Moving it means rewriting every `vector` reference across 18 migrations for no change in exposure. Left alone deliberately. |
| Leaked password protection disabled | **Fix this** — one toggle, see §1.7. |
