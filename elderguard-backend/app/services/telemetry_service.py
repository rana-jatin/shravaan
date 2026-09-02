import csv
import io
from datetime import UTC, datetime

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.device import Device
from app.models.telemetry import MotionState, TelemetryRecord
from app.schemas.telemetry import TelemetryPoint


async def save_telemetry_batch(db: AsyncSession, device: Device, points: list[TelemetryPoint]) -> int:
    if not points:
        return 0

    records = [
        TelemetryRecord(
            device_id=device.id,
            event_id=point.event_id,
            recorded_at=point.recorded_at,
            heart_rate_bpm=point.heart_rate_bpm,
            spo2_percent=point.spo2_percent,
            temperature_c=point.temperature_c,
            motion_state=point.motion_state,
            raw_payload=point.raw_payload,
        )
        for point in points
    ]
    device.last_seen_at = datetime.now(UTC)
    db.add_all(records)
    await db.commit()
    return len(records)


def parse_csv_points(csv_text: str, max_points: int = 100) -> list[TelemetryPoint]:
    reader = csv.DictReader(io.StringIO(csv_text.strip()))
    if reader.fieldnames is None:
        raise ValueError("CSV file is empty or missing a header row")

    required_fields = {"recorded_at"}
    missing = sorted(required_fields - set(reader.fieldnames))
    if missing:
        raise ValueError(f"CSV is missing required columns: {', '.join(missing)}")

    points: list[TelemetryPoint] = []
    for row in reader:
        if not any((value or "").strip() for value in row.values()):
            continue

        payload = {
            "recorded_at": row.get("recorded_at"),
            "heart_rate_bpm": _parse_optional_float(row.get("heart_rate_bpm")),
            "spo2_percent": _parse_optional_float(row.get("spo2_percent")),
            "temperature_c": _parse_optional_float(row.get("temperature_c")),
            "motion_state": row.get("motion_state") or MotionState.UNKNOWN.value,
            "raw_payload": _parse_raw_payload(row),
        }

        try:
            point = TelemetryPoint.model_validate(payload)
        except ValidationError as exc:
            raise ValueError(f"Invalid telemetry row: {exc.errors()}" ) from exc
        points.append(point)
        if len(points) > max_points:
            raise ValueError(f"CSV contains more than {max_points} telemetry rows")

    if not points:
        raise ValueError("No valid telemetry rows found in CSV")
    return points


def _parse_optional_float(value: str | None) -> float | None:
    if value is None or str(value).strip() == "":
        return None
    return float(value)


def _parse_raw_payload(row: dict[str, str]) -> dict:
    extras = {k: v for k, v in row.items() if k not in {"recorded_at", "heart_rate_bpm", "spo2_percent", "temperature_c", "motion_state"}}
    cleaned: dict[str, object] = {}
    for key, value in extras.items():
        if value is None or str(value).strip() == "":
            continue
        cleaned[key] = value
    return cleaned
