from datetime import UTC, datetime
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, model_validator

from app.models.telemetry import MotionState


class TelemetryPoint(BaseModel):
    event_id: UUID = Field(default_factory=uuid4)
    recorded_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    heart_rate_bpm: float | None = Field(default=None, ge=20, le=250)
    spo2_percent: float | None = Field(default=None, ge=50, le=100)
    temperature_c: float | None = Field(default=None, ge=25, le=45)
    motion_state: MotionState = MotionState.UNKNOWN
    raw_payload: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def require_metric(self) -> "TelemetryPoint":
        if all(value is None for value in (self.heart_rate_bpm, self.spo2_percent, self.temperature_c)) and self.motion_state == MotionState.UNKNOWN:
            raise ValueError("at least one sensor metric is required")
        return self


class TelemetryBatch(BaseModel):
    points: list[TelemetryPoint] = Field(min_length=1, max_length=100)


class TelemetryAccepted(BaseModel):
    accepted: int
    device_id: UUID


class SosRequest(BaseModel):
    source: str = Field(min_length=2, max_length=64)
    details: dict = Field(default_factory=dict)


class AlertRead(BaseModel):
    id: UUID
    device_id: UUID
    alert_type: str
    status: str
    source: str
    details: dict
    created_at: datetime
