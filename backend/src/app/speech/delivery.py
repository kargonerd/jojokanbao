"""One synthesis/cache path for web requests and offline book preparation."""
from __future__ import annotations

import asyncio
import sqlite3
from functools import lru_cache

from ..core.config import Settings
from ..core.errors import ApiError, SpeechUnavailableError
from .cache import SpeechCache, audio_cache_key
from .encoding import DELIVERY_VERSION, encode_delivery
from .providers import PROVIDERS, AudioResult
from .storage import B2SpeechStore

_pending: dict[tuple[asyncio.AbstractEventLoop, Settings, str], asyncio.Task] = {}


@lru_cache(maxsize=4)
def synthesis_slots(loop: asyncio.AbstractEventLoop) -> asyncio.Semaphore:
    return asyncio.Semaphore(2)


@lru_cache(maxsize=8)
def speech_cache(path: str) -> SpeechCache:
    return SpeechCache(path)


@lru_cache(maxsize=4)
def speech_store(settings: Settings) -> B2SpeechStore:
    return B2SpeechStore(settings)


def delivery_version(provider: str) -> str:
    return f"{PROVIDERS[provider].cache_version}:{DELIVERY_VERSION}"


def identity(provider_id: str, voice: str | None, text: str) -> tuple[str, str, str]:
    provider = PROVIDERS.get(provider_id)
    if not provider:
        raise ApiError(422, "invalid_request", "不支持的语音服务商")
    voice = voice or provider.voices[0].id
    if voice not in {option.id for option in provider.voices}:
        raise ApiError(422, "invalid_request", "当前服务商不支持这个声音，请重新选择")
    text = " ".join(text.split())
    if not text or len(text) > 600:
        raise ApiError(422, "invalid_request", "朗读文本需为 1–600 字")
    return voice, text, audio_cache_key(provider_id, delivery_version(provider_id), voice, text)


async def resolve_speech(provider_id: str, voice: str | None, text: str, settings: Settings) -> tuple[AudioResult | dict, str]:
    voice, text, key = identity(provider_id, voice, text)
    provider = PROVIDERS[provider_id]
    store = speech_store(settings) if settings.speech_storage == "b2" else None
    # Cached audio remains usable even if the provider is disabled or loses its key.
    if store and (cached := await asyncio.to_thread(store.get, provider_id, key)):
        return cached, "hit"
    if not store and settings.speech_cache_path:
        # Preserve the development cache's hit/miss response contract.
        raw_key = audio_cache_key(provider_id, provider.cache_version, voice, text)
        try:
            if cached_audio := await asyncio.to_thread(speech_cache(settings.speech_cache_path).get, raw_key):
                return cached_audio, "hit"
        except (OSError, sqlite3.Error):
            pass

    async def synthesize() -> AudioResult:
        if not provider.available(settings):
            raise SpeechUnavailableError("这段内容尚无此声音的音频，暂时无法生成，请切换其他声音")
        return await provider.synthesize(text, voice, settings)

    pending_key = (asyncio.get_running_loop(), settings, key)
    if task := _pending.get(pending_key):
        return await asyncio.shield(task), "shared"
    if len(_pending) >= 32:
        raise ApiError(429, "speech_rate_limited", "听读请求较多，请稍后再试")

    async def generate():
        slots = synthesis_slots(asyncio.get_running_loop())
        try:
            await asyncio.wait_for(slots.acquire(), timeout=2)
        except asyncio.TimeoutError as error:
            raise ApiError(429, "speech_rate_limited", "听读请求较多，请稍后再试") from error
        try:
            if store and (cached := await asyncio.to_thread(store.get, provider_id, key)):
                return cached
            # Local SQLite is only a development fallback; B2 mode writes no audio to disk.
            if not store and settings.speech_cache_path:
                raw_key = audio_cache_key(provider_id, provider.cache_version, voice, text)
                audio, _ = await speech_cache(settings.speech_cache_path).resolve(raw_key, synthesize)
            else:
                audio = await synthesize()
            if not store:
                return audio
            encoded = await asyncio.to_thread(encode_delivery, audio)
            return await asyncio.to_thread(store.put, provider_id, key, encoded)
        finally:
            slots.release()

    task = asyncio.create_task(generate())
    _pending[pending_key] = task

    def finish(completed: asyncio.Task) -> None:
        _pending.pop(pending_key, None)
        if not completed.cancelled():
            completed.exception()

    task.add_done_callback(finish)
    return await asyncio.shield(task), "miss" if store or settings.speech_cache_path else "disabled"
