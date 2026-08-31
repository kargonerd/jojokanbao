from __future__ import annotations

from datetime import datetime, timezone
import re

from jojo_news_archive.sources.discovery_contracts import (
    SitemapSource,
    SourceDiscoveryHooks,
    first_day_of_match,
    hostname_in,
    infer_iso_date,
)

def infer_published_at(value: str) -> str | None:
    if not hostname_in(value, "aljazeera.com"):
        return None
    legacy = re.search(
        r"/(?:[a-z0-9-]+/){1,2}(20\d{2})/(\d{2})/20\d{6,}\.html(?:/|$)",
        value,
        flags=re.IGNORECASE,
    )
    if legacy is not None:
        try:
            return datetime(
                int(legacy.group(1)),
                int(legacy.group(2)),
                1,
                tzinfo=timezone.utc,
            ).isoformat()
        except ValueError:
            return None
    return infer_iso_date(
        value,
        r"/(?:news|features|opinions)/(20\d{2})/(\d{1,2})/(\d{1,2})(?:/|$)",
        r"/(?:[a-z0-9-]+/)?(20\d{2})/(\d{1,2})/(\d{1,2})(?:/|$)",
    )


HOOKS = SourceDiscoveryHooks(
    publisher="aljazeera",
    owns_url=lambda value: hostname_in(value, "aljazeera.com"),
    sitemap_sources=(
        SitemapSource(
            key="aljazeera",
            publisher="aljazeera",
            index_url="https://www.aljazeera.com/sitemaps/article-archive.xml",
            child_pattern=re.compile(
                r"/article-archive/(20\d{2})/(\d{2})\.xml$"
            ),
            child_date=first_day_of_match,
            supplemental_index_urls=(
                "https://www.aljazeera.com/sitemaps/article-new.xml",
            ),
            daily_child_pattern=re.compile(
                r"/article-new/(\d{2})-(\d{2})-(20\d{2})\.xml$"
            ),
            daily_child_date=lambda match: (
                int(match.group(3)),
                int(match.group(2)),
            ),
        ),
    ),
    infer_published_at=infer_published_at,
)
