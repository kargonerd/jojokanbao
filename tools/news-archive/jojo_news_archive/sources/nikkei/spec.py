from __future__ import annotations

import re
from urllib.parse import urlsplit

from jojo_news_archive.sources.contracts import (
    ArchiveSourceSpec,
    PublisherSpec,
    SourceCatalogTargetSpec,
    SourceModule,
)
from jojo_news_archive.sources.url import (
    article_url_parts,
    finalize_article_url,
    patterns,
)


ARCHIVE_SPEC = ArchiveSourceSpec(
    publisher="nikkei",
    canonical_host="www.nikkei.com",
    wayback_patterns=("www.nikkei.com/article/*",),
    accepted_path_patterns=patterns(
        r"^/article/(?:[A-Z]{8}\d{5}|[A-Z]{6}\d{7}|[A-Z0-9_]{15,})/?$",
    ),
)

PARSER_SPEC = PublisherSpec(
    publisher="nikkei",
    parser_version="nikkei-parser/0.1.11",
    domains=("nikkei.com", "www.nikkei.com", "asia.nikkei.com"),
    default_language="ja",
    edition="jp",
    body_selectors=(
        ".articleBodyText",
        ".article-body",
        ".cmn-article_body",
        ".cmn-article_text",
        "article",
    ),
    preferred_image_hosts=("www.nikkei.com", "asia.nikkei.com"),
    use_structured_article_body=True,
)


def normalize_url(spec: ArchiveSourceSpec, value: str) -> str | None:
    parts = article_url_parts(spec, value)
    if parts is None:
        return None
    path = parts.path
    if path.startswith("/article/article/"):
        path = "/article/" + path.removeprefix("/article/article/")
    return finalize_article_url(spec, parts, path=path)


def archive_variant(
    spec: ArchiveSourceSpec,
    variant: str,
) -> ArchiveSourceSpec | None:
    if variant != "nikkei-asia-probe":
        return None
    return ArchiveSourceSpec(
        publisher=spec.publisher,
        canonical_host="asia.nikkei.com",
        wayback_patterns=("asia.nikkei.com/*",),
        accepted_path_patterns=patterns(r"^/(?:[^/?#]+/)+[^/?#]+$"),
        rejected_path_patterns=patterns(
            r"^/(?:about|authors?|info|login|search|subscribe|tags?|topics?|"
            r"user)(?:/|$)"
        ),
        preserve_normalized_hosts=("asia.nikkei.com",),
    )


def publication_year(normalized_url: str) -> int | None:
    match = re.search(
        r"[A-Z]\d{2}C(\d{2})A(?:1[0-2]|[1-9])",
        urlsplit(normalized_url).path,
        flags=re.IGNORECASE,
    )
    return 2000 + int(match.group(1)) if match is not None else None


def primary_validation_shard(year: int) -> str:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    return f"nikkei/{window}/wayback-urlkey"


def supplemental_validation_shards(year: int) -> tuple[str, ...]:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    shards: list[str] = []
    if year in {2010, 2011}:
        shards.append(f"nikkei/{year}-{year}/commoncrawl-prefix")
    shards.append(f"nikkei/{window}/commoncrawl-prefix")
    if year <= 2016:
        shards.append("nikkei/2010-2016/commoncrawl-asia-probe")
    return tuple(shards)


SOURCE = SourceModule(
    id="nikkei",
    archive_spec=ARCHIVE_SPEC,
    parser_spec=PARSER_SPEC,
    capture_policy_version="nikkei-capture/0.1.0",
    qa_policy_revision=1,
    validation_priority=8,
    catalog_targets=(
        SourceCatalogTargetSpec(5, 2010, 2015, "wayback-urlkey", 10),
        SourceCatalogTargetSpec(7, 2016, 2026, "wayback-urlkey", 10),
    ),
    minimum_validation_year=2010,
    primary_validation_shard=primary_validation_shard,
    supplemental_validation_shards=supplemental_validation_shards,
    wayback_timemap_fallback=True,
    common_crawl_fallback=True,
    arquivo_pt_fallback=True,
    unavailable_validation_years=frozenset(range(2012, 2016)),
    normalize_url=normalize_url,
    archive_variant=archive_variant,
    publication_year=publication_year,
)
