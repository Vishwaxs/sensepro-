from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    vision_backend: str = "stub"
    reid_interval_s: float = 30.0
    miss_threshold: int = 3
    cosine_threshold: float = 0.45
    enrollment_json: str = "enrollments.json"  # dev: load roster from file
    allow_origins: str = "*"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
