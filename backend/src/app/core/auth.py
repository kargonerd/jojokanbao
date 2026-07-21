from __future__ import annotations

from typing import Any

import httpx
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import Settings, get_settings
from .errors import AuthenticationError, AuthServiceError, ConfigurationError
from .models import CurrentUser


bearer = HTTPBearer(auto_error=False)


class SupabaseAuthClient:
    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        try:
            self._base_url, self._publishable_key = settings.require_supabase()
        except RuntimeError as error:
            raise ConfigurationError() from error
        self._timeout = settings.auth_timeout_seconds
        self._transport = transport

    async def get_user(self, access_token: str) -> CurrentUser:
        headers = {
            "apikey": self._publishable_key,
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
        }
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout,
                transport=self._transport,
            ) as client:
                response = await client.get("/auth/v1/user", headers=headers)
        except httpx.HTTPError as error:
            raise AuthServiceError() from error

        if response.status_code in {400, 401, 403}:
            raise AuthenticationError("Invalid or expired access token")
        if not response.is_success:
            raise AuthServiceError()

        try:
            payload: Any = response.json()
            return CurrentUser.model_validate(payload)
        except (ValueError, TypeError) as error:
            raise AuthServiceError("Authentication service returned an invalid response") from error


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    settings: Settings = Depends(get_settings),
) -> CurrentUser:
    if credentials is None or credentials.scheme.lower() != "bearer" or not credentials.credentials.strip():
        raise AuthenticationError()
    return await SupabaseAuthClient(settings).get_user(credentials.credentials)
