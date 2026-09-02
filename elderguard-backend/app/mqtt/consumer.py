import json
import logging
import asyncio
from typing import Any
from uuid import UUID

from pydantic import ValidationError

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.models.device import Device
from app.models.telemetry import MotionState
from app.models.telemetry import Alert, AlertType
from app.schemas.telemetry import TelemetryPoint
from app.services.notification_service import dispatch_emergency_alert
from app.services.telemetry_service import save_telemetry_batch

logger = logging.getLogger(__name__)

try:
    import paho.mqtt.client as mqtt
except ImportError as exc:  # pragma: no cover
    mqtt = None
    logger.warning("paho-mqtt is not installed; MQTT support is disabled")


class TelemetryMQTTConsumer:
    def __init__(self) -> None:
        if mqtt is None:
            raise RuntimeError("paho-mqtt is required for MQTT telemetry ingestion")
        self.client = mqtt.Client(client_id=settings.mqtt_client_id)
        if settings.mqtt_username and settings.mqtt_password:
            self.client.username_pw_set(settings.mqtt_username, settings.mqtt_password)

    def connect(self) -> None:
        self.client.connect(settings.mqtt_broker_host, settings.mqtt_broker_port, 60)
        self.client.on_message = self._on_message
        self.client.subscribe("shravaan/devices/+/telemetry", qos=settings.mqtt_qos)
        self.client.subscribe("shravaan/devices/+/sos", qos=settings.mqtt_qos)
        self.client.loop_start()

    def disconnect(self) -> None:
        self.client.loop_stop()
        self.client.disconnect()

    def _on_message(self, _client: Any, _userdata: Any, message: Any) -> None:
        topic_parts = str(message.topic).split("/")
        if len(topic_parts) != 4 or topic_parts[0:2] != ["shravaan", "devices"] or topic_parts[3] not in {"telemetry", "sos"}:
            logger.warning("mqtt_invalid_topic", extra={"topic": message.topic})
            return
        device_id = topic_parts[2]
        try:
            device_uuid = UUID(device_id)
        except ValueError:
            logger.warning("mqtt_invalid_device_id", extra={"device_id": device_id})
            return

        if topic_parts[3] == "sos":
            async def _save_sos() -> None:
                async with AsyncSessionLocal() as db:
                    device = await db.get(Device, device_uuid)
                    if device is None or device.status.value != "active":
                        logger.warning("mqtt_unknown_device", extra={"device_id": device_id})
                        return
                    alert = Alert(
                        device_id=device.id,
                        alert_type=AlertType.SOS,
                        source="mqtt_sos_button",
                        details=payload if isinstance(payload, dict) else {"payload": payload},
                    )
                    db.add(alert)
                    await db.commit()
                    await db.refresh(alert)
                    await dispatch_emergency_alert({
                        "alert_id": alert.id,
                        "device_id": device.id,
                        "source": alert.source,
                        "details": alert.details,
                    })

            asyncio.run(_save_sos())
            return

        try:
            payload = json.loads(message.payload.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            logger.warning("mqtt_invalid_payload", extra={"error": str(exc)})
            return

        try:
            point = TelemetryPoint.model_validate({
                "recorded_at": payload.get("recorded_at"),
                "heart_rate_bpm": payload.get("heart_rate_bpm"),
                "spo2_percent": payload.get("spo2_percent"),
                "temperature_c": payload.get("temperature_c"),
                "motion_state": payload.get("motion_state") or MotionState.UNKNOWN.value,
                "raw_payload": payload.get("raw_payload") or {"source": "mqtt"},
            })
        except ValidationError as exc:
            logger.warning("mqtt_invalid_point", extra={"error": str(exc)})
            return

        if payload.get("device_id") not in (None, device_id):
            logger.warning("mqtt_device_id_mismatch", extra={"device_id": device_id})
            return

        import asyncio

        async def _save() -> None:
            async with AsyncSessionLocal() as db:
                device = await db.get(Device, device_uuid)
                if device is None or device.status.value != "active":
                    logger.warning("mqtt_unknown_device", extra={"device_id": device_id})
                    return
                await save_telemetry_batch(db, device, [point])

        asyncio.run(_save())


consumer = TelemetryMQTTConsumer() if settings.mqtt_enabled else None
