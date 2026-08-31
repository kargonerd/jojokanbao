from __future__ import annotations

from jojo_news_archive.sources.discovery_contracts import (
    SourceDiscoveryHooks,
    infer_iso_date,
)
from urllib.parse import urlsplit


def owns_url(value: str) -> bool:
    hostname = (urlsplit(value).hostname or "").casefold()
    return hostname == "caixin.com" or hostname.endswith(".caixin.com")


def infer_published_at(value: str) -> str | None:
    if not owns_url(value):
        return None
    return infer_iso_date(value, r"/(20\d{2})-(\d{2})-(\d{2})(?:/|$)")


HOOKS = SourceDiscoveryHooks(
    publisher="caixin",
    owns_url=owns_url,
    infer_published_at=infer_published_at,
)
