from __future__ import annotations

import re

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


ARCHIVE_SPEC = ArchiveSourceSpec(
    publisher="axios",
    canonical_host="www.axios.com",
    wayback_patterns=(
        "axios.com/{year}/*",
        "www.axios.com/{year}/*",
        "axios.com/*/{year}/*",
        "www.axios.com/*/{year}/*",
        "axios.com/local/*/{year}/*",
        "www.axios.com/local/*/{year}/*",
        "axios.com/local/*",
        "www.axios.com/local/*",
    ),
    accepted_path_patterns=patterns(r"^/(?:local/[^/]+/|[^/]+/)?20\d{2}/"),
    rejected_path_patterns=patterns(r"^/(?:newsletters?|signup|about)(?:/|$)"),
)

PARSER_SPEC = PublisherSpec(
    publisher="axios",
    parser_version="axios-parser/0.1.33",
    domains=("axios.com", "www.axios.com"),
    default_language="en",
    edition="us",
    body_selectors=(
        "[data-testid='article-content']",
        ".ArticleBody",
        ".story-body",
        ".story-body-text",
        ".story-content",
        "[itemprop='articleBody']",
        ".article-body",
        "[class*='DraftjsBlocks_draftjs']",
        "#main-content",
        "article",
    ),
    preferred_image_hosts=("images.axios.com",),
    use_structured_article_body=True,
    embedded_html_body_keys=("articleBody", "body", "content"),
)


def normalize_url(spec: ArchiveSourceSpec, value: str) -> str | None:
    parts = article_url_parts(spec, value)
    if parts is None:
        return None
    path = re.sub(
        r"(?i)(?:%(?:09|0a|0d|20|5c|7f))+$",
        "",
        parts.path,
    ).rstrip("-")
    return finalize_article_url(spec, parts, path=path)


def primary_validation_shard(year: int) -> str:
    return "axios/2017-2026/wayback-urlkey"


def supplemental_validation_shards(year: int) -> tuple[str, ...]:
    shards = [
        "axios/2017-2026/sitemap-wayback",
        "axios/2017-2026/commoncrawl-prefix",
        "axios/2017-2026/axios-local-sitemap",
    ]
    if year in {2017, 2018, 2026}:
        shards.insert(0, f"axios/{year}-{year}/commoncrawl-prefix")
    return tuple(shards)


SOURCE = SourceModule(
    id="axios",
    archive_spec=ARCHIVE_SPEC,
    parser_spec=PARSER_SPEC,
    capture_policy_version="axios-capture/0.1.1",
    qa_policy_revision=7,
    validation_priority=6,
    minimum_validation_year=2017,
    primary_validation_shard=primary_validation_shard,
    supplemental_validation_shards=supplemental_validation_shards,
    normalize_url=normalize_url,
)
