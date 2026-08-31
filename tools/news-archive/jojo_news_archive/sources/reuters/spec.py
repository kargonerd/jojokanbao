from __future__ import annotations

import re
from urllib.parse import urlsplit

from jojo_news_archive.sources.contracts import (
    ArchiveSourceSpec,
    PublisherSpec,
    SourceModule,
)
from jojo_news_archive.sources.url import (
    article_url_parts,
    finalize_article_url,
    patterns,
)


_SLUG_PREFIXES = tuple("abcdefghijklmnopqrstuvwxyz0123456789")
_SECTIONS = (
    "world",
    "business",
    "markets",
    "technology",
    "legal",
    "sports",
    "lifestyle",
    "science",
    "fact-check",
    "breakingviews",
    "investigates",
)

ARCHIVE_SPEC = ArchiveSourceSpec(
    publisher="reuters",
    canonical_host="www.reuters.com",
    wayback_patterns=tuple(
        f"www.reuters.com/article/{prefix}*" for prefix in _SLUG_PREFIXES
    )
    + tuple(f"www.reuters.com/{section}/*" for section in _SECTIONS),
    accepted_path_patterns=patterns(
        r"^/article/",
        (
            r"^/(?:world|business|markets|technology|legal|sports|"
            r"lifestyle|science|fact-check|breakingviews|investigates)/.+"
        ),
    ),
    rejected_path_patterns=patterns(
        r"/(?:video|pictures|graphics)(?:/|$)",
        r"^/article/(?:comments|slideshow)(?:/|$)",
        r"%3c|%3e",
    ),
)

PARSER_SPEC = PublisherSpec(
    publisher="reuters",
    parser_version="reuters-parser/0.7.32",
    domains=("reuters.com", "www.reuters.com"),
    default_language="en",
    edition="global",
    body_selectors=(
        "[data-testid='article-body']",
        ".article-body__content",
        "[class*='ArticleBody__content']",
        "[class*='article-body__content']",
        "[class*='StandardArticleBody_body']",
        "[class*='ArticleBody_body']",
        "#articleText",
        "#rcs-articleContent",
        "article",
    ),
    remove_selectors=(
        "[class*='ReadTime-read-time']",
        "[class*='TrustBadge-trust-badge']",
        "[data-testid='promo-box']",
        "[data-testid='ToolbarItemContainer']",
        "[data-testid='LicenceContentButton']",
        "#div_with_disclaimer_id",
        "p:has(a[href*='trust-principles'])",
        ".info-box",
        ".more-on",
    ),
    text_block_selectors=("[data-testid^='paragraph-']",),
    preferred_image_hosts=("cloudfront-us-east-2.images.arcpublishing.com",),
    embedded_html_body_keys=("body",),
)


def normalize_url(spec: ArchiveSourceSpec, value: str) -> str | None:
    parts = article_url_parts(spec, value)
    if parts is None or re.search(
        r"[|<>(){}]|%(?:28|29|3c|3e|7b|7c|7d)",
        parts.path,
        re.IGNORECASE,
    ):
        return None
    return finalize_article_url(spec, parts)


def publication_year(normalized_url: str) -> int | None:
    path = urlsplit(normalized_url).path
    if not path.startswith("/article/"):
        return None
    matches = re.findall(
        r"((?:19|20)\d{2})(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])",
        path,
    )
    return int(matches[-1]) if matches else None


def primary_validation_shard(year: int) -> str:
    if year <= 2015:
        return "reuters/2010-2015/wayback-urlkey"
    if year <= 2020:
        return "reuters/2016-2020/wayback-urlkey"
    return "reuters/2021-2026/reuters-sitemap-wayback"


def supplemental_validation_shards(year: int) -> tuple[str, ...]:
    window = (
        "2010-2015"
        if year <= 2015
        else "2016-2020"
        if year <= 2020
        else "2021-2026"
    )
    return (f"reuters/{window}/commoncrawl-prefix",)


SOURCE = SourceModule(
    id="reuters",
    archive_spec=ARCHIVE_SPEC,
    parser_spec=PARSER_SPEC,
    capture_policy_version="reuters-capture/0.7.2",
    qa_policy_revision=2,
    validation_priority=0,
    minimum_validation_year=2010,
    primary_validation_shard=primary_validation_shard,
    supplemental_validation_shards=supplemental_validation_shards,
    wayback_timemap_fallback=True,
    normalize_url=normalize_url,
    publication_year=publication_year,
)
