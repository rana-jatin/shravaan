from datetime import datetime
from enum import StrEnum
from uuid import UUID, uuid4

from sqlalchemy import DateTime, Enum, Float, ForeignKey, JSON, String, func
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


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

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    event_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), unique=True, index=True, default=uuid4)
    device_id: Mapped[UUID] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    heart_rate_bpm: Mapped[float | None] = mapped_column(Float)
    spo2_percent: Mapped[float | None] = mapped_column(Float)
    temperature_c: Mapped[float | None] = mapped_column(Float)
    motion_state: Mapped[MotionState] = mapped_column(
        Enum(MotionState, name="motion_state", values_callable=lambda enum: [item.value for item in enum]),
        default=MotionState.UNKNOWN,
    )
    raw_payload: Mapped[dict] = mapped_column(JSON, default=dict)


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
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
