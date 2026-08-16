from __future__ import annotations

import httpx

from ..core.config import Settings
from ..core.errors import AuthenticationError, ConfigurationError, FeatureEvaluationError
from .models import FeatureDecision


class SupabaseFeatureFlagRepository:
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

    async def evaluate(
        self,
        keys: tuple[str, ...],
        *,
        access_token: str | None,
        visitor_id: str | None,
    ) -> list[FeatureDecision]:
        authorization = access_token or self._publishable_key
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout,
                transport=self._transport,
            ) as client:
                response = await client.post(
                    "/rest/v1/rpc/get_my_feature_flags",
                    headers={
                        "apikey": self._publishable_key,
                        "Authorization": f"Bearer {authorization}",
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                    },
                    json={"p_keys": list(keys), "p_visitor_id": visitor_id},
                )
        except httpx.HTTPError as error:
            raise FeatureEvaluationError() from error

        if response.status_code in {400, 401, 403} and access_token:
            raise AuthenticationError("Invalid or expired access token")
        if not response.is_success:
            raise FeatureEvaluationError()
        try:
            payload = response.json()
            if not isinstance(payload, list):
                raise ValueError("Expected a list")
            return [
                FeatureDecision(
                    key=str(item["flag_key"]),
                    enabled=bool(item["enabled"]),
                    revision=int(item["revision"]),
                )
                for item in payload
                if isinstance(item, dict)
            ]
        except (KeyError, TypeError, ValueError) as error:
            raise FeatureEvaluationError("Feature evaluation service returned invalid data") from error
