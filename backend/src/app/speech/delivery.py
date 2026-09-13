"""One synthesis/cache path for web requests and offline book preparation."""
from __future__ import annotations

import asyncio
import sqlite3
from functools import lru_cache, partial
from contextvars import ContextVar, copy_context
from concurrent.futures import ThreadPoolExecutor

from ..core.config import Settings
from ..core.errors import ApiError, SpeechUnavailableError
from .cache import SpeechCache, audio_cache_key
from .encoding import DELIVERY_VERSION, MAX_AUDIO_BYTES, encode_delivery
from .providers import PROVIDERS, AudioResult
from .storage import B2SpeechStore
from .voices import VOICES, VOICE_VERSION

_pending: dict[tuple[asyncio.AbstractEventLoop, Settings, str], asyncio.Task] = {}
offline_synthesis_slots: ContextVar[asyncio.Semaphore | None] = ContextVar("offline_synthesis_slots", default=None)
offline_pending_limit: ContextVar[int] = ContextVar("offline_pending_limit", default=32)
offline_blocking_pool: ContextVar[ThreadPoolExecutor | None] = ContextVar("offline_blocking_pool", default=None)


async def run_blocking(func, /, *args, **kwargs):
    pool = offline_blocking_pool.get()
    if pool is None:
        return await asyncio.to_thread(func, *args, **kwargs)
    call = partial(copy_context().run, func, *args, **kwargs)
    call.stage = getattr(func, "__name__", "blocking")
    return await asyncio.get_running_loop().run_in_executor(pool, call)


@lru_cache(maxsize=4)
def synthesis_slots(loop: asyncio.AbstractEventLoop) -> asyncio.Semaphore:
    return asyncio.Semaphore(2)


@lru_cache(maxsize=8)
def speech_cache(path: str, ttl_seconds: int = 30 * 86400) -> SpeechCache:
    return SpeechCache(path, ttl_seconds=ttl_seconds)


@lru_cache(maxsize=4)
def speech_store(settings: Settings) -> B2SpeechStore:
    return B2SpeechStore(settings)


@lru_cache(maxsize=4)
def news_speech_store(settings: Settings) -> B2SpeechStore:
    return B2SpeechStore(settings, scope="news")


def scoped_store(settings: Settings, scope: str) -> B2SpeechStore | None:
    if scope not in {"book", "news"}:
        raise ApiError(422, "invalid_request", "不支持的听读内容类型")
    if settings.speech_storage != "b2":
        return None
    return news_speech_store(settings) if scope == "news" else speech_store(settings)


def delivery_version(provider: str) -> str:
    if provider == "auto":
        return VOICE_VERSION
    return f"{PROVIDERS[provider].cache_version}:{DELIVERY_VERSION}"


def identity(provider_id: str, voice: str | None, text: str) -> tuple[str, str, str]:
    if provider_id == "auto":
        voice = voice or "male"
        text = " ".join(text.split())
        if voice not in VOICES or not 0 < len(text) <= 600:
            raise ApiError(422, "invalid_request", "请选择男声或女声，朗读文本需为 1–600 字")
        return voice, text, audio_cache_key("auto", VOICE_VERSION, voice, text)
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


class _ProviderFailure(Exception):
    """Only vendor synthesis failures qualify for fallback, never B2 failures."""

    def __init__(self, cause: Exception):
        self.cause = cause


async def resolve_speech(provider_id: str, voice: str | None, text: str, settings: Settings, *, scope: str = "book") -> tuple[AudioResult | dict, str]:
    try:
        if provider_id != "auto":
            return await _resolve_speech(provider_id, voice, text, settings, scope=scope)
        voice, text, key = identity("auto", voice, text)
        store = scoped_store(settings, scope)
        if store and (cached := await run_blocking(store.get, "auto", key)):
            return cached, "hit"
        # Actual-provider requests keep their old hashes and in-flight coalescing.
        # Offline generation still pins MiMo, so a temporary outage never fills
        # the pre-generated library with the fallback voice.
        provider = "mimo"
        try:
            result, status = await _resolve_speech(provider, VOICES[voice][provider], text, settings, scope=scope)
        except _ProviderFailure:
            provider = "edge"
            result, status = await _resolve_speech(provider, VOICES[voice][provider], text, settings, scope=scope)
        if store:
            result = await run_blocking(store.alias, key, voice, provider, result)
        return result, status
    except _ProviderFailure as error:
        raise error.cause from error


async def _resolve_speech(provider_id: str, voice: str | None, text: str, settings: Settings, *, scope: str = "book") -> tuple[AudioResult | dict, str]:
    voice, text, key = identity(provider_id, voice, text)
    provider = PROVIDERS[provider_id]
    store = scoped_store(settings, scope)
    cache_path = f"{settings.speech_cache_path}.news" if scope == "news" else settings.speech_cache_path
    cache_ttl = 86400 if scope == "news" else 30 * 86400
    # Cached audio remains usable even if the provider is unavailable or loses its key.
    if store and (cached := await run_blocking(store.get, provider_id, key)):
        return cached, "hit"
    if not store and settings.speech_cache_path:
        # Preserve the development cache's hit/miss response contract.
        raw_key = audio_cache_key(provider_id, provider.cache_version, voice, text)
        try:
            if cached_audio := await run_blocking(speech_cache(cache_path, cache_ttl).get, raw_key):
                return cached_audio, "hit"
        except (OSError, sqlite3.Error):
            pass

    async def synthesize() -> AudioResult:
        try:
            if not provider.available(settings):
                raise SpeechUnavailableError("这段内容尚无此声音的音频，暂时无法生成，请切换其他声音")
            return await provider.synthesize(text, voice, settings)
        except Exception as error:
            raise _ProviderFailure(error) from error

    pending_key = (asyncio.get_running_loop(), settings, f"{scope}:{key}")
    if task := _pending.get(pending_key):
        return await asyncio.shield(task), "shared"
    if len(_pending) >= offline_pending_limit.get():
        raise ApiError(429, "speech_rate_limited", "听读请求较多，请稍后再试")

    async def generate():
        slots = offline_synthesis_slots.get() or synthesis_slots(asyncio.get_running_loop())
        try:
            await asyncio.wait_for(slots.acquire(), timeout=2)
        except asyncio.TimeoutError as error:
            raise ApiError(429, "speech_rate_limited", "听读请求较多，请稍后再试") from error
        try:
            if store and (cached := await run_blocking(store.get, provider_id, key)):
                return cached
            # Local SQLite is only a development fallback; B2 mode writes no audio to disk.
            if not store and settings.speech_cache_path:
                raw_key = audio_cache_key(provider_id, provider.cache_version, voice, text)
                audio, _ = await speech_cache(cache_path, cache_ttl).resolve(raw_key, synthesize)
            else:
                audio = await synthesize()
            if not store:
                return audio
            # The offline MiMo adapter opts out of both HTTP and decoded WAV size
            # caps. Online adapters keep their defaults; request payloads cannot opt out.
            max_bytes = None if getattr(provider, "max_response_bytes", 0) is None else MAX_AUDIO_BYTES
            encoded = await run_blocking(encode_delivery, audio, max_bytes=max_bytes)
            return await run_blocking(store.put, provider_id, key, encoded)
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
