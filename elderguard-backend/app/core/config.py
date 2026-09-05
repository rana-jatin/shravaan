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
    #: Whether an out-of-range reading raises an alert row at all.
    #:
    #: ON BY DEFAULT, unlike almost everything else here, because the
    #: alternative is what this service did before: store vital signs and
    #: never look at them. It stays a switch because a deployment feeding this
    #: from a bench rig or a dataset replay would otherwise generate alerts
    #: about nobody.
    anomaly_alerts_enabled: bool = True
    #: How long the same kind of alert folds into the one already raised.
    #:
    #: Fifteen minutes is the same judgement as the companion's two-minute
    #: emergency cooldown, scaled to a slower event: a pulse that is still out
    #: of range a quarter of an hour later is worth raising again, and one
    #: that is out of range for six consecutive readings is not six events.
    anomaly_cooldown_minutes: int = Field(default=15, ge=1, le=1440)
    #: Shared secret the companion server presents on /api/v1/companion/*.
    #:
    #: A KEY RATHER THAN A JWT, unlike every other caller here, and the reason
    #: is what the caller is. A device token names one device and a user token
    #: names one person; the companion acts for whoever is talking to it, so
    #: neither shape fits. This is service-to-service between two halves of one
    #: product, and a static secret in both environments is the honest way to
    #: say that rather than inventing a third token type to dress it up.
    #:
    #: ⚠ UNSET MEANS THE ROUTES REFUSE, NOT THAT THEY ARE OPEN. See
    #: `require_companion` in api/deps.py — a missing key is a 503 naming the
    #: variable, never a fall-through to no authentication at all.
    companion_api_key: str | None = None
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
