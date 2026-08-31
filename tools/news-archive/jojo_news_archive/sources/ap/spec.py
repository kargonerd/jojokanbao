from __future__ import annotations

from datetime import datetime, timezone
import re
from urllib.parse import parse_qsl, urlsplit

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
    publisher="ap",
    canonical_host="apnews.com",
    wayback_patterns=tuple(
        f"hosted.ap.org/dynamic/stories/{prefix.upper()}/*"
        for prefix in _SLUG_PREFIXES
    )
    + (
        "apnews.com/article/*",
        "apnews.com/*",
    ),
    accepted_path_patterns=patterns(
        r"^/article/",
        r"^/[a-f0-9]{24,}$",
        r"^/.+-[a-f0-9]{24,}$",
        r"^/dynamic/stories/[a-z0-9]/[a-z0-9_-]+$",
        r"^/s/ap(?:_[A-Za-z0-9_-]+)?/20\d{6}/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$",
        r"^/hostednews/ap/article/[A-Za-z0-9_-]+$",
        r"^/huff-wires/20\d{6}/[A-Za-z0-9_-]+$",
    ),
    rejected_path_patterns=patterns(
        r"^/(?:hub|video|videos|search|press-releases|newsletters)(?:/|$)",
    ),
    alternate_hosts=(
        "hosted.ap.org",
        "hosted2.ap.org",
        "bigstory.ap.org",
        "news.yahoo.com",
        "www.news.yahoo.com",
        "google.com",
        "www.google.com",
        "huffingtonpost.com",
        "www.huffingtonpost.com",
    ),
    preserve_normalized_hosts=(
        "bigstory.ap.org",
        "news.yahoo.com",
        "www.google.com",
        "www.huffingtonpost.com",
    ),
)

PARSER_SPEC = PublisherSpec(
    publisher="ap",
    parser_version="ap-parser/0.6.27",
    domains=(
        "apnews.com",
        "hosted.ap.org",
        "hosted2.ap.org",
        "news.yahoo.com",
        "www.google.com",
        "www.huffingtonpost.com",
        "bigstory.ap.org",
    ),
    default_language="en",
    edition="us",
    body_selectors=(
        "[data-key='article']",
        ".RichTextStoryBody",
        "[data-testid='article-body']",
        ".ap-story-table .entry-content",
        "#yn-story .yn-story-content",
        "#hostednews-article .hn-copy > .g-section:first-child",
        ".entry .entry_content",
        ".node-body .node-content",
        ".article-body",
        "article",
    ),
    preferred_image_hosts=("dims.apnews.com", "storage.googleapis.com"),
    embedded_html_body_keys=("storyHTML",),
)


def ap_hosted_publication_datetime(value: str) -> datetime | None:
    """Parse the story-revision timestamp used by legacy Hosted AP URLs."""

    parsed = urlsplit(value.strip())
    if (parsed.hostname or "").casefold() not in {
        "hosted.ap.org",
        "hosted2.ap.org",
    }:
        return None
    ctime = next(
        (
            query_value
            for key, query_value in parse_qsl(
                parsed.query,
                keep_blank_values=True,
            )
            if key.casefold() == "ctime"
        ),
        "",
    )
    match = re.fullmatch(
        r"((?:19|20)\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})",
        ctime,
    )
    if match is None:
        return None
    try:
        return datetime(
            *(int(part) for part in match.groups()),
            tzinfo=timezone.utc,
        )
    except ValueError:
        return None


def normalize_url(spec: ArchiveSourceSpec, value: str) -> str | None:
    parts = article_url_parts(spec, value)
    if parts is None:
        return None
    if parts.hostname in {"hosted.ap.org", "hosted2.ap.org"}:
        published = ap_hosted_publication_datetime(value)
        if published is None:
            return None
        return finalize_article_url(
            spec,
            parts,
            normalized_host="hosted.ap.org",
            query="CTIME=" + published.strftime("%Y-%m-%d-%H-%M-%S"),
        )
    return finalize_article_url(spec, parts)


def deduplication_key(normalized_url: str) -> str:
    parsed = urlsplit(normalized_url)
    if (parsed.hostname or "").casefold() in {
        "news.yahoo.com",
        "www.news.yahoo.com",
    }:
        match = re.match(
            r"^/s/ap(?:_[A-Za-z0-9_-]+)?/"
            r"((?:19|20)\d{2})\d{4}/[A-Za-z0-9_-]+/"
            r"([A-Za-z0-9_-]+)$",
            parsed.path,
        )
        if match is not None:
            slug = re.sub(r"_\d+$", "", match.group(2).casefold())
            return f"ap-yahoo:{match.group(1)}:{slug}"
    return normalized_url


def publication_year(normalized_url: str) -> int | None:
    published = ap_hosted_publication_datetime(normalized_url)
    if published is not None:
        return published.year
    parsed = urlsplit(normalized_url)
    host = (parsed.hostname or "").casefold()
    if host in {"news.yahoo.com", "www.news.yahoo.com"}:
        match = re.match(r"^/s/ap(?:_[A-Za-z0-9_-]+)?/(20\d{6})/", parsed.path)
        if match is not None:
            return int(match.group(1)[:4])
    if host in {"huffingtonpost.com", "www.huffingtonpost.com"}:
        match = re.match(r"^/huff-wires/(20\d{6})/", parsed.path)
        if match is not None:
            return int(match.group(1)[:4])
    return None


def primary_validation_shard(year: int) -> str:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    return f"ap/{window}/sitemap-wayback"


def supplemental_validation_shards(year: int) -> tuple[str, ...]:
    return ("ap/2010-2015/legacy-archive",) if year <= 2015 else ()


SOURCE = SourceModule(
    id="ap",
    archive_spec=ARCHIVE_SPEC,
    parser_spec=PARSER_SPEC,
    capture_policy_version="ap-capture/0.6.4",
    qa_policy_revision=1,
    validation_priority=5,
    minimum_validation_year=2010,
    primary_validation_shard=primary_validation_shard,
    supplemental_validation_shards=supplemental_validation_shards,
    normalize_url=normalize_url,
    deduplication_key=deduplication_key,
    publication_year=publication_year,
)
