from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models.device import DeviceStatus


class DeviceRegisterRequest(BaseModel):
    hardware_uid: str = Field(min_length=4, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")


class DevicePairRequest(BaseModel):
    hardware_uid: str = Field(min_length=4, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")
    qr_token: str = Field(min_length=20, max_length=256)


class DeviceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    hardware_uid: str
    owner_id: UUID | None
    status: DeviceStatus
    last_seen_at: datetime | None


class DeviceRegisterResponse(BaseModel):
    device: DeviceRead
    qr_token: str


class DevicePairResponse(BaseModel):
    device: DeviceRead
    device_token: str
