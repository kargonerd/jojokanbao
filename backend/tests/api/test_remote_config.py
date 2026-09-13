import asyncio
import base64
import hashlib
import hmac
import json
from dataclasses import replace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

from app.application import create_app
from app.core.config import Settings, get_settings
from app.core.remote_config import RemoteConfig, get_remote_config
from app.core.errors import ApiError
from app.account.signup import sign_signup_authorization

TOKEN = "fixture-operator-token-with-at-least-32-characters"


def settings():
    return Settings(environment="test", allowed_origins=(), supabase_url="https://test.supabase.co", supabase_publishable_key="public",
                    auth_timeout_seconds=1, operator_token=TOKEN, posthog_project_token="phc_test")


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
def test_signup_uses_server_policy_and_binds_the_signed_claim_to_email_and_code(required):
    app = create_app()
    config = AsyncMock()
    config.get.return_value = {"invitationRequired": required}
    app.dependency_overrides[get_remote_config] = lambda: config
    app.dependency_overrides[get_settings] = settings
    with TestClient(app) as client:
        response = client.post("/v1/account/signup-authorization", json={"email": " Reader@example.com ", "invitationCode": "abc234" if required else ""})
        assert response.status_code == 200
        encoded, signature = response.json()["authorization"].split(".")
        assert hmac.compare_digest(signature, hmac.new(hashlib.sha256(TOKEN.encode()).digest(), f"jojo.signup.v1.{encoded}".encode(), hashlib.sha256).hexdigest())
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        assert payload["email"] == "reader@example.com"
        assert payload["required"] is required
        assert payload["code"] == ("ABC234" if required else "")
        assert config.get.call_args.args == ("auth_signup_config",)
        assert client.post("/v1/account/signup-authorization", json={"email":"x@example.com","invitationRequired":False}).status_code == 422
        if required:
            assert client.post("/v1/account/signup-authorization", json={"email":"x@example.com"}).status_code == 400


def test_signup_denies_missing_server_credentials_and_unavailable_posthog():
    app = create_app()
    config = AsyncMock()
    config.get.side_effect = ApiError(503, "remote_config_unavailable", "unavailable")
    app.dependency_overrides[get_remote_config] = lambda: config
    app.dependency_overrides[get_settings] = settings
    with TestClient(app) as client:
        assert client.post("/v1/account/signup-authorization", json={"email":"x@example.com"}).status_code == 503
        app.dependency_overrides[get_settings] = lambda: replace(settings(), operator_token=None)
        config.get.reset_mock()
        assert client.post("/v1/account/signup-authorization", json={"email":"x@example.com"}).status_code == 503
        config.get.assert_not_called()


def test_annotation_gateway_forwards_captured_identity_and_its_own_threshold(monkeypatch):
    app = create_app()
    config = AsyncMock()
    config.get.return_value = {"publicMarkThreshold": 7}
    app.dependency_overrides[get_remote_config] = lambda: config
    app.dependency_overrides[get_settings] = settings
    seen = []
    async def post(_self, url, **kwargs):
        seen.append((url, kwargs))
        return httpx.Response(200, json=[])
    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    with TestClient(app) as client:
        body = {"operation":"get_annotation_threads","params":{"p_public_mark_threshold":1}}
        assert client.post("/v1/annotations", json=body).status_code == 401
        assert not seen
        response = client.post("/v1/annotations", json=body, headers={"Authorization":"Bearer captured-reader-token"})
        assert response.status_code == 200
        assert seen[0][1]["headers"]["Authorization"] == "Bearer captured-reader-token"
        assert seen[0][1]["json"]["p_public_mark_threshold"] == 7
        assert seen[0][1]["json"]["p_operator_token"] == TOKEN
        assert TOKEN not in response.text


def test_authorization_encoding_is_stable_for_database_verification():
    signed = sign_signup_authorization("reader@example.com", "ABC234", True, TOKEN, now=1000)
    encoded, _ = signed.split(".")
    assert json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))) == {
        "email":"reader@example.com", "code":"ABC234", "required":True, "expires":1120,
    }
