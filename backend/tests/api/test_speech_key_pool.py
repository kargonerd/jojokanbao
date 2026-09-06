import asyncio
import base64
import os

import httpx
import pytest

from app.core.config import Settings
from app.core.errors import ApiError
from app.speech.key_pool import KeyPool, key_pool, retry_after
from app.speech.providers import MimoProvider, PooledMimoProvider


def configured(**kwargs):
    return Settings(environment="test", allowed_origins=(), supabase_url=None,
                    supabase_publishable_key=None, auth_timeout_seconds=1, **kwargs)


def audio():
    return httpx.Response(200, json={"choices": [{"message": {"audio": {
        "data": base64.b64encode(b"RIFF\x04\0\0\0WAVEdata").decode(),
    }}}]})


@pytest.fixture(autouse=True)
def fresh_pool(monkeypatch):
    key_pool.cache_clear()
    monkeypatch.setattr("app.speech.key_pool.secrets.randbelow", lambda _: 0)
    yield
    key_pool.cache_clear()


def test_env_array_is_deduplicated_and_redacted(monkeypatch):
    for name in os.environ:
        if name.startswith("MIMO_"):
            monkeypatch.delenv(name)
    monkeypatch.setenv("JOJO_ENV", "test")
    monkeypatch.setenv("MIMO_API_KEYS", '[" primary-secret ","second-secret","primary-secret","tenth-secret"]')
    monkeypatch.setenv("MIMO_API_KEY", "ignored-legacy-secret")
    monkeypatch.setenv("MIMO_API_KEY_10", "tenth-secret")
    monkeypatch.setenv("MIMO_API_KEY_2", "second-secret")
    monkeypatch.setenv("MIMO_API_KEY_3", "primary-secret")
    monkeypatch.setenv("MIMO_API_KEY_4", " ")
    monkeypatch.setenv("MIMO_API_KEY_extra", "excluded-secret")
    monkeypatch.setenv("MIMO_TOKEN_PLAN", "excluded-token-plan")
    settings = Settings.from_env()
    assert settings.mimo_keys == ("primary-secret", "second-secret", "tenth-secret")
    assert "secret" not in repr(settings)
    assert "token-plan" not in repr(settings)


@pytest.mark.parametrize("value", ['bad-secret', '"secret"', '{"key":"secret"}', '["secret",null]', '[""]', '[123]'])
def test_invalid_array_fails_closed_without_exposing_value(monkeypatch, value):
    monkeypatch.setenv("JOJO_ENV", "test")
    monkeypatch.setenv("MIMO_API_KEYS", value)
    with pytest.raises(RuntimeError, match="MIMO_API_KEYS must be a JSON array") as failure:
        Settings.from_env()
    assert "secret" not in str(failure.value)


def test_empty_array_disables_mimo_instead_of_using_legacy_key(monkeypatch):
    monkeypatch.setenv("JOJO_ENV", "test")
    monkeypatch.setenv("MIMO_API_KEYS", "[]")
    monkeypatch.setenv("MIMO_API_KEY", "ignored-legacy")
    assert Settings.from_env().mimo_keys == ()


def test_absent_array_uses_legacy_key(monkeypatch):
    monkeypatch.setenv("JOJO_ENV", "test")
    monkeypatch.delenv("MIMO_API_KEYS", raising=False)
    monkeypatch.setenv("MIMO_API_KEY", " legacy-secret ")
    monkeypatch.setenv("MIMO_API_KEY_2", "ignored-numbered-secret")
    assert Settings.from_env().mimo_keys == ("legacy-secret",)


def test_primary_optional_and_single_key_still_supported():
    assert PooledMimoProvider().available(configured(mimo_api_keys=("second",)))
    assert configured(mimo_api_key="first").mimo_keys == ("first",)
    assert not PooledMimoProvider().available(configured(tts_enabled=False, mimo_api_keys=("second",)))


def test_least_busy_rotation_and_cooldown():
    now = [0.0]
    pool = KeyPool(("first", "second", "third"), clock=lambda: now[0], start=0)
    assert pool.acquire(set()) == (0, "first")
    assert pool.acquire(set()) == (1, "second")
    pool.release(1)
    assert pool.acquire(set()) == (2, "third")
    pool.release(2)
    assert pool.acquire(set()) == (1, "second")  # first remains busy
    pool.defer(1, 60)
    pool.release(1)
    pool.release(0)
    assert pool.acquire({0, 2}) is None
    now[0] = 61
    assert pool.acquire({0, 2}) == (1, "second")


def test_sequential_requests_use_all_keys_and_keep_protocol():
    used = []
    def upstream(request):
        used.append(request.headers["api-key"])
        return audio()
    provider = PooledMimoProvider(httpx.MockTransport(upstream))
    settings = configured(mimo_api_key="first", mimo_api_keys=("first", "second", "third"))
    async def run():
        for _ in range(6):
            await provider.synthesize("测试", "白桦", settings)
    asyncio.run(run())
    assert used == ["first", "second", "third"] * 2


@pytest.mark.parametrize("status", [401, 403, 429, 500, 503])
def test_explicit_rejection_fails_over_and_cools_bad_key(status):
    used = []
    def upstream(request):
        key = request.headers["api-key"]
        used.append(key)
        return httpx.Response(status, headers={"Retry-After": "90"}, json={"secret": "never expose"}) if key == "bad" else audio()
    provider = PooledMimoProvider(httpx.MockTransport(upstream))
    settings = configured(mimo_api_keys=("bad", "good"))
    async def run():
        await provider.synthesize("测试", "冰糖", settings)
        await provider.synthesize("测试二", "白桦", settings)
    asyncio.run(run())
    assert used == ["bad", "good", "good"]


def test_retries_bounded_and_errors_sanitized():
    used = []
    def upstream(request):
        used.append(request.headers["api-key"])
        return httpx.Response(429, json={"message": "secret upstream data"})
    provider = PooledMimoProvider(httpx.MockTransport(upstream))
    settings = configured(mimo_api_keys=("a", "b", "c", "d"))
    with pytest.raises(ApiError) as failure:
        asyncio.run(provider.synthesize("测试", "白桦", settings))
    assert len(used) == 3 and len(set(used)) == 3
    assert failure.value.status_code == 429
    assert "secret" not in str(failure.value)


def test_all_cooling_keys_do_not_send_requests():
    settings = configured(mimo_api_keys=("a", "b"))
    pool = key_pool(settings.mimo_keys)
    pool.defer(0, 60)
    pool.defer(1, 60)
    provider = PooledMimoProvider(httpx.MockTransport(lambda _: pytest.fail("Should not call upstream")))
    with pytest.raises(ApiError) as failure:
        asyncio.run(provider.synthesize("测试", "白桦", settings))
    assert failure.value.status_code == 429


@pytest.mark.parametrize("problem", ["timeout", "invalid_audio", "invalid_request"])
def test_ambiguous_or_content_failures_do_not_repeat_across_keys(problem):
    used = []
    def upstream(request):
        used.append(request.headers["api-key"])
        if problem == "timeout":
            raise httpx.ReadTimeout("secret", request=request)
        return httpx.Response(400 if problem == "invalid_request" else 200, json={"choices": []})
    provider = PooledMimoProvider(httpx.MockTransport(upstream))
    with pytest.raises(ApiError) as failure:
        asyncio.run(provider.synthesize("测试", "白桦", configured(mimo_api_keys=("a", "b"))))
    assert len(used) == 1
    assert "secret" not in str(failure.value)


def test_raw_offline_adapter_stays_pinned_despite_online_key_settings():
    used = []
    def upstream(request):
        used.append(request.headers["api-key"])
        return audio()
    provider = MimoProvider(httpx.MockTransport(upstream))
    asyncio.run(provider.synthesize("测试", "白桦", configured(mimo_api_key="pinned", mimo_api_keys=("other",))))
    assert used == ["pinned"]


def test_cancelled_request_releases_key():
    async def scenario():
        started = asyncio.Event()
        async def upstream(request):
            started.set()
            await asyncio.Event().wait()
        settings = configured(mimo_api_keys=("first", "second"))
        provider = PooledMimoProvider(httpx.MockTransport(upstream))
        task = asyncio.create_task(provider.synthesize("测试", "白桦", settings))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        pool = key_pool(settings.mimo_keys)
        assert pool._active == [0, 0]
    asyncio.run(scenario())


def test_cache_is_shared_across_key_configuration_changes(tmp_path, monkeypatch):
    from app.speech import delivery
    from app.speech.providers import PROVIDERS
    used = []
    def upstream(request):
        used.append(request.headers["api-key"])
        return audio()
    monkeypatch.setitem(PROVIDERS, "mimo", PooledMimoProvider(httpx.MockTransport(upstream)))
    async def scenario():
        path = str(tmp_path / "speech.sqlite3")
        first, _ = await delivery.resolve_speech("mimo", "白桦", "正文", configured(mimo_api_keys=("first",), speech_cache_path=path))
        second, status = await delivery.resolve_speech("mimo", "白桦", "正文", configured(mimo_api_keys=("second",), speech_cache_path=path))
        assert first == second and status == "hit"
    asyncio.run(scenario())
    assert used == ["first"]


@pytest.mark.parametrize("value,expected", [(None, 60), ("invalid", 60), ("nan", 60), ("inf", 60), ("120", 120), ("0", 1)])
def test_retry_after(value, expected):
    assert retry_after(value) == expected
