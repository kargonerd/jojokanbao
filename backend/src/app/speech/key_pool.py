"""Small process-local key scheduler; no keys, account IDs, or vendor text in logs."""
from __future__ import annotations

import math
import secrets
import threading
import time
from email.utils import parsedate_to_datetime
from functools import lru_cache


def retry_after(value: str | None) -> float:
    """Respect a vendor delay, including HTTP dates; malformed values use 60s."""
    try:
        delay = float(value) if value is not None else 60.0
    except ValueError:
        try:
            delay = parsedate_to_datetime(value).timestamp() - time.time()
        except (TypeError, ValueError, OverflowError):
            delay = 60.0
    return max(1.0, delay) if math.isfinite(delay) else 60.0


class KeyPool:
    """Least in-flight, rotating ties; random cold-start offset across instances.

    Cooldowns are instance-local, not an account-wide RPM/TPM guarantee.
    The existing synthesis semaphore continues to bound cloud-function memory.
    """

    def __init__(self, keys: tuple[str, ...], *, clock=time.monotonic, start=None):
        self._keys = keys
        self._clock = clock
        self._lock = threading.Lock()
        self._active = [0] * len(keys)
        self._cooldown = [0.0] * len(keys)
        self._next = (secrets.randbelow(len(keys)) if keys else 0) if start is None else start

    def acquire(self, excluded: set[int]) -> tuple[int, str] | None:
        with self._lock:
            now = self._clock()
            candidates = [i for i in range(len(self._keys))
                          if i not in excluded and self._cooldown[i] <= now]
            if not candidates:
                return None
            index = min(candidates, key=lambda i: (self._active[i], (i - self._next) % len(self._keys)))
            self._active[index] += 1
            self._next = (index + 1) % len(self._keys)
            return index, self._keys[index]

    def defer(self, index: int, seconds: float) -> None:
        with self._lock:
            self._cooldown[index] = max(self._cooldown[index], self._clock() + seconds)

    def release(self, index: int) -> None:
        with self._lock:
            self._active[index] -= 1


@lru_cache(maxsize=8)
def key_pool(keys: tuple[str, ...]) -> KeyPool:
    return KeyPool(keys)
