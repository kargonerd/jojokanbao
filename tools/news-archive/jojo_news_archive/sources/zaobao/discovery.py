from __future__ import annotations

import re

from jojo_news_archive.sources.discovery_contracts import (
    SitemapSource,
    SourceDiscoveryHooks,
    first_day_of_match,
    hostname_in,
    infer_iso_date,
)


def infer_published_at(value: str) -> str | None:
    if not hostname_in(value, "zaobao.com.sg"):
        return None
    return infer_iso_date(value, r"/story(20\d{2})(\d{2})(\d{2})(?:[-/]|$)")


HOOKS = SourceDiscoveryHooks(
    publisher="zaobao",
    owns_url=lambda value: hostname_in(value, "zaobao.com.sg"),
    sitemap_sources=(
        SitemapSource(
            key="zaobao",
            publisher="zaobao",
            index_url="https://www.zaobao.com.sg/sitemap.xml",
            child_pattern=re.compile(r"/sitemap-(20\d{2})(\d{2})\.xml$"),
            child_date=first_day_of_match,
        ),
    ),
    infer_published_at=infer_published_at,
)
