"""BME280 temperature/humidity/pressure over I2C.

Same mock-on-failure contract as sensors/imu.py: no /dev/i2c-1, or no chip at
the expected address, means mock readings instead of an exception. Compensation
formulas follow the Bosch BME280 datasheet (integer path), trimmed to the
fields pi_client actually reports.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

_ADDR = 0x76  # 0x77 on some breakout boards — pass address= if yours differs.
_REG_CALIB_00 = 0x88
_REG_CALIB_26 = 0xE1
_REG_CTRL_HUM = 0xF2
_REG_CTRL_MEAS = 0xF4
_REG_DATA = 0xF7  # press_msb .. hum_lsb, 8 bytes


@dataclass(frozen=True)
class ClimateReading:
    temperature_c: float
    humidity_pct: float
    pressure_hpa: float
    mocked: bool


class _Calibration:
    """Unpacks the factory calibration registers into the coefficients the
    compensation formulas below use. Field names match the datasheet."""

    def __init__(self, calib1: list[int], calib2: list[int]) -> None:
        def u16(lo: int, hi: int) -> int:
            return calib1[lo] | (calib1[hi] << 8)

        def s16(lo: int, hi: int) -> int:
            v = u16(lo, hi)
            return v - 65536 if v & 0x8000 else v

        self.dig_T1 = u16(0, 1)
        self.dig_T2 = s16(2, 3)
        self.dig_T3 = s16(4, 5)
        self.dig_P1 = u16(6, 7)
        self.dig_P2 = s16(8, 9)
        self.dig_P3 = s16(10, 11)
        self.dig_P4 = s16(12, 13)
        self.dig_P5 = s16(14, 15)
        self.dig_P6 = s16(16, 17)
        self.dig_P7 = s16(18, 19)
        self.dig_P8 = s16(20, 21)
        self.dig_P9 = s16(22, 23)
        self.dig_H1 = calib1[25]
        self.dig_H2 = calib2[0] | (calib2[1] << 8)
        if self.dig_H2 & 0x8000:
            self.dig_H2 -= 65536
        self.dig_H3 = calib2[2]
        e4, e5, e6 = calib2[3], calib2[4], calib2[5]
        self.dig_H4 = (e4 << 4) | (e5 & 0x0F)
        self.dig_H5 = (e6 << 4) | (e5 >> 4)
        for attr in ("dig_H4", "dig_H5"):
            v = getattr(self, attr)
            if v & 0x8000:
                setattr(self, attr, v - 65536)
        self.dig_H6 = calib2[6]
        if self.dig_H6 & 0x80:
            self.dig_H6 -= 256


class Climate:
    def __init__(self, bus_number: int = 1, address: int = _ADDR) -> None:
        self._bus_number = bus_number
        self._address = address
        self._bus = None  # type: ignore[var-annotated]
        self._calib: _Calibration | None = None
        self._mocked = False

    def open(self) -> None:
        try:
            from smbus2 import SMBus

            bus = SMBus(self._bus_number)
            calib1 = bus.read_i2c_block_data(self._address, _REG_CALIB_00, 26)
            calib2 = bus.read_i2c_block_data(self._address, _REG_CALIB_26, 7)
            self._calib = _Calibration(calib1, calib2)
            bus.write_byte_data(self._address, _REG_CTRL_HUM, 0x01)  # humidity oversample x1
            bus.write_byte_data(self._address, _REG_CTRL_MEAS, 0x27)  # temp/press x1, normal mode
            self._bus = bus
            self._mocked = False
        except Exception as err:  # noqa: BLE001 - any hardware/driver failure means "no BME280 here"
            self._bus = None
            self._mocked = True
            print(f"[climate] no BME280 on i2c bus {self._bus_number} ({err}) -- using mock readings")

    def read(self) -> ClimateReading:
        if self._mocked or self._bus is None or self._calib is None:
            return ClimateReading(temperature_c=25.0, humidity_pct=45.0, pressure_hpa=1013.25, mocked=True)

        data = self._bus.read_i2c_block_data(self._address, _REG_DATA, 8)
        raw_press = (data[0] << 12) | (data[1] << 4) | (data[2] >> 4)
        raw_temp = (data[3] << 12) | (data[4] << 4) | (data[5] >> 4)
        raw_hum = (data[6] << 8) | data[7]

        c = self._calib
        var1 = (raw_temp / 16384.0 - c.dig_T1 / 1024.0) * c.dig_T2
        var2 = (raw_temp / 131072.0 - c.dig_T1 / 8192.0) ** 2 * c.dig_T3
        t_fine = var1 + var2
        temperature_c = t_fine / 5120.0

        var1 = t_fine / 2.0 - 64000.0
        var2 = var1 * var1 * c.dig_P6 / 32768.0
        var2 = var2 + var1 * c.dig_P5 * 2.0
        var2 = var2 / 4.0 + c.dig_P4 * 65536.0
        var1 = (c.dig_P3 * var1 * var1 / 524288.0 + c.dig_P2 * var1) / 524288.0
        var1 = (1.0 + var1 / 32768.0) * c.dig_P1
        if var1 == 0:
            pressure_hpa = 0.0
        else:
            press = 1048576.0 - raw_press
            press = (press - var2 / 4096.0) * 6250.0 / var1
            var1 = c.dig_P9 * press * press / 2147483648.0
            var2 = press * c.dig_P8 / 32768.0
            pressure_hpa = (press + (var1 + var2 + c.dig_P7) / 16.0) / 100.0

        h = t_fine - 76800.0
        h = (raw_hum - (c.dig_H4 * 64.0 + c.dig_H5 / 16384.0 * h)) * (
            c.dig_H2
            / 65536.0
            * (1.0 + c.dig_H6 / 67108864.0 * h * (1.0 + c.dig_H3 / 67108864.0 * h))
        )
        h = h * (1.0 - c.dig_H1 * h / 524288.0)
        humidity_pct = min(max(h, 0.0), 100.0)

        return ClimateReading(
            temperature_c=temperature_c,
            humidity_pct=humidity_pct,
            pressure_hpa=pressure_hpa,
            mocked=False,
        )

    def close(self) -> None:
        if self._bus is not None:
            self._bus.close()
            self._bus = None


if __name__ == "__main__":
    climate = Climate()
    climate.open()
    try:
        while True:
            print(climate.read())
            time.sleep(2)
    except KeyboardInterrupt:
        pass
    finally:
        climate.close()
