from jojo_news_archive.sources.contracts import (
    ArchiveSourceSpec,
    PublisherSpec,
    SourceModule,
)
from jojo_news_archive.sources.url import patterns


ARCHIVE_SPEC = ArchiveSourceSpec(
    publisher="bloomberg",
    canonical_host="www.bloomberg.com",
    wayback_patterns=(
        "www.bloomberg.com/news/articles/*",
        "www.bloomberg.com/opinion/articles/*",
        "www.bloomberg.com/features/*",
    ),
    accepted_path_patterns=patterns(
        r"^/news/articles/",
        r"^/opinion/articles/",
        r"^/features/",
    ),
)

PARSER_SPEC = PublisherSpec(
    publisher="bloomberg",
    parser_version="bloomberg-parser/0.10.300",
    domains=("bloomberg.com", "www.bloomberg.com"),
    default_language="en",
    edition="global",
    body_selectors=(
        ".body-copy-v2",
        ".body-copy",
        "[data-component='article-body']",
        ".article-body__content",
        "#story_content",
        "article .body-content",
        "article [itemprop='articleBody']",
        "main article[data-story-id]",
        ".dvz-content",
        "#main",
        "article",
    ),
    remove_selectors=(
        "[data-position='in-article']",
        "[data-position='mobile-box']",
        ".right-rail",
        ".recirc",
        ".inline-newsletter",
        ".news-designed-for-consumer-media",
        ".share-article-button",
        "[class*='share-article-button']",
        "#story_social_toolbar_top_container",
        "#story_social_toolbar_bottom",
        "#related_news_bottom",
        ".content-type-footer",
        ".topic-list",
        "table:has(.news-rsf-table-string)",
    ),
    text_block_selectors=(
        ".body-copy-v2 > div:not([class])",
        ".timeline_header #current-title",
        ".event .text",
        ".event .caption",
    ),
    preferred_image_hosts=("assets.bwbx.io", "assets.bwbx.com"),
)


def primary_validation_shard(year: int) -> str:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    return f"bloomberg/{window}/sitemap-wayback"


def supplemental_validation_shards(year: int) -> tuple[str, ...]:
    return ()

SOURCE = SourceModule(
    id="bloomberg",
    archive_spec=ARCHIVE_SPEC,
    parser_spec=PARSER_SPEC,
    capture_policy_version="bloomberg-capture/0.10.3",
    qa_policy_revision=0,
    validation_priority=1,
    minimum_validation_year=2010,
    primary_validation_shard=primary_validation_shard,
    supplemental_validation_shards=supplemental_validation_shards,
    wayback_timemap_fallback=True,
)
