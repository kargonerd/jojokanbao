from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import html
import json
from pathlib import Path
import sqlite3
import time
from typing import Iterable
from urllib.parse import parse_qs, urlsplit

import httpx
from dateutil.parser import isoparse

from .archive_sources import archive_source_spec, normalize_article_url
from .bloomberg_archive_download import ArchiveClient
from .sitemap_manifest import parse_url_sitemap, wayback_candidates
from .wayback_manifest import with_current_year_live_fallback
from .wayback_manifest import (
    CDX_ENDPOINT,
    MANIFEST_FORMAT_VERSION,
    infer_published_at,
    parse_cdx_json,
)


REUTERS_SITEMAP_DISCOVERY_VERSION = "jojo-reuters-sitemap-discovery/2"
URLSCAN_SEARCH_ENDPOINT = "https://urlscan.io/api/v1/search/"
URLSCAN_DISCOVERY_START_YEAR = 2021
REUTERS_LIVE_SITEMAP_INDEX = (
    "https://www.reuters.com/arc/outboundfeeds/sitemap-index/"
    "?outputType=xml"
)
REUTERS_YEAR_CATALOG_TARGET = 750
RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
SITEMAP_CDX_PATTERN = (
    "www.reuters.com/arc/outboundfeeds/sitemap/*"
)
SITEMAP_ORIGINAL_FILTER = (
    r"original:.*outboundfeeds/sitemap/\?outputType=xml.*"
)


def discover_reuters_sitemap_captures(
    *,
    from_year: int,
    to_year: int,
    timeout: float = 90.0,
    attempts: int = 5,
    retry_backoff_seconds: float = 1.0,
    client: httpx.Client | None = None,
) -> list[dict[str, object]]:
    if attempts < 1:
        raise ValueError("attempts must be at least 1")
    provided = client is not None
    http_client = client or httpx.Client(
        headers={
            "User-Agent": (
                "JOJO-News-Archive-Research/0.1 "
                "(authorized nonprofit academic archive)"
            )
        },
        follow_redirects=True,
        timeout=timeout,
    )
    try:
        parameters: list[tuple[str, str]] = [
            ("url", SITEMAP_CDX_PATTERN),
            ("output", "json"),
            (
                "fl",
                "timestamp,original,mimetype,statuscode,digest,length",
            ),
            ("filter", "statuscode:200"),
            ("filter", SITEMAP_ORIGINAL_FILTER),
            ("collapse", "digest"),
            ("from", str(from_year)),
            ("to", str(to_year)),
            ("limit", "5000"),
            ("showResumeKey", "true"),
        ]
        for attempt in range(attempts):
            try:
                response = http_client.get(CDX_ENDPOINT, params=parameters)
                if response.status_code in RETRYABLE_STATUS_CODES:
                    raise RuntimeError(
                        f"retryable HTTP {response.status_code}"
                    )
                response.raise_for_status()
                break
            except (httpx.HTTPError, OSError, RuntimeError):
                if attempt + 1 >= attempts:
                    raise
                time.sleep(
                    min(
                        30.0,
                        retry_backoff_seconds * (2**attempt),
                    )
                )
        page = parse_cdx_json(response.text)
        if page.resume_key:
            raise RuntimeError(
                "Reuters sitemap CDX query exceeded 5,000 rows; "
                "resume-key pagination must be added"
            )
        return [
            {
                "timestamp": capture.timestamp,
                "originalUrl": html.unescape(capture.original),
                "digest": capture.digest or "",
                "byteCount": capture.length,
            }
            for capture in page.captures
        ]
    finally:
        if not provided:
            http_client.close()


def initialize_reuters_sitemap_schema(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
    captures: Iterable[dict[str, object]],
) -> None:
    connection.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;

        CREATE TABLE IF NOT EXISTS reuters_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS reuters_sitemap_captures (
            snapshot_url TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            original_url TEXT NOT NULL,
            digest TEXT NOT NULL,
            byte_count INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            rows_seen INTEGER NOT NULL DEFAULT 0,
            rows_accepted INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS reuters_articles (
            canonical_url TEXT PRIMARY KEY,
            published_at TEXT,
            source_snapshot_url TEXT NOT NULL,
            discovery_source TEXT NOT NULL DEFAULT 'reuters-sitemap',
            updated_at TEXT NOT NULL
        );
        """
    )
    article_columns = {
        row[1]
        for row in connection.execute(
            "PRAGMA table_info(reuters_articles)"
        )
    }
    if "discovery_source" not in article_columns:
        connection.execute(
            """
            ALTER TABLE reuters_articles
            ADD COLUMN discovery_source TEXT
            NOT NULL DEFAULT 'reuters-sitemap'
            """
        )
    existing = {
        row[0]: row[1]
        for row in connection.execute(
            "SELECT key, value FROM reuters_metadata"
        )
    }
    if existing and (
        existing.get("from_year") != str(from_year)
        or existing.get("to_year") != str(to_year)
    ):
        raise ValueError(
            "Reuters sitemap state belongs to a different date window"
        )
    connection.executemany(
        """
        INSERT INTO reuters_metadata(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        {
            "schema_version": REUTERS_SITEMAP_DISCOVERY_VERSION,
            "publisher": "reuters",
            "from_year": str(from_year),
            "to_year": str(to_year),
        }.items(),
    )
    rows = []
    for capture in captures:
        timestamp = str(capture["timestamp"])
        original_url = str(capture["originalUrl"])
        snapshot_url = (
            f"https://web.archive.org/web/{timestamp}id_/{original_url}"
        )
        rows.append(
            (
                snapshot_url,
                timestamp,
                original_url,
                str(capture.get("digest") or ""),
                capture.get("byteCount"),
                _now_iso(),
            )
        )
    connection.executemany(
        """
        INSERT OR IGNORE INTO reuters_sitemap_captures(
            snapshot_url,
            timestamp,
            original_url,
            digest,
            byte_count,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    connection.execute(
        """
        UPDATE reuters_sitemap_captures
        SET status='pending',
            last_error='interrupted before completion',
            updated_at=?
        WHERE status='processing'
        """,
        (_now_iso(),),
    )
    connection.commit()


def pending_reuters_sitemaps(
    connection: sqlite3.Connection,
    *,
    maximum: int,
    maximum_attempts: int,
) -> list[tuple[str, int]]:
    return connection.execute(
        """
        SELECT snapshot_url, attempts
        FROM reuters_sitemap_captures
        WHERE status='pending'
           OR (status='error' AND attempts < ?)
        ORDER BY timestamp, original_url
        LIMIT ?
        """,
        (maximum_attempts, maximum),
    ).fetchall()


def process_reuters_sitemap(
    connection: sqlite3.Connection,
    *,
    snapshot_url: str,
    archive_client: ArchiveClient,
    from_year: int,
    to_year: int,
    maximum_bytes: int = 10 * 1024 * 1024,
) -> dict[str, object]:
    with connection:
        connection.execute(
            """
            UPDATE reuters_sitemap_captures
            SET status='processing',
                attempts=attempts+1,
                last_error=NULL,
                updated_at=?
            WHERE snapshot_url=?
            """,
            (_now_iso(), snapshot_url),
        )
    try:
        status, _, content, _ = archive_client.fetch(
            snapshot_url,
            maximum_bytes=maximum_bytes,
        )
        if status not in {200, 206}:
            raise RuntimeError(f"HTTP {status}")
        entries = parse_url_sitemap(content)
        rows = _reuters_article_rows(
            entries,
            source_url=snapshot_url,
            from_year=from_year,
            to_year=to_year,
        )
        with connection:
            before = connection.total_changes
            connection.executemany(
                """
                INSERT INTO reuters_articles(
                    canonical_url,
                    published_at,
                    source_snapshot_url,
                    discovery_source,
                    updated_at
                ) VALUES (?, ?, ?, 'reuters-sitemap', ?)
                ON CONFLICT(canonical_url) DO UPDATE SET
                    published_at=COALESCE(
                        reuters_articles.published_at,
                        excluded.published_at
                    ),
                    source_snapshot_url=excluded.source_snapshot_url,
                    updated_at=excluded.updated_at
                """,
                rows,
            )
            accepted = connection.total_changes - before
            connection.execute(
                """
                UPDATE reuters_sitemap_captures
                SET status='complete',
                    rows_seen=?,
                    rows_accepted=?,
                    updated_at=?
                WHERE snapshot_url=?
                """,
                (len(entries), accepted, _now_iso(), snapshot_url),
            )
        return {
            "status": "complete",
            "seen": len(entries),
            "accepted": accepted,
        }
    except Exception as exc:
        with connection:
            connection.execute(
                """
                UPDATE reuters_sitemap_captures
                SET status='error',
                    last_error=?,
                    updated_at=?
                WHERE snapshot_url=?
                """,
                (f"{type(exc).__name__}: {exc}", _now_iso(), snapshot_url),
            )
        return {
            "status": "error",
            "seen": 0,
            "accepted": 0,
        }


def initialize_reuters_urlscan_queries(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
    today: date | None = None,
) -> int:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS reuters_urlscan_queries (
            window_start TEXT PRIMARY KEY,
            window_end TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            rows_seen INTEGER NOT NULL DEFAULT 0,
            rows_accepted INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );
        """
    )
    current = today or datetime.now(timezone.utc).date()
    first_year = max(from_year, URLSCAN_DISCOVERY_START_YEAR)
    last_year = min(to_year, current.year)
    rows: list[tuple[str, str, str]] = []
    for year in range(first_year, last_year + 1):
        if (
            reuters_article_count_for_year(connection, year)
            >= REUTERS_YEAR_CATALOG_TARGET
        ):
            continue
        window_start = date(year, 1, 1)
        year_end = min(
            date(year + 1, 1, 1),
            current + timedelta(days=1),
        )
        while window_start < year_end:
            window_end = min(window_start + timedelta(days=7), year_end)
            rows.append(
                (
                    window_start.isoformat(),
                    window_end.isoformat(),
                    _now_iso(),
                )
            )
            window_start = window_end
    before = connection.total_changes
    connection.executemany(
        """
        INSERT OR IGNORE INTO reuters_urlscan_queries(
            window_start,
            window_end,
            updated_at
        ) VALUES (?, ?, ?)
        """,
        rows,
    )
    connection.execute(
        """
        UPDATE reuters_urlscan_queries
        SET status='pending',
            last_error='interrupted before completion',
            updated_at=?
        WHERE status='processing'
        """,
        (_now_iso(),),
    )
    connection.commit()
    return connection.total_changes - before


def initialize_reuters_live_sitemaps(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
    http_client: httpx.Client,
    today: date | None = None,
) -> int:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS reuters_live_sitemaps (
            sitemap_url TEXT PRIMARY KEY,
            last_modified TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            rows_seen INTEGER NOT NULL DEFAULT 0,
            rows_accepted INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );
        """
    )
    connection.execute(
        """
        UPDATE reuters_live_sitemaps
        SET status='pending',
            last_error='interrupted before completion',
            updated_at=?
        WHERE status='processing'
        """,
        (_now_iso(),),
    )
    current = today or datetime.now(timezone.utc).date()
    if not from_year <= current.year <= to_year:
        connection.commit()
        return 0
    if (
        reuters_article_count_for_year(connection, current.year)
        >= REUTERS_YEAR_CATALOG_TARGET
    ):
        connection.execute(
            """
            UPDATE reuters_live_sitemaps
            SET status='skipped-target-met',
                last_error=NULL,
                updated_at=?
            WHERE status='pending' OR status='error'
            """,
            (_now_iso(),),
        )
        connection.commit()
        return 0
    response = http_client.get(REUTERS_LIVE_SITEMAP_INDEX)
    response.raise_for_status()
    entries = parse_url_sitemap(response.content)
    rows = [
        (url, last_modified, _now_iso())
        for url, last_modified in entries
        if _is_reuters_live_sitemap_url(url)
    ]
    if not rows:
        raise ValueError("Reuters live sitemap index contains no child sitemaps")
    before = connection.total_changes
    connection.executemany(
        """
        INSERT INTO reuters_live_sitemaps(
            sitemap_url,
            last_modified,
            updated_at
        ) VALUES (?, ?, ?)
        ON CONFLICT(sitemap_url) DO UPDATE SET
            last_modified=excluded.last_modified,
            updated_at=excluded.updated_at
        """,
        rows,
    )
    added_or_refreshed = connection.total_changes - before
    connection.commit()
    return added_or_refreshed


def pending_reuters_live_sitemaps(
    connection: sqlite3.Connection,
    *,
    maximum: int,
    maximum_attempts: int,
) -> list[str]:
    if not _table_exists(connection, "reuters_live_sitemaps"):
        return []
    return [
        row[0]
        for row in connection.execute(
            """
            SELECT sitemap_url
            FROM reuters_live_sitemaps
            WHERE status='pending'
               OR (status='error' AND attempts < ?)
            ORDER BY
                CASE
                    WHEN sitemap_url LIKE '%&from=%' THEN 1
                    ELSE 0
                END,
                LENGTH(sitemap_url),
                sitemap_url
            LIMIT ?
            """,
            (maximum_attempts, maximum),
        ).fetchall()
    ]


def process_reuters_live_sitemap(
    connection: sqlite3.Connection,
    *,
    sitemap_url: str,
    http_client: httpx.Client,
    from_year: int,
    to_year: int,
    maximum_bytes: int = 10 * 1024 * 1024,
) -> dict[str, object]:
    with connection:
        connection.execute(
            """
            UPDATE reuters_live_sitemaps
            SET status='processing',
                attempts=attempts+1,
                last_error=NULL,
                updated_at=?
            WHERE sitemap_url=?
            """,
            (_now_iso(), sitemap_url),
        )
    try:
        response = http_client.get(sitemap_url)
        response.raise_for_status()
        content = response.content
        if len(content) > maximum_bytes:
            raise ValueError(
                f"Reuters live sitemap exceeds {maximum_bytes} bytes"
            )
        entries = parse_url_sitemap(content)
        rows = _reuters_article_rows(
            entries,
            source_url=sitemap_url,
            from_year=from_year,
            to_year=to_year,
        )
        with connection:
            before = connection.total_changes
            connection.executemany(
                """
                INSERT INTO reuters_articles(
                    canonical_url,
                    published_at,
                    source_snapshot_url,
                    discovery_source,
                    updated_at
                ) VALUES (?, ?, ?, 'reuters-live-sitemap', ?)
                ON CONFLICT(canonical_url) DO UPDATE SET
                    published_at=COALESCE(
                        reuters_articles.published_at,
                        excluded.published_at
                    ),
                    updated_at=excluded.updated_at
                """,
                rows,
            )
            accepted = connection.total_changes - before
            connection.execute(
                """
                UPDATE reuters_live_sitemaps
                SET status='complete',
                    rows_seen=?,
                    rows_accepted=?,
                    updated_at=?
                WHERE sitemap_url=?
                """,
                (len(entries), accepted, _now_iso(), sitemap_url),
            )
        return {
            "status": "complete",
            "sitemapUrl": sitemap_url,
            "seen": len(entries),
            "accepted": accepted,
        }
    except Exception as exc:
        with connection:
            connection.execute(
                """
                UPDATE reuters_live_sitemaps
                SET status='error',
                    last_error=?,
                    updated_at=?
                WHERE sitemap_url=?
                """,
                (
                    f"{type(exc).__name__}: {exc}",
                    _now_iso(),
                    sitemap_url,
                ),
            )
        return {
            "status": "error",
            "sitemapUrl": sitemap_url,
            "seen": 0,
            "accepted": 0,
        }


def skip_reuters_live_sitemaps_if_target_met(
    connection: sqlite3.Connection,
    *,
    year: int,
) -> bool:
    if (
        reuters_article_count_for_year(connection, year)
        < REUTERS_YEAR_CATALOG_TARGET
    ):
        return False
    with connection:
        connection.execute(
            """
            UPDATE reuters_live_sitemaps
            SET status='skipped-target-met',
                last_error=NULL,
                updated_at=?
            WHERE status='pending'
               OR status='error'
            """,
            (_now_iso(),),
        )
    return True


def reuters_article_count_for_year(
    connection: sqlite3.Connection,
    year: int,
) -> int:
    return int(
        connection.execute(
            """
            SELECT COUNT(*)
            FROM reuters_articles
            WHERE substr(published_at, 1, 4)=?
            """,
            (str(year),),
        ).fetchone()[0]
    )


def pending_reuters_urlscan_queries(
    connection: sqlite3.Connection,
    *,
    maximum: int,
    maximum_attempts: int,
) -> list[tuple[str, str]]:
    if not _table_exists(connection, "reuters_urlscan_queries"):
        return []
    return connection.execute(
        """
        SELECT window_start, window_end
        FROM reuters_urlscan_queries
        WHERE status='pending'
           OR (status='error' AND attempts < ?)
        ORDER BY window_start
        LIMIT ?
        """,
        (maximum_attempts, maximum),
    ).fetchall()


def process_reuters_urlscan_query(
    connection: sqlite3.Connection,
    *,
    window_start: str,
    window_end: str,
    http_client: httpx.Client,
    from_year: int,
    to_year: int,
) -> dict[str, object]:
    with connection:
        connection.execute(
            """
            UPDATE reuters_urlscan_queries
            SET status='processing',
                attempts=attempts+1,
                last_error=NULL,
                updated_at=?
            WHERE window_start=?
            """,
            (_now_iso(), window_start),
        )
    try:
        response = http_client.get(
            URLSCAN_SEARCH_ENDPOINT,
            params={
                "q": (
                    "page.domain:www.reuters.com "
                    f"AND date:[{window_start} TO {window_end}]"
                ),
                "size": "100",
            },
        )
        response.raise_for_status()
        payload = response.json()
        results = payload.get("results")
        if not isinstance(results, list):
            raise ValueError("urlscan response has no results list")
        publisher_spec = archive_source_spec("reuters")
        discovered: dict[str, str] = {}
        for result in results:
            if not isinstance(result, dict):
                continue
            for container_name in ("page", "task"):
                container = result.get(container_name)
                if not isinstance(container, dict):
                    continue
                value = container.get("url")
                if not isinstance(value, str):
                    continue
                canonical_url = normalize_article_url(
                    publisher_spec,
                    value,
                )
                if not canonical_url:
                    continue
                published_at = infer_published_at(canonical_url)
                if not published_at:
                    continue
                published_year = isoparse(published_at).year
                if not from_year <= published_year <= to_year:
                    continue
                discovered[canonical_url] = published_at
        with connection:
            before = connection.total_changes
            connection.executemany(
                """
                INSERT OR IGNORE INTO reuters_articles(
                    canonical_url,
                    published_at,
                    source_snapshot_url,
                    discovery_source,
                    updated_at
                ) VALUES (?, ?, ?, 'urlscan', ?)
                """,
                (
                    (
                        canonical_url,
                        published_at,
                        URLSCAN_SEARCH_ENDPOINT,
                        _now_iso(),
                    )
                    for canonical_url, published_at in discovered.items()
                ),
            )
            accepted = connection.total_changes - before
            connection.execute(
                """
                UPDATE reuters_urlscan_queries
                SET status='complete',
                    rows_seen=?,
                    rows_accepted=?,
                    updated_at=?
                WHERE window_start=?
                """,
                (
                    len(results),
                    accepted,
                    _now_iso(),
                    window_start,
                ),
            )
        return {
            "status": "complete",
            "windowStart": window_start,
            "windowEnd": window_end,
            "seen": len(results),
            "accepted": accepted,
        }
    except Exception as exc:
        with connection:
            connection.execute(
                """
                UPDATE reuters_urlscan_queries
                SET status='error',
                    last_error=?,
                    updated_at=?
                WHERE window_start=?
                """,
                (
                    f"{type(exc).__name__}: {exc}",
                    _now_iso(),
                    window_start,
                ),
            )
        return {
            "status": "error",
            "windowStart": window_start,
            "windowEnd": window_end,
            "seen": 0,
            "accepted": 0,
        }


def export_reuters_manifest(
    connection: sqlite3.Connection,
    *,
    destination: Path,
    from_year: int,
    to_year: int,
    maximum_attempts: int,
) -> dict[str, object]:
    import gzip

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    opener = gzip.open if destination.suffix == ".gz" else open
    articles = 0
    candidates = 0
    with opener(temporary, "wt", encoding="utf-8") as handle:
        for canonical_url, published_at, discovery_source in connection.execute(
            """
            SELECT canonical_url, published_at, discovery_source
            FROM reuters_articles
            ORDER BY canonical_url
            """
        ):
            candidate_rows = wayback_candidates(
                canonical_url,
                published_at=published_at,
            )
            candidate_rows = with_current_year_live_fallback(
                candidate_rows,
                canonical_url=canonical_url,
                published_at=published_at,
            )
            if (
                discovery_source in {"urlscan", "reuters-live-sitemap"}
                and not any(
                    candidate.get("provider") == "live-origin"
                    for candidate in candidate_rows
                )
            ):
                candidate_rows.append(
                    {
                        "provider": "live-origin",
                        "snapshotUrl": canonical_url,
                    }
                )
            row = {
                "formatVersion": MANIFEST_FORMAT_VERSION,
                "publisher": "reuters",
                "canonicalUrl": canonical_url,
                "publishedAt": published_at,
                "candidates": candidate_rows,
            }
            handle.write(
                json.dumps(row, ensure_ascii=False, separators=(",", ":"))
                + "\n"
            )
            articles += 1
            candidates += len(candidate_rows)
    temporary.replace(destination)
    actionable = connection.execute(
        """
        SELECT COUNT(*)
        FROM reuters_sitemap_captures
        WHERE status='pending'
           OR (status='error' AND attempts < ?)
        """,
        (maximum_attempts,),
    ).fetchone()[0]
    if _table_exists(connection, "reuters_urlscan_queries"):
        actionable += connection.execute(
            """
            SELECT COUNT(*)
            FROM reuters_urlscan_queries
            WHERE status='pending'
               OR (status='error' AND attempts < ?)
            """,
            (maximum_attempts,),
        ).fetchone()[0]
    if _table_exists(connection, "reuters_live_sitemaps"):
        actionable += connection.execute(
            """
            SELECT COUNT(*)
            FROM reuters_live_sitemaps
            WHERE status='pending'
               OR (status='error' AND attempts < ?)
            """,
            (maximum_attempts,),
        ).fetchone()[0]
    terminal_errors = connection.execute(
        """
        SELECT COUNT(*)
        FROM reuters_sitemap_captures
        WHERE status='error' AND attempts >= ?
        """,
        (maximum_attempts,),
    ).fetchone()[0]
    if _table_exists(connection, "reuters_urlscan_queries"):
        terminal_errors += connection.execute(
            """
            SELECT COUNT(*)
            FROM reuters_urlscan_queries
            WHERE status='error' AND attempts >= ?
            """,
            (maximum_attempts,),
        ).fetchone()[0]
    if _table_exists(connection, "reuters_live_sitemaps"):
        terminal_errors += connection.execute(
            """
            SELECT COUNT(*)
            FROM reuters_live_sitemaps
            WHERE status='error' AND attempts >= ?
            """,
            (maximum_attempts,),
        ).fetchone()[0]
    return {
        "publisher": "reuters",
        "fromYear": from_year,
        "toYear": to_year,
        "complete": actionable == 0,
        "shouldContinue": actionable > 0,
        "remainingSitemaps": actionable,
        "terminalSitemapErrors": terminal_errors,
        "articles": articles,
        "candidates": candidates,
        "manifest": str(destination),
    }


def reuters_sitemap_summary(
    connection: sqlite3.Connection,
) -> dict[str, object]:
    statuses = dict(
        connection.execute(
            """
            SELECT status, COUNT(*)
            FROM reuters_sitemap_captures
            GROUP BY status
            """
        ).fetchall()
    )
    totals = connection.execute(
        """
        SELECT
            COALESCE(SUM(rows_seen), 0),
            COALESCE(SUM(rows_accepted), 0)
        FROM reuters_sitemap_captures
        """
    ).fetchone()
    articles = connection.execute(
        "SELECT COUNT(*) FROM reuters_articles"
    ).fetchone()[0]
    result = {
        "sitemapsByStatus": statuses,
        "rowsSeen": int(totals[0]),
        "rowsAccepted": int(totals[1]),
        "articles": int(articles),
    }
    if _table_exists(connection, "reuters_urlscan_queries"):
        result["urlscanQueriesByStatus"] = dict(
            connection.execute(
                """
                SELECT status, COUNT(*)
                FROM reuters_urlscan_queries
                GROUP BY status
                """
            ).fetchall()
        )
    if _table_exists(connection, "reuters_live_sitemaps"):
        result["liveSitemapsByStatus"] = dict(
            connection.execute(
                """
                SELECT status, COUNT(*)
                FROM reuters_live_sitemaps
                GROUP BY status
                """
            ).fetchall()
        )
    return result


def _reuters_article_rows(
    entries: Iterable[tuple[str, str | None]],
    *,
    source_url: str,
    from_year: int,
    to_year: int,
) -> list[tuple[str, str, str, str]]:
    rows: list[tuple[str, str, str, str]] = []
    publisher_spec = archive_source_spec("reuters")
    for original_url, last_modified in entries:
        canonical_url = normalize_article_url(
            publisher_spec,
            original_url,
        )
        if not canonical_url:
            continue
        published_at = infer_published_at(canonical_url)
        if not published_at:
            published_at = _valid_last_modified(
                last_modified,
                from_year=from_year,
                to_year=to_year,
            )
        if not published_at:
            continue
        published_year = isoparse(published_at).year
        if not from_year <= published_year <= to_year:
            continue
        rows.append(
            (
                canonical_url,
                published_at,
                source_url,
                _now_iso(),
            )
        )
    return rows


def _is_reuters_live_sitemap_url(value: str) -> bool:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or parsed.netloc != "www.reuters.com":
        return False
    if parsed.path != "/arc/outboundfeeds/sitemap/":
        return False
    return parse_qs(parsed.query).get("outputType") == ["xml"]


def _valid_last_modified(
    value: str | None,
    *,
    from_year: int,
    to_year: int,
) -> str | None:
    if not value:
        return None
    try:
        parsed = isoparse(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not from_year <= parsed.year <= to_year:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _table_exists(connection: sqlite3.Connection, name: str) -> bool:
    return (
        connection.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type='table' AND name=?
            """,
            (name,),
        ).fetchone()
        is not None
    )
