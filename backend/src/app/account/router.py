from fastapi import APIRouter, Depends

from ..core.auth import get_current_user
from ..core.models import CurrentUser, HealthResponse


router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["system"])
async def health() -> HealthResponse:
    return HealthResponse()


@router.get("/me", response_model=CurrentUser, tags=["account"])
async def me(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    return user
