from datetime import UTC, datetime, timedelta
from hashlib import sha256
import secrets

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings


pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_value(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()


def generate_qr_token() -> str:
    return secrets.token_urlsafe(32)


def create_token(subject: str, token_type: str, expires_minutes: int) -> str:
    expires_at = datetime.now(UTC) + timedelta(minutes=expires_minutes)
    payload = {"sub": subject, "type": token_type, "exp": expires_at}
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def create_device_token(device_id: str) -> str:
    return create_token(device_id, "device", settings.device_token_expire_minutes)


def decode_token(token: str, expected_type: str) -> str | None:
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None
    if payload.get("type") != expected_type:
        return None
    subject = payload.get("sub")
    return subject if isinstance(subject, str) else None
