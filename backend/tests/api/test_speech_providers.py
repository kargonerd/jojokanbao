import asyncio
import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.core.errors import ApiError
from app.main import app
from app.speech.providers import AudioResult, MimoProvider, PROVIDERS


def configured(**kwargs):
    return Settings(environment="test", allowed_origins=(), supabase_url=None,
                    supabase_publishable_key=None, auth_timeout_seconds=1, **kwargs)


@pytest.fixture
def client():
    app.dependency_overrides[get_settings] = lambda: configured(mimo_api_key="server-only-secret")
    with TestClient(app) as value:
        yield value
    app.dependency_overrides.clear()


def test_catalog_exposes_capabilities_not_credentials(client):
    response = client.get("/v1/speech/providers")
    assert response.status_code == 200
    assert "server-only-secret" not in response.text
    assert [p["id"] for p in response.json()["providers"]] == ["edge", "mimo"]
    assert response.json()["providers"][1]["available"] is True


def test_missing_key_marks_mimo_unavailable(client):
    app.dependency_overrides[get_settings] = lambda: configured()
    assert client.get("/v1/speech/providers").json()["providers"][1]["available"] is False
    assert client.post("/v1/speech", json={"text": "朗读", "provider": "mimo"}).status_code == 503


@pytest.mark.parametrize("payload", [
    {"text": "朗读", "provider": "unknown"},
    {"text": "朗读", "provider": "mimo", "voice": "zh-CN-XiaoxiaoNeural"},
    {"text": "朗读", "provider": "edge", "voice": "冰糖"},
    {"text": " "}, {"text": "字" * 601},
])
def test_rejects_invalid_input(client, payload):
    assert client.post("/v1/speech", json=payload).status_code == 422


def test_mimo_adapter_uses_documented_protocol():
    wav = b"RIFF\x04\x00\x00\x00WAVEdata"
    def upstream(request):
        assert str(request.url) == "https://api.xiaomimimo.com/v1/chat/completions"
        assert request.headers["api-key"] == "server-only-secret"
        payload = json.loads(request.content)
        assert payload["model"] == "mimo-v2.5-tts"
        assert payload["messages"][-1] == {"role": "assistant", "content": "原文"}
        assert payload["audio"] == {"voice": "冰糖", "format": "wav"}
        return httpx.Response(200, json={"choices": [{"message": {"audio": {"data": base64.b64encode(wav).decode()}}}]})
    result = asyncio.run(MimoProvider(httpx.MockTransport(upstream)).synthesize("原文", "冰糖", configured(mimo_api_key="server-only-secret")))
    assert result == AudioResult(wav, "audio/wav", "wav")


@pytest.mark.parametrize("status,body,expected", [
    (429, {"message": "secret upstream data"}, 429),
    (401, {"message": "secret upstream data"}, 502),
    (200, {"choices": []}, 502),
    (200, {"choices": [{"message": {"audio": {"data": "bad-base64"}}}]}, 502),
])
def test_mimo_errors_are_sanitized(status, body, expected):
    adapter = MimoProvider(httpx.MockTransport(lambda _: httpx.Response(status, json=body)))
    with pytest.raises(ApiError) as failure:
        asyncio.run(adapter.synthesize("原文", "冰糖", configured(mimo_api_key="secret")))
    assert failure.value.status_code == expected
    assert "secret" not in str(failure.value)


def test_mimo_route_returns_wav_without_non_ascii_headers(client, monkeypatch):
    async def synthesize(text, voice, settings):
        assert voice == "冰糖"
        return AudioResult(b"RIFF-test-WAVE", "audio/wav", "wav")
    monkeypatch.setattr(PROVIDERS["mimo"], "synthesize", synthesize)
    response = client.post("/v1/speech", json={"provider": "mimo", "text": "原文"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["x-speech-provider"] == "mimo"


def test_production_uses_frontend_only_login(client, monkeypatch):
    app.dependency_overrides[get_settings] = lambda: Settings(
        environment="production", allowed_origins=(), supabase_url=None,
        supabase_publishable_key=None, auth_timeout_seconds=1,
        mimo_api_key="secret", tts_enabled=True)
    async def generate(*args):
        return AudioResult(b"RIFF-test-WAVE", "audio/wav", "wav")
    monkeypatch.setattr(PROVIDERS["mimo"], "synthesize", generate)
    assert client.post("/v1/speech", json={"provider": "mimo", "text": "原文"}).status_code == 200
    assert client.get("/v1/speech/providers").json()["requiresAuth"] is False


def test_production_synthesis_defaults_off_and_key_not_in_repr(monkeypatch):
    monkeypatch.setenv("JOJO_ENV", "production")
    monkeypatch.setenv("JOJO_ALLOWED_ORIGINS", "https://reader.example.com")
    monkeypatch.setenv("MIMO_API_KEY", "server-only-secret")
    monkeypatch.delenv("JOJO_TTS_ENABLED", raising=False)
    assert Settings.from_env().tts_enabled is False
    assert "server-only-secret" not in repr(Settings.from_env())


@pytest.mark.parametrize("enabled", ["true", "false"])
def test_one_environment_switch_controls_both_providers(monkeypatch, enabled):
    monkeypatch.setenv("JOJO_ENV", "production")
    monkeypatch.setenv("JOJO_ALLOWED_ORIGINS", "https://reader.example.com")
    monkeypatch.setenv("JOJO_TTS_ENABLED", enabled)
    monkeypatch.setenv("MIMO_API_KEY", "server-only-secret")
    settings = Settings.from_env()
    assert settings.tts_enabled is (enabled == "true")
    assert all(provider.available(settings) is (enabled == "true") for provider in PROVIDERS.values())


def test_synthesis_switch_rejects_invalid_values(monkeypatch):
    monkeypatch.setenv("JOJO_ENV", "test")
    monkeypatch.setenv("JOJO_TTS_ENABLED", "maybe")
    with pytest.raises(RuntimeError, match="JOJO_TTS_ENABLED must be a boolean"):
        Settings.from_env()
