from collections.abc import AsyncGenerator
from uuid import UUID

from fastapi import Depends, Header, HTTPException, status
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

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


async def get_current_user(x_user_id: str | None = Header(default=None, alias="X-User-ID"), db: AsyncSession = Depends(get_db)) -> User:
    if not x_user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="X-User-ID is required")
    try:
        user_id = UUID(x_user_id)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid user identity") from exc
    user = await db.scalar(select(User).where(User.id == user_id))
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
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
