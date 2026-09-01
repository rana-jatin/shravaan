# pi

The real device. Not an npm workspace — this is a plain Python package, run
on the Raspberry Pi itself (Raspberry Pi OS / Debian), not from the Node side
of the repo.

`ai/scripts/device-client.ts` is the laptop stand-in for this: same
hello/ready/PCM protocol, but capturing with `dshow` and running on a dev
machine with no real hardware attached. Read its header comment first — this
package is the same idea, ported to Linux + Python, with sensors added.

## What's here

- `pi_client/main.py` — connects to the backend over the device WebSocket
  protocol (`hello` → `ready`, binary PCM both ways), capturing the mic via
  `ffmpeg` (ALSA) and playing replies via `ffplay`. `play_media` /
  `stop_media` / `set_media_volume` are logged, not implemented — see
  `ai/scripts/device-client.ts`'s `MediaPlayer` for what that needs
  (ducking, a media resolver, gain ramping).
- `pi_client/sensors/imu.py` — MPU6050 (accel + gyro) over I2C.
- `pi_client/sensors/climate.py` — BME280 (temperature/humidity/pressure)
  over I2C.

Sensor readings are polled and logged locally (`sensor_loop` in `main.py`).
There's no WS protocol field for them yet — that's follow-up work once
there's a server-side consumer, not something to invent here.

## Hardware-optional by design

Both sensor drivers try to open their I2C device on `open()` and fall back to
a fixed mock reading if that fails for any reason (no `/dev/i2c-1`, no chip
at the expected address, wrong bus). That's deliberate, same reasoning as the
injectable I/O boundaries on the Node side (`CLAUDE.md`): `pi_client` should
run and be testable on a laptop with no Pi attached, not just on the device.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate       # or .venv\Scripts\activate on Windows
pip install -e .
```

Needs `ffmpeg` on PATH for audio (same as the laptop device client).

## Running

```bash
python -m pi_client.main --url ws://<backend-host>:8080 --mic default
```

`--mic` is the ALSA device name (`arecord -L` to list them). `--no-sensors`
skips the IMU/climate polling loop. See `--help` for the rest — rates and
frame size default to the same env vars the backend reads
(`ASR_SAMPLE_RATE`, `TTS_SAMPLE_RATE`, `DEVICE_FRAME_MS`), so pointing both
ends at the same `.env` keeps them in agreement.

## Verifying without a Pi

```bash
python -c "from pi_client.sensors.imu import Imu; i = Imu(); i.open(); print(i.read())"
python -c "from pi_client.sensors.climate import Climate; c = Climate(); c.open(); print(c.read())"
```

Both print a mocked reading (`mocked=True`) off-device. The WS handshake
(`hello` → `ready`) works against a running backend the same way regardless
of platform — only the audio capture/playback and sensor reads need real
Pi hardware.
