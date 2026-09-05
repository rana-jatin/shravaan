import secrets
from collections.abc import AsyncGenerator
from uuid import UUID

from fastapi import Depends, Header, HTTPException, status
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db_session
from app.core.redis import get_client
from app.core.security import decode_token
from app.models.device import Device
from app.models.user import User


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async for session in get_db_session():
        yield session


async def get_redis() -> Redis:
    client = get_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Redis is unavailable")
    return client


async def enforce_rate_limit(redis: Redis, key: str, limit: int = 120, window_seconds: int = 60) -> None:
    current = await redis.incr(key)
    if current == 1:
        await redis.expire(key, window_seconds)
    if current > limit:
        raise HTTPException(status_code=429, detail="Rate limit exceeded")


async def get_current_user(
    authorization: str | None = Header(default=None),
    x_user_id: str | None = Header(default=None, alias="X-User-ID"),
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    Who is calling, and proof of it.

    ─────────────────────────────────────────────────────────────────────────
    THIS USED TO TRUST THE `X-User-ID` HEADER, AND NOTHING ELSE.

    Any UUID a client sent was accepted as that person. Combined with an open
    /auth/provision, the whole sequence was: create a user, send its id, and
    register or pair devices as them. Device tokens were signed and verified
    properly; user identity was never checked at all.

    It is now a bearer token of type "user", issued by /auth/login and
    verified the same way a device token is. The header path survives only
    for local work, behind DEV_TRUSTED_IDENTITY, which refuses to boot
    outside a development environment (see Settings.validate_security).
    ─────────────────────────────────────────────────────────────────────────
    """
    user_id: UUID | None = None

    if authorization and authorization.startswith("Bearer "):
        subject = decode_token(authorization.removeprefix("Bearer ").strip(), "user")
        if subject is None:
            raise HTTPException(status_code=401, detail="Invalid or expired access token")
        try:
            user_id = UUID(subject)
        except ValueError as exc:
            raise HTTPException(status_code=401, detail="Invalid access token subject") from exc

    elif settings.dev_trusted_identity and x_user_id:
        try:
            user_id = UUID(x_user_id)
        except ValueError as exc:
            raise HTTPException(status_code=401, detail="Invalid user identity") from exc

    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="A bearer access token is required",
        )

    user = await db.scalar(select(User).where(User.id == user_id))
    if user is None:
        # The token verified but names nobody — a deleted account, or a token
        # signed for another deployment's database.
        raise HTTPException(status_code=401, detail="User not found")
    return user


async def require_companion(x_companion_key: str | None = Header(default=None, alias="X-Companion-Key")) -> None:
    """
    The companion server, and proof that it is.

    THE UNSET CASE IS A 503, NOT AN OPEN DOOR. The obvious way to write this —
    compare the header to the setting and reject a mismatch — treats `None ==
    None` as a match and turns a deployment that forgot the variable into one
    where anybody may read anybody's vitals. So the absence of a key is
    checked first, separately, and answered with a status that says the
    service is not configured rather than one that says the caller is wrong.

    `compare_digest` because this is a fixed secret compared on every poll, and
    a plain `==` returns early on the first differing byte.
    """
    expected = settings.companion_api_key
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Companion access is not configured on this service (COMPANION_API_KEY)",
        )
    if not x_companion_key or not secrets.compare_digest(x_companion_key, expected):
        raise HTTPException(status_code=401, detail="A valid X-Companion-Key is required")


async def get_elder(uid: str, db: AsyncSession = Depends(get_db)) -> User:
    """
    The person the companion is talking to, as this service knows them.

    ⚠ THE COMPANION'S `uid` IS ASSUMED TO BE THIS SERVICE'S USER ID. That
    assumption is the seam's weakest joint and is written down rather than
    hidden: the companion's uid arrives in a device `hello` frame and nothing
    yet guarantees it matches a row here. A uid that is not a UUID, or names
    nobody, is a 404 — so the companion degrades to "I cannot store that" and
    says so, instead of writing somebody else's reading.

    The proper fix is for pairing to establish the mapping, which is the same
    work as the caregiver dashboard and is not done.
    """
    try:
        user_id = UUID(uid)
    except ValueError:
        raise HTTPException(status_code=404, detail="No such user") from None
    user = await db.scalar(select(User).where(User.id == user_id))
    if user is None:
        raise HTTPException(status_code=404, detail="No such user")
    return user


async def get_device_from_token(authorization: str | None = Header(default=None), db: AsyncSession = Depends(get_db)) -> Device:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Bearer device token required")
    device_id = decode_token(authorization.removeprefix("Bearer ").strip(), "device")
    if not device_id:
        raise HTTPException(status_code=401, detail="Invalid or expired device token")
    try:
        device = await db.get(Device, UUID(device_id))
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid device token subject") from exc
    if device is None or device.status.value != "active":
        raise HTTPException(status_code=401, detail="Device is not active")
    return device
