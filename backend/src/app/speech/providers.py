"""Provider adapters. Credentials and vendor response formats stay on the server."""
from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Protocol

import httpx

from ..core.config import Settings
from ..core.errors import ApiError, SpeechServiceError
from .service import synthesize_audio


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
        Voice("zh-CN-YunxiNeural", "云希", "普通话男声"),
        Voice("zh-CN-YunyangNeural", "云扬", "新闻男声"),
    )

    def available(self, settings: Settings) -> bool:
        return settings.edge_tts_enabled

    async def synthesize(self, text: str, voice: str, settings: Settings) -> AudioResult:
        return AudioResult(await synthesize_audio(text, voice), "audio/mpeg", "mp3")


class MimoProvider:
    id = "mimo"
    # Bump whenever the model, instruction, or audio format changes.
    cache_version = "mimo-v2.5-tts-wav-neutral-v1"
    label = "小米 MiMo"
    description = "MiMo-V2.5-TTS · 精品音色"
    voices = (
        Voice("冰糖", "冰糖", "普通话女声"),
        Voice("茉莉", "茉莉", "普通话女声"),
        Voice("苏打", "苏打", "普通话男声"),
        Voice("白桦", "白桦", "普通话男声"),
    )

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.transport = transport

    def available(self, settings: Settings) -> bool:
        return bool(settings.mimo_tts_enabled and settings.mimo_api_key)

    async def synthesize(self, text: str, voice: str, settings: Settings) -> AudioResult:
        async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=10), transport=self.transport) as client:
            async with client.stream("POST",
                "https://api.xiaomimimo.com/v1/chat/completions",
                headers={"api-key": settings.mimo_api_key or ""},
                json={
                    "model": "mimo-v2.5-tts",
                    # MiMo requires spoken text in the assistant message, not user.
                    "messages": [
                        {"role": "user", "content": "请用自然、平稳的普通话朗读，忠实读出原文，不增加解说。"},
                        {"role": "assistant", "content": text},
                    ],
                    "audio": {"format": "wav", "voice": voice},
                },
            ) as response:
                # Bound the HTTP body before JSON/Base64 allocation. Provider errors
                # are classified below without returning their potentially sensitive text.
                payload = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(payload) + len(chunk) > 16 * 1024 * 1024:
                        raise SpeechServiceError("音频过大，请缩短朗读内容")
                    payload.extend(chunk)
        # Do not return upstream errors: they may contain credentials or input text.
        if response.status_code == 429:
            raise ApiError(429, "speech_rate_limited", "声音服务繁忙，请稍后重试")
        if response.status_code in {401, 403}:
            raise SpeechServiceError("这个声音暂不可用，请稍后重试或切换其他声音")
        response.raise_for_status()
        try:
            encoded = json.loads(payload)["choices"][0]["message"]["audio"]["data"]
            if not isinstance(encoded, str) or len(encoded) > 32 * 1024 * 1024:
                raise ValueError("Invalid audio payload")
            data = base64.b64decode(encoded, validate=True)
            if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
                raise ValueError("Invalid WAV payload")
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise SpeechServiceError("未收到有效音频，请重试或切换其他声音") from error
        return AudioResult(data, "audio/wav", "wav")


PROVIDERS: dict[str, SpeechProvider] = {provider.id: provider for provider in (EdgeProvider(), MimoProvider())}
