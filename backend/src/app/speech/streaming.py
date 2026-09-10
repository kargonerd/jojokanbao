"""Progressive MP3 delivery. Existing complete audio keeps its original cache key."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from cryptography.fernet import Fernet, InvalidToken

from ..core.config import Settings
from ..core.errors import ApiError, SpeechServiceError
from . import delivery
from .encoding import PcmMp3Encoder, encode_delivery
from .providers import AudioResult, PROVIDERS
from .voices import VOICES

logger = logging.getLogger("jojo.platform_api.speech")
TICKET_TTL = 900


def available(settings: Settings) -> bool:
    return bool(settings.speech_storage == "b2" and settings.speech_s3_application_key
                and PROVIDERS["mimo"].available(settings))


def ticket_cipher(settings: Settings) -> Fernet:
    # Reuse an existing server credential with purpose separation. The media URL
    # carries neither plaintext book text nor vendor/storage credentials. No
    # instance-local session: the POST and media GET may reach different workers.
    secret = settings.speech_s3_application_key
    if not secret:
        raise SpeechServiceError("流式听读暂时不可用")
    key = hashlib.sha256(b"jojo-speech-stream-ticket-v1\0" + secret.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def issue_ticket(provider: str, voice: str | None, text: str, scope: str, settings: Settings) -> dict:
    voice, text, _ = delivery.identity(provider, voice, text)
    if provider not in {"auto", "mimo"} or scope not in {"book", "news"}:
        raise ApiError(422, "invalid_request", "不支持的流式听读请求")
    body = json.dumps(dict(provider=provider, voice=voice, text=text, scope=scope), ensure_ascii=False).encode()
    token = ticket_cipher(settings).encrypt(body).decode()
    return {"formatVersion": "jojo-speech-stream/1", "ticket": token, "expiresAt": int(time.time()) + TICKET_TTL}


def read_ticket(token: str, settings: Settings) -> dict:
    try:
        return json.loads(ticket_cipher(settings).decrypt(token.encode(), ttl=TICKET_TTL))
    except (InvalidToken, ValueError, TypeError) as error:
        raise ApiError(410, "speech_stream_expired", "音频地址已过期，请重新播放") from error


@dataclass
class LiveAudio:
    chunks: list[bytes] = field(default_factory=list)
    changed: asyncio.Condition = field(default_factory=asyncio.Condition)
    task: asyncio.Task | None = None
    done: bool = False

    async def append(self, chunk: bytes) -> None:
        if chunk:
            async with self.changed:
                self.chunks.append(chunk)
                self.changed.notify_all()

    async def read(self) -> AsyncIterator[bytes]:
        cursor = 0
        while True:
            async with self.changed:
                await self.changed.wait_for(lambda: cursor < len(self.chunks) or self.done)
                if cursor < len(self.chunks):
                    chunk = self.chunks[cursor]
                    cursor += 1
                else:
                    break
            yield chunk
        assert self.task is not None
        # Propagate truncated upstream streams, never treat them as a complete
        # segment. Disconnecting one listener doesn't cancel another listener.
        await asyncio.shield(self.task)


_streams: dict[tuple, LiveAudio] = {}


async def stream_audio(provider_id: str, voice: str | None, text: str, settings: Settings, *, scope: str) -> AsyncIterator[bytes | dict]:
    voice, text, key = delivery.identity(provider_id, voice, text)
    store = delivery.scoped_store(settings, scope)
    if not store:
        raise SpeechServiceError("流式听读需要云端音频存储")
    if cached := await delivery.run_blocking(store.get, provider_id, key):
        yield cached
        return
    physical_voice = VOICES[voice]["mimo"] if provider_id == "auto" else voice
    _, _, physical_key = delivery.identity("mimo", physical_voice, text)
    if provider_id == "auto" and (cached := await delivery.run_blocking(store.get, "mimo", physical_key)):
        yield await delivery.run_blocking(store.alias, key, voice, "mimo", cached)
        return
    loop = asyncio.get_running_loop()
    pending_key = (loop, settings, f"{scope}:{physical_key}")
    live = _streams.get(pending_key)
    if live is None and (existing := delivery._pending.get(pending_key)):
        try:
            result = await asyncio.shield(existing)
        except delivery._ProviderFailure as error:
            raise error.cause from None
        yield result
        return
    if live is None:
        if not available(settings):
            raise SpeechServiceError("流式听读暂时不可用")
        if len(delivery._pending) >= 32:
            raise ApiError(429, "speech_rate_limited", "听读请求较多，请稍后再试")
        live = LiveAudio()
        _streams[pending_key] = live

        async def generate():
            slots = delivery.synthesis_slots(loop)
            try:
                await asyncio.wait_for(slots.acquire(), timeout=2)
            except asyncio.TimeoutError as error:
                raise ApiError(429, "speech_rate_limited", "听读请求较多，请稍后再试") from error
            started = time.monotonic()
            try:
                encoder = PcmMp3Encoder()
                try:
                    async for pcm in PROVIDERS["mimo"].stream(text, physical_voice, settings):
                        encoded = await delivery.run_blocking(encoder.encode, pcm)
                        if encoded and not live.chunks:
                            logger.info("Speech stream first_audio_ms=%d", (time.monotonic() - started) * 1000)
                        await live.append(encoded)
                    await live.append(await delivery.run_blocking(encoder.finish))
                except Exception as error:
                    raise delivery._ProviderFailure(error) from None
                audio = AudioResult(b"".join(live.chunks), "audio/mpeg", "mp3")
                encoded = await delivery.run_blocking(encode_delivery, audio)
                result = await delivery.run_blocking(store.put, "mimo", physical_key, encoded)
                if provider_id == "auto":
                    await delivery.run_blocking(store.alias, key, voice, "mimo", result)
                logger.info("Speech stream complete_ms=%d duration=%.3f", (time.monotonic() - started) * 1000, encoded.duration)
                return result
            finally:
                slots.release()

        async def bounded_generate():
            try:
                return await asyncio.wait_for(generate(), timeout=105)
            finally:
                async with live.changed:
                    live.done = True
                    live.changed.notify_all()

        live.task = asyncio.create_task(bounded_generate())
        delivery._pending[pending_key] = live.task

        def finish(task: asyncio.Task) -> None:
            _streams.pop(pending_key, None)
            delivery._pending.pop(pending_key, None)
            if not task.cancelled():
                task.exception()

        live.task.add_done_callback(finish)

    emitted = False
    try:
        async for chunk in live.read():
            emitted = True
            yield chunk
    except delivery._ProviderFailure as error:
        if emitted or provider_id != "auto":
            raise SpeechServiceError("音频生成中断，请重试") from None
        # Only fail over before any bytes were sent. Keep the existing Edge
        # fallback and logical alias; never splice two voices in one segment.
        result, _ = await delivery.resolve_speech("edge", VOICES[voice]["edge"], text, settings, scope=scope)
        yield await delivery.run_blocking(store.alias, key, voice, "edge", result)
    except ApiError:
        raise
    except Exception:
        logger.warning("Speech stream failed after_audio=%s", emitted)
        raise SpeechServiceError("音频生成中断，请重试") from None
