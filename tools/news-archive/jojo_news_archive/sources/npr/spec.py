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


ARCHIVE_SPEC = ArchiveSourceSpec(
    publisher="npr",
    canonical_host="www.npr.org",
    wayback_patterns=(
        "www.npr.org/{year}/*",
        "npr.org/{year}/*",
    ),
    accepted_path_patterns=patterns(
        r"^/20\d{2}/",
        r"^/sections/[^/]+/20\d{2}/",
        r"^/templates/story/story\.php(?:&storyId=\d+)?$",
    ),
    rejected_path_patterns=patterns(
        r"^/(?:programs|podcasts?|music)(?:/|$)",
        r"/(?:election-\d{4}-.+-results|excerpt-[a-z0-9-]+|nprs?-toy-stories|makeover-photos)(?:/|$)",
    ),
)

PARSER_SPEC = PublisherSpec(
    publisher="npr",
    parser_version="npr-parser/0.1.59",
    domains=("npr.org", "www.npr.org"),
    default_language="en",
    edition="us",
    body_selectors=(
        "#storytext",
        ".storytext",
        "[data-testid='storytext']",
        "article",
    ),
    preferred_image_hosts=("media.npr.org",),
    use_structured_article_body=True,
)


def normalize_url(spec: ArchiveSourceSpec, value: str) -> str | None:
    parts = article_url_parts(spec, value)
    if parts is None:
        return None
    legacy_story = re.search(
        r"(?i)(?:[?&]|%3f|%26)storyid(?:=|%3d)(\d+)",
        value,
    )
    if parts.path.casefold().startswith("/templates/story/story.php"):
        if legacy_story is None:
            return None
        return (
            "https://www.npr.org/templates/story/story.php?storyId="
            + legacy_story.group(1)
        )
    path = re.sub(
        r"(?i)(?:%(?:0[0-9a-f]|7f))+$",
        "",
        parts.path,
    ).rstrip("=")
    path = re.split(
        r"(?i)(?:&|%26)(?:sc|cc|ps)=",
        path,
        maxsplit=1,
    )[0]
    path = re.sub(r"(?i)(?:%5d|\])$", "", path)
    return finalize_article_url(spec, parts, path=path)


def deduplication_key(normalized_url: str) -> str:
    legacy_story = re.search(r"(?i)[?&]storyid=(\d+)", normalized_url)
    if legacy_story is not None:
        return f"npr:{legacy_story.group(1)}"
    match = re.match(
        r"^/(?:sections/[^/]+/)?\d{4}/\d{2}/\d{2}/(\d+)(?:/|$)",
        urlsplit(normalized_url).path,
    )
    return f"npr:{match.group(1)}" if match is not None else normalized_url


def publication_year(normalized_url: str) -> int | None:
    match = re.match(
        r"^/(?:sections/[^/]+/)?((?:19|20)\d{2})/\d{2}/\d{2}/"
        r"\d+(?:/|$)",
        urlsplit(normalized_url).path,
    )
    return int(match.group(1)) if match is not None else None


def primary_validation_shard(year: int) -> str:
    window = "2010-2015" if year <= 2015 else "2016-2026"
    return f"npr/{window}/wayback-urlkey"


def supplemental_validation_shards(year: int) -> tuple[str, ...]:
    shards = [
        f"npr/{year}-{year}/official-archive",
        f"npr/{year}-{year}/commoncrawl-prefix",
    ]
    if year <= 2015:
        shards.append("npr/2010-2015/commoncrawl-prefix")
    if 2012 <= year <= 2016:
        shards.append("npr/2012-2016/commoncrawl-prefix")
    if 2013 <= year <= 2026:
        shards.append("npr/2013-2026/commoncrawl-prefix")
    return tuple(shards)


SOURCE = SourceModule(
    id="npr",
    archive_spec=ARCHIVE_SPEC,
    parser_spec=PARSER_SPEC,
    capture_policy_version="npr-capture/1.2",
    qa_policy_revision=1,
    validation_priority=7,
    proven_rotated_validation_years=frozenset(
        {2010, 2011, 2012, 2013, 2026}
    ),
    minimum_validation_year=2010,
    primary_validation_shard=primary_validation_shard,
    supplemental_validation_shards=supplemental_validation_shards,
    wayback_timemap_fallback=True,
    normalize_url=normalize_url,
    deduplication_key=deduplication_key,
    publication_year=publication_year,
)
