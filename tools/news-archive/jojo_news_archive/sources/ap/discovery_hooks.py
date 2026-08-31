from __future__ import annotations

import re

from jojo_news_archive.sources.ap.spec import ap_hosted_publication_datetime
from jojo_news_archive.sources.discovery_contracts import (
    SitemapSource,
    SourceDiscoveryHooks,
    first_day_of_match,
    hostname_in,
    infer_iso_date,
)

_DOMAINS = (
    "apnews.com",
    "hosted.ap.org",
    "hosted2.ap.org",
    "bigstory.ap.org",
    "news.yahoo.com",
    "google.com",
    "huffingtonpost.com",
)


def infer_published_at(value: str) -> str | None:
    if not hostname_in(value, *_DOMAINS):
        return None
    hosted = ap_hosted_publication_datetime(value)
    if hosted is not None:
        return hosted.isoformat()
    return infer_iso_date(
        value,
        r"/article/(?:0(?:%2C|,){2})?BT-CO-(20\d{2})(\d{2})(\d{2})-",
        r"/(20\d{2})/(\d{2})/(\d{2})(?:/|$)",
    )


def transform_sitemap_candidates(
    canonical_url: str,
    published_at: str | None,
    candidates: list[dict[str, object]],
) -> list[dict[str, object]]:
    del published_at
    return [
        {"provider": "live-origin", "snapshotUrl": canonical_url},
        *candidates,
    ]


HOOKS = SourceDiscoveryHooks(
    publisher="ap",
    owns_url=lambda value: hostname_in(value, *_DOMAINS),
    sitemap_sources=(
        SitemapSource(
            key="ap",
            publisher="ap",
            index_url="https://apnews.com/ap-sitemap.xml",
            child_pattern=re.compile(r"ap-sitemap-(20\d{2})(\d{2})\.xml$"),
            child_date=first_day_of_match,
        ),
    ),
    infer_published_at=infer_published_at,
    sitemap_candidate_transform=transform_sitemap_candidates,
)
