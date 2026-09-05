from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.core.security import MAX_PASSWORD_BYTES
from app.models.user import UserRole


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: EmailStr
    full_name: str
    role: UserRole


class UserCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=200)
    role: UserRole = UserRole.ELDER
    password: str = Field(min_length=10)

    @field_validator("password")
    @classmethod
    def within_bcrypt_limit(cls, value: str) -> str:
        """
        bcrypt reads no further than 72 BYTES, and a caregiver's name in Devanagari
        reaches that in a quarter of the characters an English one would. Rejecting
        the password beats truncating it silently — two passwords sharing a long
        prefix would otherwise both open the account.
        """
        if len(value.encode("utf-8")) > MAX_PASSWORD_BYTES:
            raise ValueError(f"password must be at most {MAX_PASSWORD_BYTES} bytes")
        return value


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in_minutes: int
