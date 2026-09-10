import asyncio
import base64
import json
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.errors import ApiError, SpeechServiceError
from app.main import app
from app.speech import delivery, streaming
from app.speech.encoding import PcmMp3Encoder, encode_delivery
from app.speech.key_pool import key_pool
from app.speech.providers import AudioResult, MimoProvider, PooledMimoProvider, PROVIDERS
from app.speech.storage import B2SpeechStore
from test_speech_delivery import MemoryS3, configured, wav_audio


def event(audio=b"", finish=None):
    return b"data: " + json.dumps({"choices": [{"delta": {"audio": {"data": base64.b64encode(audio).decode()}},
                                               "finish_reason": finish}]}).encode() + b"\r\n\r\n"


class Parts(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data = data

    async def __aiter__(self):
        for index in range(0, len(self.data), 11):
            yield self.data[index:index + 11]


def test_sse_boundaries_pcm_contract_and_finish():
    raw = b"\x01\x02" * 100
    def upstream(request):
        payload = json.loads(request.content)
        assert payload["stream"] is True and payload["audio"] == {"format": "pcm16", "voice": "白桦"}
        assert payload["messages"][-1] == {"role": "assistant", "content": "正文"}
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"},
                              stream=Parts(b": keepalive\r\n\r\n" + event(raw) + event(finish="stop") + b"data: [DONE]\r\n\r\n"))
    async def run():
        return b"".join([chunk async for chunk in MimoProvider(httpx.MockTransport(upstream)).stream("正文", "白桦", configured())])
    assert asyncio.run(run()) == raw


@pytest.mark.parametrize("ending", [b"", event(finish="length"), b'data: {"error":{"message":"upstream-secret"}}\n\n'])
def test_truncated_or_failed_sse_is_not_success(ending):
    provider = MimoProvider(httpx.MockTransport(lambda _: httpx.Response(200, headers={"Content-Type": "text/event-stream"},
                                                                        content=event(b"\0\0" * 100) + ending)))
    async def run():
        return [chunk async for chunk in provider.stream("正文", "白桦", configured())]
    with pytest.raises(SpeechServiceError) as error:
        asyncio.run(run())
    assert "upstream-secret" not in str(error.value)


def test_stream_size_bound_before_base64_allocation():
    provider = MimoProvider(httpx.MockTransport(lambda _: httpx.Response(200, headers={"Content-Type": "text/event-stream"},
                                                                        stream=Parts(b"data: " + b"a" * 1000))), max_response_bytes=100)
    async def run():
        return [chunk async for chunk in provider.stream("正文", "白桦", configured())]
    with pytest.raises(SpeechServiceError, match="音频过大"):
        asyncio.run(run())


def test_stream_key_failover_before_audio_only(monkeypatch):
    key_pool.cache_clear()
    monkeypatch.setattr("app.speech.key_pool.secrets.randbelow", lambda _: 0)
    used = []
    def upstream(request):
        used.append(request.headers["api-key"])
        if used[-1] == "bad":
            return httpx.Response(429, headers={"Retry-After": "90"})
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, content=event(b"\0\0" * 100) + event(finish="stop"))
    provider = PooledMimoProvider(httpx.MockTransport(upstream))
    async def run():
        return [chunk async for chunk in provider.stream("正文", "白桦", replace(configured(), mimo_api_keys=("bad", "good")))]
    assert asyncio.run(run()) and used == ["bad", "good"]


def test_incremental_encoding_handles_split_samples_and_rejects_truncation():
    encoder = PcmMp3Encoder()
    raw = b"\x01\x00" * 24000
    output = b"".join(encoder.encode(raw[index:index + 317]) for index in range(0, len(raw), 317)) + encoder.finish()
    audio = encode_delivery(AudioResult(output, "audio/mpeg", "mp3"))
    assert 1 <= audio.duration < 1.2
    broken = PcmMp3Encoder()
    broken.encode(b"\0")
    with pytest.raises(ValueError, match="Incomplete"):
        broken.finish()


@pytest.fixture
def store(monkeypatch):
    value = B2SpeechStore(configured(), MemoryS3())
    monkeypatch.setattr(delivery, "speech_store", lambda _: value)
    return value


def test_first_mp3_precedes_completion_concurrent_readers_and_legacy_request_share_cache(monkeypatch, store):
    async def run():
        release = asyncio.Event()
        calls = 0
        async def upstream(*args):
            nonlocal calls
            calls += 1
            yield b"\0\0" * 24000
            await release.wait()
            yield b"\0\0" * 24000
        monkeypatch.setattr(PROVIDERS["mimo"], "stream", upstream)
        first = streaming.stream_audio("auto", "male", "正文", configured(), scope="book")
        prefix = await asyncio.wait_for(anext(first), 2)
        assert isinstance(prefix, bytes) and prefix and not store.client.writes
        second = streaming.stream_audio("auto", "male", "正文", configured(), scope="book")
        assert await asyncio.wait_for(anext(second), 2) == prefix
        legacy = asyncio.create_task(delivery.resolve_speech("mimo", "白桦", "正文", configured()))
        await asyncio.sleep(0)
        release.set()
        a = prefix + b"".join([chunk async for chunk in first])
        b = prefix + b"".join([chunk async for chunk in second])
        result, status = await legacy
        assert calls == 1 and a == b and status == "shared"
        assert result["bytes"] == len(a)
        assert store.client.objects[result["object"]] == a
        cached = [chunk async for chunk in streaming.stream_audio("auto", "male", "正文", replace(configured(), tts_enabled=False), scope="book")]
        assert len(cached) == 1 and cached[0]["url"] == result["url"]
        assert not streaming._streams and not delivery._pending
    asyncio.run(run())


def test_disconnect_one_listener_preserves_the_other(monkeypatch, store):
    async def run():
        release = asyncio.Event()
        async def upstream(*args):
            yield b"\0\0" * 24000
            await release.wait()
            yield b"\0\0" * 24000
        monkeypatch.setattr(PROVIDERS["mimo"], "stream", upstream)
        first = streaming.stream_audio("auto", "male", "正文", configured(), scope="book")
        second = streaming.stream_audio("auto", "male", "正文", configured(), scope="book")
        await anext(first)
        prefix = await anext(second)
        await first.aclose()
        release.set()
        assert len(prefix + b"".join([chunk async for chunk in second])) > len(prefix)
        assert len(store.client.writes) == 3
    asyncio.run(run())


@pytest.mark.parametrize("after_audio", [False, True])
def test_fallback_only_before_audio_and_incomplete_audio_never_cached(monkeypatch, store, after_audio):
    edge_calls = []
    async def upstream(*args):
        if after_audio:
            yield b"\0\0" * 24000
        raise SpeechServiceError("upstream-secret")
    async def edge(*args):
        edge_calls.append(True)
        return AudioResult(encode_delivery(wav_audio()).data, "audio/mpeg", "mp3")
    monkeypatch.setattr(PROVIDERS["mimo"], "stream", upstream)
    monkeypatch.setattr(PROVIDERS["edge"], "synthesize", edge)
    async def run():
        return [chunk async for chunk in streaming.stream_audio("auto", "male", "正文", configured(), scope="book")]
    if after_audio:
        with pytest.raises(SpeechServiceError):
            asyncio.run(run())
        assert not edge_calls and not store.client.writes
    else:
        assert asyncio.run(run())[0]["provider"] == "edge" and edge_calls == [True]


def test_ticket_is_encrypted_expiring_and_no_synthesis_until_media_get(monkeypatch, store):
    calls = []
    async def upstream(*args):
        calls.append(True)
        yield b"\0\0" * 24000
    monkeypatch.setattr(PROVIDERS["mimo"], "stream", upstream)
    app.dependency_overrides[get_settings] = configured
    try:
        with TestClient(app) as client:
            response = client.post("/v1/speech?stream=true", json={"text": "私有正文", "voice": "male"})
            ticket = response.json()["ticket"]
            assert not calls and not store.client.writes
            assert b"private" not in base64.urlsafe_b64decode(ticket) and "私有正文" not in response.text and "secret" not in response.text
            assert streaming.read_ticket(ticket, configured())["text"] == "私有正文"
            assert client.get("/v1/speech/stream", params={"ticket": ticket[:-8] + "abcdefgh"}).status_code == 410
            audio = client.get("/v1/speech/stream", params={"ticket": ticket})
            assert audio.status_code == 200 and audio.headers["content-type"] == "audio/mpeg"
            assert audio.headers["x-accel-buffering"] == "no" and "content-length" not in audio.headers
            assert encode_delivery(AudioResult(audio.content, "audio/mpeg", "mp3")).duration > 0
            assert client.get("/v1/speech/stream", params={"ticket": ticket}, follow_redirects=False).status_code == 307
            assert calls == [True]
        expired = streaming.ticket_cipher(configured()).encrypt_at_time(b'{}', 1).decode()
        with pytest.raises(ApiError):
            streaming.read_ticket(expired, configured())
    finally:
        app.dependency_overrides.clear()
