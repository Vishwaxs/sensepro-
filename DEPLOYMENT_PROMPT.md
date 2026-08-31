# SensePro+ Release Runbook: Vercel + Render

Production topology:

- Vercel serves `apps/web` and its Clerk proxy function.
- Render builds `backend/Dockerfile` and runs the FastAPI inference API.
- Supabase stores sessions, review events, aggregate windows, and attendance data.
- Live frames stay in memory and are never persisted.

Use `DEPLOYMENT.md` for the full account setup and security notes. This file is the short
release-day sequence.

## 1. Preflight the exact worktree

From `backend`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check app/main.py app/sessions.py app/store.py app/ws.py app/rtsp_api.py proctor engagement eval/harness.py eval/run.py
```

From `apps/web`:

```powershell
npx tsc --noEmit
npx eslint src/routes/capture.tsx src/routes/_shell.proctor.tsx src/routes/_shell.teacher.tsx src/routes/_shell.management.tsx src/routes/_shell.trends.tsx src/components/ProctorReviewPanel.tsx src/components/charts/VneiPanel.tsx src/lib/data/engagement.ts scripts/validate-deploy-env.mjs
npm run build
```

Repository-wide lint currently includes unrelated legacy formatting findings. Do not claim
it is globally clean; the release gate above covers the changed exam, workshop, capture,
and deployment paths.

## 2. Apply and verify Supabase migrations

```bash
supabase link --project-ref <project-ref>
supabase migration list
supabase db push
```

Do not continue if migration numbering is ambiguous or any pending migration fails. For the
production Clerk instance, assign roles through server-controlled `publicMetadata.role`.
The Supabase Access Token Hook in `DEPLOYMENT.md` is only for the optional legacy auth fallback.

## 3. Deploy the backend on Render

Create or sync a Blueprint from the repository-root `render.yaml`. It deliberately creates
only `sensepro-api`; the Vercel frontend needs a serverless Clerk proxy and must not be
deployed as a plain Render static site.

The Blueprint fixes these runtime details:

- Docker runtime using `backend/Dockerfile`
- 1 CPU / 2 GB plan (`1c-2g`)
- one inference worker
- InsightFace and YOLO model caches warmed at image-build time
- strict `/readyz` traffic gate

Enter every `sync: false` backend value in Render:

- `ALLOW_ORIGINS`: exact Vercel origin, without a trailing slash
- `FRONTEND_URL`: exact Vercel origin
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`: server-side `sb_secret_...` key
- `CLERK_SECRET_KEY`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `ADMIN_NOTIFY_EMAIL`

Never put a Supabase or Clerk server secret in a `VITE_*` variable.

## 4. Deploy the frontend on Vercel

Import the repository with Root Directory `apps/web`. Keep the committed `vercel.json`; it
contains the SPA routes, cache headers, Clerk proxy rewrites, and the strict deployment
build command.

Set these Vercel variables for Production and Preview as appropriate:

- `VITE_API_BASE=https://<render-service>.onrender.com`
- `VITE_WS_URL=wss://<render-service>.onrender.com/ws/capture`
- `VITE_SUPABASE_URL=https://<project-ref>.supabase.co`
- `VITE_SUPABASE_ANON_KEY=<publishable-or-anon-key>`
- `VITE_CLERK_PUBLISHABLE_KEY=<pk_...>`
- `VITE_CLERK_PROXY_URL=https://<vercel-app>/__clerk`
- `CLERK_SECRET_KEY=<sk_...>` as a server-side variable
- `VITE_CLASS_SECTION=<real-section>`
- `VITE_CLASS_SUBJECT=<default-subject>`

`npm run build:deploy` fails before Vite builds if the API, WebSocket, Supabase, or Clerk
contract is missing or unsafe.

## 5. Post-deploy verification

```bash
API=https://<render-service>.onrender.com
curl --fail "$API/health"
curl --fail "$API/healthz"
curl --fail "$API/readyz"
```

Required `/readyz` result:

- HTTP 200 and `ready: true`
- active and configured vision backend both `insightface`
- proctor backend ready and production-backed by YOLO
- Clerk and Supabase configured
- session/proctor, workshop aggregate, and lecture QR schemas ready

An unauthenticated request to a protected endpoint must be rejected:

```bash
curl -o /dev/null -w '%{http_code}\n' -X POST "$API/v1/sessions" \
  -H 'Content-Type: application/json' \
  -d '{"class_section":"X","subject":"Y","mode":"exam"}'
```

Expected status: `401` or `403`, never `200` or `201`.

Then verify in a real signed-in browser:

1. Teacher login completes and protected routes load without console/network errors.
2. Exam mode creates a real session, shows no QR or attendance controls, reaches
   `Proctoring live`, records a staged phone and sustained off-screen head turn as pending
   review events, and saves dismiss/follow-up decisions without applying a penalty.
3. Workshop mode shows no participant names, attendance, or QR controls; with at least five
   pose-observable participants, a complete aggregate window is retained and appears in
   teacher and management views.
4. Lecture attendance still starts, records, closes, and opens its QR flow exactly as before.
5. Ending an exam or workshop receives server confirmation and the exact session appears in
   history.

Do not call the deployment ready if any authenticated browser step is untested.

## 6. Rollback

- Render: roll back `sensepro-api` to the previous healthy deployment.
- Vercel: promote the previous production deployment.
- Supabase: do not reverse migrations ad hoc. Use a reviewed forward migration or the
  project recovery procedure.
