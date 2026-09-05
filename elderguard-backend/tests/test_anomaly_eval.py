"""
The range check that used to be dead code, and the alerts it now raises.

TWO HALVES, TESTED DIFFERENTLY. `evaluate_anomaly` is pure, so it is called
directly with dictionaries. `raise_alerts_for` writes rows, so it goes through
the real ingest route with a real database — because the thing worth proving is
not that the function works but that a reading arriving the way a device sends
one reaches it at all. That was the whole defect: the function was correct and
nothing called it.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.telemetry import Alert, AlertStatus, AlertType, MotionState
from app.services.ml_eval_service import alert_type_for, evaluate_anomaly

# --------------------------------------------------------------------------
# The bands
# --------------------------------------------------------------------------


def test_an_ordinary_reading_says_nothing() -> None:
    assert evaluate_anomaly({"heart_rate_bpm": 72, "spo2_percent": 98, "temperature_c": 36.6}) == ()


def test_a_missing_metric_is_not_a_finding() -> None:
    """A band with no SpO2 sensor is not a band failing its SpO2 check."""
    assert evaluate_anomaly({"heart_rate_bpm": 72}) == ()
    assert evaluate_anomaly({}) == ()


def test_it_names_the_metric_the_value_and_the_bound() -> None:
    findings = evaluate_anomaly({"spo2_percent": 84})
    assert len(findings) == 1
    assert findings[0].describe() == {
        "metric": "spo2_percent",
        "value": 84.0,
        "direction": "low",
        "threshold": 90,
    }


@pytest.mark.parametrize(
    "metrics",
    [
        {"heart_rate_bpm": 35},
        {"heart_rate_bpm": 195},
        {"spo2_percent": 86},
        {"temperature_c": 34.2},
        {"temperature_c": 39.8},
        {"systolic_mmhg": 200, "diastolic_mmhg": 95},
        {"systolic_mmhg": 150, "diastolic_mmhg": 130},
        {"glucose_mgdl": 42},
        {"glucose_mgdl": 380},
    ],
)
def test_each_band_fires_on_its_own(metrics: dict[str, Any]) -> None:
    assert evaluate_anomaly(metrics), f"{metrics} should have been a finding"


@pytest.mark.parametrize(
    "metrics",
    [
        # The edges themselves are inside. A bound is where "quiet is wrong"
        # starts, and a person sitting exactly on one is not an event.
        {"heart_rate_bpm": 40},
        {"heart_rate_bpm": 180},
        {"spo2_percent": 90},
        {"temperature_c": 35.0},
        {"temperature_c": 39.0},
        {"systolic_mmhg": 180, "diastolic_mmhg": 120},
        {"glucose_mgdl": 60},
        {"glucose_mgdl": 300},
    ],
)
def test_the_bounds_themselves_are_inside(metrics: dict[str, Any]) -> None:
    assert evaluate_anomaly(metrics) == ()


def test_several_metrics_out_of_range_are_several_findings() -> None:
    findings = evaluate_anomaly({"heart_rate_bpm": 190, "spo2_percent": 84})
    assert {f.metric for f in findings} == {"heart_rate_bpm", "spo2_percent"}


def test_a_non_numeric_reading_is_ignored_rather_than_raising() -> None:
    # Nothing reaches here with a string on the ingest path; this is the guard
    # for anything that arrives another way, and it must not throw.
    assert evaluate_anomaly({"heart_rate_bpm": "faulty"}) == ()


def test_a_fall_outranks_a_reading() -> None:
    assert alert_type_for({"motion_state": MotionState.FALL.value}) is AlertType.FALL
    assert (
        alert_type_for({"motion_state": MotionState.FALL.value, "heart_rate_bpm": 190})
        is AlertType.FALL
    )


def test_walking_with_an_ordinary_pulse_is_not_an_alert() -> None:
    assert alert_type_for({"motion_state": MotionState.WALKING.value, "heart_rate_bpm": 110}) is None


# --------------------------------------------------------------------------
# The wiring — a reading arriving the way a device sends one
# --------------------------------------------------------------------------


async def _alerts(sessionmaker: async_sessionmaker[AsyncSession]) -> list[Alert]:
    async with sessionmaker() as db:
        rows = await db.scalars(select(Alert).order_by(Alert.created_at))
        return list(rows)


async def test_an_out_of_range_reading_over_http_raises_an_alert(
    client: AsyncClient,
    paired_device: dict[str, Any],
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    response = await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 195, "spo2_percent": 84}]},
        headers=paired_device["headers"],
    )
    assert response.status_code == 202, response.text

    alerts = await _alerts(db_sessionmaker)
    assert len(alerts) == 1
    assert alerts[0].alert_type == AlertType.ANOMALY
    assert alerts[0].source == "telemetry"
    assert {r["metric"] for r in alerts[0].details["readings"]} == {
        "heart_rate_bpm",
        "spo2_percent",
    }
    # Stated in the row, because the row is what a dashboard renders.
    assert "not a diagnosis" in alerts[0].details["note"]


async def test_an_ordinary_reading_raises_nothing(
    client: AsyncClient,
    paired_device: dict[str, Any],
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    response = await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 72, "spo2_percent": 98}]},
        headers=paired_device["headers"],
    )
    assert response.status_code == 202
    assert await _alerts(db_sessionmaker) == []


async def test_a_batch_of_the_same_anomaly_is_one_alert(
    client: AsyncClient,
    paired_device: dict[str, Any],
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    """
    The failure this prevents is a full alert table, not a full log. A band
    reporting every five seconds sends the same out-of-range pulse a dozen
    times a minute, and after a dropout it delivers the backlog at once.
    """
    response = await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 190} for _ in range(20)]},
        headers=paired_device["headers"],
    )
    assert response.status_code == 202
    assert len(await _alerts(db_sessionmaker)) == 1


async def test_a_second_batch_inside_the_cooldown_adds_nothing(
    client: AsyncClient,
    paired_device: dict[str, Any],
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    for _ in range(3):
        response = await client.post(
            "/api/v1/telemetry/stream",
            json={"points": [{"heart_rate_bpm": 190}]},
            headers=paired_device["headers"],
        )
        assert response.status_code == 202

    assert len(await _alerts(db_sessionmaker)) == 1


async def test_the_cooldown_reopens_once_the_window_has_passed(
    client: AsyncClient,
    paired_device: dict[str, Any],
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    """
    A window rather than "is one still open" — a pulse out of range an hour
    later is news again, and nothing in this service resolves an alert on its
    own, so an open-status check would have suppressed every anomaly after the
    first one forever.
    """
    first = await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 190}]},
        headers=paired_device["headers"],
    )
    assert first.status_code == 202

    # Age the existing alert past the window rather than waiting fifteen
    # minutes. Naive UTC, which is what SQLite stores and reads back.
    async with db_sessionmaker() as db:
        alert = await db.scalar(select(Alert))
        assert alert is not None
        alert.created_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=30)
        await db.commit()

    second = await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 190}]},
        headers=paired_device["headers"],
    )
    assert second.status_code == 202
    assert len(await _alerts(db_sessionmaker)) == 2


async def test_a_resolved_alert_does_not_suppress_the_next_one(
    client: AsyncClient,
    paired_device: dict[str, Any],
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    """Somebody dealt with it. The next occurrence is a new episode."""
    await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 190}]},
        headers=paired_device["headers"],
    )
    async with db_sessionmaker() as db:
        alert = await db.scalar(select(Alert))
        assert alert is not None
        alert.status = AlertStatus.RESOLVED
        await db.commit()

    await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 190}]},
        headers=paired_device["headers"],
    )
    assert len(await _alerts(db_sessionmaker)) == 2


async def test_a_fall_and_an_anomaly_in_one_batch_is_filed_as_a_fall(
    client: AsyncClient,
    paired_device: dict[str, Any],
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    response = await client.post(
        "/api/v1/telemetry/stream",
        json={
            "points": [
                {"heart_rate_bpm": 190},
                {"heart_rate_bpm": 120, "motion_state": "fall"},
            ]
        },
        headers=paired_device["headers"],
    )
    assert response.status_code == 202

    alerts = await _alerts(db_sessionmaker)
    assert len(alerts) == 1
    assert alerts[0].alert_type == AlertType.FALL


async def test_a_fall_alert_does_not_suppress_an_anomaly_alert(
    client: AsyncClient,
    paired_device: dict[str, Any],
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    """The cooldown is per kind. They are different things to be asked about."""
    await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"motion_state": "fall"}]},
        headers=paired_device["headers"],
    )
    await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 190}]},
        headers=paired_device["headers"],
    )

    assert {a.alert_type for a in await _alerts(db_sessionmaker)} == {
        AlertType.FALL,
        AlertType.ANOMALY,
    }


async def test_an_anomaly_does_not_email_the_family(
    client: AsyncClient,
    paired_device: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    The line between "somebody pressed the button" and "a number looked odd".
    An SOS reaches the family immediately; an out-of-range reading is asked
    about first, by the companion, and reaches them only if nobody answers.
    """
    sent: list[dict[str, Any]] = []

    async def spy(payload: dict[str, Any]) -> None:
        sent.append(payload)

    monkeypatch.setattr("app.api.v1.endpoints.alerts.dispatch_emergency_alert", spy)

    await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 195}]},
        headers=paired_device["headers"],
    )
    assert sent == []
