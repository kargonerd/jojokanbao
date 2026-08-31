from __future__ import annotations

from datetime import datetime, timezone
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

ARCHIVE_SPEC = ArchiveSourceSpec(
    publisher="wsj",
    canonical_host="www.wsj.com",
    wayback_patterns=tuple(
        f"www.wsj.com/articles/{prefix}*" for prefix in _SLUG_PREFIXES
    )
    + (
        "online.wsj.com/article/*",
        "online.wsj.com/news/articles/*",
        "www.wsj.com/news/articles/*",
    ),
    accepted_path_patterns=patterns(
        r"^/articles/",
        r"^/article/",
        r"^/news/.+",
        r"^/(?:[a-z0-9-]+/)+[a-z0-9-]+-[0-9a-f]{8}$",
    ),
    rejected_path_patterns=patterns(
        r"/(?:video|podcasts?|newsletters?|livecoverage)(?:/|$)",
        r"^/articles/[^/]*-crossword(?:-|$)",
    ),
    alternate_hosts=("online.wsj.com",),
)

PARSER_SPEC = PublisherSpec(
    publisher="wsj",
    parser_version="wsj-parser/0.8.78",
    domains=("wsj.com", "www.wsj.com"),
    default_language="en",
    edition="us",
    body_selectors=(
        "[data-type='article-body']",
        "[data-testid='article-body']",
        "#wsj-article-wrap",
        "[itemprop='articleBody']",
        ".article-content",
        "#articleTabs_panel_article .article.story",
        "#articleTabs_panel_article",
        "article",
    ),
    remove_selectors=(
        "p[style*='left:-15000px']",
        "#article_tools",
        ".article_tools",
        ".share_tools",
        "[data-module-name$='/shareTools']",
        "#trending_now",
        ".article-breadCrumb-wrapper",
        ".newsletter-home",
        "#newsletter-home",
        ".googlenews",
        "#cx-snippet-overlay",
        ".snippet-promotion",
        ".resume-subscription-scrim-overlay",
        "#livefyre-wrapper",
        "[data-module-name*='livefyre' i]",
        ".jr-module",
        "[data-module-name*='journalReports' i]",
        "#right-rail",
    ),
    preferred_image_hosts=("images.wsj.net", "s.wsj.net"),
)


def normalize_url(spec: ArchiveSourceSpec, value: str) -> str | None:
    parts = article_url_parts(spec, value)
    if parts is None:
        return None
    path = re.sub(
        r"(?i)(?:%(?:09|0a|0d|20|7f))+$",
        "",
        parts.path.rstrip("/"),
    )
    return finalize_article_url(spec, parts, path=path)


def archive_variant(
    spec: ArchiveSourceSpec,
    variant: str,
) -> ArchiveSourceSpec | None:
    if variant != "wsj-legacy-probe":
        return None
    return ArchiveSourceSpec(
        publisher=spec.publisher,
        canonical_host=spec.canonical_host,
        wayback_patterns=(
            "online.wsj.com/article/*",
            "online.wsj.com/news/articles/*",
            "www.wsj.com/news/articles/*",
        ),
        accepted_path_patterns=spec.accepted_path_patterns,
        rejected_path_patterns=spec.rejected_path_patterns,
        alternate_hosts=spec.alternate_hosts,
    )


def _publication_datetime_from_normalized(value: str) -> datetime | None:
    match = re.search(r"/articles/[^/?#]+-(\d{10,12})$", urlsplit(value).path)
    if match is None:
        return None
    raw_identifier = match.group(1)
    if len(raw_identifier) == 10:
        raw_epoch = raw_identifier
    elif len(raw_identifier) == 11 and raw_identifier.startswith("1"):
        raw_epoch = raw_identifier[1:]
    elif len(raw_identifier) == 12:
        raw_epoch = raw_identifier[2:]
    else:
        return None
    published = datetime.fromtimestamp(int(raw_epoch), tz=timezone.utc)
    if not 2008 <= published.year <= 2038:
        return None
    return published.replace(hour=0, minute=0, second=0, microsecond=0)


def wsj_article_publication_datetime(value: str) -> datetime | None:
    normalized = normalize_url(ARCHIVE_SPEC, value)
    if normalized is None:
        return None
    return _publication_datetime_from_normalized(normalized)


def publication_year(normalized_url: str) -> int | None:
    published = _publication_datetime_from_normalized(normalized_url)
    return published.year if published is not None else None


def primary_validation_shard(year: int) -> str:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    suffix = "wayback-urlkey" if year <= 2015 else "wayback"
    return f"wsj/{window}/{suffix}"


def supplemental_validation_shards(year: int) -> tuple[str, ...]:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    shards = [f"wsj/{window}/commoncrawl-prefix"]
    if year <= 2013:
        shards.append("wsj/2010-2013/commoncrawl-legacy-probe")
    return tuple(shards)


SOURCE = SourceModule(
    id="wsj",
    archive_spec=ARCHIVE_SPEC,
    parser_spec=PARSER_SPEC,
    capture_policy_version="wsj-capture/0.8.9",
    qa_policy_revision=6,
    validation_priority=3,
    requires_independent_holdout=True,
    minimum_validation_year=2010,
    primary_validation_shard=primary_validation_shard,
    supplemental_validation_shards=supplemental_validation_shards,
    wayback_timemap_fallback=True,
    common_crawl_fallback=True,
    arquivo_pt_fallback=True,
    arquivo_pt_prefix_url="www.wsj.com/articles/*",
    normalize_url=normalize_url,
    archive_variant=archive_variant,
    publication_year=publication_year,
)
