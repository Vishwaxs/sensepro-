from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    vision_backend: str = "stub"
    # How often each track is re-identified (ArcFace match). Detection/boxes run
    # every frame regardless; this is the identity refresh. Low = near-continuous
    # recognition (new faces get named within a couple of seconds). Now that
    # inference runs off the event loop this is cheap to keep responsive.
    reid_interval_s: float = 2.0
    # Max faces embedded per frame. ArcFace is ~134 ms/face on CPU, so an
    # unbounded pass over a 25-track classroom blocks ~3.4 s and backs up the
    # capture socket. See SessionPipeline.max_reid_per_frame.
    max_reid_per_frame: int = 5
    miss_threshold: int = 3
    cosine_threshold: float = 0.45
    enrollment_json: str = "enrollments.json"  # dev: load roster from file
    # Known frontend origins only — never default to "*" on a service that
    # holds the server key and mints sessions.
    allow_origins: str = "http://localhost:5173,https://sensepro.sensepro.workers.dev"

    # Detection resolution. det_size is the SCRFD internal resize — the real
    # gate for small-face detection. A bigger send width with det_size 640
    # changes nothing; both must be raised together. capture_send_width and
    # capture_fps are the recommended defaults the frontend reads at startup.
    det_size: int = 640
    # SCRFD detector confidence floor. Lower recovers more partial/back-row
    # faces at the cost of more false detections; cosine_threshold still gates
    # identity, so a spurious low-confidence detection rarely becomes a wrong
    # match. Unset uses InsightFace's own default (0.5).
    det_thresh: float = 0.5
    # Measured on the real 4K classroom set (44 frames, 53-student gallery):
    # 1280 -> median face 23 px, 13/25 faces under 24 px, 31% matched.
    # 1920 -> median face 35 px, 1/25 under 24 px, 38.5% matched, for only
    # +114 ms detection per frame. Raising this WITHOUT raising det_size still
    # helps, because SCRFD's internal resize preserves more of a bigger face.
    capture_send_width: int = 1920
    capture_fps: float = 1.0
    # Minimum face pixel height to consider for matching. 0 = no filter
    # (all detected faces are matched). Raise to skip micro-detections.
    min_face_px: int = 0

    # Cumulative attendance: a student is ATTENDED for the session once they
    # have >= this many confident sightings. ATTENDED never flips back.
    attendance_sighting_threshold: int = 3

    # Clerk Auth configuration
    clerk_secret_key: str = ""
    clerk_publishable_key: str = ""
    clerk_jwks_url: str = "https://funny-teal-523.clerk.accounts.dev/.well-known/jwks.json"
    # Resend Email Notification System
    resend_api_key: str = ""
    resend_from_email: str = "SensePro+ <onboarding@resend.dev>"
    admin_notify_email: str = ""

    # Supabase write-path (Phase 2). Server-side only; the frontend reads Postgres
    # directly via RLS/Realtime. Leave supabase_url blank to run fully offline
    # (build_writer falls back to a no-op writer; tests never touch the network).
    supabase_url: str = ""
    # The sb_secret_ server key: authenticates against the Auth Admin API.
    # One credential, one env var.
    supabase_secret_key: str = ""
    # The classic service_role JWT: used for PostgREST REST calls (apikey + Bearer).
    # If set, this is preferred over supabase_secret_key for PostgREST.
    supabase_service_role_key: str = ""

    # RTSP capture source (Phase 3, backend/capture). The URL carries the
    # camera credentials — set it only via env; logs always mask the password.
    # Sample rates cap how many frames/second the pipeline processes; the
    # source itself drains the stream and keeps only the latest frame.
    rtsp_url: str = ""
    sample_fps_lecture: float = 2.0
    sample_fps_exam: float = 5.0

    # Exam-mode proctoring (Phase 3, backend/proctor). "stub" for dev/CI;
    # "yolo" needs pip install -e '.[proctor]'. Gaze-down suppression: a track
    # pitched below gaze_pitch_down_deg mutes its phone flags for gaze_window_s.
    proctor_backend: str = "stub"
    gaze_window_s: float = 10.0
    gaze_pitch_down_deg: float = -25.0
    proctor_cooldown_s: float = 30.0

    # VNEI engagement (Phase 3, backend/engagement). Zone bands are fractions
    # of frame height (camera at the front: lower in frame = nearer = front).
    # Aggregates only; zones under 5 tracked faces are suppressed (k-floor).
    engagement_window_s: float = 60.0
    zone_front_band: float = 0.66
    zone_back_band: float = 0.33

    # QR absentee verification — two independent clocks (ADR 0010).
    # CLAIM TTL: how long a scanned token stays valid. Must be shorter than a
    # relay attack (~20-35 s for photograph+send+open+claim). The QR rotates on
    # this cadence; an expired token is rejected with "scan the new one".
    qr_claim_ttl_s: int = 20
    # VERIFICATION WINDOW: once a token is claimed (single-use, race over), the
    # student has this many seconds to grant camera permission, frame their face,
    # and submit the selfie. Generous — the anti-relay defence is the claim TTL.
    qr_verify_window_s: int = 90
    # Stricter cosine threshold for the selfie 1:1 match. The selfie is taken
    # under controlled conditions (front camera, arm's length, cooperating
    # subject), so a tighter gate reduces false accepts without hurting genuine
    # students. Falls back to cosine_threshold if unset/0.
    qr_verify_threshold: float = 0.50

    # Canonical frontend URL for emails, QR codes, and redirects
    frontend_url: str = ""

    @property
    def app_url(self) -> str:
        """Resolves the canonical public frontend URL for emails, QR codes, and redirects.

        Priority:
        1. Explicit `frontend_url` / `FRONTEND_URL` env var (e.g. `https://sensepro-six.vercel.app`)
        2. First https:// origin in `allow_origins`
        3. Local dev fallback `http://localhost:5173`
        """
        if self.frontend_url and self.frontend_url.strip():
            return self.frontend_url.strip().rstrip("/")

        for origin in self.allow_origins.split(","):
            cleaned = origin.strip().rstrip("/")
            if cleaned.startswith("https://"):
                return cleaned

        return "http://localhost:5173"

    @property
    def supabase_enabled(self) -> bool:
        return bool(
            self.supabase_url and (self.supabase_secret_key or self.supabase_service_role_key)
        )

    @property
    def supabase_postgrest_key(self) -> str:
        """Key used for PostgREST REST calls — prefers the JWT service_role key."""
        return self.supabase_service_role_key or self.supabase_secret_key

    @property
    def supabase_auth_key(self) -> str:
        """Key used for Supabase Auth Admin API calls (sb_secret_ format)."""
        return self.supabase_secret_key or self.supabase_service_role_key

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
