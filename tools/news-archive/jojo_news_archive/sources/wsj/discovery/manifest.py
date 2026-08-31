from __future__ import annotations

import gzip
from pathlib import Path
import sqlite3

from jojo_news_archive.sources.contracts import ArchiveSourceSpec
from jojo_news_archive.sources.registry import normalize_article_url
from jojo_news_archive.sources.wsj.discovery.infini import (
    wsj_infini_capture_candidates,
    wsj_infini_should_continue,
    wsj_infini_summary,
)
from jojo_news_archive.sources.wsj.discovery.infini_direct import (
    wsj_infini_direct_capture_candidates,
    wsj_infini_direct_should_continue,
    wsj_infini_direct_summary,
)
from jojo_news_archive.sources.wsj.discovery.syndication import (
    wsj_syndication_articles,
    wsj_syndication_should_continue,
    wsj_syndication_summary,
)
from jojo_news_archive.sources.wsj.discovery.wayback import (
    _wsj_external_articles,
    _wsj_syndication_candidate,
    wsj_catalog_count_for_year,
    wsj_catalog_ready_for_capture,
    wsj_legacy_date_summary,
)


def export_wsj_capture_manifest(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    destination: Path,
    from_year: int,
    to_year: int,
    capture_minimum_per_year: int,
) -> dict[str, int | bool | str | object]:
    from jojo_news_archive.discovery.wayback import (
        approximate_wayback_candidates as _approximate_wayback_candidates,
        archived_date_summary,
        merge_capture_candidates as _merge_capture_candidates,
        timestamp_datetime as _timestamp_datetime,
        write_manifest_row as _write_manifest_row,
    )

    destination.parent.mkdir(parents=True, exist_ok=True)
    hydration_filter = (
        """
          AND canonical_url NOT IN (
              SELECT canonical_url FROM archived_date_hydration
              WHERE status != 'complete'
          )
        """
        if _table_exists(connection, "archived_date_hydration")
        else ""
    )
    rows = connection.execute(
        f"""
        SELECT canonical_url, published_at, timestamp, original_url,
               digest, mimetype, status_code, byte_count
        FROM candidates
        WHERE published_at >= ? AND published_at < ? {hydration_filter}
        ORDER BY canonical_url, rank_score, timestamp, digest
        """,
        (f"{from_year:04d}-01-01", f"{to_year + 1:04d}-01-01"),
    )
    articles: dict[str, tuple[str | None, list[dict[str, object]]]] = {}
    for row in rows:
        canonical_url = str(row[0])
        if normalize_article_url(spec, canonical_url) != canonical_url:
            continue
        published_at, candidates = articles.setdefault(
            canonical_url,
            (str(row[1]) if row[1] else None, []),
        )
        captured_at = _timestamp_datetime(str(row[2]))
        candidates.append(
            {
                "provider": "wayback",
                "snapshotUrl": (
                    f"https://web.archive.org/web/{row[2]}id_/{row[3]}"
                ),
                "capturedAt": captured_at.isoformat(),
                **({"digest": row[4]} if row[4] else {}),
                "mimeType": row[5],
                "statusCode": row[6],
                **({"byteCount": row[7]} if row[7] is not None else {}),
            }
        )

    external_articles = _wsj_external_articles(connection)
    infini_candidates = wsj_infini_capture_candidates(connection)
    direct_infini_candidates = wsj_infini_direct_capture_candidates(connection)
    syndicated_articles = wsj_syndication_articles(connection)
    for canonical_url, published_at in external_articles.items():
        if normalize_article_url(spec, canonical_url) != canonical_url:
            continue
        existing = articles.get(canonical_url)
        articles[canonical_url] = (
            published_at,
            existing[1] if existing is not None else [],
        )

    temporary = destination.with_suffix(destination.suffix + ".tmp")
    opener = gzip.open if destination.suffix == ".gz" else open
    article_count = 0
    candidate_count = 0
    with opener(temporary, "wt", encoding="utf-8") as handle:
        for canonical_url, (published_at, candidates) in articles.items():
            preferred: list[dict[str, object]] = []
            if canonical_url in direct_infini_candidates:
                preferred.append(direct_infini_candidates[canonical_url])
            if canonical_url in infini_candidates:
                preferred.append(infini_candidates[canonical_url])
            candidates = _merge_capture_candidates(preferred, candidates)
            if canonical_url in external_articles:
                candidates = _merge_capture_candidates(
                    candidates,
                    _approximate_wayback_candidates(
                        canonical_url,
                        published_at=published_at or external_articles[canonical_url],
                    ),
                )
            if canonical_url in syndicated_articles:
                candidates = _merge_capture_candidates(
                    [_wsj_syndication_candidate(syndicated_articles[canonical_url])],
                    candidates,
                )
            _write_manifest_row(
                handle,
                spec=spec,
                canonical_url=canonical_url,
                published_at=published_at,
                candidates=candidates,
            )
            article_count += 1
            candidate_count += len(candidates)
    temporary.replace(destination)

    incomplete = int(
        connection.execute(
            "SELECT COUNT(*) FROM discovery_queries WHERE status != 'complete'"
        ).fetchone()[0]
    )
    archived_dates = archived_date_summary(connection)
    if archived_dates is not None and archived_dates["remaining"] > 0:
        incomplete += 1
    for table in ("wsj_bluesky_state", "wsj_google_news_state"):
        if not _table_exists(connection, table):
            continue
        status = connection.execute(
            f"SELECT status FROM {table} WHERE singleton=1"
        ).fetchone()[0]
        if not str(status).startswith("complete"):
            incomplete += 1
    incomplete += int(wsj_syndication_should_continue(connection))
    incomplete += int(wsj_infini_should_continue(connection))
    incomplete += int(wsj_infini_direct_should_continue(connection))
    year_counts = {
        str(year): wsj_catalog_count_for_year(connection, year, spec=spec)
        for year in range(from_year, to_year + 1)
    }
    return {
        "publisher": spec.publisher,
        "fromYear": from_year,
        "toYear": to_year,
        "complete": incomplete == 0,
        "captureReady": wsj_catalog_ready_for_capture(
            connection,
            from_year=from_year,
            to_year=to_year,
            minimum_catalog=capture_minimum_per_year,
            spec=spec,
        ),
        "captureMinimumPerYear": capture_minimum_per_year,
        "yearCounts": year_counts,
        "remainingQueries": incomplete,
        "articles": article_count,
        "candidates": candidate_count,
        "manifest": str(destination),
    }


def augment_wsj_discovery_summary(
    connection: sqlite3.Connection,
    result: dict[str, object],
) -> dict[str, object]:
    article_urls = {
        str(row[0])
        for row in connection.execute(
            "SELECT DISTINCT canonical_url FROM candidates"
        )
    }
    article_urls.update(_wsj_external_articles(connection))
    result["articles"] = len(article_urls)
    state_fields = (
        (
            "wsj_bluesky_state",
            "wsjBluesky",
            "status, pages, posts_seen, urls_accepted, oldest_at, last_error",
            ("status", "pages", "postsSeen", "urlsAccepted", "oldestAt", "lastError"),
        ),
        (
            "wsj_rss_state",
            "wsjRss",
            "polls, feeds_checked, items_seen, urls_accepted, last_error",
            ("polls", "feedsChecked", "itemsSeen", "urlsAccepted", "lastError"),
        ),
        (
            "wsj_google_news_state",
            "wsjGoogleNews",
            "status, polls, items_seen, decodes_attempted, urls_accepted, last_error",
            ("status", "polls", "itemsSeen", "decodesAttempted", "urlsAccepted", "lastError"),
        ),
    )
    for table, output_key, fields, keys in state_fields:
        if not _table_exists(connection, table):
            continue
        row = connection.execute(
            f"SELECT {fields} FROM {table} WHERE singleton=1"
        ).fetchone()
        result[output_key] = dict(zip(keys, row, strict=True))
        if keys[0] == "status":
            result["shouldContinue"] = bool(result["shouldContinue"]) or not str(
                row[0]
            ).startswith("complete")

    extensions = (
        ("wsjSyndication", wsj_syndication_summary, wsj_syndication_should_continue),
        ("wsjInfini", wsj_infini_summary, wsj_infini_should_continue),
        ("wsjInfiniDirect", wsj_infini_direct_summary, wsj_infini_direct_should_continue),
    )
    for output_key, summary, should_continue in extensions:
        value = summary(connection)
        if value is not None:
            result[output_key] = value
            result["shouldContinue"] = bool(
                result["shouldContinue"]
            ) or should_continue(connection)
    legacy_dates = wsj_legacy_date_summary(connection)
    if legacy_dates is not None:
        result["wsjLegacyDates"] = legacy_dates
        result["shouldContinue"] = bool(
            result["shouldContinue"]
        ) or legacy_dates["remaining"] > 0
    return result


def _table_exists(connection: sqlite3.Connection, name: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone() is not None
