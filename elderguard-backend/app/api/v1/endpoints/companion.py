"""
The seam the companion talks through.

─────────────────────────────────────────────────────────────────────────────
WHY THESE ROUTES EXIST AT ALL, WHEN /telemetry ALREADY DOES. Those routes are
a device's: they authenticate as one device, take a batch, and are shaped for
a band streaming every few seconds. The companion is not a device. It acts for
whoever is currently talking to it, one reading at a time, and it needs to
READ — the existing API has no way to ask what somebody's last blood pressure
was, because until now nothing ever asked.

THE DIRECTION OF THE ARROW IS DELIBERATE. The companion calls this service;
this service never calls the companion. It means no inbound authentication to
build on the Node side, no webhook to retry, and — when this service is down —
a companion that simply cannot store a reading and says so, rather than one
half-holding state for a service it cannot reach. The cost is that an alert
raised here is seen when the companion next polls, which is seconds, not
instant. For an out-of-range reading that is the right trade. For an SOS it is
not, which is why the SOS path still sends its own email immediately and this
is the second, slower thing that also happens.

⚠ NOTHING HERE RETURNS FREE TEXT AND NOTHING HERE ACCEPTS IT. See the note at
the top of schemas/companion.py: the companion holds a transcript of somebody's
home and this service holds their health record, and the two must not be
joined by accident.
─────────────────────────────────────────────────────────────────────────────
"""

from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, get_elder, require_companion
from app.models.device import Device, DeviceStatus
from app.models.telemetry import Alert, AlertStatus, TelemetryRecord
from app.models.user import User
from app.schemas.companion import (
    AlertAck,
    CompanionAlert,
    CompanionContext,
    ContextIdentity,
    SelfReportedVital,
    VitalRead,
    VitalsAccepted,
)
from app.schemas.telemetry import TelemetryPoint
from app.services.telemetry_service import save_telemetry_batch

router = APIRouter(
    prefix="/companion",
    tags=["Companion"],
    # ON THE ROUTER, NOT PER ROUTE. A dependency added to each handler is one
    # somebody forgets on the handler they add next, and the one they forget is
    # always the one that reads somebody's vitals.
    dependencies=[Depends(require_companion)],
)


async def _devices_of(db: AsyncSession, user: User) -> list[Device]:
    rows = await db.scalars(
        select(Device)
        .where(Device.owner_id == user.id, Device.status == DeviceStatus.ACTIVE)
        .order_by(Device.last_seen_at.desc().nullslast(), Device.created_at.desc())
    )
    return list(rows)


@router.post(
    "/vitals/{uid}",
    response_model=VitalsAccepted,
    status_code=status.HTTP_201_CREATED,
    summary="Record a reading the user said out loud",
)
async def record_vital(
    reading: SelfReportedVital,
    elder: User = Depends(get_elder),
    db: AsyncSession = Depends(get_db),
) -> VitalsAccepted:
    """
    ATTRIBUTED TO THE PERSON'S OWN DEVICE, because `telemetry_records` is keyed
    by device and a reading with nowhere to hang is not storable. The device
    the companion is running on is the closest true answer available: it is
    the thing that was in the room.

    No device means a 409 rather than a silent success. The companion says it
    cannot keep the number, which is a poor answer and an honest one — the
    alternative is a person telling their device their blood sugar every
    morning for a month and nothing being there.
    """
    devices = await _devices_of(db, elder)
    if not devices:
        raise HTTPException(
            status_code=409,
            detail="This user has no active paired device to attribute the reading to",
        )

    point = TelemetryPoint(
        recorded_at=reading.recorded_at or datetime.now(UTC),
        heart_rate_bpm=reading.heart_rate_bpm,
        spo2_percent=reading.spo2_percent,
        temperature_c=reading.temperature_c,
        systolic_mmhg=reading.systolic_mmhg,
        diastolic_mmhg=reading.diastolic_mmhg,
        glucose_mgdl=reading.glucose_mgdl,
        # THE ONE FIELD THAT MAKES THIS ROW READABLE LATER. Everything else is
        # identical to what a sensor would have written.
        source="self_reported",
        raw_payload={"glucose_context": reading.glucose_context.value},
    )

    device = devices[0]
    before = await _latest_alert_id(db, device)
    await save_telemetry_batch(db, device, [point])
    after = await _latest_alert_id(db, device)

    return VitalsAccepted(stored=True, device_id=device.id, alerted=before != after)


async def _latest_alert_id(db: AsyncSession, device: Device) -> UUID | None:
    """
    Which alert was newest before and after the write.

    Cheaper and more honest than re-running the bands here: the same reading
    can be inside them, outside them but inside the cooldown, or genuinely new,
    and only the save path knows which. Comparing the newest id across the call
    answers "did this reading raise something" without duplicating that logic.
    """
    return await db.scalar(
        select(Alert.id).where(Alert.device_id == device.id).order_by(Alert.created_at.desc()).limit(1)
    )


@router.get(
    "/vitals/{uid}",
    response_model=list[VitalRead],
    summary="The user's most recent readings",
)
async def recent_vitals(
    elder: User = Depends(get_elder),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=10, ge=1, le=100),
) -> list[TelemetryRecord]:
    """
    Newest first, across every device this person has.

    Bounded low on purpose. This answers "what was my blood pressure on
    Tuesday", which is a question with a short answer; it is not an export, and
    a companion that could pull a thousand rows into a prompt would eventually
    do so.
    """
    devices = await _devices_of(db, elder)
    if not devices:
        return []

    rows = await db.scalars(
        select(TelemetryRecord)
        .where(TelemetryRecord.device_id.in_([d.id for d in devices]))
        .order_by(TelemetryRecord.recorded_at.desc())
        .limit(limit)
    )
    return list(rows)


@router.get(
    "/alerts/{uid}",
    response_model=list[CompanionAlert],
    summary="Alerts nobody has dealt with yet",
)
async def open_alerts(
    elder: User = Depends(get_elder),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=20, ge=1, le=100),
) -> list[Alert]:
    """
    OPEN ONLY, OLDEST FIRST. The companion opens an escalation ladder per alert
    it sees here, and it acknowledges each one as it deals with it — so an
    alert that is still `open` on the next poll is one still waiting, and the
    ordering means a backlog is worked through in the order it happened rather
    than newest-first, which would leave the oldest unattended forever.
    """
    devices = await _devices_of(db, elder)
    if not devices:
        return []

    rows = await db.scalars(
        select(Alert)
        .where(Alert.device_id.in_([d.id for d in devices]), Alert.status == AlertStatus.OPEN)
        .order_by(Alert.created_at)
        .limit(limit)
    )
    return list(rows)


@router.post(
    "/alerts/{uid}/{alert_id}/ack",
    response_model=CompanionAlert,
    summary="Record what asking about an alert produced",
)
async def acknowledge_alert(
    alert_id: UUID,
    ack: AlertAck,
    elder: User = Depends(get_elder),
    db: AsyncSession = Depends(get_db),
) -> Alert:
    """
    THE UID IS IN THE PATH AND IS CHECKED, even though the alert id alone would
    find the row. An id is a bearer of authority when nothing else is checked,
    and this endpoint is reached with a key that acts for every user at once —
    so the row has to belong to the person named, or it is a 404.

    Acknowledging is idempotent. The ladder can settle the same alert twice
    (the person answered, and the sweep had already queued a retry), and the
    second call must not be an error the companion has to reason about.
    """
    devices = await _devices_of(db, elder)
    alert = await db.scalar(
        select(Alert).where(Alert.id == alert_id, Alert.device_id.in_([d.id for d in devices]))
    )
    if alert is None:
        raise HTTPException(status_code=404, detail="No such alert for this user")

    alert.status = ack.status
    await db.commit()
    await db.refresh(alert)
    return alert


@router.get(
    "/context/{uid}",
    response_model=CompanionContext,
    summary="Who the companion is talking to",
)
async def companion_context(elder: User = Depends(get_elder)) -> CompanionContext:
    """
    What goes into the model's prompt at the top of a session.

    ⚠ NO HEALTH DATA, DELIBERATELY, and the schema says why at length. This is
    the one payload the companion reads without being asked to, so anything in
    it is something the device may raise unprompted — and a companion that
    opens with yesterday's alarming pulse reading is the exact product nobody
    should build. Vitals are behind a tool the person has to ask for.
    """
    return CompanionContext(
        uid=str(elder.id),
        fetched_at=datetime.now(UTC),
        identity=ContextIdentity(display_name=elder.full_name),
        entitlements=[],
    )
