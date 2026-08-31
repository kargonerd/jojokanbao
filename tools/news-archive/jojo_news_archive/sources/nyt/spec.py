from __future__ import annotations

import re
from urllib.parse import urlsplit

from jojo_news_archive.sources.contracts import (
    ArchiveSourceSpec,
    PublisherSpec,
    SourceModule,
)
from jojo_news_archive.sources.url import patterns


ARCHIVE_SPEC = ArchiveSourceSpec(
    publisher="nyt",
    canonical_host="www.nytimes.com",
    wayback_patterns=(
        "www.nytimes.com/{year}/*",
        "nytimes.com/{year}/*",
    ),
    accepted_path_patterns=patterns(
        r"^/20\d{2}/\d{2}/\d{2}/",
        r"^/interactive/20\d{2}/",
    ),
    rejected_path_patterns=patterns(
        r"/(?:video|podcasts?|crosswords?|games|wirecutter)(?:/|$)",
    ),
)

PARSER_SPEC = PublisherSpec(
    publisher="nyt",
    parser_version="nyt-parser/0.8.158",
    domains=("nytimes.com", "www.nytimes.com"),
    default_language="en",
    edition="us",
    body_selectors=(
        "section[name='articleBody']",
        "[data-testid='article-body']",
        ".StoryBodyCompanionColumn",
        ".story-body",
        ".PostV2__postBody",
        ".Post__body",
        ".interactive-body",
        "article",
    ),
    remove_selectors=(
        ".story-print-citation",
        ".story-footer-links",
        "[data-testid='optimistic-truncator-message']",
        "[class*='relatedcoverage' i]",
        "[class*='Recirculation-' i]",
        ".rad-series-box",
        "#newsletter-module",
        "[class*='Newsletter-wrap']",
        "figure[id^='Newsletter-embed-']",
        "section[role='complementary'][aria-labelledby='styln-toplinks-title']",
        ".mainTabsContainer",
    ),
    preferred_image_hosts=("static01.nyt.com", "static.nytimes.com"),
)


def validation_candidate(normalized_url: str) -> bool:
    return re.fullmatch(
        r"/interactive/20\d{2}/us/[a-z0-9-]+-covid-cases\.html",
        urlsplit(normalized_url).path,
        flags=re.IGNORECASE,
    ) is None


def publication_year(normalized_url: str) -> int | None:
    match = re.match(
        r"^/(?:interactive/)?((?:19|20)\d{2})(?:/|$)",
        urlsplit(normalized_url).path,
    )
    return int(match.group(1)) if match is not None else None


def primary_validation_shard(year: int) -> str:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    return f"nyt/{window}/sitemap-wayback"


def supplemental_validation_shards(year: int) -> tuple[str, ...]:
    return ()


SOURCE = SourceModule(
    id="nyt",
    archive_spec=ARCHIVE_SPEC,
    parser_spec=PARSER_SPEC,
    capture_policy_version="nyt-capture/0.9.2",
    qa_policy_revision=9,
    validation_priority=4,
    minimum_validation_year=2010,
    primary_validation_shard=primary_validation_shard,
    supplemental_validation_shards=supplemental_validation_shards,
    wayback_timemap_fallback=True,
    validation_candidate=validation_candidate,
    publication_year=publication_year,
)
