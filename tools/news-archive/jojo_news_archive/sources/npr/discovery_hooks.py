from __future__ import annotations

import re
import sqlite3
from urllib.parse import parse_qs, urlsplit

from jojo_news_archive.sources.discovery_contracts import (
    SourceDiscoveryHooks,
    extract_structured_published_at,
    hostname_in,
    infer_iso_date,
    static_prefixes,
)


def story_id(value: str) -> int | None:
    parsed = urlsplit(value)
    if parsed.path.casefold() != "/templates/story/story.php":
        return None
    values = parse_qs(parsed.query).get("storyId") or parse_qs(
        parsed.query.casefold()
    ).get("storyid")
    try:
        return int(values[0]) if values else None
    except (TypeError, ValueError):
        return None


def infer_published_at(value: str) -> str | None:
    if not hostname_in(value, "npr.org"):
        return None
    return infer_iso_date(
        value,
        r"/(?:sections/[^/]+/)?(20\d{2})/(\d{2})/(\d{2})(?:/|$)",
    )


def prefix_query_priority(pattern: str, collection_id: str) -> int | None:
    if not pattern.endswith("/templates/story/story.php"):
        return None
    return -2 if collection_id.startswith("CC-MAIN-2018-") else -1


def order_prefix_hydration(
    connection: sqlite3.Connection,
    rows: list[tuple[object, ...]],
    from_year: int,
    to_year: int,
) -> list[tuple[object, ...]]:
    start = f"{from_year:04d}-01-01"
    end = f"{to_year + 1:04d}-01-01"
    target_story_ids = sorted(
        story
        for (canonical_url,) in connection.execute(
            "SELECT DISTINCT canonical_url FROM prefix_candidates "
            "WHERE published_at >= ? AND published_at < ?",
            (start, end),
        )
        if (story := story_id(str(canonical_url))) is not None
    )
    if not target_story_ids:
        return rows
    lower = target_story_ids[len(target_story_ids) // 100]
    upper = target_story_ids[len(target_story_ids) * 99 // 100]
    midpoint = (lower + upper) // 2
    return sorted(
        rows,
        key=lambda row: (
            int(row[1]),
            not (
                (current := story_id(str(row[0]))) is not None
                and lower <= current <= upper
            ),
            abs((current or 0) - midpoint),
            str(row[0]),
        ),
    )


HOOKS = SourceDiscoveryHooks(
    publisher="npr",
    owns_url=lambda value: hostname_in(value, "npr.org"),
    infer_published_at=infer_published_at,
    archived_date_extractor=extract_structured_published_at,
    prefix_patterns=static_prefixes(
        "www.npr.org/templates/story/story.php",
        "npr.org/templates/story/story.php",
    ),
    prefix_query_priority=prefix_query_priority,
    prefix_hydration_order=order_prefix_hydration,
)
