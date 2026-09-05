"""
MQTT ingestion — parsing, and what reaches the database.

The SOS case is the reason this file exists. It raised `UnboundLocalError`
inside a paho callback thread, which swallows exceptions, so pressing the
hardware button produced no alert and no log line. These tests call the parser
and the writer directly; neither needs a broker.
"""

import asyncio
import logging
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
    TelemetryMQTTConsumer,
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


# ── the broker thread ──────────────────────────────────────────────────────


class Message:
    """What paho hands the callback."""

    def __init__(self, topic: str, payload: Any) -> None:
        self.topic = topic
        self.payload = payload


async def drain(consumer: "TelemetryMQTTConsumer") -> None:
    """Wait for every write the consumer dispatched."""
    for future in list(consumer._inflight):
        await asyncio.wrap_future(future)


async def test_a_broker_message_reaches_the_database_from_another_thread(
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    """
    The arrangement paho actually uses: the callback fires on a network thread
    while the database belongs to the application's loop.

    This is the test that could not be written before. Driving the old
    `asyncio.run`-per-message path from here deadlocked outright, because that
    built a second loop and closed it under the connection pool.
    """
    await make_device(db_sessionmaker)

    consumer = TelemetryMQTTConsumer(session_factory=db_sessionmaker)
    consumer.bind_loop()

    await asyncio.to_thread(
        consumer._on_message, None, None, Message(sos_topic(), b'{"button": "held"}')
    )
    await drain(consumer)

    async with db_sessionmaker() as db:
        alert = (await db.execute(select(Alert))).scalar_one()
        assert alert.alert_type == AlertType.SOS
        assert alert.details == {"button": "held"}


async def test_repeated_messages_from_the_broker_thread_are_all_recorded(
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    """
    The bridge holds across many messages, not just the first.

    Each write is drained before the next is published, and that is a LIMIT OF
    THE HARNESS rather than a claim about production. The test database is one
    SQLite connection shared through a StaticPool, so several sessions writing
    at once interleave on a single transaction and silently lose rows —
    SQLAlchemy's documented hazard for sharing a connection across concurrent
    tasks. Postgres hands each session its own connection from a real pool, so
    genuine write concurrency belongs in a test against Postgres. Recorded as a
    follow-up rather than faked here.
    """
    await make_device(db_sessionmaker)

    consumer = TelemetryMQTTConsumer(session_factory=db_sessionmaker)
    consumer.bind_loop()

    for beat in (70, 72, 74, 76, 78):
        await asyncio.to_thread(
            consumer._on_message,
            None,
            None,
            Message(telemetry_topic(), f'{{"heart_rate_bpm": {beat}}}'.encode()),
        )
        await drain(consumer)

    async with db_sessionmaker() as db:
        records = (await db.execute(select(TelemetryRecord))).scalars().all()
        assert sorted(r.heart_rate_bpm for r in records) == [70, 72, 74, 76, 78]


async def test_several_messages_in_flight_all_complete(
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    """
    What CAN be asserted about concurrency here: every write the broker thread
    dispatched runs to completion without raising, and the consumer's in-flight
    set empties. Whether all the rows land is the harness limitation above.
    """
    await make_device(db_sessionmaker)

    consumer = TelemetryMQTTConsumer(session_factory=db_sessionmaker)
    consumer.bind_loop()

    def publish_burst() -> None:
        for beat in (70, 72, 74, 76, 78):
            consumer._on_message(
                None, None, Message(telemetry_topic(), f'{{"heart_rate_bpm": {beat}}}'.encode())
            )

    await asyncio.to_thread(publish_burst)
    await drain(consumer)

    assert not consumer._inflight, "every dispatched write must be accounted for"


async def test_telemetry_is_shed_under_backpressure_but_an_sos_never_is(
    db_sessionmaker: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    A broker replaying a backlog can deliver faster than the database accepts.
    Dropping a reading is a gap in a chart; dropping an SOS is the failure this
    module exists to prevent, so the ceiling applies to one and not the other.
    """
    await make_device(db_sessionmaker)

    consumer = TelemetryMQTTConsumer(session_factory=db_sessionmaker)
    consumer.bind_loop()
    monkeypatch.setattr(TelemetryMQTTConsumer, "MAX_INFLIGHT", 0)

    await asyncio.to_thread(
        consumer._on_message, None, None, Message(telemetry_topic(), b'{"heart_rate_bpm": 72}')
    )
    await asyncio.to_thread(
        consumer._on_message, None, None, Message(sos_topic(), b'{"button": "held"}')
    )
    await drain(consumer)

    async with db_sessionmaker() as db:
        assert (await db.execute(select(TelemetryRecord))).first() is None
        assert (await db.execute(select(Alert))).scalar_one() is not None


async def test_a_message_arriving_after_shutdown_is_logged_not_raised(
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    """
    Messages can arrive between `loop_stop` and the loop going away. Without
    the guard this is where `run_coroutine_threadsafe` raises, on paho's
    thread, where nobody would see it.
    """
    consumer = TelemetryMQTTConsumer(session_factory=db_sessionmaker)
    consumer.bind_loop()
    consumer._loop = None

    await asyncio.to_thread(
        consumer._on_message, None, None, Message(sos_topic(), b'{"button": "held"}')
    )
    assert not consumer._inflight


async def test_a_failing_write_is_logged_rather_than_lost(
    db_sessionmaker: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """
    Fire-and-forget swallows exceptions unless somebody consumes the future.
    That is precisely how the original defect stayed invisible.
    """

    class BrokenSessionFactory:
        def __call__(self) -> Any:
            raise RuntimeError("the database is unreachable")

    consumer = TelemetryMQTTConsumer(session_factory=BrokenSessionFactory())
    consumer.bind_loop()

    with caplog.at_level(logging.ERROR):
        await asyncio.to_thread(
            consumer._on_message, None, None, Message(sos_topic(), b'{"button": "held"}')
        )
        for future in list(consumer._inflight):
            with pytest.raises(RuntimeError):
                await asyncio.wrap_future(future)

    assert any("mqtt_write_failed" in record.message for record in caplog.records)


def test_the_broker_callback_never_lets_an_exception_escape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    paho runs `_on_message` on its own network thread and swallows whatever it
    raises. That is how the SOS crash stayed invisible, so nothing may escape
    here — not for a message that is complete nonsense, and not when the
    dispatch below it fails.

    No loop is bound, so dispatch takes the shutdown branch and logs. The
    threaded tests above are what cover the loop actually running.
    """
    consumer = TelemetryMQTTConsumer()

    for message in (
        Message("garbage", b""),
        Message("shravaan/devices/not-a-uuid/sos", b"{}"),
        Message(telemetry_topic(), b"not json"),
        Message(sos_topic(), None),
        Message(sos_topic(), object()),
        Message(sos_topic(), b'{"button": "held"}'),
    ):
        TelemetryMQTTConsumer._on_message(consumer, None, None, message)

    assert not consumer._inflight

    def explode(self: Any, command: Any) -> None:
        raise RuntimeError("dispatch is broken")

    monkeypatch.setattr(TelemetryMQTTConsumer, "_dispatch", explode)
    TelemetryMQTTConsumer._on_message(
        consumer, None, None, Message(sos_topic(), b'{"button": "held"}')
    )
