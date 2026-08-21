# Live demo runbook — camera attendance + corner-student QR

Goal for the session: enrolled students turn **PRESENT** by face on the classroom camera, and a
student the camera can't see is marked present by scanning the rotating QR and taking one selfie on
their phone. Everything below runs on the **classroom laptop** (backend + web + tunnel); the teacher
opens the capture page on that laptop, and only the student's phone uses the tunnel URL.

What only you can do is marked 👤. Do the phases in order — each gates the next.

---

## Phase A — Enrol the class (once, before demo day) 👤

Migrations 0008/0009/0010 are already applied and consent is complete (53 rows, all `Y`).

```powershell
cd d:\Vvs_Project\sensepro\backend
.\.venv\Scripts\Activate.ps1
# reg_no-named subfolders (2-3 photos each); keep them OUTSIDE the repo. _consent is skipped.
sensepro-enroll-photos --photos-dir "D:\path\to\reg_no_folders" --dry-run   # read the reject reasons
sensepro-enroll-photos --photos-dir "D:\path\to\reg_no_folders" --supabase  # real run -> pgvector
```

Optional multi-angle/side-face/distance templates (faster PRESENT): upload the two iPhone videos per
student (knee + waist framing) through the **admin → Enrollment** dashboard, or run
`sensepro-enroll-videos`. Note who the dry-run flags as below threshold — those need videos.

## Phase B — Config 👤

**Backend** (`backend/.env` — already has your Supabase keys). Ensure the real vision backend and,
once only, install it (first run downloads the buffalo_l models ~300 MB — do this with internet
BEFORE the demo, not in the room):

```powershell
cd d:\Vvs_Project\sensepro\backend
pip install -e ".[insightface]"   # once
```

**Web** (`apps/web/.env.local`, from `.env.example`):

```
VITE_WS_URL=ws://localhost:8000/ws/capture
VITE_API_BASE=/api                    # same-origin through the Vite proxy (one tunnel covers all)
VITE_CLAIM_BASE=https://<your-tunnel> # fill in after Phase D, then restart npm run dev
VITE_CLASS_SECTION=4 MCA B            # MUST equal the students' class_section
VITE_SUPABASE_URL=...                 # your project URL
VITE_SUPABASE_ANON_KEY=...            # anon/publishable key only
```

Also confirm the Supabase **Access Token Hook** (`public.custom_access_token_hook`) is **enabled** and
Realtime is on for `presence_intervals` — without the hook, no JWT carries `app_role` and the route
guards correctly deny everyone (looks exactly like a bug).

## Phase C — Start the services 👤

```powershell
# terminal 1 — backend (real vision)
cd d:\Vvs_Project\sensepro\backend
.\.venv\Scripts\Activate.ps1
$env:VISION_BACKEND = "insightface"
uvicorn app.main:app --host 0.0.0.0 --port 8000

# terminal 2 — web
cd d:\Vvs_Project\sensepro\apps\web
npm run dev
```

## Phase D — HTTPS tunnel to the web app 👤

```powershell
# terminal 3 — any HTTPS tunnel to the Vite port
cloudflared tunnel --url http://localhost:5173
```

Copy the `https://…` URL it prints → put it in `VITE_CLAIM_BASE` (Phase B) → **restart `npm run dev`**
so the QR encodes it. The phone camera only works over this HTTPS origin — a plain `http://` LAN IP
will not grant `getUserMedia`.

## Phase E — Preflight (60 seconds, catches every "why is it broken") 👤

```powershell
curl http://localhost:8000/healthz
```

Expect: `vision_backend: "insightface"`, `supabase_configured: true`, `embeddings_count > 0`,
`roster_count: 53`, `qr_tables_ready: true`. Anything off here explains a downstream failure before
you're standing in front of the class.

## Phase F — Camera attendance by face 👤

Open `http://localhost:5173/capture` on the laptop, sign in as **teacher/admin**, **Start**. An
enrolled person in view turns **PRESENT**; a row lands in `presence_intervals`; the teacher dashboard
updates live without a refresh.

## Phase G — Corner-student QR 👤

On the capture screen, open the **Absentee** QR panel. A student the camera can't see:
scans the QR on their phone → signs in → **claims** → **Verify me** takes one selfie → the backend
1:1-matches their enrolled face → **PRESENT** (`via='qr'`), with the result shown right on the phone.

---

## Triage

| Symptom | Cause → fix |
|---|---|
| Login denies everyone / no role | Access Token Hook not enabled (Phase B). |
| Camera never marks PRESENT | `healthz` shows `embeddings_count: 0` (run Phase A) or `vision_backend: "stub"` (set `VISION_BACKEND=insightface`) or the cosine threshold is too strict. |
| DB has rows but dashboard is still | Realtime not enabled for `presence_intervals`. |
| QR claim → 403 "not enrolled in this class" | `VITE_CLASS_SECTION` ≠ the students' `class_section`. Set it to exactly `4 MCA B`. |
| Phone: camera blocked | Page isn't HTTPS — open the **tunnel** URL, not `localhost`/a LAN IP. |
| QR verify → "no enrolment on file" | That student has no embeddings — enrol them (Phase A). |
| QR verify → "face didn't match" | Lighting/threshold — retry in better light within the window. |

## Honest caveats (say these in the viva, don't hide them)
- **Cosine threshold** (`COSINE_THRESHOLD`, default 0.45) is **not yet calibrated on real faces**. Test
  at 2 m / 4 m / 6 m, then set it so an absent person is never marked present, and record the value.
- **Liveness gap** (ADR 0010): a printed photo held to the phone during the window would pass. It's
  bounded by the rotating in-room QR + single-use short window; challenge–response is the documented
  next step, deliberately out of scope for now.
