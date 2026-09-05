"""
User authentication.

The regression this file exists for is `test_the_x_user_id_header_is_no_longer
_accepted`: identity used to be whatever UUID a client put in a header, so
anyone could provision an account, send its id, and act as any user they liked.
"""

from typing import Any
from uuid import uuid4

import pytest
from httpx import AsyncClient

from app.core.config import INSECURE_DEFAULT_JWT_SECRET, Settings, settings
from app.core.security import create_device_token, hash_password, verify_password

PASSWORD = "a-sufficiently-long-test-password"


async def provision(client: AsyncClient, email: str, password: str = PASSWORD) -> Any:
    return await client.post(
        "/api/v1/auth/provision",
        json={"email": email, "full_name": "A Person", "role": "relative", "password": password},
    )


# ── the hole that was closed ───────────────────────────────────────────────


async def test_the_x_user_id_header_is_no_longer_accepted(
    client: AsyncClient, user: dict[str, Any]
) -> None:
    """
    THE REGRESSION TEST. This header was the whole of this service's user
    authentication, and it was never verified against anything.
    """
    response = await client.get("/api/v1/auth/me", headers={"X-User-ID": user["id"]})
    assert response.status_code == 401


async def test_a_forged_identity_cannot_reach_a_protected_route(
    client: AsyncClient, user: dict[str, Any]
) -> None:
    response = await client.post(
        "/api/v1/devices/register",
        json={"hardware_uid": "forged-0001"},
        headers={"X-User-ID": user["id"]},
    )
    assert response.status_code == 401


async def test_a_device_token_is_not_a_user_session(client: AsyncClient) -> None:
    """
    Device tokens are valid for a year and live on hardware someone could pick
    up. The `type` claim is what stops one being spent as a person's session.
    """
    token = create_device_token(str(uuid4()))
    response = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


# ── signing in ─────────────────────────────────────────────────────────────


async def test_a_provisioned_user_can_sign_in_and_read_themselves(
    client: AsyncClient, user: dict[str, Any]
) -> None:
    response = await client.get("/api/v1/auth/me", headers=user["headers"])
    assert response.status_code == 200
    assert response.json()["email"] == user["email"]


async def test_login_returns_a_usable_token(client: AsyncClient) -> None:
    await provision(client, "signin@example.com")
    response = await client.post(
        "/api/v1/auth/login", json={"email": "signin@example.com", "password": PASSWORD}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["expires_in_minutes"] == settings.access_token_expire_minutes

    me = await client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"}
    )
    assert me.status_code == 200


async def test_a_wrong_password_and_an_unknown_email_are_indistinguishable(
    client: AsyncClient,
) -> None:
    """
    Different answers here would let anyone ask which relatives of which
    patients hold an account on this service.
    """
    await provision(client, "known@example.com")

    wrong_password = await client.post(
        "/api/v1/auth/login", json={"email": "known@example.com", "password": "not-the-password"}
    )
    unknown_email = await client.post(
        "/api/v1/auth/login", json={"email": "nobody@example.com", "password": PASSWORD}
    )

    assert wrong_password.status_code == unknown_email.status_code == 401
    assert wrong_password.json()["detail"] == unknown_email.json()["detail"]


async def test_no_token_at_all_is_refused(client: AsyncClient) -> None:
    response = await client.get("/api/v1/auth/me")
    assert response.status_code == 401


@pytest.mark.parametrize(
    "header",
    ["Bearer not-a-jwt", "Bearer ", "Basic dXNlcjpwYXNz", "some-token"],
)
async def test_a_malformed_authorization_header_is_refused(
    client: AsyncClient, header: str
) -> None:
    response = await client.get("/api/v1/auth/me", headers={"Authorization": header})
    assert response.status_code == 401


async def test_a_token_for_a_deleted_user_is_refused(client: AsyncClient) -> None:
    from app.core.security import create_access_token

    token = create_access_token(str(uuid4()))
    response = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


# ── provisioning ───────────────────────────────────────────────────────────


async def test_a_duplicate_email_is_a_conflict_not_a_500(client: AsyncClient) -> None:
    await provision(client, "twice@example.com")
    again = await provision(client, "twice@example.com")
    assert again.status_code == 409


async def test_a_short_password_is_rejected(client: AsyncClient) -> None:
    response = await provision(client, "short@example.com", password="four")
    assert response.status_code == 422


async def test_a_password_beyond_bcrypts_limit_is_rejected_not_truncated(
    client: AsyncClient,
) -> None:
    """
    bcrypt reads 72 bytes and no more. Truncating silently would mean two
    passwords sharing a long prefix both open the account.
    """
    response = await provision(client, "long@example.com", password="x" * 73)
    assert response.status_code == 422

    # And in Devanagari the limit arrives four times sooner, per byte.
    response = await provision(client, "devanagari@example.com", password="न" * 25)
    assert response.status_code == 422


# ── hashing ────────────────────────────────────────────────────────────────


def test_passwords_are_hashed_not_stored() -> None:
    hashed = hash_password(PASSWORD)
    assert PASSWORD not in hashed
    assert hashed.startswith("$2")
    assert verify_password(PASSWORD, hashed)
    assert not verify_password("something else", hashed)


def test_the_same_password_hashes_differently_each_time() -> None:
    assert hash_password(PASSWORD) != hash_password(PASSWORD)


def test_verify_never_raises_on_a_hash_it_cannot_read() -> None:
    """
    A 500 here would tell an attacker which accounts predate password support.
    """
    assert verify_password(PASSWORD, None) is False
    assert verify_password(PASSWORD, "") is False
    assert verify_password(PASSWORD, "not-a-bcrypt-hash") is False
    assert verify_password("x" * 500, hash_password(PASSWORD)) is False


# ── the development escape hatch ───────────────────────────────────────────


async def test_the_header_still_works_when_explicitly_enabled_in_development(
    client: AsyncClient, user: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "dev_trusted_identity", True)
    response = await client.get("/api/v1/auth/me", headers={"X-User-ID": user["id"]})
    assert response.status_code == 200


def test_the_escape_hatch_refuses_to_boot_outside_development() -> None:
    with pytest.raises(ValueError, match="DEV_TRUSTED_IDENTITY"):
        Settings(
            environment="staging",
            jwt_secret_key="a-real-secret-key-long-enough-to-pass-validation",
            dev_trusted_identity=True,
        ).validate_security()


def test_the_default_jwt_secret_refuses_to_boot_outside_development() -> None:
    """
    This check used to fire only for `production`/`prod`, so a deployment
    calling itself `staging` signed year-long device tokens with a key that is
    published in this repository.
    """
    with pytest.raises(ValueError, match="JWT_SECRET_KEY"):
        Settings(
            environment="staging", jwt_secret_key=INSECURE_DEFAULT_JWT_SECRET
        ).validate_security()

    # And the environments that are genuinely local still start on the default.
    for environment in ("development", "dev", "local", "test"):
        Settings(
            environment=environment, jwt_secret_key=INSECURE_DEFAULT_JWT_SECRET
        ).validate_security()

    # A staging deployment that brings its own key is fine.
    Settings(
        environment="staging", jwt_secret_key="a-real-secret-key-long-enough-to-pass"
    ).validate_security()
