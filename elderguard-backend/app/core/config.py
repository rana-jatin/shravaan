from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


#: The key this repository ships with. Public, therefore not a secret — it is
#: a placeholder that lets a fresh clone start, and `validate_security` refuses
#: it anywhere that is not recognisably a development environment.
INSECURE_DEFAULT_JWT_SECRET = "development-only-insecure-secret-change-me"


class Settings(BaseSettings):
    app_name: str = "Shravaan Safety API"
    environment: str = "development"
    debug: bool = False
    api_v1_prefix: str = "/api/v1"
    database_url: str = "postgresql+asyncpg://shravaan:shravaan@db:5432/shravaan"
    redis_url: str = "redis://redis:6379/0"
    jwt_secret_key: str = Field(default=INSECURE_DEFAULT_JWT_SECRET, min_length=32)
    jwt_algorithm: str = "HS256"
    device_token_expire_minutes: int = 60 * 24 * 365
    access_token_expire_minutes: int = 30
    #: Accept an unverified X-User-ID header as proof of identity.
    #:
    #: This WAS the only authentication this service had. It is kept for local
    #: work — it makes curl against a fresh database bearable — and it refuses
    #: to boot anywhere but development. See validate_security below.
    dev_trusted_identity: bool = False
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

    @property
    def is_development(self) -> bool:
        return self.environment.lower() in {"development", "dev", "local", "test"}

    def validate_security(self) -> None:
        """
        Refuse to start rather than run insecurely.

        The JWT check used to fire only for `production`/`prod`, which meant a
        deployment calling itself `staging` signed device tokens — valid for a
        year — with a key published in this repository. Anything that is not
        recognisably a development environment now has to bring its own.
        """
        if not self.is_development and self.jwt_secret_key == INSECURE_DEFAULT_JWT_SECRET:
            raise ValueError(
                f"JWT_SECRET_KEY must be configured when ENVIRONMENT={self.environment!r}. "
                "The default is public in this repository and signs year-long device tokens."
            )
        if self.dev_trusted_identity and not self.is_development:
            raise ValueError(
                f"DEV_TRUSTED_IDENTITY cannot be enabled when ENVIRONMENT={self.environment!r}. "
                "It accepts an unverified X-User-ID header as proof of identity."
            )


@lru_cache
def get_settings() -> Settings:
    value = Settings()
    value.validate_security()
    return value


settings = get_settings()
