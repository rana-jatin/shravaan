"""
Telemetry and SOS arriving over MQTT.

─────────────────────────────────────────────────────────────────────────────
THE SOS PATH WAS DEAD, AND IT FAILED IN A WAY NOTHING WOULD REPORT.

`_on_message` handled both topics inline, and the `sos` branch tripped over two
names before it reached the database:

  1. `import asyncio` sat halfway down the function body. That makes `asyncio`
     a LOCAL name for the whole function, so the `asyncio.run(...)` above it
     raised `UnboundLocalError` — the module-level import at the top was
     shadowed and never consulted.

  2. The alert body read `payload`, which is only assigned further down, on the
     telemetry path. Had the first error not fired, this one would have.

Both raised inside a paho callback thread, where an exception is swallowed by
the client loop. So a person pressing the hardware SOS button got silence, and
the server logged nothing at all.

WHAT CHANGED, AND WHY IT IS SHAPED THIS WAY. Parsing is now a pure function
over (topic, bytes) and the database work is an ordinary coroutine. Neither
needs a broker, a network or an event loop to exercise, which is the whole
reason the original defect survived: there was no way to call this code from a
test. The rule is the same one `ai/` holds — if it leaves the process, it goes
behind a seam.
─────────────────────────────────────────────────────────────────────────────
"""

import asyncio
import json
import logging
from concurrent.futures import CancelledError, Future
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.models.device import Device
from app.models.telemetry import Alert, AlertType, MotionState
from app.schemas.telemetry import METRIC_FIELDS, TelemetryPoint
from app.services.notification_service import dispatch_emergency_alert
from app.services.telemetry_service import save_telemetry_batch

logger = logging.getLogger(__name__)

try:
    import paho.mqtt.client as mqtt
except ImportError as exc:  # pragma: no cover
    mqtt = None
    logger.warning("paho-mqtt is not installed; MQTT support is disabled")

TELEMETRY_TOPIC = "shravaan/devices/+/telemetry"
SOS_TOPIC = "shravaan/devices/+/sos"


@dataclass(frozen=True)
class SosCommand:
    """Someone pressed the button. `details` is context, not the point."""

    device_id: UUID
    details: dict[str, Any]


@dataclass(frozen=True)
class TelemetryCommand:
    device_id: UUID
    point: TelemetryPoint


Command = SosCommand | TelemetryCommand


def parse_message(topic: str, raw: bytes) -> Command | None:
    """
    A broker message into something the database layer can act on.

    Pure: no I/O, no clock, no session. Returns None for anything malformed,
    having said why in the log — a bad message is an operational event, not an
    exception to propagate into a callback thread that would swallow it.

    THE TWO TOPICS DEGRADE DIFFERENTLY, ON PURPOSE. Telemetry with an
    unreadable payload is dropped: there is no reading to store, so there is
    nothing to do. An SOS with an unreadable payload is STILL RAISED, carrying
    whatever arrived as raw context. The alarm is the message; the JSON is
    commentary. A device with a flat battery sending a truncated frame is
    exactly when someone needs the alert to get through, and refusing to
    escalate because a field was malformed inverts what this path is for.
    """
    parts = topic.split("/")
    if len(parts) != 4 or parts[0:2] != ["shravaan", "devices"] or parts[3] not in {"telemetry", "sos"}:
        logger.warning("mqtt_invalid_topic", extra={"topic": topic})
        return None

    kind = parts[3]
    try:
        device_id = UUID(parts[2])
    except ValueError:
        logger.warning("mqtt_invalid_device_id", extra={"device_id": parts[2]})
        return None

    payload = _decode(raw)

    if kind == "sos":
        if isinstance(payload, dict):
            details = payload
        elif payload is None:
            # Unreadable, but the button was still pressed. Keep the bytes so a
            # responder can see what the device actually sent.
            details = {"raw": _describe(raw)}
        else:
            details = {"payload": payload}
        return SosCommand(device_id=device_id, details=details)

    if not isinstance(payload, dict):
        logger.warning("mqtt_invalid_payload", extra={"device_id": str(device_id)})
        return None

    # An advisory field. The topic is what identifies the device; a payload that
    # disagrees with it is either a misconfigured publisher or a spoof, and
    # either way the reading is not trustworthy enough to store.
    stated = payload.get("device_id")
    if stated is not None and str(stated) != str(device_id):
        logger.warning("mqtt_device_id_mismatch", extra={"device_id": str(device_id)})
        return None

    # ONLY THE KEYS THAT ARE ACTUALLY PRESENT.
    #
    # This was `payload.get(...)` for every field, which passes an explicit None
    # for anything the device omitted — and an explicit None DEFEATS a pydantic
    # default rather than falling back to it. `recorded_at` is the one that
    # bites: it is a plain `datetime` with a `default_factory`, so every
    # telemetry message without a timestamp was rejected and dropped, logged
    # only as `mqtt_invalid_point`. A device streaming vitals with no clock of
    # its own stored nothing at all.
    #
    # Omitting the key instead lets the schema's own default apply, which makes
    # this path agree with POST /telemetry/stream, where a client that leaves
    # `recorded_at` out gets the time of arrival.
    fields: dict[str, Any] = {
        "motion_state": payload.get("motion_state") or MotionState.UNKNOWN.value,
        "raw_payload": payload.get("raw_payload") or {"source": "mqtt"},
    }
    # METRIC_FIELDS rather than a list written out again here. A metric added to
    # the schema and forgotten in this loop would be accepted over HTTP and
    # silently dropped over MQTT — which is the harder of the two to notice,
    # because the device gets its acknowledgement either way.
    for key in ("recorded_at", "event_id", *METRIC_FIELDS):
        if payload.get(key) is not None:
            fields[key] = payload[key]

    try:
        point = TelemetryPoint.model_validate(fields)
    except ValidationError as exc:
        logger.warning("mqtt_invalid_point", extra={"error": str(exc)})
        return None

    return TelemetryCommand(device_id=device_id, point=point)


def _decode(raw: bytes) -> Any:
    """Parsed JSON, or None when it is not readable as any."""
    try:
        return json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, AttributeError):
        return None


def _describe(raw: bytes) -> str:
    """Something a human can read in an alert email, never raw bytes."""
    try:
        text = raw.decode("utf-8", errors="replace").strip()
    except AttributeError:
        return repr(raw)[:200]
    return text[:200] if text else "(empty)"


async def apply_command(db: AsyncSession, command: Command) -> bool:
    """
    Act on a parsed command. Returns whether anything was written.

    Takes the session rather than opening one so a test can hand in its own,
    and so a future caller batching several messages does not pay for a
    connection each.
    """
    device = await db.get(Device, command.device_id)
    if device is None or device.status.value != "active":
        logger.warning("mqtt_unknown_device", extra={"device_id": str(command.device_id)})
        return False

    if isinstance(command, TelemetryCommand):
        await save_telemetry_batch(db, device, [command.point])
        return True

    alert = Alert(
        device_id=device.id,
        alert_type=AlertType.SOS,
        source="mqtt_sos_button",
        details=command.details,
    )
    db.add(alert)
    await db.commit()
    await db.refresh(alert)

    # The alert row is committed BEFORE the notification goes out. If the mail
    # relay is down, the SOS is still recorded and a caregiver looking at the
    # dashboard can see it — losing the record as well as the email is the one
    # outcome worth engineering against.
    await dispatch_emergency_alert(
        {
            "alert_id": alert.id,
            "device_id": device.id,
            "source": alert.source,
            "details": alert.details,
        }
    )
    return True


class TelemetryMQTTConsumer:
    """
    Bridges paho's network thread to the application's event loop.

    ─────────────────────────────────────────────────────────────────────────
    WHY NOT `asyncio.run`, WHICH IS WHAT THIS USED TO DO.

    `asyncio.run` builds a BRAND NEW event loop, runs the coroutine on it, and
    closes it. Doing that per message puts the database work on a loop the
    engine's connections do not belong to: asyncpg binds a connection to the
    loop that opened it, so the pool built during startup is unusable from
    here. The failure is the familiar "attached to a different loop", and it
    degrades with traffic rather than failing cleanly on the first message —
    the worst shape for something a family is relying on.

    It is not theoretical. Driving the old path from a test deadlocked
    outright, because the loop closed while the driver thread was still live.

    So the loop is captured at `connect()` — which the app lifespan calls from
    inside the running loop — and every message is handed to it with
    `run_coroutine_threadsafe`. One loop, one pool, one owner.
    ─────────────────────────────────────────────────────────────────────────
    """

    #: Writes allowed in flight before telemetry starts being shed. A broker
    #: replaying a backlog can deliver far faster than Postgres will accept,
    #: and a queue with no ceiling is a memory leak with extra steps. An SOS is
    #: NEVER shed — see `_dispatch`.
    MAX_INFLIGHT = 256

    def __init__(self, session_factory: Any = None) -> None:
        if mqtt is None:
            raise RuntimeError("paho-mqtt is required for MQTT telemetry ingestion")
        self.client = mqtt.Client(client_id=settings.mqtt_client_id)
        if settings.mqtt_username and settings.mqtt_password:
            self.client.username_pw_set(settings.mqtt_username, settings.mqtt_password)

        # Injectable so a test can supply its own database. Everything else in
        # this repo that leaves the process takes its client the same way.
        self._session_factory = session_factory or AsyncSessionLocal
        self._loop: asyncio.AbstractEventLoop | None = None
        # Strong references. `run_coroutine_threadsafe` does not keep one, and
        # a future nobody holds can be collected before it finishes.
        self._inflight: set[Future[None]] = set()

    def bind_loop(self, loop: asyncio.AbstractEventLoop | None = None) -> None:
        """
        Name the loop that database work will run on.

        Separate from `connect` so it can be established without a broker —
        which is what lets a test drive `_on_message` from a real worker
        thread, the arrangement paho actually uses, instead of asserting
        against a stub.
        """
        self._loop = loop or asyncio.get_running_loop()

    def connect(self, loop: asyncio.AbstractEventLoop | None = None) -> None:
        self.bind_loop(loop)
        # Set BEFORE connecting. Registering the handler afterwards leaves a
        # window where a message could arrive with nothing to receive it.
        self.client.on_message = self._on_message
        self.client.connect(settings.mqtt_broker_host, settings.mqtt_broker_port, 60)
        self.client.subscribe(TELEMETRY_TOPIC, qos=settings.mqtt_qos)
        self.client.subscribe(SOS_TOPIC, qos=settings.mqtt_qos)
        self.client.loop_start()

    def disconnect(self) -> None:
        self.client.loop_stop()
        self.client.disconnect()
        # Stop accepting work before the loop this points at goes away.
        self._loop = None

    def _on_message(self, _client: Any, _userdata: Any, message: Any) -> None:
        """
        Runs on paho's network thread, which swallows exceptions.

        Nothing may escape this method: an error here is invisible, so it is
        caught and logged rather than left to disappear. That is also why the
        work below is two calls into tested code and nothing else.
        """
        try:
            command = parse_message(str(message.topic), message.payload)
            if command is None:
                return
            self._dispatch(command)
        except Exception:
            logger.exception("mqtt_message_failed", extra={"topic": str(message.topic)})

    def _dispatch(self, command: Command) -> None:
        """Hand one command to the application loop. Never blocks paho."""
        loop = self._loop
        if loop is None or loop.is_closed():
            # Shutdown, or a consumer that was never connected. Say so loudly:
            # a dropped SOS is the failure this whole module exists to avoid.
            logger.error(
                "mqtt_no_event_loop",
                extra={"command": type(command).__name__, "device_id": str(command.device_id)},
            )
            return

        # Backpressure applies to telemetry only. A reading is one of thousands
        # and the next one is a second away; an SOS happens once and matters.
        if isinstance(command, TelemetryCommand) and len(self._inflight) >= self.MAX_INFLIGHT:
            logger.warning("mqtt_telemetry_shed", extra={"inflight": len(self._inflight)})
            return

        try:
            future = asyncio.run_coroutine_threadsafe(self._run(command), loop)
        except RuntimeError:
            # The loop closed between the check above and here.
            logger.exception("mqtt_dispatch_failed", extra={"device_id": str(command.device_id)})
            return

        self._inflight.add(future)
        future.add_done_callback(self._finished)

    def _finished(self, future: "Future[None]") -> None:
        """
        Consume the result, or the exception disappears into the future.

        Fire-and-forget without this is how the original defect stayed silent
        for so long: the work failed and nothing anywhere said so.
        """
        self._inflight.discard(future)
        try:
            future.result()
        except CancelledError:
            logger.warning("mqtt_write_cancelled")
        except Exception:
            logger.exception("mqtt_write_failed")

    async def _run(self, command: Command) -> None:
        async with self._session_factory() as db:
            await apply_command(db, command)


consumer = TelemetryMQTTConsumer() if settings.mqtt_enabled else None
