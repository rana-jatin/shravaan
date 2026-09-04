"""
CSV telemetry parsing — pure, so it is tested directly.

`parse_csv_points` is the one piece of this service that already had no I/O in
it. Every failure below is one a caregiver could plausibly cause by uploading
the wrong file, so each has to come back as a stated reason rather than a
stack trace.
"""

import pytest

from app.models.telemetry import MotionState
from app.services.telemetry_service import parse_csv_points

HEADER = "recorded_at,heart_rate_bpm,spo2_percent,temperature_c,motion_state"


def test_parses_a_well_formed_file() -> None:
    points = parse_csv_points(
        f"{HEADER}\n"
        "2026-09-01T09:00:00Z,72,98,36.6,still\n"
        "2026-09-01T09:01:00Z,74,97,36.7,walking\n"
    )
    assert len(points) == 2
    assert points[0].heart_rate_bpm == 72
    assert points[1].motion_state == MotionState.WALKING


def test_blank_rows_are_skipped_not_rejected() -> None:
    """A trailing newline from a spreadsheet export is not a broken file."""
    points = parse_csv_points(f"{HEADER}\n2026-09-01T09:00:00Z,72,98,36.6,still\n,,,,\n")
    assert len(points) == 1


def test_unknown_columns_are_kept_as_raw_payload() -> None:
    points = parse_csv_points(
        f"{HEADER},device_note\n2026-09-01T09:00:00Z,72,98,36.6,still,after breakfast\n"
    )
    assert points[0].raw_payload == {"device_note": "after breakfast"}


def test_missing_recorded_at_column_is_named() -> None:
    with pytest.raises(ValueError, match="recorded_at"):
        parse_csv_points("heart_rate_bpm\n72\n")


def test_an_empty_file_is_rejected() -> None:
    with pytest.raises(ValueError):
        parse_csv_points("")


def test_a_row_with_no_metric_at_all_is_rejected() -> None:
    # TelemetryPoint requires at least one reading; a row of timestamps carries
    # no information and would otherwise pad the store silently.
    with pytest.raises(ValueError):
        parse_csv_points(f"{HEADER}\n2026-09-01T09:00:00Z,,,,unknown\n")


def test_an_out_of_range_reading_is_rejected() -> None:
    # 400 bpm is a sensor fault, not a person. Accepting it would eventually
    # drive an anomaly alert to a family for a hardware problem.
    with pytest.raises(ValueError):
        parse_csv_points(f"{HEADER}\n2026-09-01T09:00:00Z,400,98,36.6,still\n")


def test_the_row_cap_is_enforced() -> None:
    rows = "".join(f"2026-09-01T09:00:00Z,72,98,36.6,still\n" for _ in range(6))
    with pytest.raises(ValueError, match="more than 4"):
        parse_csv_points(f"{HEADER}\n{rows}", max_points=4)
