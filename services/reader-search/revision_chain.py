"""Single-index append-only revision filtering for Reader search."""
from __future__ import annotations

import threading
import time
from typing import Any, Dict, Iterable, Set


INTERNAL_REVISION_FIELDS = {"isRevision", "supersedesId", "deleted"}


def build_active_query(
    query_clause: Dict[str, Any],
    superseded_ids: Iterable[str],
) -> Dict[str, Any]:
    """Wrap a query so only active revision-chain leaves can match."""
    must_not = [{"term": {"deleted": True}}]
    ids = sorted({str(value) for value in superseded_ids if value})
    if ids:
        must_not.append({"ids": {"values": ids}})
    return {
        "bool": {
            "must": [query_clause],
            "must_not": must_not,
        }
    }


def read_superseded_ids(es: Any, index: str, *, limit: int = 10000) -> Set[str]:
    """Load revision edges; fail closed if the configured safety limit is hit."""
    response = es.search(
        index=index,
        body={
            "size": limit,
            "_source": ["supersedesId"],
            "query": {"exists": {"field": "supersedesId"}},
        },
    )
    hits = (response.get("hits") or {})
    rows = hits.get("hits") or []
    total = hits.get("total") or {}
    total_value = total.get("value", len(rows))
    if total.get("relation") == "gte" or total_value > len(rows):
        raise RuntimeError(
            f"revision state exceeds limit ({total_value} > {limit}); "
            "increase SEARCH_REVISION_LIMIT before serving results"
        )
    return {
        str(row["_source"]["supersedesId"])
        for row in rows
        if (row.get("_source") or {}).get("supersedesId")
    }


def hit_to_active_result(hit: Dict[str, Any]) -> Dict[str, Any]:
    source = dict(hit.get("_source") or {})
    source.pop("@timestamp", None)
    for field in INTERNAL_REVISION_FIELDS:
        source.pop(field, None)
    source["documentId"] = hit.get("_id")

    highlight = hit.get("highlight") or {}
    title = highlight.get("title")
    if title:
        source["title"] = title[0]
    content = highlight.get("content")
    if content:
        source["content"] = content[0]
    return source


class RevisionStateCache:
    def __init__(self, *, ttl_seconds: float = 30, limit: int = 10000):
        self.ttl_seconds = max(0, ttl_seconds)
        self.limit = limit
        self._expires_at = 0.0
        self._ids: Set[str] = set()
        self._lock = threading.Lock()

    def get(self, es: Any, index: str) -> Set[str]:
        now = time.monotonic()
        if now < self._expires_at:
            return set(self._ids)
        with self._lock:
            now = time.monotonic()
            if now >= self._expires_at:
                self._ids = read_superseded_ids(es, index, limit=self.limit)
                self._expires_at = now + self.ttl_seconds
            return set(self._ids)

    def clear(self) -> None:
        with self._lock:
            self._expires_at = 0
            self._ids = set()
