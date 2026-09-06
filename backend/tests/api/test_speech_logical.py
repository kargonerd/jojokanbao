import asyncio

import pytest

from app.speech import delivery
from app.speech.providers import PROVIDERS
from app.speech.storage import B2SpeechStore
from test_speech_delivery import MemoryS3, configured, wav_audio


@pytest.mark.parametrize("voice,primary,backup", [
    ("male", "白桦", "zh-CN-YunyangNeural"),
    ("female", "冰糖", "zh-CN-XiaoxiaoNeural"),
])
def test_logical_fallback_is_cached_and_shared(monkeypatch, voice, primary, backup):
    async def scenario():
        settings = configured()
        store = B2SpeechStore(settings, MemoryS3())
        monkeypatch.setattr(delivery, "speech_store", lambda _: store)
        calls = []
        async def mimo(text, selected, settings):
            calls.append(("mimo", selected))
            await asyncio.sleep(.02)
            raise TimeoutError("vendor unavailable")
        async def edge(text, selected, settings):
            calls.append(("edge", selected))
            await asyncio.sleep(.02)
            return wav_audio()
        monkeypatch.setattr(PROVIDERS["mimo"], "synthesize", mimo)
        monkeypatch.setattr(PROVIDERS["edge"], "synthesize", edge)
        results = await asyncio.gather(*(delivery.resolve_speech("auto", voice, "测试正文", settings) for _ in range(2)))
        assert calls == [("mimo", primary), ("edge", backup)]
        assert results[0][0] == results[1][0]
        record, status = await delivery.resolve_speech("auto", voice, "测试正文", settings)
        assert status == "hit" and record["provider"] == "edge"
        assert record["key"] == delivery.identity("auto", voice, "测试正文")[2]
        assert len(calls) == 2
    asyncio.run(scenario())


def test_existing_mimo_audio_is_aliased_without_copy_or_synthesis(monkeypatch):
    async def scenario():
        settings = configured()
        s3 = MemoryS3()
        store = B2SpeechStore(settings, s3)
        monkeypatch.setattr(delivery, "speech_store", lambda _: store)
        async def mimo(*args):
            return wav_audio()
        monkeypatch.setattr(PROVIDERS["mimo"], "synthesize", mimo)
        old, _ = await delivery.resolve_speech("mimo", "白桦", "正文", settings)
        async def forbidden(*args):
            pytest.fail("Cached MiMo audio must not synthesize again")
        monkeypatch.setattr(PROVIDERS["mimo"], "synthesize", forbidden)
        monkeypatch.setattr(PROVIDERS["edge"], "synthesize", forbidden)
        new, status = await delivery.resolve_speech("auto", "male", "正文", settings)
        assert status == "hit" and new["object"] == old["object"]
        assert new["sourceKey"] == old["key"] and new["key"] != old["key"]
        assert sum(write["Key"].endswith(".mp3") for write in s3.writes) == 1
    asyncio.run(scenario())


def test_storage_errors_never_trigger_fallback(monkeypatch):
    async def scenario():
        settings = configured()
        s3 = MemoryS3()
        s3.error = OSError("storage offline")
        monkeypatch.setattr(delivery, "speech_store", lambda _: B2SpeechStore(settings, s3))
        async def forbidden(*args):
            pytest.fail("Storage errors must not spend TTS")
        for provider in PROVIDERS.values():
            monkeypatch.setattr(provider, "synthesize", forbidden)
        with pytest.raises(OSError):
            await delivery.resolve_speech("auto", "male", "正文", settings)
    asyncio.run(scenario())


def test_only_two_logical_identities():
    assert delivery.identity("auto", None, "  正文  ") == delivery.identity("auto", "male", "正文")
    assert delivery.identity("auto", "male", "正文")[2] != delivery.identity("auto", "female", "正文")[2]
