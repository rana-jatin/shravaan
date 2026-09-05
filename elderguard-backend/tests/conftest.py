"""
Test fixtures for the safety API.

TWO RULES, BORROWED FROM THE REST OF THIS REPO.

  NO CREDENTIALS, NO NETWORK. The suite runs against an in-memory SQLite
  database and a fake Redis. Nothing here opens a socket, reads a real `.env`,
  or needs Postgres running. That is the same promise `ai/`'s 681 tests make,
  and it is the reason those tests get run and these ones will be.

  THE APP IS BUILT, NOT IMPORTED. `create_app()` is called per test module and
  its dependencies are overridden, so a test never mutates global state another
  test then inherits.

The environment is set BEFORE any `app.*` import because `app.core.config`
builds its `Settings` singleton at import time — an env var set afterwards
would arrive too late to be read.
"""

import os

os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/15")
os.environ.setdefault("JWT_SECRET_KEY", "test-only-secret-key-of-sufficient-length-32")
os.environ.setdefault("MQTT_ENABLED", "false")
os.environ.setdefault("RELATIVE_EMAILS", "")
os.environ.setdefault("SMTP_HOST", "")
# Set here rather than per test: `Settings` is built once at import and the
# companion routes refuse with 503 when this is missing, so a suite that set
# it later would be testing the unconfigured path everywhere by accident.
os.environ.setdefault("COMPANION_API_KEY", "test-companion-key")

from collections.abc import AsyncGenerator  # noqa: E402
from typing import Any  # noqa: E402

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.api.deps import get_db, get_redis  # noqa: E402
from app.core.database import Base  # noqa: E402
from app.main import create_app  # noqa: E402


class FakeRedis:
    """
    Enough Redis for what the routes actually call.

    Deliberately not a full fake: the endpoints use `incr`, `expire` and
    `setex`, and a fake that silently accepts commands it does not implement
    would let a real call slip through untested. Anything else raises.
    """

    def __init__(self) -> None:
        self.values: dict[str, Any] = {}
        self.expiries: dict[str, int] = {}

    async def incr(self, key: str) -> int:
        self.values[key] = int(self.values.get(key, 0)) + 1
        return self.values[key]

    async def expire(self, key: str, seconds: int) -> bool:
        self.expiries[key] = seconds
        return True

    async def setex(self, key: str, seconds: int, value: Any) -> bool:
        self.values[key] = value
        self.expiries[key] = seconds
        return True

    async def get(self, key: str) -> Any:
        return self.values.get(key)


@pytest.fixture(scope="session", autouse=True)
def cheap_password_hashing() -> Any:
    """
    bcrypt at its production cost, run per test, turns this suite from one
    second into eleven — and a suite that is slow stops being run, which is the
    failure step one of this refactor existed to fix.

    The cost factor is lowered for tests ONLY. Everything else about the hash
    is real: same algorithm, same salting, same verification path, so
    `test_passwords_are_hashed_not_stored` still means what it says.
    """
    import bcrypt

    real_gensalt = bcrypt.gensalt
    bcrypt.gensalt = lambda rounds=4, prefix=b"2b": real_gensalt(4, prefix)
    yield
    bcrypt.gensalt = real_gensalt


@pytest_asyncio.fixture
async def db_sessionmaker() -> AsyncGenerator[async_sessionmaker[AsyncSession], None]:
    """
    A fresh schema per test.

    StaticPool plus a shared in-memory database is what makes this work: SQLite
    gives every new connection its own empty `:memory:` database, so without it
    the tables created here would be invisible to the request that needs them.
    """
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    await engine.dispose()


@pytest.fixture
def fake_redis() -> FakeRedis:
    return FakeRedis()


@pytest_asyncio.fixture
async def client(
    db_sessionmaker: async_sessionmaker[AsyncSession],
    fake_redis: FakeRedis,
) -> AsyncGenerator[AsyncClient, None]:
    """
    An HTTP client wired to the app, with no server and no lifespan.

    ASGITransport does not run startup/shutdown, which is exactly what we want:
    the lifespan's only jobs are connecting Redis and the MQTT consumer, and
    both are supplied or disabled here. Background tasks DO still run, so the
    SOS route's notification dispatch is exercised rather than skipped.
    """
    app = create_app()

    async def override_db() -> AsyncGenerator[AsyncSession, None]:
        async with db_sessionmaker() as session:
            yield session

    async def override_redis() -> FakeRedis:
        return fake_redis

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_redis] = override_redis

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as http:
        yield http

    app.dependency_overrides.clear()


PASSWORD = "a-sufficiently-long-test-password"


@pytest_asyncio.fixture
async def user(client: AsyncClient) -> dict[str, Any]:
    """
    A provisioned user, signed in.

    `headers` used to be `{"X-User-ID": ...}` — which was the whole of this
    service's user authentication, and is now a real bearer token.
    """
    email = "relative@example.com"
    created = await client.post(
        "/api/v1/auth/provision",
        json={
            "email": email,
            "full_name": "A Relative",
            "role": "relative",
            "password": PASSWORD,
        },
    )
    assert created.status_code == 201, created.text

    signed_in = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
    )
    assert signed_in.status_code == 200, signed_in.text
    token = signed_in.json()["access_token"]

    return {
        "id": created.json()["id"],
        "email": email,
        "token": token,
        "headers": {"Authorization": f"Bearer {token}"},
    }


@pytest_asyncio.fixture
async def paired_device(client: AsyncClient, user: dict[str, Any]) -> dict[str, Any]:
    """
    A device registered and paired to `user`, plus its bearer token.

    This is the fixture the SOS and telemetry tests need, and building it was
    impossible before the models stopped hard-coding the Postgres UUID type.
    """
    registered = await client.post(
        "/api/v1/devices/register",
        json={"hardware_uid": "test-device-0001"},
        headers=user["headers"],
    )
    assert registered.status_code == 201, registered.text
    qr_token = registered.json()["qr_token"]

    paired = await client.post(
        "/api/v1/devices/pair",
        json={"hardware_uid": "test-device-0001", "qr_token": qr_token},
        headers=user["headers"],
    )
    assert paired.status_code == 201, paired.text
    body = paired.json()
    return {
        "id": body["device"]["id"],
        "token": body["device_token"],
        "headers": {"Authorization": f"Bearer {body['device_token']}"},
    }
