from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials

from ..core.auth import bearer
from ..core.config import Settings, get_settings
from ..core.errors import FeatureNotAvailableError
from .repository import SupabaseFeatureFlagRepository


def get_feature_flag_repository(
    settings: Settings = Depends(get_settings),
) -> SupabaseFeatureFlagRepository:
    return SupabaseFeatureFlagRepository(settings)


def require_feature(
    key: str,
) -> Callable[..., Awaitable[None]]:
    async def dependency(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
        repository: SupabaseFeatureFlagRepository = Depends(get_feature_flag_repository),
    ) -> None:
        token = credentials.credentials if credentials and credentials.scheme.lower() == "bearer" else None
        decisions = await repository.evaluate((key,), access_token=token, visitor_id=None)
        if not decisions or not decisions[0].enabled:
            raise FeatureNotAvailableError()

    return dependency
