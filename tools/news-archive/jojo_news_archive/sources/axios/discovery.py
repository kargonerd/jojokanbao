from __future__ import annotations

import re

from jojo_news_archive.sources.discovery_contracts import (
    SitemapSource,
    SourceDiscoveryHooks,
    hostname_in,
    infer_iso_date,
)


_MONTHS = {
    name: number
    for number, name in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"),
        start=1,
    )
}


def _child_date(match: re.Match[str]) -> tuple[int, int]:
    return int(match.group(2)), _MONTHS[match.group(1).casefold()]


def infer_published_at(value: str) -> str | None:
    if not hostname_in(value, "axios.com"):
        return None
    return infer_iso_date(value, r"/(20\d{2})/(\d{2})/(\d{2})(?:/|$)")


HOOKS = SourceDiscoveryHooks(
    publisher="axios",
    owns_url=lambda value: hostname_in(value, "axios.com"),
    sitemap_sources=(
        SitemapSource(
            key="axios",
            publisher="axios",
            index_url="https://www.axios.com/sitemap.xml",
            child_pattern=re.compile(
                r"^/sitemaps/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(20\d{2})\.xml$",
                re.IGNORECASE,
            ),
            child_date=_child_date,
        ),
        SitemapSource(
            key="axios-local",
            publisher="axios",
            index_url="https://www.axios.com/sitemap.xml",
            child_pattern=re.compile(
                r"^/sitemaps/[^/]+/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(20\d{2})\.xml$",
                re.IGNORECASE,
            ),
            child_date=_child_date,
        ),
    ),
    infer_published_at=infer_published_at,
)
