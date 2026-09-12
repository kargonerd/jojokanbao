"""Provider adapters. Credentials and vendor response formats stay on the server."""
from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator, Callable
from contextlib import aclosing
from dataclasses import dataclass, replace
from typing import Protocol, TypeVar

import httpx

from ..core.config import Settings
from ..core.errors import ApiError, SpeechServiceError
from .service import synthesize_audio
from .key_pool import key_pool, retry_after

T = TypeVar("T")
MIMO_INSTRUCTION = "请用自然、平稳的普通话朗读，忠实读出原文，不增加解说。"


@dataclass(frozen=True)
class Voice:
    id: str
    label: str
    description: str


@dataclass(frozen=True)
class AudioResult:
    data: bytes
    media_type: str
    extension: str


class SpeechProvider(Protocol):
    id: str
    cache_version: str
    label: str
    description: str
    voices: tuple[Voice, ...]

    def available(self, settings: Settings) -> bool: ...
    async def synthesize(self, text: str, voice: str, settings: Settings) -> AudioResult: ...


class EdgeProvider:
    id = "edge"
    cache_version = "edge-neural-mp3-v1"
    label = "Microsoft Edge"
    description = "在线朗读 · 非正式接口"
    voices = (
        Voice("zh-CN-XiaoxiaoNeural", "晓晓", "普通话女声"),
        Voice("zh-CN-YunyangNeural", "云扬", "新闻男声"),
    )

    def available(self, settings: Settings) -> bool:
        return True

    async def synthesize(self, text: str, voice: str, settings: Settings) -> AudioResult:
        return AudioResult(await synthesize_audio(text, voice), "audio/mpeg", "mp3")


class MimoUpstreamError(ApiError):
    """Internal status for failover; never retain upstream bodies or credentials."""

    def __init__(self, status: int, delay: float = 60):
        super().__init__(429 if status == 429 else 502,
                         "speech_rate_limited" if status == 429 else "speech_service_unavailable",
                         "声音服务繁忙，请稍后重试" if status == 429 else "这个声音暂不可用，请稍后重试或切换其他声音")
        self.upstream_status = status
        self.retry_delay = delay


class MimoProvider:
    id = "mimo"
    # Voice/model/instruction identity. Streaming PCM and buffered WAV use the
    # same PCM16 speech and MP3 delivery settings, so existing audio stays valid.
    cache_version = "mimo-v2.5-tts-wav-neutral-v1"
    label = "小米 MiMo"
    description = "MiMo-V2.5-TTS · 精品音色"
    voices = (
        Voice("冰糖", "冰糖", "普通话女声"),
        Voice("白桦", "白桦", "普通话男声"),
    )

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None, *,
                 max_response_bytes: int | None = 16 * 1024 * 1024) -> None:
        self.transport = transport
        # Only the standalone offline tool opts out. Never read this from an API request.
        self.max_response_bytes = max_response_bytes

    def available(self, settings: Settings) -> bool:
        return bool(settings.mimo_api_key)

    async def synthesize(self, text: str, voice: str, settings: Settings) -> AudioResult:
        async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=10), transport=self.transport) as client:
            async with client.stream("POST",
                "https://api.xiaomimimo.com/v1/chat/completions",
                headers={"api-key": settings.mimo_api_key or ""},
                json={
                    "model": "mimo-v2.5-tts",
                    # MiMo requires spoken text in the assistant message, not user.
                    "messages": [
                        {"role": "user", "content": MIMO_INSTRUCTION},
                        {"role": "assistant", "content": text},
                    ],
                    "audio": {"format": "wav", "voice": voice},
                },
            ) as response:
                # Bound the HTTP body before JSON/Base64 allocation. Provider errors
                # are classified below without returning their potentially sensitive text.
                payload = bytearray()
                async for chunk in response.aiter_bytes():
                    if self.max_response_bytes is not None and len(payload) + len(chunk) > self.max_response_bytes:
                        raise SpeechServiceError("音频过大，请缩短朗读内容")
                    payload.extend(chunk)
        # Do not return upstream errors: they may contain credentials or input text.
        if response.status_code in {401, 403, 429}:
            raise MimoUpstreamError(response.status_code, retry_after(response.headers.get("Retry-After")))
        response.raise_for_status()
        try:
            encoded = json.loads(payload)["choices"][0]["message"]["audio"]["data"]
            if not isinstance(encoded, str):
                raise ValueError("Invalid audio payload")
            data = base64.b64decode(encoded, validate=True)
            if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
                raise ValueError("Invalid WAV payload")
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise SpeechServiceError("未收到有效音频，请重试或切换其他声音") from error
        return AudioResult(data, "audio/wav", "wav")

    async def stream(self, text: str, voice: str, settings: Settings) -> AsyncIterator[bytes]:
        """MiMo streaming contract: SSE containing 24 kHz mono PCM16LE chunks."""
        received = 0
        audio_bytes = 0
        stopped = False
        line_buffer = bytearray()
        event: list[bytes] = []
        async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=10), transport=self.transport) as client:
            async with client.stream("POST", "https://api.xiaomimimo.com/v1/chat/completions",
                headers={"api-key": settings.mimo_api_key or ""},
                json={"model": "mimo-v2.5-tts", "stream": True,
                      "messages": [{"role": "user", "content": MIMO_INSTRUCTION},
                                   {"role": "assistant", "content": text}],
                      "audio": {"format": "pcm16", "voice": voice}},
            ) as response:
                if response.status_code != 200:
                    raise MimoUpstreamError(response.status_code, retry_after(response.headers.get("Retry-After")))
                if not response.headers.get("content-type", "").startswith("text/event-stream"):
                    raise SpeechServiceError("未收到有效音频，请重试或切换其他声音")
                async for chunk in response.aiter_bytes():
                    received += len(chunk)
                    if received > (self.max_response_bytes or 16 * 1024 * 1024):
                        raise SpeechServiceError("音频过大，请缩短朗读内容")
                    line_buffer.extend(chunk)
                    while b"\n" in line_buffer:
                        line, _, rest = line_buffer.partition(b"\n")
                        line_buffer = bytearray(rest)
                        line = line.rstrip(b"\r")
                        if line.startswith(b"data:"):
                            event.append(bytes(line[5:]).lstrip(b" "))
                        if line or not event:
                            continue
                        payload = b"\n".join(event)
                        event.clear()
                        if payload == b"[DONE]":
                            if not stopped or not audio_bytes:
                                raise SpeechServiceError("音频生成中断，请重试")
                            return
                        try:
                            message = json.loads(payload)
                            if "error" in message:
                                raise ValueError("Upstream stream error")
                            for choice in message.get("choices", []):
                                audio = choice.get("delta", {}).get("audio") or {}
                                encoded = audio.get("data")
                                if encoded:
                                    if stopped or not isinstance(encoded, str):
                                        raise ValueError("Invalid audio chunk")
                                    data = base64.b64decode(encoded, validate=True)
                                    audio_bytes += len(data)
                                    if data:
                                        yield data
                                finish = choice.get("finish_reason")
                                if finish:
                                    if finish != "stop":
                                        raise ValueError("Incomplete synthesis")
                                    stopped = True
                        except (KeyError, TypeError, ValueError, AttributeError) as error:
                            raise SpeechServiceError("音频生成中断，请重试") from error
        if not stopped or not audio_bytes or line_buffer or event:
            raise SpeechServiceError("音频生成中断，请重试")


class PooledMimoProvider(MimoProvider):
    """Online only. Offline tools retain the single-key adapter and their own budgets."""

    def available(self, settings: Settings) -> bool:
        return bool(settings.mimo_keys)

    async def synthesize(self, text: str, voice: str, settings: Settings) -> AudioResult:
        async def generate(selected: Settings) -> AsyncIterator[AudioResult]:
            yield await MimoProvider.synthesize(self, text, voice, selected)
        async with aclosing(self._with_keys(settings, generate)) as results:
            async for result in results:
                return result
        raise SpeechServiceError("未收到有效音频，请重试")

    async def stream(self, text: str, voice: str, settings: Settings) -> AsyncIterator[bytes]:
        async with aclosing(self._with_keys(settings, lambda selected: MimoProvider.stream(self, text, voice, selected))) as chunks:
            async for chunk in chunks:
                yield chunk

    async def _with_keys(self, settings: Settings, generate: Callable[[Settings], AsyncIterator[T]]) -> AsyncIterator[T]:
        pool = key_pool(settings.mimo_keys)
        attempted: set[int] = set()
        last_error: ApiError = ApiError(429, "speech_rate_limited", "声音服务繁忙，请稍后重试")
        # Bound latency and upstream work; callers retain existing error handling.
        for _ in range(min(3, len(settings.mimo_keys))):
            selected = pool.acquire(attempted)
            if selected is None:
                break
            index, key = selected
            attempted.add(index)
            emitted = False
            try:
                async with aclosing(generate(replace(settings, mimo_api_key=key, mimo_api_keys=()))) as results:
                    async for result in results:
                        emitted = True
                        yield result
                return
            except (MimoUpstreamError, httpx.HTTPStatusError) as error:
                status = error.upstream_status if isinstance(error, MimoUpstreamError) else error.response.status_code
                failure = error if isinstance(error, MimoUpstreamError) else MimoUpstreamError(status)
                if emitted:
                    raise failure from None
                if status not in {401, 403, 429} and status < 500:
                    raise failure from None
                pool.defer(index, failure.retry_delay if status == 429 else 300 if status in {401, 403} else 10)
                last_error = failure
            except httpx.TransportError:
                # An ambiguous timeout may already have generated audio: don't
                # multiply the same synthesis across keys on a network failure.
                pool.defer(index, 10)
                raise SpeechServiceError("声音服务连接中断，请稍后重试") from None
            finally:
                pool.release(index)
        raise last_error


PROVIDERS: dict[str, SpeechProvider] = {provider.id: provider for provider in (EdgeProvider(), PooledMimoProvider())}
