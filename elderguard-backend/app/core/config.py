from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Shravaan Safety API"
    environment: str = "development"
    debug: bool = False
    api_v1_prefix: str = "/api/v1"
    database_url: str = "postgresql+asyncpg://shravaan:shravaan@db:5432/shravaan"
    redis_url: str = "redis://redis:6379/0"
    jwt_secret_key: str = Field(default="development-only-insecure-secret-change-me", min_length=32)
    jwt_algorithm: str = "HS256"
    device_token_expire_minutes: int = 60 * 24 * 365
    access_token_expire_minutes: int = 30
    cors_origins: str = "http://localhost:5173,http://localhost:3000"
    log_level: str = "INFO"
    telemetry_batch_size: int = Field(default=100, ge=1, le=1000)
    mqtt_enabled: bool = False
    mqtt_broker_host: str = "localhost"
    mqtt_broker_port: int = 1883
    mqtt_client_id: str = "shravaan-api"
    mqtt_username: str | None = None
    mqtt_password: str | None = None
    mqtt_topic: str = "shravaan/devices/+/telemetry"
    mqtt_qos: int = 1
    relative_emails: str = ""
    smtp_host: str | None = None
    smtp_port: int = 465
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from: str | None = None

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def relative_email_list(self) -> list[str]:
        return [email.strip() for email in self.relative_emails.split(",") if email.strip()]

    def validate_security(self) -> None:
        if self.environment.lower() in {"production", "prod"} and self.jwt_secret_key == "development-only-insecure-secret-change-me":
            raise ValueError("JWT_SECRET_KEY must be configured in production")


@lru_cache
def get_settings() -> Settings:
    value = Settings()
    value.validate_security()
    return value


settings = get_settings()
