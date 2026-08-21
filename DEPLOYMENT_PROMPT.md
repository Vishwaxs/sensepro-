# SensePro+ Deployment Prompt: Vercel Frontend + Render Backend

You are deploying SensePro+ to production with the following architecture:
- **Frontend**: Vercel (React + Vite + TanStack Router)
- **Backend**: Render (FastAPI + Vision Models)
- **Database**: Supabase (already configured)
- **Email**: Resend (already configured)
- **Auth**: Clerk (already configured)

## Prerequisites

1. Fork the SensePro+ repository to your GitHub
2. Have Supabase, Resend, and Clerk accounts ready with API keys
3. Install required tools:
   ```bash
   npm install -g vercel
   ```

## Step 1: Prepare Environment Variables

### Backend Secrets (Render)
Collect these values for later:
- `ALLOW_ORIGINS`: Will be set to Vercel frontend URL after deployment
- `SUPABASE_URL`: From Supabase dashboard
- `SUPABASE_SECRET_KEY`: Rotated service role key (sb_secret_ format)
- `SUPABASE_SERVICE_ROLE_KEY`: Optional, same as above
- `RESEND_API_KEY`: From Resend dashboard (re_xxxxx format)
- `RESEND_FROM_EMAIL`: Your verified domain email
- `ADMIN_NOTIFY_EMAIL`: Admin email for notifications
- `CLERK_SECRET_KEY`: From Clerk dashboard (sk_test_xxxxx)
- `CLERK_PUBLISHABLE_KEY`: From Clerk dashboard (pk_test_xxxxx)
- `RTSP_URL`: If using RTSP camera (optional)

### Frontend Secrets (Vercel)
Collect these values:
- `VITE_API_BASE`: Will be https://sensepro-api.onrender.com
- `VITE_WS_URL`: Will be wss://sensepro-api.onrender.com/ws/capture
- `VITE_SUPABASE_URL`: From Supabase dashboard
- `VITE_SUPABASE_ANON_KEY`: From Supabase dashboard (anon key only)
- `VITE_CLERK_PUBLISHABLE_KEY`: From Clerk dashboard
- `VITE_CLASS_SECTION`: e.g., MCA-4B
- `VITE_CLASS_SUBJECT`: e.g., Distributed Systems

## Step 2: Update render.yaml

Remove the frontend service from `render.yaml` since we're deploying it to Vercel.

**Current file has both services. Modify it to only include the backend:**

```yaml
services:
  - type: web
    name: sensepro-api
    runtime: python
    plan: standard
    rootDir: backend
    buildCommand: >-
      pip install --upgrade pip &&
      pip install -e ".[insightface,supabase,proctor]" &&
      mkdir -p /opt/render/project/.cache/sensepro &&
      python -c "from ultralytics import YOLO; YOLO('/opt/render/project/.cache/sensepro/yolov8n.pt')" &&
      python -c "from insightface.app import FaceAnalysis; a=FaceAnalysis(name='buffalo_l'); a.prepare(ctx_id=-1, det_size=(640,640))"
    startCommand: uvicorn app.main:app --host 0.0.0.0 --port $PORT
    healthCheckPath: /health
    envVars:
      - key: PYTHON_VERSION
        value: "3.12.7"
      - key: VISION_BACKEND
        value: insightface
      - key: PROCTOR_BACKEND
        value: yolo
      - key: PROCTOR_MODEL_PATH
        value: /opt/render/project/.cache/sensepro/yolov8n.pt
      - key: CAPTURE_SEND_WIDTH
        value: "1920"
      - key: REID_INTERVAL_S
        value: "30"
      - key: ENROLLMENT_JSON
        value: enrollments.json
      - key: ENGAGEMENT_WINDOW_S
        value: "60"
      - key: ALLOW_ORIGINS
        sync: false  # Set to Vercel URL after frontend deploy
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_SECRET_KEY
        sync: false
      - key: SUPABASE_SERVICE_ROLE_KEY
        sync: false
```

**IF YOU GET STUCK HERE**: Open a browser, go to https://dashboard.render.com, and manually create a web service with these settings. The YAML is just a shortcut - you can configure everything in the UI.

## Step 3: Deploy Backend to Render

### Option A: Using Blueprint (Recommended)
1. Open https://dashboard.render.com/blueprints
2. Click "New Blueprint Instance"
3. Connect to your forked GitHub repository
4. Render will detect `render.yaml`
5. Review the configuration
6. Click "Deploy Blueprint"

### Option B: Manual Setup (If Blueprint Fails)
1. Go to https://dashboard.render.com
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Configure:
   - **Name**: sensepro-api
   - **Runtime**: Python
   - **Plan**: Standard (2GB RAM - critical for vision models)
   - **Root Directory**: backend
   - **Build Command**: (same as in YAML above)
   - **Start Command**: uvicorn app.main:app --host 0.0.0.0 --port $PORT
5. Add environment variables from Step 1
6. Click "Create Web Service"

**IF YOU GET STUCK**: Open browser to Render dashboard and configure manually. The UI is intuitive - just match the settings from the YAML.

## Step 4: Verify Backend Deployment

After deployment completes:

```bash
# Check health endpoint
curl https://sensepro-api.onrender.com/health

# Check detailed health
curl https://sensepro-api.onrender.com/healthz
```

Both should return `{"status": "ok"}`.

**IF THIS FAILS**:
- Check Render logs in dashboard
- Verify environment variables are set correctly
- Ensure you're using Standard plan (not free tier)
- Model downloads can take 5-10 minutes on first deploy

## Step 5: Deploy Frontend to Vercel

1. Navigate to the frontend directory:
   ```bash
   cd apps/web
   ```

2. Run Vercel CLI:
   ```bash
   vercel
   ```

3. Follow the prompts:
   - **Set up and deploy?** Y
   - **Which scope?** Select your account
   - **Link to existing project?** N (first time)
   - **Project name**: sensepro-web (or your choice)
   - **Directory**: ./ (current directory)
   - **Override settings?** N (use defaults)

4. **IF PROMPTED FOR ENVIRONMENT VARIABLES**:
   - Vercel will ask about `VITE_*` variables
   - Enter the values from Step 1
   - Use the backend URL: https://sensepro-api.onrender.com
   - Use WebSocket URL: wss://sensepro-api.onrender.com/ws/capture

5. **IF YOU GET STUCK AT LOGIN**:
   - Open browser to https://vercel.com/login
   - Login with your GitHub account
   - After login, return to terminal and press Enter
   - The CLI will detect your active session

6. After deployment, Vercel will output:
   - Production URL: https://sensepro-web.vercel.app
   - Copy this URL for the next step

**IF VERCEL CLI FAILS**:
- Open browser to https://vercel.com/new
- Import your GitHub repository
- Set root directory to `apps/web`
- Configure environment variables in project settings
- Click Deploy

## Step 6: Update Backend CORS

Now that the frontend is deployed, update the backend CORS to allow the Vercel domain:

1. Go to Render dashboard → sensepro-api
2. Navigate to "Environment"
3. Find `ALLOW_ORIGINS`
4. Update value to: `https://sensepro-web.vercel.app`
5. (Optional) Add localhost for dev: `https://sensepro-web.vercel.app,http://localhost:5173`
6. Click "Save Changes"
7. Render will automatically redeploy with new settings

**IF YOU GET STUCK**: This is critical - without this, the frontend cannot call the backend due to CORS errors. The setting is in Render dashboard under Environment variables.

## Step 7: Create Vercel Configuration (SPA Fallback)

Create `apps/web/vercel.json` for proper SPA routing:

```json
{
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/_shell.html"
    }
  ]
}
```

Commit and push this file, then Vercel will auto-deploy.

**IF YOU GET STUCK**: This file ensures client-side routes (like /teacher, /capture) work. Without it, refreshing the page on these routes will show 404.

## Step 8: Final Verification

### Test Frontend
```bash
# Open in browser
open https://sensepro-web.vercel.app
```

### Test Backend Health
```bash
curl https://sensepro-api.onrender.com/health
```

### Test WebSocket Connection
Open browser console on the frontend and run:
```javascript
const ws = new WebSocket('wss://sensepro-api.onrender.com/ws/capture');
ws.onopen = () => console.log('WebSocket connected');
ws.onerror = (e) => console.error('WebSocket error:', e);
```

### Test Email Notification
```bash
curl -X POST https://sensepro-api.onrender.com/v1/notifications/test \
  -H "Content-Type: application/json" \
  -d '{"to_email": "your@email.com"}'
```

### Test End-to-End Flow
1. Open https://sensepro-web.vercel.app
2. Sign in via Clerk
3. Create a session
4. Navigate to capture page
5. Verify live roster updates
6. End session and check email

## Troubleshooting Guide

### Backend Deployment Fails
- **Issue**: Out of memory on model load
- **Fix**: Ensure Standard plan (2GB RAM), not free tier (512MB)
- **Check**: Render dashboard → plan settings

### WebSocket Connection Fails
- **Issue**: Mixed content error
- **Fix**: Ensure `VITE_WS_URL` uses `wss://` not `ws://`
- **Check**: Frontend environment variables in Vercel

### CORS Errors
- **Issue**: Frontend cannot call backend
- **Fix**: Update `ALLOW_ORIGINS` in Render to include Vercel domain
- **Check**: Render environment variables

### Emails Not Sending
- **Issue**: Resend domain not verified
- **Fix**: Add and verify domain in Resend dashboard
- **Check**: DNS TXT and CNAME records

### Frontend Routes 404 on Refresh
- **Issue**: Missing SPA fallback
- **Fix**: Create `vercel.json` with rewrite rule
- **Check**: File exists in `apps/web/`

### Build Takes Too Long
- **Issue**: Model downloads during build
- **Fix**: This is normal first time (5-10 min). Subsequent builds use cache.
- **Check**: Render build logs for progress

## Cost Summary

- **Render Backend**: $25/mo (Standard plan, 2GB RAM)
- **Vercel Frontend**: Free (Hobby plan)
- **Supabase**: $25/mo (Pro) or Free (if <500MB DB)
- **Resend**: Free (3,000 emails/mo)
- **Clerk**: Free (5,000 MAUs)

**Total**: ~$50/mo or ~$25/mo with Supabase free tier

## Success Criteria

Deployment is successful when:
- Backend health endpoint returns 200
- Frontend loads without errors
- WebSocket connects successfully
- Email test delivers to inbox
- End-to-end session flow works
- No CORS errors in browser console

## Emergency Rollback

If anything breaks:
- **Backend**: Render dashboard → Deployments → Click rollback on previous successful deploy
- **Frontend**: Vercel dashboard → Deployments → Click rollback on previous successful deploy
- **Database**: Supabase dashboard → Point-in-time recovery (if needed)

## Next Steps After Deployment

1. Set up monitoring (Render metrics, Vercel Analytics)
2. Configure custom domains (optional)
3. Enable autoscaling if traffic grows (Render)
4. Set up backup strategies (Supabase automatic backups)
5. Document secret rotation process

---

**IF YOU GET STUCK AT ANY POINT**: Open the relevant dashboard (Render or Vercel) in a browser and configure manually. The CLI tools are convenient but the UIs are fully functional and often easier for troubleshooting.
