from __future__ import annotations

import re
from urllib.parse import urlsplit

from jojo_news_archive.sources.contracts import (
    ArchiveSourceSpec,
    PublisherSpec,
    SourceCatalogTargetSpec,
    SourceModule,
)
from jojo_news_archive.sources.url import patterns


ARCHIVE_SPEC = ArchiveSourceSpec(
    publisher="aljazeera",
    canonical_host="www.aljazeera.com",
    wayback_patterns=(
        "www.aljazeera.com/news/{year}/*",
        "www.aljazeera.com/economy/{year}/*",
        "www.aljazeera.com/features/{year}/*",
        "www.aljazeera.com/opinions/{year}/*",
        "www.aljazeera.com/sports/{year}/*",
        "www.aljazeera.com/gallery/{year}/*",
        "www.aljazeera.com/{year}/*",
        "aljazeera.com/{year}/*",
    ),
    accepted_path_patterns=patterns(
        r"^/(?:[a-z0-9-]+/){1,2}20\d{2}/\d{1,2}/\d{1,2}/[^/]+$",
        r"^/20\d{2}/\d{1,2}/\d{1,2}/[^/]+$",
        r"^/(?:[a-z0-9-]+/){1,2}20\d{2}/\d{2}/20\d{6,}\.html$",
        r"^/20\d{2}/\d{2}/20\d{6,}\.html$",
    ),
    rejected_path_patterns=patterns(r"^/(?:video|program|podcasts?)(?:/|$)"),
)

PARSER_SPEC = PublisherSpec(
    publisher="aljazeera",
    parser_version="aljazeera-parser/0.1.21",
    domains=("aljazeera.com", "www.aljazeera.com"),
    default_language="en",
    edition="global",
    body_selectors=(
        ".wysiwyg",
        ".article__body",
        ".article__content",
        "article",
    ),
    remove_selectors=(".more-on",),
    preferred_image_hosts=("www.aljazeera.com",),
    use_structured_article_body=True,
)


def validation_candidate(normalized_url: str) -> bool:
    path = urlsplit(normalized_url).path
    if re.fullmatch(
        r"/gallery/(?:19|20)\d{2}/\d{1,2}/\d{1,2}/photo-\d+",
        path,
        flags=re.IGNORECASE,
    ):
        return False
    return re.fullmatch(
        r"/(?:[a-z0-9-]+/){1,2}(?:19|20)\d{2}/\d{1,2}/\d{1,2}/hold-[^/]+",
        path,
        flags=re.IGNORECASE,
    ) is None


def deduplication_key(normalized_url: str) -> str:
    match = re.match(
        r"^/(?:[a-z0-9-]+/){1,2}"
        r"((?:19|20)\d{2}/\d{1,2}/\d{1,2}/[^/]+)$",
        urlsplit(normalized_url).path,
        flags=re.IGNORECASE,
    )
    if match is not None:
        return f"aljazeera:{match.group(1).casefold()}"
    return normalized_url


def primary_validation_shard(year: int) -> str:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    return f"aljazeera/{window}/sitemap-wayback"


def supplemental_validation_shards(year: int) -> tuple[str, ...]:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    shards = [
        f"aljazeera/{window}/commoncrawl-prefix",
        f"aljazeera/{window}/wayback-urlkey",
    ]
    if year in {2016, 2017, 2018}:
        shards.insert(0, f"aljazeera/{year}-{year}/commoncrawl-prefix")
    return tuple(shards)


SOURCE = SourceModule(
    id="aljazeera",
    archive_spec=ARCHIVE_SPEC,
    parser_spec=PARSER_SPEC,
    capture_policy_version="aljazeera-capture/0.2.0",
    qa_policy_revision=6,
    validation_priority=10,
    catalog_targets=(
        SourceCatalogTargetSpec(0, 2010, 2015, "sitemap-wayback", 30),
        SourceCatalogTargetSpec(1, 2016, 2026, "sitemap-wayback", 30),
    ),
    minimum_validation_year=2010,
    primary_validation_shard=primary_validation_shard,
    supplemental_validation_shards=supplemental_validation_shards,
    validation_candidate=validation_candidate,
    deduplication_key=deduplication_key,
)
