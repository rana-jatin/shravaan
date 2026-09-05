from datetime import UTC, datetime
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, model_validator

from app.models.telemetry import MotionState


#: Which sensor metrics a point may carry. One list, so `require_metric` and
#: the anomaly bands cannot drift apart — adding a metric to the model without
#: adding it here would silently make a point carrying only that metric look
#: empty, and it would be rejected at ingest.
METRIC_FIELDS = (
    "heart_rate_bpm",
    "spo2_percent",
    "temperature_c",
    "systolic_mmhg",
    "diastolic_mmhg",
    "glucose_mgdl",
)


class TelemetryPoint(BaseModel):
    event_id: UUID = Field(default_factory=uuid4)
    recorded_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    heart_rate_bpm: float | None = Field(default=None, ge=20, le=250)
    spo2_percent: float | None = Field(default=None, ge=50, le=100)
    temperature_c: float | None = Field(default=None, ge=25, le=45)
    # WIDER THAN THE ANOMALY BANDS ON PURPOSE, and the two limits answer
    # different questions. These reject what no human body produces — sensor
    # damage, a transposed digit, a field in the wrong unit — so that the bands
    # in ml_eval_service never see it. The bands then decide whether a reading
    # a person really could have is one somebody should hear about.
    systolic_mmhg: float | None = Field(default=None, ge=50, le=260)
    diastolic_mmhg: float | None = Field(default=None, ge=30, le=160)
    glucose_mgdl: float | None = Field(default=None, ge=20, le=700)
    motion_state: MotionState = MotionState.UNKNOWN
    #: "device" for anything a sensor measured, "self_reported" for a number
    #: the person said out loud. See the column comment in models/telemetry.py.
    source: str = Field(default="device", max_length=32)
    raw_payload: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def require_metric(self) -> "TelemetryPoint":
        if all(getattr(self, field) is None for field in METRIC_FIELDS) and self.motion_state == MotionState.UNKNOWN:
            raise ValueError("at least one sensor metric is required")
        return self

    @model_validator(mode="after")
    def require_both_pressures(self) -> "TelemetryPoint":
        """
        Blood pressure is a pair or it is nothing.

        A lone systolic is not half a reading, it is an unreadable one: nobody
        can act on "140 over —", and the anomaly bands would score it as though
        the missing half were fine. This is the one place where a partial
        reading is worth refusing rather than storing.
        """
        if (self.systolic_mmhg is None) != (self.diastolic_mmhg is None):
            raise ValueError("blood pressure needs both systolic and diastolic")
        if self.systolic_mmhg is not None and self.diastolic_mmhg is not None and self.diastolic_mmhg >= self.systolic_mmhg:
            raise ValueError("systolic must be higher than diastolic")
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
