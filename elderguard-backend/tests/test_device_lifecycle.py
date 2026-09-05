"""
Register, pair, authenticate — the path every other device route depends on.

These are the first tests in this service that touch the database, and they
exist as much to prove the fixture works as to cover the routes: the SOS and
telemetry work in the next plan steps needs a real paired device to test
against.
"""

from typing import Any

from httpx import AsyncClient


async def test_register_requires_an_identity(client: AsyncClient) -> None:
    response = await client.post(
        "/api/v1/devices/register", json={"hardware_uid": "unclaimed-0001"}
    )
    assert response.status_code == 401


async def test_a_hardware_uid_can_only_be_registered_once(
    client: AsyncClient, user: dict[str, Any]
) -> None:
    first = await client.post(
        "/api/v1/devices/register",
        json={"hardware_uid": "duplicate-0001"},
        headers=user["headers"],
    )
    assert first.status_code == 201

    second = await client.post(
        "/api/v1/devices/register",
        json={"hardware_uid": "duplicate-0001"},
        headers=user["headers"],
    )
    assert second.status_code == 409


async def test_pairing_activates_the_device_and_issues_a_token(
    paired_device: dict[str, Any],
) -> None:
    assert paired_device["token"]
    assert paired_device["id"]


async def test_a_qr_token_cannot_be_used_twice(
    client: AsyncClient, user: dict[str, Any]
) -> None:
    """
    Pairing consumes the token by rewriting its hash. Without that, a QR code
    photographed once would pair the device again later — to whoever held the
    picture.
    """
    registered = await client.post(
        "/api/v1/devices/register",
        json={"hardware_uid": "replay-0001"},
        headers=user["headers"],
    )
    qr_token = registered.json()["qr_token"]

    first = await client.post(
        "/api/v1/devices/pair",
        json={"hardware_uid": "replay-0001", "qr_token": qr_token},
        headers=user["headers"],
    )
    assert first.status_code == 201

    replay = await client.post(
        "/api/v1/devices/pair",
        json={"hardware_uid": "replay-0001", "qr_token": qr_token},
        headers=user["headers"],
    )
    assert replay.status_code == 404


async def test_a_wrong_qr_token_does_not_reveal_that_the_hardware_exists(
    client: AsyncClient, user: dict[str, Any]
) -> None:
    await client.post(
        "/api/v1/devices/register",
        json={"hardware_uid": "guessing-0001"},
        headers=user["headers"],
    )
    response = await client.post(
        "/api/v1/devices/pair",
        json={"hardware_uid": "guessing-0001", "qr_token": "x" * 32},
        headers=user["headers"],
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Hardware or QR token is invalid"


async def test_check_in_records_a_heartbeat(
    client: AsyncClient, user: dict[str, Any], paired_device: dict[str, Any], fake_redis: Any
) -> None:
    response = await client.post(
        f"/api/v1/devices/{paired_device['id']}/check-in", headers=user["headers"]
    )
    assert response.status_code == 200
    assert response.json()["last_seen_at"] is not None
    assert f"device:heartbeat:{paired_device['id']}" in fake_redis.values


async def test_another_user_cannot_read_your_device(
    client: AsyncClient, paired_device: dict[str, Any]
) -> None:
    await client.post(
        "/api/v1/auth/provision",
        json={
            "email": "stranger@example.com",
            "full_name": "Stranger",
            "role": "relative",
            "password": "another-long-enough-password",
        },
    )
    signed_in = await client.post(
        "/api/v1/auth/login",
        json={"email": "stranger@example.com", "password": "another-long-enough-password"},
    )
    headers = {"Authorization": f"Bearer {signed_in.json()['access_token']}"}

    response = await client.get(f"/api/v1/devices/{paired_device['id']}", headers=headers)
    assert response.status_code == 404
