from __future__ import annotations

from typing import Any

import httpx
import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import Settings, get_settings
from .errors import AuthenticationError, AuthServiceError, ConfigurationError
from .models import CurrentUser


bearer = HTTPBearer(auto_error=False)

JWT_LEEWAY_SECONDS = 30


def decode_access_token(token: str, settings: Settings) -> CurrentUser:
    """Verify a Supabase access token locally (HS256) and map claims to CurrentUser."""
    if not settings.supabase_url or not settings.supabase_jwt_secret:
        raise ConfigurationError()
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
            issuer=f"{settings.supabase_url}/auth/v1",
            leeway=JWT_LEEWAY_SECONDS,
            options={"require": ["exp", "sub"]},
        )
    except jwt.InvalidTokenError as error:
        raise AuthenticationError("Invalid or expired access token") from error
    try:
        return CurrentUser.model_validate({
            "id": payload["sub"],
            "email": payload.get("email") or "",
            "role": payload.get("role") or "authenticated",
            "aud": payload.get("aud") or "authenticated",
            "app_metadata": payload.get("app_metadata") or {},
            "user_metadata": payload.get("user_metadata") or {},
        })
    except (ValueError, TypeError) as error:
        raise AuthenticationError("Invalid or expired access token") from error


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
    if settings.supabase_jwt_secret:
        return decode_access_token(credentials.credentials, settings)
    return await SupabaseAuthClient(settings).get_user(credentials.credentials)
