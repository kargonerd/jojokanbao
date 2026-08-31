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


EDITORIAL_HOSTS = (
    "china.caixin.com",
    "economy.caixin.com",
    "finance.caixin.com",
    "companies.caixin.com",
    "international.caixin.com",
    "opinion.caixin.com",
    "culture.caixin.com",
    "photos.caixin.com",
    "video.caixin.com",
)
_NONARTICLE_HOSTS = frozenset({"photos.caixin.com", "video.caixin.com"})

ARCHIVE_SPEC = ArchiveSourceSpec(
    publisher="caixin",
    canonical_host="www.caixin.com",
    wayback_patterns=(
        "www.caixin.com/*",
        "www.caixin.com/{year}-*",
        "www.caixin.com/{year}/*",
        "magazine.caixin.com/{year}/*",
    )
    + tuple(f"{host}/{{year}}-*" for host in EDITORIAL_HOSTS),
    accepted_path_patterns=patterns(r"^/20\d{2}(?:[-/]|$)"),
    alternate_hosts=("magazine.caixin.com",) + EDITORIAL_HOSTS,
    preserve_normalized_hosts=("magazine.caixin.com",) + EDITORIAL_HOSTS,
)

PARSER_SPEC = PublisherSpec(
    publisher="caixin",
    parser_version="caixin-parser/0.1.15",
    domains=("caixin.com", "www.caixin.com", "magazine.caixin.com"),
    default_language="zh",
    edition="cn",
    body_selectors=(".article-content", ".article_body", "article"),
    preferred_image_hosts=("img.caixin.com", "file.caixin.com"),
    use_structured_article_body=True,
)


def normalize_url(spec: ArchiveSourceSpec, value: str) -> str | None:
    parts = article_url_parts(spec, value)
    if parts is None:
        return None
    path = re.sub(
        r"_(?:all|\d+)(\.html)$",
        r"\1",
        parts.path,
        flags=re.IGNORECASE,
    )
    return finalize_article_url(spec, parts, path=path)


def validation_candidate(normalized_url: str) -> bool:
    return (urlsplit(normalized_url).hostname or "").casefold() not in _NONARTICLE_HOSTS


def primary_validation_shard(year: int) -> str:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    return f"caixin/{window}/wayback-urlkey"


def supplemental_validation_shards(year: int) -> tuple[str, ...]:
    return (f"caixin/{year}-{year}/commoncrawl-prefix",)


SOURCE = SourceModule(
    id="caixin",
    archive_spec=ARCHIVE_SPEC,
    parser_spec=PARSER_SPEC,
    capture_policy_version="caixin-capture/0.1.1",
    qa_policy_revision=1,
    validation_priority=12,
    allow_initial_capacity_reset=True,
    minimum_validation_year=2010,
    primary_validation_shard=primary_validation_shard,
    supplemental_validation_shards=supplemental_validation_shards,
    enabled=False,
    normalize_url=normalize_url,
    validation_candidate=validation_candidate,
)
