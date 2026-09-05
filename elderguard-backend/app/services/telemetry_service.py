"""
Storing readings, and noticing when one of them is worth someone hearing about.

THE SECOND HALF IS NEW AND IS THE POINT. `save_telemetry_batch` used to write
rows and return a count; `evaluate_anomaly` sat next door with no callers. Every
reading this service has ever accepted was therefore filed and forgotten, which
is a strange thing for a safety product to do with vital signs.

WHY THE EVALUATION IS INSIDE THE SAVE rather than in the endpoints. There are
three ways a reading arrives — POST /telemetry/stream, the CSV upload, and the
MQTT consumer — and all three already funnel through here. Putting it in the
endpoints would mean remembering it three times, and the one that gets
forgotten is always the one nobody is watching.
"""

import csv
import io
import logging
from datetime import UTC, datetime

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.device import Device
from app.models.telemetry import Alert, AlertStatus, AlertType, MotionState, TelemetryRecord
from app.schemas.telemetry import TelemetryPoint
from app.services.ml_eval_service import Finding, alert_type_for, evaluate_anomaly

logger = logging.getLogger(__name__)

#: Columns `parse_csv_points` reads as metrics. Anything else in the file is
#: kept as `raw_payload`, so a caregiver's own notes column survives the trip.
CSV_METRIC_COLUMNS = (
    "heart_rate_bpm",
    "spo2_percent",
    "temperature_c",
    "systolic_mmhg",
    "diastolic_mmhg",
    "glucose_mgdl",
)


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
            systolic_mmhg=point.systolic_mmhg,
            diastolic_mmhg=point.diastolic_mmhg,
            glucose_mgdl=point.glucose_mgdl,
            motion_state=point.motion_state,
            source=point.source,
            raw_payload=point.raw_payload,
        )
        for point in points
    ]
    device.last_seen_at = datetime.now(UTC)
    db.add_all(records)
    await db.commit()

    # AFTER the commit, deliberately. The readings are the record and must
    # survive whatever the alerting path does; an alert that cannot be raised
    # is not a reason to lose the data that would have explained it. Same rule
    # the MQTT SOS path follows — see the note in mqtt/consumer.py.
    await raise_alerts_for(db, device, points)
    return len(records)


async def raise_alerts_for(
    db: AsyncSession, device: Device, points: list[TelemetryPoint]
) -> Alert | None:
    """
    At most one alert for the whole batch. Returns it, or None.

    ONE PER BATCH, NOT ONE PER READING. A band streaming every five seconds
    sends the same out-of-range pulse a dozen times a minute, and a device
    replaying a backlog after a dropout can deliver a hundred of them at once.
    Each of those is the same event, and a hundred rows would make the alert
    table useless exactly when somebody needs to read it.

    A FALL WINS OVER A READING when the batch contains both, because it is the
    more urgent thing to be asked about and the two would otherwise race on
    whichever point happened to come first in the list.

    ⚠ NOTHING IS EMAILED HERE, unlike the SOS path. An out-of-range reading is
    not a confirmed emergency, and telling a family that one occurred before
    anybody has asked the person how they are is precisely the false alarm the
    wide bands in ml_eval_service exist to avoid. The alert is a row; the
    companion picks it up, asks, and escalates only if nobody answers.
    """
    if not settings.anomaly_alerts_enabled:
        return None

    worst: AlertType | None = None
    findings: tuple[Finding, ...] = ()
    at: datetime | None = None

    for point in points:
        metrics = point.model_dump()
        kind = alert_type_for(metrics)
        if kind is None:
            continue
        # FALL outranks ANOMALY. Among equals the first one wins, which is the
        # earliest reading in the batch that showed it — a batch is one event,
        # and the moment it started is the useful one to report.
        promotes = worst is None or (kind is AlertType.FALL and worst is not AlertType.FALL)
        if promotes:
            worst, findings, at = kind, evaluate_anomaly(metrics), point.recorded_at

    if worst is None:
        return None

    if await _recently_alerted(db, device, worst):
        logger.info(
            "alert_suppressed_within_cooldown",
            extra={"device_id": str(device.id), "alert_type": worst.value},
        )
        return None

    alert = Alert(
        device_id=device.id,
        alert_type=worst,
        source="telemetry",
        details={
            "observed_at": at.isoformat() if at else None,
            "readings": [finding.describe() for finding in findings],
            # Said in the row itself, because `details` is what a dashboard
            # renders and what an email quotes. Nobody reading this should have
            # to know how the thresholds work to know what it does not claim.
            "note": "a reading fell outside its expected range; this is not a diagnosis",
        },
    )
    db.add(alert)
    await db.commit()
    await db.refresh(alert)

    # WARNING rather than INFO: until the companion is wired to it, this log
    # line is the only place a raised anomaly is visible to a human at all.
    logger.warning(
        "telemetry_alert_raised",
        extra={
            "alert_id": str(alert.id),
            "device_id": str(device.id),
            "alert_type": worst.value,
            "readings": len(findings),
        },
    )
    return alert


async def _recently_alerted(db: AsyncSession, device: Device, kind: AlertType) -> bool:
    """
    Has this device already raised this kind of alert lately?

    A TIME WINDOW RATHER THAN "IS ONE STILL OPEN", and the difference matters.
    An open-status check reads better and fails worse: nothing resolves an
    alert unless somebody acts on it, so one unattended anomaly would suppress
    every anomaly after it, forever, silently. A window always reopens.

    The comparison is done in Python against a normalised value because
    `DateTime(timezone=True)` is honoured by Postgres and ignored by SQLite —
    the suite runs on the latter, so a naive value coming back is the ordinary
    case and not a fault. Ordering is left to SQL, which both agree on.
    """
    latest = await db.scalar(
        select(Alert)
        .where(
            Alert.device_id == device.id,
            Alert.alert_type == kind,
            # A resolved alert is a closed episode. The next reading of the
            # same kind is news again, however recently the last one was filed.
            Alert.status != AlertStatus.RESOLVED,
        )
        .order_by(Alert.created_at.desc())
        .limit(1)
    )
    if latest is None or latest.created_at is None:
        return False

    created = latest.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=UTC)
    age_seconds = (datetime.now(UTC) - created).total_seconds()
    return age_seconds < settings.anomaly_cooldown_minutes * 60


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
            "motion_state": row.get("motion_state") or MotionState.UNKNOWN.value,
            "raw_payload": _parse_raw_payload(row),
        }
        for column in CSV_METRIC_COLUMNS:
            payload[column] = _parse_optional_float(row.get(column))
        # A file is a file, whoever typed it. Overriding the default here would
        # let an uploaded spreadsheet claim its numbers came off a sensor.
        payload["source"] = "csv_upload"

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
    known = {"recorded_at", "motion_state", "source", *CSV_METRIC_COLUMNS}
    extras = {k: v for k, v in row.items() if k not in known}
    cleaned: dict[str, object] = {}
    for key, value in extras.items():
        if value is None or str(value).strip() == "":
            continue
        cleaned[key] = value
    return cleaned
