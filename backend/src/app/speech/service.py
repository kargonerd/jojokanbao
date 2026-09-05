from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

import edge_tts


SYNTHESIS_TIMEOUT_SECONDS = 25.0


async def _collect_audio(text: str, voice: str) -> bytes:
    audio = bytearray()
    communicate = edge_tts.Communicate(text=text, voice=voice)
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            if len(audio) + len(chunk["data"]) > 12 * 1024 * 1024:
                raise ValueError("Speech audio exceeds size limit")
            audio.extend(chunk["data"])
    if not audio:
        raise RuntimeError("Speech provider returned no audio")
    return bytes(audio)


async def synthesize_audio(
    text: str,
    voice: str,
    *,
    collector: Callable[[str, str], Awaitable[bytes]] = _collect_audio,
) -> bytes:
    return await asyncio.wait_for(collector(text, voice), timeout=SYNTHESIS_TIMEOUT_SECONDS)
