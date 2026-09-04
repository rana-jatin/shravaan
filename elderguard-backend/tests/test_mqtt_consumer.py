"""
MQTT ingestion — parsing, and what reaches the database.

The SOS case is the reason this file exists. It raised `UnboundLocalError`
inside a paho callback thread, which swallows exceptions, so pressing the
hardware button produced no alert and no log line. These tests call the parser
and the writer directly; neither needs a broker.
"""

from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.device import Device, DeviceStatus
from app.models.telemetry import Alert, AlertType, MotionState, TelemetryRecord
from app.mqtt.consumer import (
    SosCommand,
    TelemetryCommand,
    apply_command,
    parse_message,
)

DEVICE_ID = UUID("11111111-2222-3333-4444-555555555555")


def sos_topic(device_id: UUID = DEVICE_ID) -> str:
    return f"shravaan/devices/{device_id}/sos"


def telemetry_topic(device_id: UUID = DEVICE_ID) -> str:
    return f"shravaan/devices/{device_id}/telemetry"


# ── parsing ────────────────────────────────────────────────────────────────


def test_an_sos_message_parses_into_a_command() -> None:
    """
    The regression test. This exact call raised UnboundLocalError before —
    twice over, on `asyncio` and then on `payload`.
    """
    command = parse_message(sos_topic(), b'{"button": "held", "battery": 12}')

    assert isinstance(command, SosCommand)
    assert command.device_id == DEVICE_ID
    assert command.details == {"button": "held", "battery": 12}


@pytest.mark.parametrize(
    "raw",
    [b"", b"not json at all", b"\xff\xfe\x00", b"null"],
    ids=["empty", "not-json", "invalid-utf8", "json-null"],
)
def test_an_sos_is_raised_even_when_its_payload_is_unreadable(raw: bytes) -> None:
    """
    The alarm is the message; the JSON is commentary. A device with a failing
    battery sending a truncated frame is exactly when the alert must survive.
    """
    command = parse_message(sos_topic(), raw)

    assert isinstance(command, SosCommand)
    assert command.device_id == DEVICE_ID
    assert command.details, "details must carry something a responder can read"


def test_an_sos_payload_that_is_not_an_object_is_kept_verbatim() -> None:
    command = parse_message(sos_topic(), b'"help"')
    assert isinstance(command, SosCommand)
    assert command.details == {"payload": "help"}


def test_a_telemetry_message_parses_into_a_point() -> None:
    command = parse_message(
        telemetry_topic(),
        b'{"heart_rate_bpm": 72, "spo2_percent": 98, "motion_state": "walking"}',
    )

    assert isinstance(command, TelemetryCommand)
    assert command.point.heart_rate_bpm == 72
    assert command.point.motion_state == MotionState.WALKING


def test_unreadable_telemetry_is_dropped_rather_than_stored() -> None:
    # Nothing to store, so nothing to do — the opposite call from SOS above.
    assert parse_message(telemetry_topic(), b"not json") is None
    assert parse_message(telemetry_topic(), b'"a string"') is None


def test_out_of_range_telemetry_is_dropped() -> None:
    assert parse_message(telemetry_topic(), b'{"heart_rate_bpm": 400}') is None


def test_telemetry_is_dropped_when_the_payload_names_a_different_device() -> None:
    other = uuid4()
    assert parse_message(telemetry_topic(), f'{{"device_id": "{other}", "heart_rate_bpm": 72}}'.encode()) is None


def test_telemetry_is_kept_when_the_payload_agrees_with_the_topic() -> None:
    raw = f'{{"device_id": "{DEVICE_ID}", "heart_rate_bpm": 72}}'.encode()
    assert isinstance(parse_message(telemetry_topic(), raw), TelemetryCommand)


@pytest.mark.parametrize(
    "topic",
    [
        "shravaan/devices/{id}/unknown",
        "shravaan/devices/{id}",
        "other/devices/{id}/sos",
        "shravaan/devices/{id}/sos/extra",
        "",
    ],
)
def test_a_topic_outside_the_contract_is_refused(topic: str) -> None:
    assert parse_message(topic.format(id=DEVICE_ID), b"{}") is None


def test_a_device_id_that_is_not_a_uuid_is_refused() -> None:
    assert parse_message("shravaan/devices/not-a-uuid/sos", b"{}") is None


# ── writing ────────────────────────────────────────────────────────────────


async def make_device(
    sessionmaker: async_sessionmaker[AsyncSession],
    status: DeviceStatus = DeviceStatus.ACTIVE,
) -> UUID:
    async with sessionmaker() as db:
        device = Device(
            id=DEVICE_ID,
            hardware_uid="mqtt-device-0001",
            qr_token_hash="hash-of-a-consumed-token",
            status=status,
        )
        db.add(device)
        await db.commit()
    return DEVICE_ID


async def test_an_sos_command_writes_an_alert(
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    await make_device(db_sessionmaker)
    command = parse_message(sos_topic(), b'{"button": "held"}')
    assert command is not None

    async with db_sessionmaker() as db:
        assert await apply_command(db, command) is True

    async with db_sessionmaker() as db:
        alert = (await db.execute(select(Alert))).scalar_one()
        assert alert.alert_type == AlertType.SOS
        assert alert.source == "mqtt_sos_button"
        assert alert.details == {"button": "held"}


async def test_a_telemetry_command_writes_a_record(
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    await make_device(db_sessionmaker)
    command = parse_message(telemetry_topic(), b'{"heart_rate_bpm": 72}')
    assert command is not None

    async with db_sessionmaker() as db:
        assert await apply_command(db, command) is True

    async with db_sessionmaker() as db:
        record = (await db.execute(select(TelemetryRecord))).scalar_one()
        assert record.heart_rate_bpm == 72


async def test_nothing_is_written_for_an_unknown_device(
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    command = parse_message(sos_topic(), b'{"button": "held"}')
    assert command is not None

    async with db_sessionmaker() as db:
        assert await apply_command(db, command) is False
        assert (await db.execute(select(Alert))).first() is None


async def test_nothing_is_written_for_a_revoked_device(
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    """
    A revoked device is one that was taken out of service. Accepting its SOS
    would send a family to an address nobody lives at any more.
    """
    await make_device(db_sessionmaker, status=DeviceStatus.REVOKED)
    command = parse_message(sos_topic(), b'{"button": "held"}')
    assert command is not None

    async with db_sessionmaker() as db:
        assert await apply_command(db, command) is False


async def test_the_alert_is_recorded_even_when_notification_fails(
    db_sessionmaker: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    Losing the email is survivable; losing the email AND the record is not.
    A caregiver opening the dashboard has to be able to see that it happened.
    """
    from app.mqtt import consumer as module

    async def explode(_payload: dict[str, Any]) -> None:
        raise RuntimeError("smtp relay unreachable")

    monkeypatch.setattr(module, "dispatch_emergency_alert", explode)

    await make_device(db_sessionmaker)
    command = parse_message(sos_topic(), b'{"button": "held"}')
    assert command is not None

    async with db_sessionmaker() as db:
        with pytest.raises(RuntimeError):
            await apply_command(db, command)

    async with db_sessionmaker() as db:
        assert (await db.execute(select(Alert))).scalar_one() is not None


async def test_telemetry_without_a_timestamp_is_accepted_and_stamped(
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    """
    Regression. Every field was previously passed as `payload.get(...)`, and an
    explicit None defeats a pydantic default instead of falling back to it — so
    a device with no clock of its own had every reading silently dropped.
    """
    command = parse_message(telemetry_topic(), b'{"heart_rate_bpm": 72}')

    assert isinstance(command, TelemetryCommand)
    assert command.point.recorded_at is not None

    await make_device(db_sessionmaker)
    async with db_sessionmaker() as db:
        assert await apply_command(db, command) is True


def test_the_broker_callback_never_lets_an_exception_escape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    paho runs `_on_message` on its own network thread and swallows whatever it
    raises. That is how the SOS crash stayed invisible, so nothing may escape
    here — not even a message that is complete nonsense, and not even when the
    database work itself fails.

    The database work is STUBBED rather than exercised, and deliberately so.
    `_on_message` still calls `asyncio.run` per message, which spins up a fresh
    event loop while the engine's connection thread belongs to another one —
    driving it for real from a test deadlocks. That is the next step in the
    plan; this test covers the callback's own contract and nothing else.
    """
    from app.mqtt.consumer import TelemetryMQTTConsumer

    class Message:
        def __init__(self, topic: str, payload: Any) -> None:
            self.topic = topic
            self.payload = payload

    dispatched: list[Any] = []

    async def record(self: Any, command: Any) -> None:
        dispatched.append(command)

    async def explode(self: Any, command: Any) -> None:
        raise RuntimeError("the database is unreachable")

    # Built without __init__, which wants a broker. Only the callback is under test.
    consumer = object.__new__(TelemetryMQTTConsumer)

    monkeypatch.setattr(TelemetryMQTTConsumer, "_run", record)
    for message in (
        Message(sos_topic(), b'{"button": "held"}'),
        Message(telemetry_topic(), b'{"heart_rate_bpm": 72}'),
    ):
        TelemetryMQTTConsumer._on_message(consumer, None, None, message)
    assert len(dispatched) == 2, "a valid message must reach the database layer"

    # Nonsense reaches the parser, is refused there, and never gets this far.
    for message in (
        Message("garbage", b""),
        Message("shravaan/devices/not-a-uuid/sos", b"{}"),
        Message(telemetry_topic(), b"not json"),
        Message(sos_topic(), None),
        Message(sos_topic(), object()),
    ):
        TelemetryMQTTConsumer._on_message(consumer, None, None, message)

    # And a failure below the parser is logged, not raised into paho's thread.
    monkeypatch.setattr(TelemetryMQTTConsumer, "_run", explode)
    TelemetryMQTTConsumer._on_message(
        consumer, None, None, Message(sos_topic(), b'{"button": "held"}')
    )
