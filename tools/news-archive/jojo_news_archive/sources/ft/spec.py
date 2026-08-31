from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re
from urllib.parse import urlsplit
from uuid import UUID

from jojo_news_archive.sources.contracts import (
    ArchiveSourceSpec,
    PublisherSpec,
    SourceModule,
)
from jojo_news_archive.sources.url import patterns


ARCHIVE_SPEC = ArchiveSourceSpec(
    publisher="ft",
    canonical_host="www.ft.com",
    wayback_patterns=(
        "www.ft.com/content/*",
        "ft.com/content/*",
    ),
    accepted_path_patterns=patterns(r"^/content/[0-9a-f-]{20,}$"),
)

PARSER_SPEC = PublisherSpec(
    publisher="ft",
    parser_version="ft-parser/0.8.69",
    domains=("ft.com", "www.ft.com"),
    default_language="en",
    edition="global",
    body_selectors=(
        ".article__content-body",
        "#article-body",
        "#storyContent",
        "[data-trackable='article-body']",
        ".article-body[itemprop='articleBody']",
        ".article-body",
        "article",
    ),
    preferred_image_hosts=("www.ft.com", "d1e00ek4ebabms.cloudfront.net"),
    use_structured_article_body=True,
)


def ft_content_uuid_creation_year(value: str) -> int | None:
    """Return the creation year encoded by an FT UUIDv1 content id."""

    parsed = urlsplit(value.strip())
    if (parsed.hostname or "").casefold() not in {"ft.com", "www.ft.com"}:
        return None
    match = re.fullmatch(
        r"/content/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
        r"[0-9a-f]{4}-[0-9a-f]{12})",
        parsed.path,
        flags=re.IGNORECASE,
    )
    if match is None:
        return None
    try:
        article_uuid = UUID(match.group(1))
    except ValueError:
        return None
    if article_uuid.version != 1:
        return None
    created = datetime(1582, 10, 15, tzinfo=timezone.utc) + timedelta(
        microseconds=article_uuid.time // 10
    )
    return created.year


def primary_validation_shard(year: int) -> str:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    return f"ft/{window}/sitemap-wayback"


def supplemental_validation_shards(year: int) -> tuple[str, ...]:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    return (f"ft/{window}/commoncrawl-prefix",)


SOURCE = SourceModule(
    id="ft",
    archive_spec=ARCHIVE_SPEC,
    parser_spec=PARSER_SPEC,
    capture_policy_version="ft-capture/0.20.2",
    qa_policy_revision=7,
    validation_priority=2,
    proven_rotated_validation_years=frozenset({2016}),
    minimum_validation_year=2010,
    primary_validation_shard=primary_validation_shard,
    supplemental_validation_shards=supplemental_validation_shards,
    common_crawl_fallback=True,
    arquivo_pt_fallback=True,
    arquivo_pt_prefix_url="www.ft.com/content/*",
)
