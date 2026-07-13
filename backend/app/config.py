from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    vision_backend: str = "stub"
    reid_interval_s: float = 30.0
    miss_threshold: int = 3
    cosine_threshold: float = 0.45
    enrollment_json: str = "enrollments.json"  # dev: load roster from file
    # Known frontend origins only — never default to "*" on a service that
    # holds the server key and mints sessions.
    allow_origins: str = "http://localhost:5173"

    # Supabase write-path (Phase 2). Server-side only; the frontend reads Postgres
    # directly via RLS/Realtime. Leave supabase_url blank to run fully offline
    # (build_writer falls back to a no-op writer; tests never touch the network).
    supabase_url: str = ""
    # The sb_secret_ server key: authenticates as the service_role Postgres
    # role, bypasses RLS. One credential, one env var.
    supabase_secret_key: str = ""

    @property
    def supabase_enabled(self) -> bool:
        return bool(self.supabase_url and self.supabase_secret_key)

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
