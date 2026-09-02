from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db, get_redis
from app.core.security import create_device_token, generate_qr_token, hash_value
from app.models.device import Device, DeviceStatus
from app.models.user import User
from app.schemas.device import DevicePairRequest, DevicePairResponse, DeviceRead, DeviceRegisterRequest, DeviceRegisterResponse

router = APIRouter(prefix="/devices", tags=["Devices"])


@router.post("/register", response_model=DeviceRegisterResponse, status_code=status.HTTP_201_CREATED, summary="Create a device record and issue a one-time QR pairing token")
async def register_device(
    request: DeviceRegisterRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DeviceRegisterResponse:
    existing = await db.scalar(select(Device).where(Device.hardware_uid == request.hardware_uid))
    if existing is not None:
        raise HTTPException(status_code=409, detail="Device hardware UID is already registered")

    qr_token = generate_qr_token()
    device = Device(
        hardware_uid=request.hardware_uid,
        qr_token_hash=hash_value(qr_token),
        owner_id=current_user.id,
        status=DeviceStatus.INACTIVE,
    )
    db.add(device)
    await db.commit()
    await db.refresh(device)

    return DeviceRegisterResponse(device=device, qr_token=qr_token)


@router.post("/pair", response_model=DevicePairResponse, status_code=status.HTTP_201_CREATED, summary="Pair hardware using a QR token")
async def pair_device(
    request: DevicePairRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DevicePairResponse:
    device = await db.scalar(select(Device).where(Device.hardware_uid == request.hardware_uid).with_for_update())
    if device is None:
        raise HTTPException(status_code=404, detail="Hardware or QR token is invalid")

    if device.status == DeviceStatus.REVOKED:
        raise HTTPException(status_code=409, detail="Device has been revoked")

    if device.status == DeviceStatus.ACTIVE and device.owner_id != current_user.id:
        raise HTTPException(status_code=409, detail="Device is already paired")

    if device.qr_token_hash != hash_value(request.qr_token):
        raise HTTPException(status_code=404, detail="Hardware or QR token is invalid")

    if device.owner_id is not None and device.owner_id != current_user.id:
        raise HTTPException(status_code=409, detail="Device is already paired")

    device.owner_id = current_user.id
    device.status = DeviceStatus.ACTIVE
    device.qr_token_hash = hash_value(f"consumed:{request.qr_token}")
    await db.commit()
    await db.refresh(device)
    return DevicePairResponse(device=device, device_token=create_device_token(str(device.id)))


@router.get("/{device_id}", response_model=DeviceRead, summary="Read device status")
async def get_device(device_id: UUID, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)) -> Device:
    device = await db.scalar(select(Device).where(Device.id == device_id, Device.owner_id == current_user.id))
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.post("/{device_id}/check-in", response_model=DeviceRead, summary="Record a device heartbeat")
async def check_in(device_id: UUID, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db), redis: Redis = Depends(get_redis)) -> Device:
    device = await db.scalar(select(Device).where(Device.id == device_id, Device.owner_id == current_user.id))
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    now = datetime.now(UTC)
    device.last_seen_at = now
    await redis.setex(f"device:heartbeat:{device_id}", 120, now.isoformat())
    await db.commit()
    await db.refresh(device)
    return device
