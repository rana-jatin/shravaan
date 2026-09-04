"""
The REST SOS route — the other way an alarm is raised.

Both entry points land on the same table, so both are tested. This one is
reached by the voice agent and by any app the family uses; the MQTT one is the
hardware button.
"""

from typing import Any

from httpx import AsyncClient


async def test_sos_requires_a_device_token(client: AsyncClient) -> None:
    response = await client.post("/api/v1/alerts/sos", json={"source": "panic_button"})
    assert response.status_code == 401


async def test_a_user_header_is_not_a_device_token(
    client: AsyncClient, user: dict[str, Any]
) -> None:
    response = await client.post(
        "/api/v1/alerts/sos", json={"source": "panic_button"}, headers=user["headers"]
    )
    assert response.status_code == 401


async def test_sos_creates_an_alert_and_returns_it(
    client: AsyncClient, paired_device: dict[str, Any]
) -> None:
    response = await client.post(
        "/api/v1/alerts/sos",
        json={"source": "panic_button", "details": {"room": "kitchen"}},
        headers=paired_device["headers"],
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["alert_type"] == "sos"
    assert body["status"] == "open"
    assert body["source"] == "panic_button"
    assert body["details"] == {"room": "kitchen"}
    assert body["device_id"] == paired_device["id"]


async def test_sos_works_with_no_details_at_all(
    client: AsyncClient, paired_device: dict[str, Any]
) -> None:
    # `details` is optional, and a button that sends nothing but "help" must
    # still raise the alarm.
    response = await client.post(
        "/api/v1/alerts/sos",
        json={"source": "voice_agent"},
        headers=paired_device["headers"],
    )
    assert response.status_code == 201, response.text
    assert response.json()["details"] == {}


async def test_repeated_sos_calls_each_record_an_alert(
    client: AsyncClient, paired_device: dict[str, Any]
) -> None:
    """
    No de-duplication here today, and that is worth pinning: the voice agent
    has its own two-minute cooldown, this route has none. When the shared
    escalation pathway lands, this is the test that will have to change.
    """
    for _ in range(3):
        response = await client.post(
            "/api/v1/alerts/sos",
            json={"source": "panic_button"},
            headers=paired_device["headers"],
        )
        assert response.status_code == 201
