"""Durable local MP3 outbox for the manual library job, never the online API."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
from threading import RLock

from app.speech.encoding import EncodedAudio


class AudioOutbox:
    def __init__(self, path: Path, *, max_bytes=20 * 1024**3, reserve_bytes=5 * 1024**3):
        self.path = path
        self.max_bytes, self.reserve_bytes = max_bytes, reserve_bytes
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        # FULL auto-vacuum reclaims confirmed audio space; WAL + FULL makes each
        # staged MP3 atomic and durable without a two-file commit gap.
        self.db.execute("PRAGMA auto_vacuum=FULL")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS audio (
            key TEXT PRIMARY KEY, voice TEXT NOT NULL, data BLOB,
            duration REAL NOT NULL, sha TEXT NOT NULL, size INTEGER NOT NULL,
            record TEXT)""")
        self.db.commit()
        self.pending_count, self.pending_bytes = self.db.execute(
            "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM audio WHERE data IS NOT NULL").fetchone()

    def snapshot(self):
        with self.lock:
            return {"pending": self.pending_count, "pendingBytes": self.pending_bytes,
                    "maxBytes": self.max_bytes, "reserveBytes": self.reserve_bytes}

    def has_room(self, reserved=0):
        with self.lock:
            return (self.pending_bytes + reserved < self.max_bytes
                    and shutil.disk_usage(self.path.parent).free > self.reserve_bytes + reserved)

    def lookup(self, key):
        with self.lock:
            row = self.db.execute("SELECT record FROM audio WHERE key=?", (key,)).fetchone()
            if row is None:
                return None
            return ("uploaded", json.loads(row[0])) if row[0] else ("pending", None)

    def pending_keys(self):
        with self.lock:
            return {row[0] for row in self.db.execute("SELECT key FROM audio WHERE data IS NOT NULL")}

    def stage(self, key, voice, audio: EncodedAudio):
        digest = hashlib.sha256(audio.data).hexdigest()
        with self.lock:
            with self.db:
                if self.db.execute("SELECT 1 FROM audio WHERE key=?", (key,)).fetchone():
                    raise ValueError("Refusing to replace staged audio")
                self.db.execute("INSERT INTO audio VALUES (?, ?, ?, ?, ?, ?, NULL)",
                                (key, voice, audio.data, audio.duration, digest, len(audio.data)))
            self.pending_count += 1
            self.pending_bytes += len(audio.data)

    def load(self, key):
        with self.lock:
            row = self.db.execute("SELECT data, duration, sha FROM audio WHERE key=?", (key,)).fetchone()
        if not row or row[0] is None or hashlib.sha256(row[0]).hexdigest() != row[2]:
            raise ValueError("Missing or corrupt staged audio; do not resynthesize automatically")
        return EncodedAudio(row[0], row[1])

    def confirm(self, key, record):
        with self.lock:
            row = self.db.execute("SELECT size, data IS NOT NULL FROM audio WHERE key=?", (key,)).fetchone()
            if not row:
                raise ValueError("Missing staged audio")
            with self.db:
                self.db.execute("UPDATE audio SET record=?, data=NULL WHERE key=?",
                                (json.dumps(record), key))
            if row[1]:
                self.pending_count -= 1
                self.pending_bytes -= row[0]

    def close(self):
        with self.lock:
            self.db.close()
