from __future__ import annotations

import sqlite3
from pathlib import Path

from jojo_news_archive.sources.contracts import ArchiveSourceSpec
from jojo_news_archive.sources.discovery_contracts import (
    SourceDiscoveryHooks,
    hostname_in,
    infer_iso_date,
)
from jojo_news_archive.sources.wsj.spec import wsj_article_publication_datetime


def infer_published_at(value: str) -> str | None:
    if not hostname_in(value, "wsj.com", "online.wsj.com"):
        return None
    published = wsj_article_publication_datetime(value)
    if published is not None:
        return published.isoformat()
    return infer_iso_date(
        value,
        r"/article/(?:0(?:%2C|,){2})?BT-CO-(20\d{2})(\d{2})(\d{2})-",
    )


def preserve_hydration_order(
    connection: sqlite3.Connection,
    rows: list[tuple[object, ...]],
    from_year: int,
    to_year: int,
) -> list[tuple[object, ...]]:
    del connection, from_year, to_year
    return rows


def wayback_query_priority(pattern: str, from_year: int, to_year: int) -> int:
    del to_year
    return -1 if pattern == "online.wsj.com/article/*" and from_year <= 2013 else 0


def export_wayback_manifest(
    connection: sqlite3.Connection,
    spec: ArchiveSourceSpec,
    destination: Path,
    from_year: int,
    to_year: int,
    capture_minimum_per_year: int,
) -> dict[str, int | bool | str | object]:
    from jojo_news_archive.sources.wsj.discovery.manifest import (
        export_wsj_capture_manifest,
    )

    return export_wsj_capture_manifest(
        connection,
        spec=spec,
        destination=destination,
        from_year=from_year,
        to_year=to_year,
        capture_minimum_per_year=capture_minimum_per_year,
    )


def augment_wayback_summary(
    connection: sqlite3.Connection,
    result: dict[str, object],
) -> dict[str, object]:
    from jojo_news_archive.sources.wsj.discovery.manifest import (
        augment_wsj_discovery_summary,
    )

    return augment_wsj_discovery_summary(connection, result)


HOOKS = SourceDiscoveryHooks(
    publisher="wsj",
    owns_url=lambda value: hostname_in(value, "wsj.com", "online.wsj.com"),
    infer_published_at=infer_published_at,
    prefix_hydration_order=preserve_hydration_order,
    wayback_manifest_exporter=export_wayback_manifest,
    wayback_summary=augment_wayback_summary,
    wayback_query_priority=wayback_query_priority,
)
