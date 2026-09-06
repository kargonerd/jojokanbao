"""Offline-only blocking pool, isolated from asyncio's DNS executor."""
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
import time


class BlockingPool(ThreadPoolExecutor):
    def __init__(self, workers):
        super().__init__(max_workers=workers, thread_name_prefix="speech-storage")
        self.workers = workers
        self._stats_lock = Lock()
        self._stats = defaultdict(lambda: dict(submitted=0, active=0, completed=0, failed=0, queueSeconds=0.0, workSeconds=0.0))

    def submit(self, fn, /, *args, **kwargs):
        stage = getattr(fn, "stage", "blocking")
        queued = time.monotonic()
        with self._stats_lock:
            self._stats[stage]["submitted"] += 1
        def run():
            started = time.monotonic()
            failed = False
            with self._stats_lock:
                self._stats[stage]["active"] += 1
                self._stats[stage]["queueSeconds"] += started - queued
            try:
                return fn(*args, **kwargs)
            except BaseException:
                failed = True
                raise
            finally:
                with self._stats_lock:
                    row = self._stats[stage]
                    row["active"] -= 1
                    row["completed"] += 1
                    row["failed"] += int(failed)
                    row["workSeconds"] += time.monotonic() - started
        return super().submit(run)

    def snapshot(self):
        with self._stats_lock:
            return {stage: {**row,
                "queued": row["submitted"] - row["completed"] - row["active"],
                "meanQueueSeconds": round(row["queueSeconds"] / max(1, row["completed"] + row["active"]), 3),
                "meanWorkSeconds": round(row["workSeconds"] / max(1, row["completed"]), 3),
            } for stage, row in self._stats.items()}
