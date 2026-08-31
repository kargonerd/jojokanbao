from jojo_news_archive.sources.contracts import (
    ArchiveSourceSpec,
    PublisherSpec,
    SourceCatalogTargetSpec,
    SourceModule,
)
from jojo_news_archive.sources.url import patterns


ARCHIVE_SPEC = ArchiveSourceSpec(
    publisher="zaobao",
    canonical_host="www.zaobao.com.sg",
    wayback_patterns=("www.zaobao.com.sg/news/*",),
    accepted_path_patterns=patterns(r"^/(?:[a-z0-9-]+/)+story20\d{6}-\d+$"),
    rejected_path_patterns=patterns(r"^/(?:zvideos|podcast)(?:/|$)"),
)

PARSER_SPEC = PublisherSpec(
    publisher="zaobao",
    parser_version="zaobao-parser/0.1.22",
    domains=("zaobao.com.sg", "www.zaobao.com.sg"),
    default_language="zh",
    edition="sg",
    body_selectors=(
        ".field-name-body",
        ".article-content",
        "#article_content .a_body",
        "#article-content",
        "article",
    ),
    preferred_image_hosts=("www.zaobao.com.sg",),
    use_structured_article_body=True,
)


def primary_validation_shard(year: int) -> str:
    return "zaobao/2016-2026/sitemap-wayback"


def supplemental_validation_shards(year: int) -> tuple[str, ...]:
    return ()

SOURCE = SourceModule(
    id="zaobao",
    archive_spec=ARCHIVE_SPEC,
    parser_spec=PARSER_SPEC,
    capture_policy_version="zaobao-capture/1.0.1",
    qa_policy_revision=6,
    validation_priority=9,
    catalog_targets=(
        SourceCatalogTargetSpec(2, 2016, 2026, "sitemap-wayback", 30),
    ),
    minimum_validation_year=2016,
    primary_validation_shard=primary_validation_shard,
    supplemental_validation_shards=supplemental_validation_shards,
)
