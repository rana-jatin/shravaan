"""The real device client — mic in, speaker out, over the protocol documented
at the top of ai/scripts/device-client.ts (the laptop stand-in for this):

  device -> server   binary  : linear16 PCM @ ASR_SAMPLE_RATE, mono
  device -> server   json    : { type: "hello", uid, sid?, locale_hint? }
  server -> device   binary  : linear16 PCM @ TTS_SAMPLE_RATE, mono
  server -> device   json    : ready | notice | clear_audio | session_closed
                               play_media | stop_media | set_media_volume

Audio is moved by ffmpeg (capture, ALSA) and ffplay (playback) rather than a
native binding — same reasoning as the TS device client: it runs on stock Pi
OS with no build step. Radio/YouTube media playback (play_media/stop_media)
is NOT implemented here yet — those messages are logged and ignored. See
ai/scripts/device-client.ts's MediaPlayer for what a real implementation
needs (ducking, a media resolver, gain ramping).

Sensor readings (pi_client/sensors/) are polled and logged locally. There is
no WS protocol field for them yet — that's follow-up work once there's a
server-side consumer for the data, not something this starter should invent
on its own.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import uuid
from datetime import datetime, timezone

import websockets
import paho.mqtt.client as mqtt
from websockets.asyncio.client import ClientConnection

from pi_client.sensors.climate import Climate
from pi_client.sensors.imu import Imu


def log(msg: str, **extra: object) -> None:
    line = {
        "t": datetime.now(timezone.utc).isoformat(),
        "src": "pi-client",
        "msg": msg,
        **extra,
    }
    print(json.dumps(line), flush=True)


def parse_args(argv: list[str]) -> argparse.Namespace:
    port = os.environ.get("PORT", "8080").strip() or "8080"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=f"ws://127.0.0.1:{port}")
    parser.add_argument("--uid", default="pi-dev")
    parser.add_argument("--sid", default=None)
    parser.add_argument("--locale", default=None)
    parser.add_argument("--mic", default="default", help="ALSA input device name")
    parser.add_argument(
        "--asr-rate", type=int, default=int(os.environ.get("ASR_SAMPLE_RATE", "16000"))
    )
    parser.add_argument(
        "--tts-rate", type=int, default=int(os.environ.get("TTS_SAMPLE_RATE", "24000"))
    )
    parser.add_argument(
        "--frame-ms", type=int, default=int(os.environ.get("DEVICE_FRAME_MS", "80"))
    )
    parser.add_argument(
        "--sensor-interval-s",
        type=float,
        default=5.0,
        help="how often to poll and log IMU/climate readings",
    )
    parser.add_argument("--no-sensors", action="store_true")
    parser.add_argument("--device-id", default=os.environ.get("DEVICE_ID"))
    parser.add_argument("--mqtt-host", default=os.environ.get("MQTT_BROKER_HOST", "127.0.0.1"))
    parser.add_argument("--mqtt-port", type=int, default=int(os.environ.get("MQTT_BROKER_PORT", "1883")))
    parser.add_argument("--mqtt-username", default=os.environ.get("MQTT_USERNAME"))
    parser.add_argument("--mqtt-password", default=os.environ.get("MQTT_PASSWORD"))
    parser.add_argument("--mqtt-topic-prefix", default=os.environ.get("MQTT_TOPIC_PREFIX", "shravaan/devices"))
    parser.add_argument("--sos-button", default=os.environ.get("SOS_BUTTON_GPIO"), type=int)
    return parser.parse_args(argv)


class Player:
    """Feeds PCM to ffplay. flush() kills it outright on barge-in — buffered
    audio lives in this process, so only this process can drop it. Mirrors
    ai/scripts/device-client.ts's Player class."""

    def __init__(self, rate: int) -> None:
        self._rate = rate
        self._proc: asyncio.subprocess.Process | None = None

    async def write(self, pcm: bytes) -> None:
        if self._proc is None:
            await self._spawn()
        assert self._proc is not None and self._proc.stdin is not None
        try:
            self._proc.stdin.write(pcm)
            await self._proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            # The pipe died under us (e.g. flush() raced a write) — not fatal.
            pass

    def flush(self) -> None:
        if self._proc is not None:
            self._proc.kill()
            self._proc = None

    async def _spawn(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            "ffplay",
            "-hide_banner",
            "-loglevel",
            "error",
            "-nodisp",
            "-autoexit",
            "-probesize",
            "32",
            "-analyzeduration",
            "0",
            "-fflags",
            "nobuffer",
            "-flags",
            "low_delay",
            "-f",
            "s16le",
            "-ar",
            str(self._rate),
            "-ac",
            "1",
            "-i",
            "pipe:0",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
        )


async def capture_mic(ws: ClientConnection, args: argparse.Namespace) -> None:
    bytes_per_frame = int(args.asr_rate * 2 * args.frame_ms / 1000)  # s16 mono
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "alsa",
        "-i",
        args.mic,
        "-ac",
        "1",
        "-ar",
        str(args.asr_rate),
        "-acodec",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    log("listening", mic=args.mic, asr_rate=args.asr_rate, frame_bytes=bytes_per_frame)

    assert proc.stdout is not None
    pending = b""
    try:
        while True:
            chunk = await proc.stdout.read(bytes_per_frame)
            if not chunk:
                break
            pending += chunk
            while len(pending) >= bytes_per_frame:
                frame, pending = pending[:bytes_per_frame], pending[bytes_per_frame:]
                await ws.send(frame)
    finally:
        if proc.returncode is None:
            proc.kill()


async def handle_messages(ws: ClientConnection, player: Player) -> None:
    async for data in ws:
        if isinstance(data, (bytes, bytearray)):
            await player.write(data)
            continue
        try:
            msg = json.loads(data)
        except json.JSONDecodeError:
            log("server sent a non-JSON control frame")
            continue

        msg_type = msg.get("type")
        if msg_type == "clear_audio":
            player.flush()
            log("barge-in — playback dropped")
        elif msg_type == "ready":
            log("session ready", sid=msg.get("sid"))
        elif msg_type == "notice":
            log("notice", key=msg.get("key"), language=msg.get("language"))
        elif msg_type in ("play_media", "stop_media", "set_media_volume"):
            log("media control received but not implemented on this device", type=msg_type)
        elif msg_type == "session_closed":
            log("session closed by server", reason=msg.get("reason"))
            return
        else:
            log("unhandled control message", type=msg_type)


async def sensor_loop(interval_s: float, args: argparse.Namespace) -> None:
    if not args.device_id:
        raise ValueError("--device-id or DEVICE_ID is required when sensors are enabled")
    imu = Imu()
    climate = Climate()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"pi-{args.device_id}")
    if args.mqtt_username and args.mqtt_password:
        client.username_pw_set(args.mqtt_username, args.mqtt_password)
    client.connect(args.mqtt_host, args.mqtt_port, 60)
    client.loop_start()
    topic = f"{args.mqtt_topic_prefix.rstrip('/')}/{args.device_id}/telemetry"
    sos_topic = f"{args.mqtt_topic_prefix.rstrip('/')}/{args.device_id}/sos"
    imu.open()
    climate.open()
    try:
        while True:
            reading = imu.read()
            climate_reading = climate.read()
            event_id = str(uuid.uuid4())
            telemetry = {
                "event_id": event_id,
                "device_id": args.device_id,
                "recorded_at": datetime.now(timezone.utc).isoformat(),
                "temperature_c": round(climate_reading.temperature_c, 2),
                "motion_state": "still",
                "raw_payload": {
                    "accel_g": reading.accel_g,
                    "gyro_dps": reading.gyro_dps,
                    "humidity_pct": round(climate_reading.humidity_pct, 2),
                    "pressure_hpa": round(climate_reading.pressure_hpa, 2),
                    "mocked": reading.mocked or climate_reading.mocked,
                },
            }
            result = client.publish(topic, json.dumps(telemetry), qos=1)
            if result.rc != mqtt.MQTT_ERR_SUCCESS:
                raise RuntimeError(f"MQTT publish failed with code {result.rc}")
            log(
                "sensors",
                event_id=event_id,
                published_topic=topic,
                accel_g=reading.accel_g,
                gyro_dps=reading.gyro_dps,
                temperature_c=round(climate_reading.temperature_c, 2),
                humidity_pct=round(climate_reading.humidity_pct, 2),
                mocked=reading.mocked or climate_reading.mocked,
            )
            await asyncio.sleep(interval_s)
    finally:
        imu.close()
        climate.close()
        client.loop_stop()
        client.disconnect()


def publish_sos(args: argparse.Namespace) -> None:
    if not args.device_id:
        raise ValueError("--device-id or DEVICE_ID is required for SOS")
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"pi-sos-{args.device_id}")
    if args.mqtt_username and args.mqtt_password:
        client.username_pw_set(args.mqtt_username, args.mqtt_password)
    client.connect(args.mqtt_host, args.mqtt_port, 60)
    topic = f"{args.mqtt_topic_prefix.rstrip('/')}/{args.device_id}/sos"
    result = client.publish(topic, json.dumps({"source": "physical_sos_button", "recorded_at": datetime.now(timezone.utc).isoformat()}), qos=1)
    result.wait_for_publish()
    client.disconnect()


async def sos_button_loop(args: argparse.Namespace) -> None:
    if args.sos_button is None:
        return
    try:
        from gpiozero import Button
    except ImportError as exc:
        raise RuntimeError("gpiozero is required when --sos-button is configured") from exc

    button = Button(args.sos_button, pull_up=True, bounce_time=0.2)
    loop = asyncio.get_running_loop()
    last_press = 0.0
    try:
        while True:
            await loop.run_in_executor(None, button.wait_for_press)
            now = loop.time()
            if now - last_press >= 2.0:
                publish_sos(args)
                last_press = now
            await loop.run_in_executor(None, button.wait_for_release)
    finally:
        button.close()


async def run(args: argparse.Namespace) -> None:
    tasks: list[asyncio.Task[None]] = []
    async with websockets.connect(args.url) as ws:
        log("connected", url=args.url)
        hello: dict[str, object] = {"type": "hello", "uid": args.uid}
        if args.sid:
            hello["sid"] = args.sid
        if args.locale:
            hello["locale_hint"] = args.locale
        await ws.send(json.dumps(hello))

        player = Player(args.tts_rate)
        if not args.no_sensors:
            tasks.append(asyncio.create_task(sensor_loop(args.sensor_interval_s, args)))
        if args.sos_button is not None:
            tasks.append(asyncio.create_task(sos_button_loop(args)))
        tasks.append(asyncio.create_task(capture_mic(ws, args)))

        try:
            await handle_messages(ws, player)
        finally:
            player.flush()
            for t in tasks:
                t.cancel()


def main() -> None:
    args = parse_args(sys.argv[1:])
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
