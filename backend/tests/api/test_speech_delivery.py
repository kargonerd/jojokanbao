import asyncio
import io
import json
import wave
from dataclasses import replace

import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import app
from app.speech import delivery
from app.speech.encoding import encode_delivery
from app.speech.providers import AudioResult, PROVIDERS
from app.speech.storage import B2SpeechStore, PREFIX


def configured():
    return Settings(environment="test", allowed_origins=(), supabase_url=None,
                    supabase_publishable_key=None, auth_timeout_seconds=1, mimo_api_key="secret",
                    speech_storage="b2", speech_s3_endpoint="https://s3.test.invalid",
                    speech_s3_bucket="existing", speech_s3_key_id="key", speech_s3_application_key="secret")


def wav_audio():
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(b"\0\0" * 24000)
    return AudioResult(output.getvalue(), "audio/wav", "wav")


class MemoryS3:
    def __init__(self):
        self.objects = {}
        self.writes = []
        self.error = None

    def get_object(self, **kwargs):
        if self.error:
            raise self.error
        if kwargs["Key"] not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey"}, "ResponseMetadata": {"HTTPStatusCode": 404}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[kwargs["Key"]])}

    def put_object(self, **kwargs):
        self.writes.append(kwargs)
        self.objects[kwargs["Key"]] = kwargs["Body"]


def test_wav_is_compressed_to_independent_playable_mp3():
    raw = wav_audio()
    audio = encode_delivery(raw)
    assert 1 <= audio.duration < 1.2
    assert len(audio.data) < len(raw.data) / 4
    assert encode_delivery(AudioResult(audio.data, "audio/mpeg", "mp3")) == audio


def test_commit_last_metadata_never_contains_text_or_credentials():
    s3 = MemoryS3()
    store = B2SpeechStore(configured(), s3)
    key = "a" * 64
    result = store.put("mimo", key, encode_delivery(wav_audio()))
    assert s3.writes[0]["Key"].endswith(".mp3")
    assert s3.writes[-1]["Key"].endswith(".json")
    assert s3.writes[0]["ContentType"] == "audio/mpeg"
    assert "immutable" in s3.writes[0]["CacheControl"]
    assert store.get("mimo", key) == result
    assert result["url"].startswith("https://blacknews.jojokanbao.cn/audio/speech/v1/")
    assert "secret" not in s3.writes[-1]["Body"].decode()
    with pytest.raises(ValueError):
        store.put_json("content/catalog.jox", {})


def test_two_users_and_a_new_instance_reuse_b2_and_only_one_provider_call(monkeypatch):
    async def scenario():
        s3 = MemoryS3()
        settings = configured()
        calls = 0
        monkeypatch.setattr(delivery, "speech_store", lambda _: B2SpeechStore(settings, s3))
        async def synthesize(*args):
            nonlocal calls
            calls += 1
            await asyncio.sleep(.03)
            return wav_audio()
        monkeypatch.setattr(PROVIDERS["mimo"], "synthesize", synthesize)
        results = await asyncio.gather(*(delivery.resolve_speech("mimo", "白桦", "同一段正文", settings) for _ in range(5)))
        assert calls == 1
        assert all(result[0]["url"] == results[0][0]["url"] for result in results)
        disabled = replace(settings, tts_enabled=False, mimo_api_key=None)
        result, status = await delivery.resolve_speech("mimo", "白桦", "同一段正文", disabled)
        assert status == "hit" and result == results[0][0]
        assert calls == 1
    asyncio.run(scenario())


def test_storage_error_is_not_a_miss_and_does_not_spend_tts(monkeypatch):
    settings = configured()
    s3 = MemoryS3()
    s3.error = ClientError({"Error": {"Code": "AccessDenied"}, "ResponseMetadata": {"HTTPStatusCode": 403}}, "GetObject")
    monkeypatch.setattr(delivery, "speech_store", lambda _: B2SpeechStore(settings, s3))
    async def must_not_run(*args):
        pytest.fail("TTS must not run on storage failure")
    monkeypatch.setattr(PROVIDERS["mimo"], "synthesize", must_not_run)
    with pytest.raises(ClientError):
        asyncio.run(delivery.resolve_speech("mimo", "白桦", "正文", settings))


def test_saturated_synthesis_slots_return_429_without_calling_provider(monkeypatch):
    settings = configured()
    s3 = MemoryS3()
    slots = asyncio.Semaphore(0)
    real_wait_for = asyncio.wait_for
    slot_waits = []

    async def immediate_slot_timeout(awaitable, timeout):
        if timeout == 2:
            slot_waits.append(timeout)
            # Exercise the runtime's real asyncio timeout type without waiting.
            return await real_wait_for(awaitable, timeout=0)
        return await real_wait_for(awaitable, timeout)

    async def must_not_run(*args):
        pytest.fail("A saturated queue must not call the provider")

    monkeypatch.setattr(delivery, "speech_store", lambda _: B2SpeechStore(settings, s3))
    monkeypatch.setattr(delivery, "synthesis_slots", lambda _: slots)
    monkeypatch.setattr(asyncio, "wait_for", immediate_slot_timeout)
    monkeypatch.setattr(PROVIDERS["mimo"], "synthesize", must_not_run)
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            response = client.post("/v1/speech", json={"provider": "mimo", "voice": "白桦", "text": "正文"})
        assert response.status_code == 429
        assert response.json()["error"]["code"] == "speech_rate_limited"
        assert slot_waits == [2]
        assert slots.locked() and not s3.writes and not delivery._pending
    finally:
        app.dependency_overrides.clear()


def test_b2_route_returns_public_url_not_audio_or_auth_token(monkeypatch):
    settings = configured()
    s3 = MemoryS3()
    monkeypatch.setattr(delivery, "speech_store", lambda _: B2SpeechStore(settings, s3))
    async def synthesize(*args):
        return wav_audio()
    monkeypatch.setattr(PROVIDERS["mimo"], "synthesize", synthesize)
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            first = client.post("/v1/speech", json={"provider": "mimo", "voice": "白桦", "text": "正文"})
            second = client.post("/v1/speech", json={"provider": "mimo", "voice": "白桦", "text": "正文"})
        assert first.status_code == second.status_code == 200
        assert second.json()["cache"] == "hit"
        assert first.json()["url"] == second.json()["url"]
        assert "secret" not in first.text and "正文" not in first.text
    finally:
        app.dependency_overrides.clear()


def test_identity_partitions_versions_and_voices():
    assert delivery.identity("mimo", "白桦", " a\n b ")[2] == delivery.identity("mimo", "白桦", "a b")[2]
    assert delivery.identity("mimo", "白桦", "a")[2] != delivery.identity("mimo", "冰糖", "a")[2]


def test_missing_bucket_is_not_treated_as_missing_audio():
    s3 = MemoryS3()
    s3.error = ClientError({"Error": {"Code": "NoSuchBucket"}, "ResponseMetadata": {"HTTPStatusCode": 404}}, "GetObject")
    with pytest.raises(ClientError):
        B2SpeechStore(configured(), s3).get("mimo", "a" * 64)


def test_failed_audio_upload_does_not_publish_a_descriptor():
    s3 = MemoryS3()
    def fail(**kwargs):
        raise OSError("unavailable")
    s3.put_object = fail
    store = B2SpeechStore(configured(), s3)
    with pytest.raises(OSError):
        store.put("mimo", "a" * 64, encode_delivery(wav_audio()))
    assert not s3.objects


def test_cached_voice_remains_selectable_when_synthesis_is_disabled():
    app.dependency_overrides[get_settings] = lambda: replace(configured(), mimo_api_key=None, tts_enabled=False)
    try:
        with TestClient(app) as client:
            result = client.get("/v1/speech/providers").json()
        assert result["defaultVoice"] == "白桦"
        mimo = next(provider for provider in result["providers"] if provider["id"] == "mimo")
        assert mimo["available"] is True and mimo["canGenerate"] is False
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("provider,voice", [("edge", "zh-CN-XiaoxiaoNeural"), ("mimo", "白桦")])
def test_master_switch_blocks_new_audio_but_keeps_b2_hits_with_credentials(monkeypatch, provider, voice):
    settings = replace(configured(), tts_enabled=False)
    s3 = MemoryS3()
    store = B2SpeechStore(settings, s3)
    key = delivery.identity(provider, voice, "已生成的正文")[2]
    cached = store.put(provider, key, encode_delivery(wav_audio()))
    writes_before = len(s3.writes)
    monkeypatch.setattr(delivery, "speech_store", lambda _: store)

    async def must_not_run(*args):
        pytest.fail("Disabled synthesis must not contact either provider")

    for adapter in PROVIDERS.values():
        monkeypatch.setattr(adapter, "synthesize", must_not_run)
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(app) as client:
            hit = client.post("/v1/speech", json={"provider": provider, "voice": voice, "text": "已生成的正文"})
            miss = client.post("/v1/speech", json={"provider": provider, "voice": voice, "text": "尚未生成的正文"})
            catalog = client.get("/v1/speech/providers").json()
        assert hit.status_code == 200
        assert hit.json()["url"] == cached["url"] and hit.json()["cache"] == "hit"
        assert miss.status_code == 503 and miss.json()["error"]["code"] == "speech_not_enabled"
        assert all(option["available"] and not option["canGenerate"] for option in catalog["providers"])
        assert len(s3.writes) == writes_before
    finally:
        app.dependency_overrides.clear()
