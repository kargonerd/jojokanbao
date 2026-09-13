"""Server-only database operations, after application authentication."""
from typing import Any

import httpx

from app.core.config import Settings
from app.core.errors import ApiError, ConfigurationError


async def service_rpc(settings: Settings, name: str, params: dict[str, Any]) -> Any:
    if not settings.supabase_secret_key:
        raise ConfigurationError()
    base, _ = settings.require_supabase()
    headers = {"apikey": settings.supabase_secret_key}
    # Legacy service_role JWTs need the explicit bearer header. Modern secret
    # API keys are authenticated by the Supabase gateway using apikey alone.
    if settings.supabase_secret_key.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {settings.supabase_secret_key}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(f"{base}/rest/v1/rpc/{name}", headers=headers, json=params)
        if not response.is_success:
            status = response.status_code if response.status_code in (400, 404, 409) else 502
            raise ApiError(status, "database_operation_failed", "操作未完成，请稍后重试。")
        return response.json()
    except (httpx.HTTPError, ValueError) as error:
        raise ApiError(502, "database_unavailable", "数据服务暂时不可用。") from error
