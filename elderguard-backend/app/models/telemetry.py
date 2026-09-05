from datetime import datetime
from enum import StrEnum
from uuid import UUID, uuid4

from sqlalchemy import DateTime, Enum, Float, ForeignKey, JSON, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import GUID, Base


class MotionState(StrEnum):
    STILL = "still"
    WALKING = "walking"
    FALL = "fall"
    UNKNOWN = "unknown"


class AlertType(StrEnum):
    SOS = "sos"
    FALL = "fall"
    ANOMALY = "anomaly"


class AlertStatus(StrEnum):
    OPEN = "open"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"


class TelemetryRecord(Base):
    __tablename__ = "telemetry_records"

    id: Mapped[UUID] = mapped_column(GUID(), primary_key=True, default=uuid4)
    event_id: Mapped[UUID] = mapped_column(GUID(), unique=True, index=True, default=uuid4)
    device_id: Mapped[UUID] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    heart_rate_bpm: Mapped[float | None] = mapped_column(Float)
    spo2_percent: Mapped[float | None] = mapped_column(Float)
    temperature_c: Mapped[float | None] = mapped_column(Float)
    # THE THREE A PERSON RECITES RATHER THAN A WRISTBAND MEASURING. No consumer
    # band reads blood pressure or blood sugar, and those are the two numbers an
    # elderly person in this country actually keeps track of and repeats out
    # loud. Without somewhere to put them, the companion hearing "my sugar was
    # one thirty this morning" could only say something agreeable and drop it.
    systolic_mmhg: Mapped[float | None] = mapped_column(Float)
    diastolic_mmhg: Mapped[float | None] = mapped_column(Float)
    glucose_mgdl: Mapped[float | None] = mapped_column(Float)
    motion_state: Mapped[MotionState] = mapped_column(
        Enum(MotionState, name="motion_state", values_callable=lambda enum: [item.value for item in enum]),
        default=MotionState.UNKNOWN,
    )
    # WHERE THE NUMBER CAME FROM, and it is not bookkeeping. A reading a sensor
    # took and a number somebody remembered over breakfast are not the same
    # kind of fact, and anyone reading this table later — a caregiver, a
    # dashboard, a doctor — has to be able to tell them apart without guessing.
    # A plain string rather than an enum because the set is open: every new way
    # a reading can arrive should not be a migration.
    source: Mapped[str] = mapped_column(String(32), default="device")
    raw_payload: Mapped[dict] = mapped_column(JSON, default=dict)


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[UUID] = mapped_column(GUID(), primary_key=True, default=uuid4)
    device_id: Mapped[UUID] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    alert_type: Mapped[AlertType] = mapped_column(
        Enum(AlertType, name="alert_type", values_callable=lambda enum: [item.value for item in enum])
    )
    status: Mapped[AlertStatus] = mapped_column(
        Enum(AlertStatus, name="alert_status", values_callable=lambda enum: [item.value for item in enum]),
        default=AlertStatus.OPEN,
    )
    source: Mapped[str] = mapped_column(String(64))
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
