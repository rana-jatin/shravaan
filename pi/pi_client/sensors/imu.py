"""MPU6050 accelerometer/gyroscope over I2C.

Real hardware needs /dev/i2c-1, which only exists on the Pi. Everywhere else
(a dev laptop, CI) this falls back to a fixed mock reading rather than
raising, so the rest of pi_client is runnable without hardware attached —
same reasoning as the injectable I/O boundaries on the Node side
(CLAUDE.md: "every I/O boundary is injectable").
"""

from __future__ import annotations

import time
from dataclasses import dataclass

_ADDR = 0x68
_PWR_MGMT_1 = 0x6B
_ACCEL_XOUT_H = 0x3B
_GYRO_XOUT_H = 0x43

# LSB/g and LSB/(deg/s) at the sensor's power-on default full-scale range
# (+-2g, +-250 deg/s). Good enough for presence/tamper heuristics; a
# production driver would read and honour the configured range instead.
_ACCEL_SCALE = 16384.0
_GYRO_SCALE = 131.0


@dataclass(frozen=True)
class ImuReading:
    accel_g: tuple[float, float, float]
    gyro_dps: tuple[float, float, float]
    mocked: bool


def _to_signed16(high: int, low: int) -> int:
    value = (high << 8) | low
    return value - 65536 if value & 0x8000 else value


class Imu:
    """Call open() once, then read() as often as you like."""

    def __init__(self, bus_number: int = 1, address: int = _ADDR) -> None:
        self._bus_number = bus_number
        self._address = address
        self._bus = None  # type: ignore[var-annotated]
        self._mocked = False

    def open(self) -> None:
        try:
            from smbus2 import SMBus

            self._bus = SMBus(self._bus_number)
            # Wake the chip — it boots in sleep mode.
            self._bus.write_byte_data(self._address, _PWR_MGMT_1, 0)
            self._mocked = False
        except Exception as err:  # noqa: BLE001 - any hardware/driver failure means "no IMU here"
            self._bus = None
            self._mocked = True
            print(f"[imu] no MPU6050 on i2c bus {self._bus_number} ({err}) -- using mock readings")

    def read(self) -> ImuReading:
        if self._mocked or self._bus is None:
            # Resting flat on a table: ~1g on Z, everything else ~0.
            return ImuReading(accel_g=(0.0, 0.0, 1.0), gyro_dps=(0.0, 0.0, 0.0), mocked=True)

        regs = self._bus.read_i2c_block_data(self._address, _ACCEL_XOUT_H, 6)
        ax, ay, az = (
            _to_signed16(regs[0], regs[1]) / _ACCEL_SCALE,
            _to_signed16(regs[2], regs[3]) / _ACCEL_SCALE,
            _to_signed16(regs[4], regs[5]) / _ACCEL_SCALE,
        )
        regs = self._bus.read_i2c_block_data(self._address, _GYRO_XOUT_H, 6)
        gx, gy, gz = (
            _to_signed16(regs[0], regs[1]) / _GYRO_SCALE,
            _to_signed16(regs[2], regs[3]) / _GYRO_SCALE,
            _to_signed16(regs[4], regs[5]) / _GYRO_SCALE,
        )
        return ImuReading(accel_g=(ax, ay, az), gyro_dps=(gx, gy, gz), mocked=False)

    def close(self) -> None:
        if self._bus is not None:
            self._bus.close()
            self._bus = None


if __name__ == "__main__":
    imu = Imu()
    imu.open()
    try:
        while True:
            print(imu.read())
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        imu.close()
