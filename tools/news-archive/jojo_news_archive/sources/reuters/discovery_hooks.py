from __future__ import annotations

from urllib.parse import urlsplit

from jojo_news_archive.sources.discovery_contracts import (
    SourceDiscoveryHooks,
    hostname_in,
    infer_iso_date,
)

def infer_published_at(value: str) -> str | None:
    if not hostname_in(value, "reuters.com"):
        return None
    path = urlsplit(value).path
    patterns = []
    if path.startswith("/article/"):
        patterns.append(r"((?:19|20)\d{2})(\d{2})(\d{2})(?:[^0-9]|$)")
    patterns.extend(
        (
            r"/((?:19|20)\d{2})/(\d{2})/(\d{2})(?:/|$)",
            r"-((?:19|20)\d{2})-(\d{2})-(\d{2})(?:/|$)",
        )
    )
    return infer_iso_date(value, *patterns)


def prefix_query_priority(pattern: str, collection_id: str) -> int | None:
    del collection_id
    if pattern.startswith("www.reuters.com/") and "/article/" not in pattern:
        return -3
    return None


HOOKS = SourceDiscoveryHooks(
    publisher="reuters",
    owns_url=lambda value: hostname_in(value, "reuters.com"),
    infer_published_at=infer_published_at,
    prefix_query_priority=prefix_query_priority,
)
