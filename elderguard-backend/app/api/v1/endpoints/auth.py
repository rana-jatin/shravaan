from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.core.config import settings
from app.core.security import create_access_token, hash_password, verify_password
from app.models.user import User
from app.schemas.user import TokenResponse, UserCreate, UserLogin, UserRead

router = APIRouter(prefix="/auth", tags=["Authentication"])


@router.get("/me", response_model=UserRead, status_code=status.HTTP_200_OK, summary="Read the authenticated profile")
async def read_current_user(current_user: User = Depends(get_current_user)) -> User:
    return current_user


@router.post("/provision", response_model=UserRead, status_code=status.HTTP_201_CREATED, summary="Provision a platform profile")
async def provision_user(request: UserCreate, db: AsyncSession = Depends(get_db)) -> User:
    """
    Sign-up. Open by design — somebody has to be able to create the first
    account — but it now sets a credential, which is what makes every route
    after it verifiable.
    """
    user = User(
        email=request.email,
        full_name=request.full_name,
        role=request.role,
        password_hash=hash_password(request.password),
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError as exc:
        # `email` is unique. Without this the duplicate surfaced as a bare 500
        # from the catch-all handler, telling the caller nothing actionable.
        await db.rollback()
        raise HTTPException(status_code=409, detail="That email address is already registered") from exc
    await db.refresh(user)
    return user


@router.post("/login", response_model=TokenResponse, status_code=status.HTTP_200_OK, summary="Exchange credentials for an access token")
async def login(request: UserLogin, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    user = await db.scalar(select(User).where(User.email == request.email))

    # ONE MESSAGE FOR BOTH FAILURES, and the password is verified even when no
    # user was found — against a hash that cannot match. Answering "no such
    # user" faster than "wrong password" turns this endpoint into a way to
    # enumerate which relatives of which patients hold an account here.
    candidate_hash = user.password_hash if user else _DUMMY_HASH
    if not verify_password(request.password, candidate_hash) or user is None:
        raise HTTPException(status_code=401, detail="Email or password is incorrect")

    return TokenResponse(
        access_token=create_access_token(str(user.id)),
        expires_in_minutes=settings.access_token_expire_minutes,
    )


#: A real bcrypt hash of a value nobody knows, so the no-such-user path costs
#: the same as the wrong-password path. Computed once at import — hashing on
#: every failed login would make this endpoint its own denial of service.
_DUMMY_HASH = hash_password("an unguessable placeholder for timing parity")
