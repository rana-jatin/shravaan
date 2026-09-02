from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.user import User
from app.schemas.user import UserCreate, UserRead

router = APIRouter(prefix="/auth", tags=["Authentication"])


@router.get("/me", response_model=UserRead, status_code=status.HTTP_200_OK, summary="Read the authenticated profile")
async def read_current_user(current_user: User = Depends(get_current_user)) -> User:
    return current_user


@router.post("/provision", response_model=UserRead, status_code=status.HTTP_201_CREATED, summary="Provision a platform profile")
async def provision_user(request: UserCreate, db: AsyncSession = Depends(get_db)) -> User:
    user = User(**request.model_dump())
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user
