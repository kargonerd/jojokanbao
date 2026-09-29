"""Validated PostHog SDK snapshots, held only in the serving process."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any
from urllib.parse import urlsplit

from fastapi import Request
from posthog import AsyncPosthog

from .config import Settings
from .errors import ApiError

logger = logging.getLogger("jojo.platform_api.config")

# Registration stays available when PostHog is unreachable: a missing or invalid
# snapshot serves this documented fail-open policy instead of refusing the
# request. Every use is logged, so the fallback is never silent to operators.
FAIL_OPEN_DEFAULTS: dict[str, dict[str, Any]] = {
    "auth_signup_config": {"invitationRequired": False},
}


def validate_config(key: str, value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    if key == "auth_signup_config" and type(value.get("invitationRequired")) is bool:
        return {"invitationRequired": value["invitationRequired"]}
    return None


class RemoteConfig:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client: AsyncPosthog | None = None
        self.values: dict[str, dict[str, Any]] = {}
        self.pending: asyncio.Task | None = None
        self.refresh_after = 0.0

    async def refresh(self) -> None:
        self.refresh_after = time.monotonic() + 30
        try:
            host = urlsplit(self.settings.posthog_api_host)
            if not self.settings.posthog_project_token or host.scheme != "https" or not host.hostname or host.username or host.password:
                return
            if self.client is None:
                self.client = AsyncPosthog(
                    self.settings.posthog_project_token, host=self.settings.posthog_api_host,
                    feature_flags_request_timeout_seconds=3, feature_flags_request_max_retries=0,
                    before_send=lambda _event: None,
                )
            flags = await self.client.evaluate_flags("jojo-public-config", person_properties={"signed_in": False})
            valid = True
            for key in ("auth_signup_config",):
                value = validate_config(key, flags.get_flag_payload(key))
                if flags.is_enabled(key) and value is not None:
                    self.values[key] = value
                else:
                    valid = False
            self.refresh_after = time.monotonic() + (300 if valid else 30)
        except Exception:
            # Keep the documented 30s retry window, and never log SDK responses
            # or attach credentials to user-facing errors.
            logger.warning("Remote config refresh failed; retrying within 30 seconds")

    async def get(self, key: str) -> dict[str, Any]:
        if time.monotonic() >= self.refresh_after and (self.pending is None or self.pending.done()):
            self.pending = asyncio.create_task(self.refresh())
        if key not in self.values and self.pending is not None:
            await asyncio.shield(self.pending)
        if key not in self.values:
            fallback = FAIL_OPEN_DEFAULTS.get(key)
            if fallback is None:
                raise ApiError(503, "remote_config_unavailable", "运行配置暂时无法读取，请稍后重试。")
            logger.warning("Remote config %s is unavailable; serving the fail-open default", key)
            return dict(fallback)
        return dict(self.values[key])

    async def close(self) -> None:
        if self.pending and not self.pending.done():
            self.pending.cancel()
            await asyncio.gather(self.pending, return_exceptions=True)
        if self.client:
            await self.client.shutdown()


def get_remote_config(request: Request) -> RemoteConfig:
    return request.app.state.remote_config
