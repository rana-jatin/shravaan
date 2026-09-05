"""
The seam the voice companion talks through.

WHAT IS ACTUALLY BEING TESTED HERE is not "does the route return 200". It is
the three promises this boundary makes and that nothing else can enforce:

  a key is required, and a missing key is a refusal rather than an open door;
  one user's readings and alerts are never reachable through another's uid;
  the context payload carries no health data, ever.

The last one is a test about a `for` loop that does not exist, which is an odd
thing to assert — but it is the assertion that stops somebody adding a
`history` of recent alerts in six months and shipping a device that opens the
conversation by mentioning an eighty-year-old's pulse.
"""

from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.telemetry import Alert, AlertStatus

KEY = {"X-Companion-Key": "test-companion-key"}


@pytest.fixture
def elder(user: dict[str, Any]) -> str:
    """The uid the companion would send. See `get_elder` on why it is this."""
    return user["id"]


# --------------------------------------------------------------------------
# The key
# --------------------------------------------------------------------------


async def test_no_key_is_refused(client: AsyncClient, elder: str) -> None:
    response = await client.get(f"/api/v1/companion/context/{elder}")
    assert response.status_code == 401


async def test_a_wrong_key_is_refused(client: AsyncClient, elder: str) -> None:
    response = await client.get(
        f"/api/v1/companion/context/{elder}", headers={"X-Companion-Key": "not-the-key"}
    )
    assert response.status_code == 401


async def test_a_user_bearer_token_is_not_a_companion_key(
    client: AsyncClient, user: dict[str, Any]
) -> None:
    """Three credentials reach this service and none of them is the others."""
    response = await client.get(
        f"/api/v1/companion/context/{user['id']}", headers=user["headers"]
    )
    assert response.status_code == 401


async def test_an_unconfigured_service_refuses_rather_than_opening(
    client: AsyncClient, elder: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    THE FAILURE THIS EXISTS FOR. Written the obvious way — compare the header
    to the setting, reject a mismatch — a deployment that never set the
    variable would match `None` against `None` and let anybody read anybody's
    vitals. It answers 503 and names the variable instead.
    """
    monkeypatch.setattr("app.api.deps.settings.companion_api_key", None)

    unset = await client.get(f"/api/v1/companion/context/{elder}")
    assert unset.status_code == 503
    assert "COMPANION_API_KEY" in unset.json()["detail"]

    # And it is not merely the empty header that fails.
    with_key = await client.get(f"/api/v1/companion/context/{elder}", headers=KEY)
    assert with_key.status_code == 503


# --------------------------------------------------------------------------
# Identity
# --------------------------------------------------------------------------


async def test_an_unknown_uid_is_a_404_not_a_500(client: AsyncClient) -> None:
    response = await client.get(
        "/api/v1/companion/context/00000000-0000-0000-0000-000000000000", headers=KEY
    )
    assert response.status_code == 404


async def test_a_uid_that_is_not_a_uuid_is_a_404(client: AsyncClient) -> None:
    """
    The companion's uid comes off a device `hello` frame and may be anything.
    It has to degrade to "I cannot store that", not to a stack trace.
    """
    response = await client.get("/api/v1/companion/context/anonymous", headers=KEY)
    assert response.status_code == 404


# --------------------------------------------------------------------------
# Context
# --------------------------------------------------------------------------


async def test_context_names_the_person_and_nothing_medical(
    client: AsyncClient, elder: str, paired_device: dict[str, Any]
) -> None:
    # A reading exists and an alert has been raised, so anything that leaked
    # health data into this payload would have something to leak.
    await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 195}]},
        headers=paired_device["headers"],
    )

    response = await client.get(f"/api/v1/companion/context/{elder}", headers=KEY)
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["identity"]["display_name"] == "A Relative"
    assert body["entitlements"] == []

    # THE ASSERTION THAT MATTERS. This payload is read straight into the
    # model's prompt, so anything here is something the device may say
    # unprompted. Nothing about a reading, a heart rate or an alert belongs in
    # it — vitals are behind a tool the person has to ask for.
    serialised = response.text.lower()
    for forbidden in ("heart_rate", "195", "alert", "anomaly", "spo2", "glucose"):
        assert forbidden not in serialised, f"{forbidden!r} reached the session prompt"


# --------------------------------------------------------------------------
# Writing a reading somebody said out loud
# --------------------------------------------------------------------------


async def test_a_self_reported_reading_is_stored_and_marked_as_such(
    client: AsyncClient, elder: str, paired_device: dict[str, Any]
) -> None:
    response = await client.post(
        f"/api/v1/companion/vitals/{elder}",
        json={"systolic_mmhg": 138, "diastolic_mmhg": 84},
        headers=KEY,
    )
    assert response.status_code == 201, response.text
    assert response.json()["stored"] is True
    assert response.json()["alerted"] is False

    stored = await client.get(f"/api/v1/companion/vitals/{elder}", headers=KEY)
    assert stored.status_code == 200
    row = stored.json()[0]
    assert (row["systolic_mmhg"], row["diastolic_mmhg"]) == (138, 84)
    # "You told me" and "your band measured" are not the same sentence to say
    # to somebody, so the companion has to be able to tell them apart.
    assert row["source"] == "self_reported"


async def test_a_reading_with_no_paired_device_is_refused_plainly(
    client: AsyncClient, elder: str
) -> None:
    """
    A poor answer and an honest one. The alternative is somebody reciting
    their blood sugar every morning for a month with nothing being kept.
    """
    response = await client.post(
        f"/api/v1/companion/vitals/{elder}", json={"glucose_mgdl": 120}, headers=KEY
    )
    assert response.status_code == 409
    assert "device" in response.json()["detail"].lower()


async def test_a_reading_with_no_numbers_at_all_is_rejected(
    client: AsyncClient, elder: str, paired_device: dict[str, Any]
) -> None:
    response = await client.post(f"/api/v1/companion/vitals/{elder}", json={}, headers=KEY)
    assert response.status_code == 422


async def test_a_lone_systolic_is_rejected(
    client: AsyncClient, elder: str, paired_device: dict[str, Any]
) -> None:
    response = await client.post(
        f"/api/v1/companion/vitals/{elder}", json={"systolic_mmhg": 140}, headers=KEY
    )
    assert response.status_code == 422


async def test_an_out_of_range_self_report_says_it_alerted(
    client: AsyncClient, elder: str, paired_device: dict[str, Any]
) -> None:
    """
    `alerted` exists so the companion can open its ladder now rather than on
    the next poll. It is NOT permission to say anything about the reading —
    what the device says is its own reviewed copy, and it asks how the person
    is rather than quoting a number back at them.
    """
    response = await client.post(
        f"/api/v1/companion/vitals/{elder}",
        json={"systolic_mmhg": 210, "diastolic_mmhg": 105},
        headers=KEY,
    )
    assert response.status_code == 201, response.text
    assert response.json()["alerted"] is True


async def test_glucose_context_survives_as_a_token(
    client: AsyncClient, elder: str, paired_device: dict[str, Any],
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    """
    Before or after a meal is the one thing that makes a sugar reading
    readable, and it travels as a token rather than as the sentence the person
    said.
    """
    from app.models.telemetry import TelemetryRecord

    await client.post(
        f"/api/v1/companion/vitals/{elder}",
        json={"glucose_mgdl": 126, "glucose_context": "fasting"},
        headers=KEY,
    )
    async with db_sessionmaker() as db:
        row = await db.scalar(select(TelemetryRecord))
        assert row is not None
        assert row.raw_payload == {"glucose_context": "fasting"}


async def test_a_free_text_note_is_not_accepted(
    client: AsyncClient, elder: str, paired_device: dict[str, Any]
) -> None:
    """
    The companion holds a transcript of somebody's home and this service holds
    their health record. Nothing that would join the two crosses this
    boundary — an unknown field is refused rather than quietly ignored.
    """
    response = await client.post(
        f"/api/v1/companion/vitals/{elder}",
        json={"glucose_mgdl": 126, "note": "she said she felt dizzy after lunch"},
        headers=KEY,
    )
    assert response.status_code == 422


# --------------------------------------------------------------------------
# Reading back
# --------------------------------------------------------------------------


async def test_recent_vitals_are_newest_first_and_bounded(
    client: AsyncClient, elder: str, paired_device: dict[str, Any]
) -> None:
    for hour, bpm in enumerate((70, 72, 74)):
        await client.post(
            "/api/v1/telemetry/stream",
            json={
                "points": [
                    {"recorded_at": f"2026-09-01T0{hour}:00:00Z", "heart_rate_bpm": bpm}
                ]
            },
            headers=paired_device["headers"],
        )

    response = await client.get(f"/api/v1/companion/vitals/{elder}?limit=2", headers=KEY)
    assert response.status_code == 200
    body = response.json()
    assert [row["heart_rate_bpm"] for row in body] == [74, 72]


async def test_a_user_with_no_device_reads_back_nothing_rather_than_failing(
    client: AsyncClient, elder: str
) -> None:
    assert (await client.get(f"/api/v1/companion/vitals/{elder}", headers=KEY)).json() == []
    assert (await client.get(f"/api/v1/companion/alerts/{elder}", headers=KEY)).json() == []


# --------------------------------------------------------------------------
# Alerts, and settling them
# --------------------------------------------------------------------------


async def test_open_alerts_are_listed_oldest_first(
    client: AsyncClient, elder: str, paired_device: dict[str, Any]
) -> None:
    await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"motion_state": "fall"}]},
        headers=paired_device["headers"],
    )
    await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 195}]},
        headers=paired_device["headers"],
    )

    response = await client.get(f"/api/v1/companion/alerts/{elder}", headers=KEY)
    assert response.status_code == 200, response.text
    assert [a["alert_type"] for a in response.json()] == ["fall", "anomaly"]


async def test_acknowledging_an_alert_takes_it_off_the_list(
    client: AsyncClient, elder: str, paired_device: dict[str, Any]
) -> None:
    await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 195}]},
        headers=paired_device["headers"],
    )
    alert_id = (await client.get(f"/api/v1/companion/alerts/{elder}", headers=KEY)).json()[0]["id"]

    acked = await client.post(
        f"/api/v1/companion/alerts/{elder}/{alert_id}/ack",
        json={"status": "acknowledged"},
        headers=KEY,
    )
    assert acked.status_code == 200, acked.text
    assert acked.json()["status"] == "acknowledged"
    assert (await client.get(f"/api/v1/companion/alerts/{elder}", headers=KEY)).json() == []


async def test_acknowledging_twice_is_not_an_error(
    client: AsyncClient, elder: str, paired_device: dict[str, Any]
) -> None:
    """
    The ladder can settle the same alert twice — the person answered, and the
    sweep had already queued a retry. The second call must not be something
    the companion has to reason about.
    """
    await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 195}]},
        headers=paired_device["headers"],
    )
    alert_id = (await client.get(f"/api/v1/companion/alerts/{elder}", headers=KEY)).json()[0]["id"]

    for _ in range(2):
        response = await client.post(
            f"/api/v1/companion/alerts/{elder}/{alert_id}/ack",
            json={"status": "resolved"},
            headers=KEY,
        )
        assert response.status_code == 200


async def test_an_alert_cannot_be_settled_through_another_users_uid(
    client: AsyncClient,
    elder: str,
    paired_device: dict[str, Any],
    db_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    """
    An id is a bearer of authority when nothing else is checked, and this key
    acts for every user at once. The uid in the path is checked against the
    row, so knowing an alert id is not enough to settle it.
    """
    await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 195}]},
        headers=paired_device["headers"],
    )
    alert_id = (await client.get(f"/api/v1/companion/alerts/{elder}", headers=KEY)).json()[0]["id"]

    other = await client.post(
        "/api/v1/auth/provision",
        json={
            "email": "someone-else@example.com",
            "full_name": "Someone Else",
            "role": "relative",
            "password": "a-sufficiently-long-test-password",
        },
    )
    assert other.status_code == 201

    response = await client.post(
        f"/api/v1/companion/alerts/{other.json()['id']}/{alert_id}/ack",
        json={"status": "resolved"},
        headers=KEY,
    )
    assert response.status_code == 404

    async with db_sessionmaker() as db:
        alert = await db.scalar(select(Alert))
        assert alert is not None
        assert alert.status == AlertStatus.OPEN


async def test_one_users_vitals_are_not_readable_through_another_uid(
    client: AsyncClient, elder: str, paired_device: dict[str, Any]
) -> None:
    await client.post(
        f"/api/v1/companion/vitals/{elder}",
        json={"glucose_mgdl": 126},
        headers=KEY,
    )
    other = await client.post(
        "/api/v1/auth/provision",
        json={
            "email": "stranger@example.com",
            "full_name": "A Stranger",
            "role": "relative",
            "password": "a-sufficiently-long-test-password",
        },
    )
    response = await client.get(
        f"/api/v1/companion/vitals/{other.json()['id']}", headers=KEY
    )
    assert response.status_code == 200
    assert response.json() == []


# --------------------------------------------------------------------------
# The feed the companion actually polls
# --------------------------------------------------------------------------


async def test_the_service_wide_feed_names_who_each_alert_belongs_to(
    client: AsyncClient, elder: str, paired_device: dict[str, Any]
) -> None:
    """
    THE CASE THE PER-UID FEED CANNOT COVER. The companion learns a uid when a
    device says hello, so it can only ask about somebody already talking to
    it — and the band that raised this alert does not need the companion device
    switched on. The person nobody can reach is exactly the one whose family
    should hear about it.
    """
    await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"heart_rate_bpm": 195}]},
        headers=paired_device["headers"],
    )

    response = await client.get("/api/v1/companion/alerts", headers=KEY)
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body) == 1
    assert body[0]["uid"] == elder
    assert body[0]["alert_type"] == "anomaly"


async def test_the_feed_needs_the_key_like_everything_else(client: AsyncClient) -> None:
    assert (await client.get("/api/v1/companion/alerts")).status_code == 401


async def test_a_settled_alert_leaves_the_feed(
    client: AsyncClient, elder: str, paired_device: dict[str, Any]
) -> None:
    await client.post(
        "/api/v1/telemetry/stream",
        json={"points": [{"motion_state": "fall"}]},
        headers=paired_device["headers"],
    )
    alert = (await client.get("/api/v1/companion/alerts", headers=KEY)).json()[0]

    await client.post(
        f"/api/v1/companion/alerts/{elder}/{alert['id']}/ack",
        json={"status": "acknowledged"},
        headers=KEY,
    )
    assert (await client.get("/api/v1/companion/alerts", headers=KEY)).json() == []
