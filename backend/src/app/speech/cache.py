"""Bounded, persistent audio cache. Stores hashes/audio, never text or keys.

Shared by users of this API host; containers need a persistent mounted volume.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import sqlite3
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

from ..core.errors import ApiError
from .providers import AudioResult

logger = logging.getLogger("jojo.platform_api.speech")


def audio_cache_key(provider: str, version: str, voice: str, text: str) -> str:
    return hashlib.sha256(json.dumps([provider, version, voice, text], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


class SpeechCache:
    def __init__(self, path: str, max_bytes: int = 2 * 1024**3, ttl_seconds: int = 30 * 86400):
        self.path = Path(path)
        self.max_bytes = max_bytes
        self.ttl_seconds = ttl_seconds
        self.pending: dict[tuple[asyncio.AbstractEventLoop, str], asyncio.Task[AudioResult]] = {}

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=10)
        connection.execute("CREATE TABLE IF NOT EXISTS audio (key TEXT PRIMARY KEY, data BLOB NOT NULL, media_type TEXT NOT NULL, extension TEXT NOT NULL, created REAL NOT NULL, accessed REAL NOT NULL)")
        return connection

    def get(self, key: str) -> AudioResult | None:
        connection = self._connect()
        try:
            with connection:
                row = connection.execute("SELECT data, media_type, extension, created FROM audio WHERE key = ?", (key,)).fetchone()
                if row is None:
                    return None
                if row[3] < time.time() - self.ttl_seconds or not row[0] or (row[1], row[2]) not in {("audio/mpeg", "mp3"), ("audio/wav", "wav")}:
                    connection.execute("DELETE FROM audio WHERE key = ?", (key,))
                    return None
                connection.execute("UPDATE audio SET accessed = ? WHERE key = ?", (time.time(), key))
                return AudioResult(row[0], row[1], row[2])
        finally:
            connection.close()

    def put(self, key: str, audio: AudioResult) -> None:
        if not audio.data or len(audio.data) > self.max_bytes:
            return
        connection = self._connect()
        try:
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute("DELETE FROM audio WHERE created < ? OR key = ?", (time.time() - self.ttl_seconds, key))
                total = connection.execute("SELECT COALESCE(SUM(length(data)), 0) FROM audio").fetchone()[0]
                for old_key, size in connection.execute("SELECT key, length(data) FROM audio ORDER BY accessed ASC").fetchall():
                    if total + len(audio.data) <= self.max_bytes:
                        break
                    connection.execute("DELETE FROM audio WHERE key = ?", (old_key,))
                    total -= size
                connection.execute("INSERT INTO audio VALUES (?, ?, ?, ?, ?, ?)", (key, audio.data, audio.media_type, audio.extension, time.time(), time.time()))
        finally:
            connection.close()

    async def resolve(self, key: str, synthesize: Callable[[], Awaitable[AudioResult]]) -> tuple[AudioResult, str]:
        async def read() -> AudioResult | None:
            try:
                return await asyncio.to_thread(self.get, key)
            except (OSError, sqlite3.Error):
                logger.warning("Speech cache read unavailable")
                return None

        if cached := await read():
            return cached, "hit"
        pending_key = (asyncio.get_running_loop(), key)
        if task := self.pending.get(pending_key):
            return await asyncio.shield(task), "shared"
        if len(self.pending) >= 128:
            raise ApiError(429, "speech_rate_limited", "听读请求较多，请稍后再试")

        async def generate() -> AudioResult:
            if cached := await read():
                return cached
            audio = await synthesize()
            try:
                await asyncio.to_thread(self.put, key, audio)
            except (OSError, sqlite3.Error):
                logger.warning("Speech cache write unavailable")
            return audio

        task = asyncio.create_task(generate())
        self.pending[pending_key] = task

        def finish(completed: asyncio.Task[AudioResult]) -> None:
            self.pending.pop(pending_key, None)
            if not completed.cancelled():
                completed.exception()  # Observe failures even after all clients disconnect.

        task.add_done_callback(finish)
        return await asyncio.shield(task), "miss"
