"""Load the active search exclusions from one COS JSON object."""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any, Callable, Dict, FrozenSet


LOGGER = logging.getLogger(__name__)
DEFAULT_KEY = "runtime/search/search-state.json"


class SearchStateUnavailable(RuntimeError):
    """Raised when a configured remote state has never loaded successfully."""


def parse_search_state(raw: bytes | str) -> Dict[str, FrozenSet[str]]:
    """Validate the deliberately small public contract of search-state.json."""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("search-state.json 必须是对象")
    by_index = payload.get("excludedIds")
    # Accept the first flat-file shape while the initial COS object is rolled
    # forward. New publishers always emit the index-scoped form.
    if isinstance(by_index, list):
        by_index = {"*": by_index}
    if not isinstance(by_index, dict):
        raise ValueError("search-state.json 必须包含 excludedIds 对象")
    parsed: Dict[str, FrozenSet[str]] = {}
    for index, values in by_index.items():
        if not isinstance(index, str) or not index or not isinstance(values, list):
            raise ValueError("search-state.json 的索引及排除列表格式错误")
        if any(not isinstance(value, str) for value in values):
            raise ValueError("search-state.json 的 excludedIds 只能包含字符串")
        parsed[index] = frozenset(value.strip() for value in values if value.strip())
    return parsed


class CosSearchState:
    """Cache one COS object and refresh it only when its ETag changes."""

    def __init__(
        self,
        *,
        bucket: str = "",
        region: str = "",
        key: str = DEFAULT_KEY,
        cache_seconds: float = 60,
        client: Any = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.bucket = bucket.strip()
        self.region = region.strip()
        self.key = key.strip().lstrip("/") or DEFAULT_KEY
        self.cache_seconds = max(float(cache_seconds), 1)
        self._client = client
        self._clock = clock
        self._lock = threading.Lock()
        self._etag: str | None = None
        self._excluded_ids: Dict[str, FrozenSet[str]] = {}
        self._loaded = False
        self._check_after = 0.0

    @classmethod
    def from_environment(cls) -> "CosSearchState":
        return cls(
            bucket=os.environ.get("SEARCH_STATE_COS_BUCKET", ""),
            region=os.environ.get("SEARCH_STATE_COS_REGION")
            or os.environ.get("TENCENTCLOUD_REGION", ""),
            key=os.environ.get("SEARCH_STATE_COS_KEY", DEFAULT_KEY),
            cache_seconds=float(os.environ.get("SEARCH_STATE_CACHE_SECONDS", "60")),
        )

    @property
    def enabled(self) -> bool:
        return bool(self.bucket and self.region)

    def status(self) -> dict[str, Any]:
        return {
            "configured": self.enabled,
            "loaded": self._loaded,
            "excludedCount": sum(len(values) for values in self._excluded_ids.values()),
            "etag": self._etag,
        }

    def excluded_ids(self, index: str) -> FrozenSet[str]:
        """Return current IDs, retaining the last good state on refresh errors."""
        if not self.enabled:
            return frozenset()
        now = self._clock()
        if self._loaded and now < self._check_after:
            return self._for_index(index)

        with self._lock:
            now = self._clock()
            if self._loaded and now < self._check_after:
                return self._for_index(index)
            try:
                client = self._client or self._create_client()
                self._client = client
                head = client.head_object(Bucket=self.bucket, Key=self.key)
                etag = str(head.get("ETag") or "").strip('"')
                if self._loaded and etag and etag == self._etag:
                    self._check_after = now + self.cache_seconds
                    return self._for_index(index)

                response = client.get_object(Bucket=self.bucket, Key=self.key)
                body = response["Body"]
                stream = body.get_raw_stream() if hasattr(body, "get_raw_stream") else body
                excluded_ids = parse_search_state(stream.read())
                self._excluded_ids = excluded_ids
                self._etag = etag or str(response.get("ETag") or "").strip('"') or None
                self._loaded = True
                self._check_after = now + self.cache_seconds
                return self._for_index(index)
            except Exception as exc:
                # Do not hammer COS during an incident. Existing warm containers
                # remain useful with their last known-good state.
                self._check_after = now + min(self.cache_seconds, 10)
                if self._loaded:
                    LOGGER.warning("COS search state refresh failed; using cached state: %s", exc)
                    return self._for_index(index)
                raise SearchStateUnavailable(
                    f"无法读取 COS search-state.json: {exc}"
                ) from exc

    def _for_index(self, index: str) -> FrozenSet[str]:
        return self._excluded_ids.get(index, self._excluded_ids.get("*", frozenset()))

    def _create_client(self):
        try:
            from qcloud_cos import CosConfig, CosS3Client
        except ImportError as exc:
            raise RuntimeError("缺少 cos-python-sdk-v5") from exc

        config = CosConfig(
            Region=self.region,
            SecretId=os.environ.get("TENCENTCLOUD_SECRETID"),
            SecretKey=os.environ.get("TENCENTCLOUD_SECRETKEY"),
            Token=os.environ.get("TENCENTCLOUD_SESSIONTOKEN"),
            Scheme="https",
        )
        return CosS3Client(config)
