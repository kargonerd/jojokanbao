from jojo_news_archive.sources.contracts import (
    ArchiveSourceSpec,
    PublisherSpec,
    SourceCatalogTargetSpec,
    SourceModule,
)
from jojo_news_archive.sources.url import patterns


ARCHIVE_SPEC = ArchiveSourceSpec(
    publisher="scmp",
    canonical_host="www.scmp.com",
    wayback_patterns=(
        "www.scmp.com/article/*",
        "www.scmp.com/*/article/*",
        "www.scmp.com/news/*",
        "www.scmp.com/business/*",
        "www.scmp.com/sport/*",
        "www.scmp.com/lifestyle/*",
        "www.scmp.com/tech/*",
        "www.scmp.com/comment/*",
        "www.scmp.com/asia/*",
        "www.scmp.com/infographics/*",
    ),
    accepted_path_patterns=patterns(r"^/article/\d+", r"^/.+/article/\d+"),
    rejected_path_patterns=patterns(r"^/(?:video|magazines)(?:/|$)"),
)

PARSER_SPEC = PublisherSpec(
    publisher="scmp",
    parser_version="scmp-parser/0.1.53",
    domains=("scmp.com", "www.scmp.com"),
    default_language="en",
    edition="hk",
    body_selectors=(
        ".article__body",
        ".article-body",
        "[data-qa='article-body']",
        "[class*='ArticleContent__StyledBody-']",
        ".pane-node-body .pane-content",
        ".pane-node-body .field-name-body",
        ".field-name-body",
        "article",
    ),
    text_block_selectors=(
        "[class*='Body__StyledFallBackDiv-']:not(:has(img))",
    ),
    preferred_image_hosts=("cdn.i-scmp.com", "www.scmp.com"),
    use_structured_article_body=True,
)


def primary_validation_shard(year: int) -> str:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    return f"scmp/{window}/wayback-urlkey"


def supplemental_validation_shards(year: int) -> tuple[str, ...]:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    return (
        f"scmp/{window}/sitemap-wayback",
        f"scmp/{window}/commoncrawl-prefix",
    )

SOURCE = SourceModule(
    id="scmp",
    archive_spec=ARCHIVE_SPEC,
    parser_spec=PARSER_SPEC,
    capture_policy_version="scmp-capture/1",
    qa_policy_revision=19,
    validation_priority=11,
    catalog_targets=(
        SourceCatalogTargetSpec(3, 2010, 2015, "sitemap-wayback", 30),
        SourceCatalogTargetSpec(4, 2016, 2026, "sitemap-wayback", 30),
        SourceCatalogTargetSpec(6, 2010, 2015, "wayback-urlkey", 10),
        SourceCatalogTargetSpec(8, 2016, 2026, "wayback-urlkey", 10),
    ),
    minimum_validation_year=2010,
    primary_validation_shard=primary_validation_shard,
    supplemental_validation_shards=supplemental_validation_shards,
)
