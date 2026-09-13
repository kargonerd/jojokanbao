import asyncio
from dataclasses import replace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

from app.application import create_app
from app.core.config import Settings, get_settings
from app.core.remote_config import RemoteConfig, get_remote_config
from app.core.errors import ApiError

TOKEN = "sb_secret_fixture"


def settings():
    return Settings(environment="test", allowed_origins=(), supabase_url="https://test.supabase.co", supabase_publishable_key="public",
                    auth_timeout_seconds=1, supabase_secret_key=TOKEN, posthog_project_token="phc_test")


class Flags:
    def __init__(self, values): self.values = values
    def is_enabled(self, key): return key in self.values
    def get_flag_payload(self, key): return self.values.get(key)


def test_process_cache_deduplicates_cold_reads_and_does_not_wait_for_background_refresh():
    async def scenario():
        config = RemoteConfig(settings())
        sdk = AsyncMock()
        sdk.evaluate_flags.return_value = Flags({"auth_signup_config": {"invitationRequired": False}})
        config.client = sdk
        assert await asyncio.gather(config.get("auth_signup_config"), config.get("auth_signup_config")) == [{"invitationRequired": False}] * 2
        assert sdk.evaluate_flags.await_count == 1
        waiting = asyncio.Event()
        async def slow(*_args, **_kwargs):
            await waiting.wait()
            return Flags({"auth_signup_config": {"invitationRequired": True}})
        sdk.evaluate_flags.side_effect = slow
        config.refresh_after = 0
        assert await config.get("auth_signup_config") == {"invitationRequired": False}
        assert not waiting.is_set()
        waiting.set()
        await config.pending
        assert await config.get("auth_signup_config") == {"invitationRequired": True}
        sdk.evaluate_flags.side_effect = RuntimeError("offline")
        config.refresh_after = 0
        assert await config.get("auth_signup_config") == {"invitationRequired": True}
        await config.close()
    asyncio.run(scenario())


def test_invalid_first_snapshot_cannot_open_registration():
    async def scenario():
        config = RemoteConfig(settings())
        sdk = AsyncMock()
        sdk.evaluate_flags.return_value = Flags({"auth_signup_config": {"invitationRequired": "false"}})
        config.client = sdk
        with pytest.raises(ApiError) as failure:
            await config.get("auth_signup_config")
        assert failure.value.status_code == 503
        await config.close()
    asyncio.run(scenario())


@pytest.mark.parametrize("required", [False, True])
def test_signup_sends_only_server_policy_to_the_server_only_database_rpc(required, monkeypatch):
    app = create_app()
    config = AsyncMock()
    config.get.return_value = {"invitationRequired": required}
    app.dependency_overrides[get_remote_config] = lambda: config
    app.dependency_overrides[get_settings] = settings
    seen = []
    async def post(_self, url, **kwargs):
        seen.append((url, kwargs))
        return httpx.Response(200, json="signed-receipt")
    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    with TestClient(app) as client:
        response = client.post("/v1/account/signup-authorization", json={"email":" Reader@example.com ","invitationCode":"abc234" if required else ""})
        assert response.status_code == 200
        assert response.json() == {"authorization":"signed-receipt"}
        assert seen[0][1]["headers"] == {"apikey":TOKEN}
        assert seen[0][1]["json"] == {"p_email":"reader@example.com","p_code":"ABC234" if required else "","p_invitation_required":required}
        assert seen[0][0].endswith("/rpc/authorize_signup")
        assert client.post("/v1/account/signup-authorization", json={"email":"x@example.com","invitationRequired":False}).status_code == 422
        if required:
            assert client.post("/v1/account/signup-authorization", json={"email":"x@example.com"}).status_code == 400


def test_signup_denies_unavailable_policy_and_missing_server_key():
    app = create_app()
    config = AsyncMock()
    config.get.side_effect = ApiError(503, "remote_config_unavailable", "unavailable")
    app.dependency_overrides[get_remote_config] = lambda: config
    app.dependency_overrides[get_settings] = settings
    with TestClient(app) as client:
        assert client.post("/v1/account/signup-authorization", json={"email":"x@example.com"}).status_code == 503
        app.dependency_overrides[get_settings] = lambda: replace(settings(), supabase_secret_key=None)
        config.get.side_effect = None
        config.get.return_value = {"invitationRequired":False}
        assert client.post("/v1/account/signup-authorization", json={"email":"x@example.com"}).status_code == 503

