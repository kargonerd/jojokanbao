import asyncio

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import app
from app.speech.cache import SpeechCache, audio_cache_key
from app.speech.providers import AudioResult, PROVIDERS

AUDIO = AudioResult(b"cached-audio", "audio/mpeg", "mp3")


def test_cache_persists_across_instances_and_partitions_voice_and_version(tmp_path):
    path = str(tmp_path / "cache.sqlite3")
    key = audio_cache_key("edge", "v1", "voice", "text")
    SpeechCache(path).put(key, AUDIO)
    assert SpeechCache(path).get(key) == AUDIO
    for fields in [("mimo", "v1", "voice", "text"), ("edge", "v2", "voice", "text"), ("edge", "v1", "other", "text"), ("edge", "v1", "voice", "new text")]:
        assert SpeechCache(path).get(audio_cache_key(*fields)) is None


def test_concurrent_requests_share_one_synthesis(tmp_path):
    async def scenario():
        cache = SpeechCache(str(tmp_path / "cache.sqlite3"))
        calls = 0
        async def generate():
            nonlocal calls
            calls += 1
            await asyncio.sleep(.05)
            return AUDIO
        results = await asyncio.gather(*(cache.resolve("key", generate) for _ in range(8)))
        assert all(audio == AUDIO for audio, _ in results)
        assert calls == 1
        assert await cache.resolve("key", generate) == (AUDIO, "hit")
        assert not cache.pending
    asyncio.run(scenario())


def test_failed_generation_is_retryable_and_not_cached(tmp_path):
    async def scenario():
        cache = SpeechCache(str(tmp_path / "cache.sqlite3"))
        async def fail():
            raise ValueError("upstream failed")
        with pytest.raises(ValueError):
            await cache.resolve("key", fail)
        assert cache.get("key") is None
        async def success():
            return AUDIO
        assert await cache.resolve("key", success) == (AUDIO, "miss")
    asyncio.run(scenario())


def test_expiration_and_size_eviction(tmp_path, monkeypatch):
    cache = SpeechCache(str(tmp_path / "cache.sqlite3"), max_bytes=len(AUDIO.data), ttl_seconds=10)
    monkeypatch.setattr("app.speech.cache.time.time", lambda: 100)
    cache.put("old", AUDIO)
    cache.put("new", AUDIO)
    assert cache.get("old") is None
    assert cache.get("new") == AUDIO
    monkeypatch.setattr("app.speech.cache.time.time", lambda: 111)
    assert cache.get("new") is None


def test_route_reuses_audio_with_frontend_only_login_policy(tmp_path, monkeypatch):
    cache_path = str(tmp_path / "cache.sqlite3")
    settings = Settings(environment="test", allowed_origins=(), supabase_url=None,
        supabase_publishable_key=None, auth_timeout_seconds=1, speech_cache_path=cache_path)
    calls = 0
    async def generate(text, voice, settings):
        nonlocal calls
        calls += 1
        return AUDIO
    monkeypatch.setattr(PROVIDERS["edge"], "synthesize", generate)
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            payload = {"text": "同一本书的正文", "voice": "zh-CN-XiaoxiaoNeural"}
            first = client.post("/v1/speech", json=payload)
            second = client.post("/v1/speech", json=payload)
            assert first.status_code == second.status_code == 200
            assert first.content == second.content == AUDIO.data
            assert first.headers["X-Speech-Cache"] == "miss"
            assert second.headers["X-Speech-Cache"] == "hit"
            assert calls == 1
            from dataclasses import replace
            settings = replace(settings, environment="production", tts_enabled=False)
            assert client.post("/v1/speech", json=payload).status_code == 200
            assert calls == 1
    finally:
        app.dependency_overrides.clear()
