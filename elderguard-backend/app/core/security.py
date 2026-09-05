"""
Password hashing and token issuing.

WHY `bcrypt` DIRECTLY AND NOT `passlib`. `passlib[bcrypt]==1.7.4` was in
requirements.txt with a `CryptContext` that nothing ever called — dead code, so
nobody discovered it does not work. passlib 1.7.4 (last released 2020) reads
`bcrypt.__about__.__version__` to detect its backend, which bcrypt 5 removed;
the backend then fails to load and the first real `hash()` raises. Wiring
passwords through it would have broken the moment someone registered.

The choice was pin bcrypt back to <4.1 to keep an unmaintained wrapper alive,
or call bcrypt itself. bcrypt's own API is two functions and it is the library
passlib was calling anyway.

THE 72-BYTE LIMIT IS REAL AND IS NOT PAPERED OVER. bcrypt ignores everything
past 72 bytes of the password, and bcrypt 5 raises rather than truncating
silently. Silent truncation is the worse failure — two different passwords that
share a long prefix would both open the account — so the limit is enforced at
the schema boundary (see UserCreate) and asserted here.
"""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
import secrets

import bcrypt
from jose import JWTError, jwt

from app.core.config import settings

#: bcrypt reads no further than this. Enforced rather than truncated to.
MAX_PASSWORD_BYTES = 72


def hash_value(value: str) -> str:
    """
    For QR tokens, not passwords.

    A plain SHA-256 is right here and wrong for a password: a pairing token is
    32 bytes of `secrets.token_urlsafe`, so there is no guessable input for a
    slow hash to protect. Passwords go through `hash_password`.
    """
    return sha256(value.encode("utf-8")).hexdigest()


def hash_password(password: str) -> str:
    encoded = password.encode("utf-8")
    if len(encoded) > MAX_PASSWORD_BYTES:
        raise ValueError(f"password must be at most {MAX_PASSWORD_BYTES} bytes")
    return bcrypt.hashpw(encoded, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str | None) -> bool:
    """
    Never raises. A malformed stored hash, a missing one, or an oversized
    candidate is a failed login, not a 500 — and a 500 here would tell an
    attacker which accounts predate password support.
    """
    if not password_hash:
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8")[:MAX_PASSWORD_BYTES], password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def generate_qr_token() -> str:
    return secrets.token_urlsafe(32)


def create_token(subject: str, token_type: str, expires_minutes: int) -> str:
    expires_at = datetime.now(UTC) + timedelta(minutes=expires_minutes)
    payload = {"sub": subject, "type": token_type, "exp": expires_at}
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def create_device_token(device_id: str) -> str:
    return create_token(device_id, "device", settings.device_token_expire_minutes)


def create_access_token(user_id: str) -> str:
    """
    A person's session. Short-lived, unlike a device token.

    The `type` claim is what keeps the two apart: a device token is valid for a
    year and is stored on hardware someone could physically take, so it must
    never be spendable as a user session.
    """
    return create_token(user_id, "user", settings.access_token_expire_minutes)


def decode_token(token: str, expected_type: str) -> str | None:
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None
    if payload.get("type") != expected_type:
        return None
    subject = payload.get("sub")
    return subject if isinstance(subject, str) else None
