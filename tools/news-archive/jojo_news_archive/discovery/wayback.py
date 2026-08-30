from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
from typing import Iterable
from urllib.parse import urlsplit
from xml.etree import ElementTree

import httpx
from bs4 import BeautifulSoup

from jojo_news_archive.sources.registry import (
    ArchiveSourceSpec,
    ap_hosted_publication_datetime,
    archive_source_spec,
    normalize_article_url,
    wsj_article_publication_datetime,
)
from jojo_news_archive.discovery.client import GlobalRateLimiter
from jojo_news_archive.discovery.wsj_infini import (
    wsj_infini_articles,
    wsj_infini_capture_candidates,
    wsj_infini_should_continue,
    wsj_infini_summary,
)
from jojo_news_archive.discovery.wsj_infini_direct import (
    wsj_infini_direct_capture_candidates,
    wsj_infini_direct_should_continue,
    wsj_infini_direct_summary,
)
from jojo_news_archive.discovery.wsj_syndication import (
    wsj_syndication_articles,
    wsj_syndication_should_continue,
    wsj_syndication_summary,
)


CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx"
RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
DISCOVERY_SCHEMA_VERSION = "jojo-wayback-discovery/1"
MANIFEST_FORMAT_VERSION = "jojo-capture-manifest/1"
WSJ_BLUESKY_ENDPOINT = (
    "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed"
)
WSJ_BLUESKY_START_YEAR = 2024
WSJ_CATALOG_TARGET_PER_YEAR = 750
WSJ_GOOGLE_NEWS_YEARS = (2023, 2024)
WSJ_GOOGLE_NEWS_MINIMUM_CATALOG = 750
WSJ_GOOGLE_NEWS_MAXIMUM_DECODES = 100
GOOGLE_NEWS_RSS_ENDPOINT = "https://news.google.com/rss/search"
GOOGLE_NEWS_DECODE_ENDPOINT = (
    "https://news.google.com/_/DotsSplashUi/data/batchexecute"
)
WSJ_RSS_ENDPOINTS = (
    "https://feeds.content.dowjones.io/public/rss/RSSOpinion",
    "https://feeds.content.dowjones.io/public/rss/RSSWorldNews",
    "https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness",
    "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain",
    "https://feeds.content.dowjones.io/public/rss/RSSWSJD",
    "https://feeds.content.dowjones.io/public/rss/RSSLifestyle",
    "https://feeds.content.dowjones.io/public/rss/RSSUSnews",
    "https://feeds.content.dowjones.io/public/rss/socialpoliticsfeed",
    "https://feeds.content.dowjones.io/public/rss/socialeconomyfeed",
    "https://feeds.content.dowjones.io/public/rss/RSSArtsCulture",
    "https://feeds.content.dowjones.io/public/rss/latestnewsrealestate",
    "https://feeds.content.dowjones.io/public/rss/RSSPersonalFinance",
    "https://feeds.content.dowjones.io/public/rss/socialhealth",
    "https://feeds.content.dowjones.io/public/rss/RSSStyle",
    "https://feeds.content.dowjones.io/public/rss/rsssportsfeed",
)
PARSER_VALIDATION_CATALOG_MINIMUM_PER_YEAR = 750
WSJ_LEGACY_DATE_HYDRATIONS_PER_RUN = 100
ARCHIVED_DATE_HYDRATION_PUBLISHERS = {"nikkei", "npr", "scmp"}
ARCHIVED_DATE_HYDRATIONS_PER_RUN = 100


@dataclass(frozen=True)
class CDXCapture:
    timestamp: str
    original: str
    mimetype: str
    status_code: int
    digest: str | None
    length: int | None

    @property
    def snapshot_url(self) -> str:
        return (
            f"https://web.archive.org/web/{self.timestamp}id_/{self.original}"
        )


@dataclass(frozen=True)
class CDXPage:
    captures: tuple[CDXCapture, ...]
    resume_key: str | None


class WaybackCDXClient:
    def __init__(
        self,
        *,
        minimum_interval: float = 1.0,
        timeout: float = 90.0,
        attempts: int = 6,
        page_limit: int = 10_000,
        collapse: str = "digest",
        client: httpx.Client | None = None,
    ) -> None:
        if collapse not in {"digest", "urlkey"}:
            raise ValueError("collapse must be 'digest' or 'urlkey'")
        self.rate_limiter = GlobalRateLimiter(minimum_interval)
        self.timeout = timeout
        self.attempts = attempts
        self.page_limit = page_limit
        self.collapse = collapse
        self._provided_client = client
        self._client = client or httpx.Client(
            headers={
                "User-Agent": (
                    "JOJO-News-Archive-Research/0.1 "
                    "(nonprofit academic archive; contact via repository)"
                )
            },
            follow_redirects=True,
            timeout=timeout,
        )

    def close(self) -> None:
        if self._provided_client is None:
            self._client.close()

    def fetch_page(
        self,
        *,
        pattern: str,
        from_year: int,
        to_year: int,
        resume_key: str | None,
    ) -> CDXPage:
        parameters: list[tuple[str, str]] = [
            ("url", pattern),
            ("output", "json"),
            (
                "fl",
                "timestamp,original,mimetype,statuscode,digest,length",
            ),
            ("filter", "statuscode:200"),
            ("filter", "mimetype:text/html"),
            ("collapse", self.collapse),
            ("from", str(from_year)),
            ("to", str(to_year)),
            ("limit", str(self.page_limit)),
            ("showResumeKey", "true"),
        ]
        if resume_key:
            parameters.append(("resumeKey", resume_key))
        last_status: int | None = None
        for attempt in range(self.attempts):
            self.rate_limiter.wait()
            try:
                response = self._client.get(CDX_ENDPOINT, params=parameters)
                last_status = response.status_code
                if response.status_code in RETRYABLE_STATUS_CODES:
                    raise RuntimeError(f"retryable HTTP {response.status_code}")
                response.raise_for_status()
                return parse_cdx_json(response.text)
            except (httpx.HTTPError, RuntimeError, ValueError):
                if attempt + 1 >= self.attempts:
                    break
                time.sleep(min(60.0, 2.0**attempt))
        raise RuntimeError(
            f"Wayback CDX query failed after {self.attempts} attempts"
            + (f" (last HTTP status {last_status})" if last_status else "")
        )


def parse_cdx_json(value: str) -> CDXPage:
    payload = json.loads(value)
    if not isinstance(payload, list) or not payload:
        return CDXPage(captures=(), resume_key=None)
    header = payload[0]
    expected = [
        "timestamp",
        "original",
        "mimetype",
        "statuscode",
        "digest",
        "length",
    ]
    if header != expected:
        raise ValueError(f"unexpected CDX header: {header!r}")
    captures: list[CDXCapture] = []
    resume_key: str | None = None
    for row in payload[1:]:
        if row == []:
            continue
        if isinstance(row, list) and len(row) == 1:
            resume_key = str(row[0]) or None
            continue
        if not isinstance(row, list) or len(row) != len(expected):
            raise ValueError(f"unexpected CDX row: {row!r}")
        captures.append(
            CDXCapture(
                timestamp=str(row[0]),
                original=str(row[1]),
                mimetype=str(row[2]),
                status_code=int(row[3]),
                digest=str(row[4]) if row[4] not in {None, "-"} else None,
                length=int(row[5]) if str(row[5]).isdigit() else None,
            )
        )
    return CDXPage(captures=tuple(captures), resume_key=resume_key)


def initialize_discovery_schema(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    from_year: int,
    to_year: int,
    collapse: str = "digest",
) -> None:
    connection.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;

        CREATE TABLE IF NOT EXISTS discovery_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS discovery_queries (
            pattern TEXT PRIMARY KEY,
            resume_key TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            pages INTEGER NOT NULL DEFAULT 0,
            rows_seen INTEGER NOT NULL DEFAULT 0,
            rows_accepted INTEGER NOT NULL DEFAULT 0,
            failures INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS candidates (
            canonical_url TEXT NOT NULL,
            published_at TEXT,
            timestamp TEXT NOT NULL,
            original_url TEXT NOT NULL,
            digest TEXT NOT NULL DEFAULT '',
            mimetype TEXT NOT NULL,
            status_code INTEGER NOT NULL,
            byte_count INTEGER,
            rank_score INTEGER NOT NULL,
            PRIMARY KEY(canonical_url, timestamp, digest)
        );

        CREATE INDEX IF NOT EXISTS idx_candidates_canonical_rank
            ON candidates(canonical_url, rank_score, timestamp);
        """
    )
    query_columns = {
        str(row[1])
        for row in connection.execute("PRAGMA table_info(discovery_queries)")
    }
    if "failures" not in query_columns:
        connection.execute(
            "ALTER TABLE discovery_queries "
            "ADD COLUMN failures INTEGER NOT NULL DEFAULT 0"
        )
    if "last_error" not in query_columns:
        connection.execute(
            "ALTER TABLE discovery_queries ADD COLUMN last_error TEXT"
        )
    fingerprint = _spec_fingerprint(
        spec,
        from_year=from_year,
        to_year=to_year,
        collapse=collapse,
    )
    patterns = spec.expanded_wayback_patterns(
        from_year=from_year,
        to_year=to_year,
    )
    existing = connection.execute(
        "SELECT value FROM discovery_metadata WHERE key='fingerprint'"
    ).fetchone()
    if existing and existing[0] != fingerprint:
        previous_metadata = dict(
            connection.execute(
                """
                SELECT key, value
                FROM discovery_metadata
                WHERE key IN ('publisher', 'from_year', 'to_year', 'collapse')
                """
            ).fetchall()
        )
        previous_patterns = {
            str(row[0])
            for row in connection.execute(
                "SELECT pattern FROM discovery_queries"
            )
        }
        current_patterns = set(patterns)
        same_scope = previous_metadata == {
            "publisher": spec.publisher,
            "from_year": str(from_year),
            "to_year": str(to_year),
            "collapse": collapse,
        }
        if not same_scope or not previous_patterns < current_patterns:
            raise ValueError(
                "discovery state belongs to a different publisher, date window, or spec"
            )
    metadata = {
        "schema_version": DISCOVERY_SCHEMA_VERSION,
        "publisher": spec.publisher,
        "from_year": str(from_year),
        "to_year": str(to_year),
        "collapse": collapse,
        "fingerprint": fingerprint,
    }
    connection.executemany(
        """
        INSERT INTO discovery_metadata(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        metadata.items(),
    )
    connection.executemany(
        """
        INSERT OR IGNORE INTO discovery_queries(pattern, updated_at)
        VALUES (?, ?)
        """,
        [(pattern, _now_iso()) for pattern in patterns],
    )
    # URL inference evolves as additional publisher URL families are found.
    # Reclassify persisted candidates whenever a stronger publication date is
    # now available so an old capture timestamp cannot masquerade as an
    # article publication year in a resumed discovery database.
    corrected_rows: list[tuple[str, int, str, str, str]] = []
    for canonical_url, timestamp, digest, published_at in connection.execute(
        """
        SELECT canonical_url, timestamp, digest, published_at
        FROM candidates
        """
    ):
        inferred = infer_published_at(str(canonical_url))
        if inferred and inferred != published_at:
            corrected_rows.append(
                (
                    inferred,
                    candidate_rank(
                        str(timestamp),
                        published_at=inferred,
                    ),
                    str(canonical_url),
                    str(timestamp),
                    str(digest),
                )
            )
    connection.executemany(
        """
        UPDATE candidates
        SET published_at=?, rank_score=?
        WHERE canonical_url=? AND timestamp=? AND digest=?
        """,
        corrected_rows,
    )
    connection.execute(
        """
        DELETE FROM candidates
        WHERE published_at IS NOT NULL
          AND (
            published_at < ?
            OR published_at >= ?
          )
        """,
        (
            f"{from_year:04d}-01-01",
            f"{to_year + 1:04d}-01-01",
        ),
    )
    connection.commit()


def initialize_wsj_legacy_date_schema(
    connection: sqlite3.Connection,
) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS wsj_legacy_date_hydration (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            published_at TEXT,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_wsj_legacy_date_status
            ON wsj_legacy_date_hydration(status, attempts, updated_at);
        """
    )
    undated_urls = [
        (str(row[0]), _now_iso())
        for row in connection.execute(
            "SELECT DISTINCT canonical_url FROM candidates"
        )
        if infer_published_at(str(row[0])) is None
    ]
    connection.executemany(
        """
        INSERT OR IGNORE INTO wsj_legacy_date_hydration(
            canonical_url, updated_at
        ) VALUES (?, ?)
        """,
        undated_urls,
    )
    connection.execute(
        """
        DELETE FROM candidates
        WHERE canonical_url IN (
            SELECT canonical_url
            FROM wsj_legacy_date_hydration
            WHERE status='no-date'
        )
        """
    )
    connection.commit()


def process_wsj_legacy_dates(
    connection: sqlite3.Connection,
    *,
    http_client: httpx.Client,
    maximum: int = WSJ_LEGACY_DATE_HYDRATIONS_PER_RUN,
    minimum_request_interval: float = 0.0,
) -> dict[str, object]:
    """Replace capture-time guesses with dates embedded in legacy WSJ pages."""
    if maximum < 1:
        raise ValueError("maximum must be positive")
    initialize_wsj_legacy_date_schema(connection)
    rows = connection.execute(
        """
        SELECT hydration.canonical_url, candidate.timestamp,
               candidate.original_url
        FROM wsj_legacy_date_hydration AS hydration
        JOIN candidates AS candidate
          ON candidate.canonical_url=hydration.canonical_url
        WHERE hydration.status IN ('pending', 'retry')
          AND hydration.attempts < 3
          AND candidate.rowid=(
              SELECT selected.rowid
              FROM candidates AS selected
              WHERE selected.canonical_url=hydration.canonical_url
              ORDER BY selected.rank_score, selected.timestamp
              LIMIT 1
          )
        ORDER BY hydration.attempts, hydration.updated_at,
                 hydration.canonical_url
        LIMIT ?
        """,
        (maximum,),
    ).fetchall()
    limiter = GlobalRateLimiter(minimum_request_interval)
    found = 0
    rejected = 0
    errors: list[str] = []
    window = dict(
        connection.execute(
            """
            SELECT key, value FROM discovery_metadata
            WHERE key IN ('from_year', 'to_year')
            """
        )
    )
    for canonical_url, timestamp, original_url in rows:
        snapshot_url = (
            f"https://web.archive.org/web/{timestamp}id_/{original_url}"
        )
        status = "retry"
        published_at = None
        error = None
        try:
            limiter.wait()
            response = http_client.get(snapshot_url)
            response.raise_for_status()
            published_at = extract_wsj_legacy_published_at(response.text)
            if published_at is None:
                status = "no-date"
                rejected += 1
            else:
                status = "complete"
                found += 1
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            errors.append(f"{canonical_url}: {error}")
        with connection:
            connection.execute(
                """
                UPDATE wsj_legacy_date_hydration
                SET status=?, attempts=attempts+1, published_at=?,
                    last_error=?, updated_at=?
                WHERE canonical_url=?
                """,
                (
                    status,
                    published_at,
                    error,
                    _now_iso(),
                    canonical_url,
                ),
            )
            if published_at is not None:
                candidate_rows = connection.execute(
                    """
                    SELECT timestamp, digest FROM candidates
                    WHERE canonical_url=?
                    """,
                    (canonical_url,),
                ).fetchall()
                connection.executemany(
                    """
                    UPDATE candidates SET published_at=?, rank_score=?
                    WHERE canonical_url=? AND timestamp=? AND digest=?
                    """,
                    [
                        (
                            published_at,
                            candidate_rank(
                                str(candidate_timestamp),
                                published_at=published_at,
                            ),
                            canonical_url,
                            candidate_timestamp,
                            digest,
                        )
                        for candidate_timestamp, digest in candidate_rows
                    ],
                )
                if not (
                    f"{int(window['from_year']):04d}-01-01"
                    <= published_at
                    < f"{int(window['to_year']) + 1:04d}-01-01"
                ):
                    connection.execute(
                        "DELETE FROM candidates WHERE canonical_url=?",
                        (canonical_url,),
                    )
            elif status == "no-date":
                # A capture timestamp is not evidence of publication time.
                # Keeping this row would silently place an undated legacy
                # article in the year when Wayback happened to crawl it.
                connection.execute(
                    "DELETE FROM candidates WHERE canonical_url=?",
                    (canonical_url,),
                )
    remaining = connection.execute(
        """
        SELECT COUNT(*) FROM wsj_legacy_date_hydration
        WHERE status IN ('pending', 'retry') AND attempts < 3
        """
    ).fetchone()[0]
    return {
        "attempted": len(rows),
        "found": found,
        "noDate": rejected,
        "remaining": int(remaining),
        "errors": errors,
    }


def wsj_legacy_date_summary(
    connection: sqlite3.Connection,
) -> dict[str, int] | None:
    if not _table_exists(connection, "wsj_legacy_date_hydration"):
        return None
    row = connection.execute(
        """
        SELECT
            COUNT(*),
            SUM(status='complete'),
            SUM(status='no-date'),
            SUM(status IN ('pending', 'retry') AND attempts < 3)
        FROM wsj_legacy_date_hydration
        """
    ).fetchone()
    return {
        "total": int(row[0] or 0),
        "complete": int(row[1] or 0),
        "noDate": int(row[2] or 0),
        "remaining": int(row[3] or 0),
    }


def initialize_archived_date_schema(
    connection: sqlite3.Connection,
    *,
    publisher: str,
) -> None:
    """Track URL families whose publication year is absent from the URL."""
    if publisher not in ARCHIVED_DATE_HYDRATION_PUBLISHERS:
        raise ValueError(
            f"archived date hydration is not supported for {publisher!r}"
        )
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS archived_date_hydration (
            canonical_url TEXT PRIMARY KEY,
            publisher TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            published_at TEXT,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_archived_date_hydration_status
            ON archived_date_hydration(publisher, status, attempts, updated_at);
        """
    )
    spec = archive_source_spec(publisher)
    candidate_urls = [
        str(row[0])
        for row in connection.execute(
            "SELECT DISTINCT canonical_url FROM candidates"
        )
    ]
    valid_urls = {
        canonical_url
        for canonical_url in candidate_urls
        if normalize_article_url(spec, canonical_url) == canonical_url
    }
    undated_urls = [
        (canonical_url, publisher, _now_iso())
        for canonical_url in valid_urls
        if infer_published_at(canonical_url) is None
    ]
    connection.executemany(
        """
        INSERT OR IGNORE INTO archived_date_hydration(
            canonical_url, publisher, updated_at
        ) VALUES (?, ?, ?)
        """,
        undated_urls,
    )
    # A stricter URL family may be deployed after a resumable CDX checkpoint
    # was first written.  Such stale rows are already excluded at manifest
    # export; exclude them from hydration as well so we do not spend archived
    # requests trying to extract dates from prefix keys or static assets.
    invalid_urls = set(candidate_urls) - valid_urls
    connection.executemany(
        """
        DELETE FROM archived_date_hydration
        WHERE canonical_url=? AND publisher=?
        """,
        [(canonical_url, publisher) for canonical_url in invalid_urls],
    )
    # A capture timestamp is not publication-date evidence. Permanently
    # rejected or exhausted rows must never leak back into a yearly manifest.
    connection.execute(
        """
        DELETE FROM candidates
        WHERE canonical_url IN (
            SELECT canonical_url
            FROM archived_date_hydration
            WHERE publisher=? AND status IN ('no-date', 'failed')
        )
        """,
        (publisher,),
    )
    connection.commit()


def process_archived_dates(
    connection: sqlite3.Connection,
    *,
    publisher: str,
    http_client: httpx.Client,
    maximum: int = ARCHIVED_DATE_HYDRATIONS_PER_RUN,
    minimum_request_interval: float = 0.0,
) -> dict[str, object]:
    """Recover exact publication dates from archived publisher markup."""
    if maximum < 1:
        raise ValueError("maximum must be positive")
    initialize_archived_date_schema(connection, publisher=publisher)
    rows = connection.execute(
        """
        SELECT canonical_url, attempts
        FROM archived_date_hydration
        WHERE publisher=?
          AND status IN ('pending', 'retry')
          AND attempts < 3
        ORDER BY attempts, updated_at, canonical_url
        LIMIT ?
        """,
        (publisher, maximum),
    ).fetchall()
    limiter = GlobalRateLimiter(minimum_request_interval)
    found = 0
    rejected = 0
    failed = 0
    errors: list[str] = []
    window = dict(
        connection.execute(
            """
            SELECT key, value FROM discovery_metadata
            WHERE key IN ('from_year', 'to_year')
            """
        )
    )
    for canonical_url, prior_attempts in rows:
        candidates = connection.execute(
            """
            SELECT timestamp, original_url
            FROM candidates
            WHERE canonical_url=?
            ORDER BY rank_score, timestamp
            LIMIT 3
            """,
            (canonical_url,),
        ).fetchall()
        published_at = None
        successful_response = False
        request_errors: list[str] = []
        for timestamp, original_url in candidates:
            snapshot_url = (
                f"https://web.archive.org/web/{timestamp}id_/"
                f"{original_url}"
            )
            try:
                limiter.wait()
                response = http_client.get(snapshot_url)
                response.raise_for_status()
                successful_response = True
                published_at = extract_archived_published_at(
                    response.text,
                    publisher=publisher,
                )
                if published_at is not None:
                    break
            except Exception as exc:
                request_errors.append(f"{type(exc).__name__}: {exc}")
        attempts = int(prior_attempts) + 1
        if published_at is not None:
            status = "complete"
            error = None
            found += 1
        elif successful_response and not request_errors:
            status = "no-date"
            error = None
            rejected += 1
        elif attempts >= 3:
            status = "failed"
            error = "; ".join(request_errors) or "no usable archived page"
            failed += 1
        else:
            status = "retry"
            error = "; ".join(request_errors) or "no usable archived page"
        if error:
            errors.append(f"{canonical_url}: {error}")
        with connection:
            connection.execute(
                """
                UPDATE archived_date_hydration
                SET status=?, attempts=?, published_at=?, last_error=?,
                    updated_at=?
                WHERE canonical_url=? AND publisher=?
                """,
                (
                    status,
                    attempts,
                    published_at,
                    error,
                    _now_iso(),
                    canonical_url,
                    publisher,
                ),
            )
            if published_at is not None:
                candidate_rows = connection.execute(
                    """
                    SELECT timestamp, digest FROM candidates
                    WHERE canonical_url=?
                    """,
                    (canonical_url,),
                ).fetchall()
                connection.executemany(
                    """
                    UPDATE candidates SET published_at=?, rank_score=?
                    WHERE canonical_url=? AND timestamp=? AND digest=?
                    """,
                    [
                        (
                            published_at,
                            candidate_rank(
                                str(candidate_timestamp),
                                published_at=published_at,
                            ),
                            canonical_url,
                            candidate_timestamp,
                            digest,
                        )
                        for candidate_timestamp, digest in candidate_rows
                    ],
                )
                if not (
                    f"{int(window['from_year']):04d}-01-01"
                    <= published_at
                    < f"{int(window['to_year']) + 1:04d}-01-01"
                ):
                    connection.execute(
                        "DELETE FROM candidates WHERE canonical_url=?",
                        (canonical_url,),
                    )
            elif status in {"no-date", "failed"}:
                connection.execute(
                    "DELETE FROM candidates WHERE canonical_url=?",
                    (canonical_url,),
                )
    remaining = connection.execute(
        """
        SELECT COUNT(*) FROM archived_date_hydration
        WHERE publisher=?
          AND status IN ('pending', 'retry')
          AND attempts < 3
        """,
        (publisher,),
    ).fetchone()[0]
    return {
        "attempted": len(rows),
        "found": found,
        "noDate": rejected,
        "failed": failed,
        "remaining": int(remaining),
        "errors": errors,
    }


def archived_date_summary(
    connection: sqlite3.Connection,
) -> dict[str, int] | None:
    if not _table_exists(connection, "archived_date_hydration"):
        return None
    row = connection.execute(
        """
        SELECT
            COUNT(*),
            SUM(status='complete'),
            SUM(status='no-date'),
            SUM(status='failed'),
            SUM(status IN ('pending', 'retry') AND attempts < 3)
        FROM archived_date_hydration
        """
    ).fetchone()
    return {
        "total": int(row[0] or 0),
        "complete": int(row[1] or 0),
        "noDate": int(row[2] or 0),
        "failed": int(row[3] or 0),
        "remaining": int(row[4] or 0),
    }


def extract_archived_published_at(
    html: str,
    *,
    publisher: str,
) -> str | None:
    if publisher not in ARCHIVED_DATE_HYDRATION_PUBLISHERS:
        raise ValueError(
            f"archived date extraction is not supported for {publisher!r}"
        )
    # Prefer publisher-provided structured timestamps when present. Both
    # Nikkei and SCMP have used JSON-LD/Open Graph on newer archived
    # templates, while their older templates need the visible selectors
    # below. Keeping both families here prevents a template transition from
    # being mistaken for an undated article.
    structured = extract_wsj_legacy_published_at(html)
    if structured is not None:
        return structured
    soup = BeautifulSoup(html, "html.parser")
    if publisher == "nikkei":
        node = soup.select_one(".cmnc-publish")
        value = (
            " ".join(node.get_text(" ", strip=True).split()) if node else ""
        )
        match = re.search(
            r"(?P<year>20\d{2})\s*(?:/|年)\s*"
            r"(?P<month>\d{1,2})\s*(?:/|月)\s*"
            r"(?P<day>\d{1,2})(?:日)?",
            value,
        )
        if match is None:
            return None
        try:
            parsed = datetime(
                int(match.group("year")),
                int(match.group("month")),
                int(match.group("day")),
                tzinfo=timezone(timedelta(hours=9)),
            )
        except ValueError:
            return None
        return parsed.isoformat()

    node = soup.select_one(
        ".pane-node-created .pane-content, .pane-node-created"
    )
    value = " ".join(node.get_text(" ", strip=True).split()) if node else ""
    match = re.search(
        r"(?P<day>\d{1,2})\s+(?P<month>[A-Za-z]+),?\s+"
        r"(?P<year>20\d{2}),?\s+"
        r"(?P<time>\d{1,2}:\d{2}\s*[ap]m)",
        value,
        flags=re.IGNORECASE,
    )
    if match is None:
        return None
    normalized = (
        f"{match.group('day')} {match.group('month')} "
        f"{match.group('year')} {match.group('time').replace(' ', '')}"
    )
    for format_string in ("%d %B %Y %I:%M%p", "%d %b %Y %I:%M%p"):
        try:
            parsed = datetime.strptime(normalized, format_string)
        except ValueError:
            continue
        return parsed.replace(
            tzinfo=timezone(timedelta(hours=8))
        ).isoformat()
    return None


def extract_wsj_legacy_published_at(html: str) -> str | None:
    patterns = (
        r"""publicationDate\s*[:=]\s*['"]([^'"]+)""",
        r"""property=['"]article:published_time['"][^>]*content=['"]([^'"]+)""",
        r"""name=['"]article\.published['"][^>]*content=['"]([^'"]+)""",
        r"""["']datePublished["']\s*:\s*["']([^"']+)""",
    )
    for pattern in patterns:
        match = re.search(pattern, html, flags=re.IGNORECASE)
        if match is None:
            continue
        value = _parse_iso_datetime(match.group(1))
        if value is not None and 1900 <= value.year <= 2100:
            return value.isoformat()
    return None


def initialize_wsj_bluesky_schema(
    connection: sqlite3.Connection,
) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS wsj_bluesky_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            cursor TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            pages INTEGER NOT NULL DEFAULT 0,
            posts_seen INTEGER NOT NULL DEFAULT 0,
            urls_accepted INTEGER NOT NULL DEFAULT 0,
            oldest_at TEXT,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wsj_bluesky_articles (
            canonical_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            post_uri TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    connection.execute(
        """
        INSERT OR IGNORE INTO wsj_bluesky_state(
            singleton,
            updated_at
        ) VALUES (1, ?)
        """,
        (_now_iso(),),
    )
    connection.execute(
        """
        UPDATE wsj_bluesky_state
        SET status='running',
            last_error='interrupted before completion',
            updated_at=?
        WHERE singleton=1 AND status='processing'
        """,
        (_now_iso(),),
    )
    connection.commit()


def initialize_wsj_rss_schema(
    connection: sqlite3.Connection,
) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS wsj_rss_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            polls INTEGER NOT NULL DEFAULT 0,
            feeds_checked INTEGER NOT NULL DEFAULT 0,
            items_seen INTEGER NOT NULL DEFAULT 0,
            urls_accepted INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wsj_rss_articles (
            canonical_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            feed_url TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    connection.execute(
        """
        INSERT OR IGNORE INTO wsj_rss_state(
            singleton,
            updated_at
        ) VALUES (1, ?)
        """,
        (_now_iso(),),
    )
    connection.commit()


def initialize_wsj_google_news_schema(
    connection: sqlite3.Connection,
) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS wsj_google_news_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            status TEXT NOT NULL DEFAULT 'pending',
            polls INTEGER NOT NULL DEFAULT 0,
            items_seen INTEGER NOT NULL DEFAULT 0,
            decodes_attempted INTEGER NOT NULL DEFAULT 0,
            urls_accepted INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wsj_google_news_articles (
            canonical_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            google_news_url TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    connection.execute(
        """
        INSERT OR IGNORE INTO wsj_google_news_state(
            singleton,
            updated_at
        ) VALUES (1, ?)
        """,
        (_now_iso(),),
    )
    connection.commit()


def wsj_google_news_should_continue(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
    minimum_catalog: int = WSJ_GOOGLE_NEWS_MINIMUM_CATALOG,
) -> bool:
    initialize_wsj_google_news_schema(connection)
    if (
        _wsj_google_news_target_year(
            connection,
            from_year=from_year,
            to_year=to_year,
            minimum_catalog=minimum_catalog,
        )
        is None
    ):
        with connection:
            connection.execute(
                """
                UPDATE wsj_google_news_state
                SET status='complete-target-met',
                    last_error=NULL,
                    updated_at=?
                WHERE singleton=1
                """,
                (_now_iso(),),
            )
        return False
    # A previous release may have persisted complete-target-met after filling
    # only one historical year. Reopen until every supported gap year has the
    # parser-QA reserve.
    return True


def wsj_google_news_is_only_catalog_gap(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
    minimum_catalog: int = WSJ_GOOGLE_NEWS_MINIMUM_CATALOG,
) -> bool:
    gap_years = {
        year
        for year in range(from_year, to_year + 1)
        if wsj_catalog_count_for_year(connection, year) < minimum_catalog
    }
    return bool(gap_years) and gap_years.issubset(WSJ_GOOGLE_NEWS_YEARS)


def process_wsj_google_news_feed(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    http_client: httpx.Client,
    from_year: int,
    to_year: int,
    maximum_decodes: int = WSJ_GOOGLE_NEWS_MAXIMUM_DECODES,
    minimum_catalog: int = WSJ_GOOGLE_NEWS_MINIMUM_CATALOG,
) -> dict[str, object]:
    if spec.publisher != "wsj":
        raise ValueError("Google News discovery is only supported for WSJ")
    if maximum_decodes < 1:
        raise ValueError("maximum_decodes must be positive")
    initialize_wsj_google_news_schema(connection)
    polls = int(
        connection.execute(
            "SELECT polls FROM wsj_google_news_state WHERE singleton=1"
        ).fetchone()[0]
    )
    target_year = _wsj_google_news_target_year(
        connection,
        from_year=from_year,
        to_year=to_year,
        minimum_catalog=minimum_catalog,
    )
    if target_year is None:
        return {
            "status": "complete-target-met",
            "targetYear": None,
            "itemsSeen": 0,
            "decodesAttempted": 0,
            "accepted": 0,
            "catalogCount": None,
            "errors": [],
        }
    month = polls % 12 + 1
    window_start = f"{target_year:04d}-{month:02d}-01"
    if month == 12:
        window_end = f"{target_year + 1:04d}-01-01"
    else:
        window_end = f"{target_year:04d}-{month + 1:02d}-01"
    query = (
        "site:wsj.com/articles "
        f"after:{window_start} before:{window_end}"
    )
    response = http_client.get(
        GOOGLE_NEWS_RSS_ENDPOINT,
        params={
            "q": query,
            "hl": "en-US",
            "gl": "US",
            "ceid": "US:en",
        },
    )
    response.raise_for_status()
    root = ElementTree.fromstring(response.content)
    items = root.findall("./channel/item")
    rows: list[tuple[str, str, str, str]] = []
    errors: list[str] = []
    decodes_attempted = 0
    for item in items:
        if decodes_attempted >= maximum_decodes:
            break
        published_at = _parse_rss_datetime(item.findtext("pubDate"))
        if (
            published_at is None
            or published_at.year != target_year
            or not from_year <= published_at.year <= to_year
        ):
            continue
        google_news_url = (item.findtext("link") or "").strip()
        if not google_news_url:
            continue
        decodes_attempted += 1
        try:
            original_url = _decode_google_news_url(
                http_client,
                google_news_url,
            )
            canonical_url = normalize_article_url(spec, original_url)
            if canonical_url is None:
                raise ValueError("decoded URL is not a WSJ article")
            rows.append(
                (
                    canonical_url,
                    published_at.isoformat(),
                    google_news_url,
                    _now_iso(),
                )
            )
        except Exception as exc:
            errors.append(f"{type(exc).__name__}: {exc}")
    with connection:
        before = connection.total_changes
        connection.executemany(
            """
            INSERT INTO wsj_google_news_articles(
                canonical_url,
                published_at,
                google_news_url,
                updated_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(canonical_url) DO UPDATE SET
                published_at=MIN(
                    wsj_google_news_articles.published_at,
                    excluded.published_at
                ),
                google_news_url=excluded.google_news_url,
                updated_at=excluded.updated_at
            """,
            rows,
        )
        accepted = connection.total_changes - before
        catalog_count = wsj_catalog_count_for_year(
            connection,
            target_year,
        )
        status = (
            "complete-target-met"
            if _wsj_google_news_target_year(
                connection,
                from_year=from_year,
                to_year=to_year,
                minimum_catalog=minimum_catalog,
            )
            is None
            else "partial"
        )
        connection.execute(
            """
            UPDATE wsj_google_news_state
            SET status=?,
                polls=polls+1,
                items_seen=items_seen+?,
                decodes_attempted=decodes_attempted+?,
                urls_accepted=urls_accepted+?,
                last_error=?,
                updated_at=?
            WHERE singleton=1
            """,
            (
                status,
                len(items),
                decodes_attempted,
                accepted,
                "; ".join(errors[-5:]) if errors else None,
                _now_iso(),
            ),
        )
    return {
        "status": status,
        "targetYear": target_year,
        "itemsSeen": len(items),
        "decodesAttempted": decodes_attempted,
        "accepted": accepted,
        "catalogCount": catalog_count,
        "errors": errors,
    }


def _wsj_google_news_target_year(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
    minimum_catalog: int,
) -> int | None:
    years = [
        year
        for year in WSJ_GOOGLE_NEWS_YEARS
        if from_year <= year <= to_year
        and wsj_catalog_count_for_year(connection, year) < minimum_catalog
    ]
    if not years:
        return None
    return min(
        years,
        key=lambda year: (wsj_catalog_count_for_year(connection, year), year),
    )


def _decode_google_news_url(
    http_client: httpx.Client,
    google_news_url: str,
) -> str:
    parsed = httpx.URL(google_news_url)
    path_parts = [part for part in parsed.path.split("/") if part]
    if (
        parsed.host != "news.google.com"
        or len(path_parts) < 2
        or path_parts[-2] not in {"articles", "read"}
    ):
        raise ValueError("invalid Google News article URL")
    article_id = path_parts[-1]
    parameter_response = http_client.get(
        f"https://news.google.com/rss/articles/{article_id}"
    )
    parameter_response.raise_for_status()
    signature_match = re.search(
        r'data-n-a-sg="([^"]+)"',
        parameter_response.text,
    )
    timestamp_match = re.search(
        r'data-n-a-ts="(\d+)"',
        parameter_response.text,
    )
    if signature_match is None or timestamp_match is None:
        raise ValueError("Google News decoding parameters are missing")
    descriptor = [
        "garturlreq",
        [
            [
                "X",
                "X",
                ["X", "X"],
                None,
                None,
                1,
                1,
                "US:en",
                None,
                1,
                None,
                None,
                None,
                None,
                None,
                0,
                1,
            ],
            "X",
            "X",
            1,
            [1, 1, 1],
            1,
            1,
            None,
            0,
            0,
            None,
            0,
        ],
        article_id,
        int(timestamp_match.group(1)),
        signature_match.group(1),
    ]
    request_payload = [
        [
            [
                "Fbv4je",
                json.dumps(
                    descriptor,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            ]
        ]
    ]
    decode_response = http_client.post(
        GOOGLE_NEWS_DECODE_ENDPOINT,
        data={
            "f.req": json.dumps(
                request_payload,
                ensure_ascii=False,
                separators=(",", ":"),
            )
        },
        headers={
            "Origin": "https://news.google.com",
            "Referer": "https://news.google.com/",
        },
    )
    decode_response.raise_for_status()
    for chunk in decode_response.text.split("\n\n"):
        try:
            payload = json.loads(chunk)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, list):
            continue
        for row in payload:
            if (
                not isinstance(row, list)
                or len(row) < 3
                or row[0] not in {"wrb.fr", "w779db"}
                or row[1] != "Fbv4je"
            ):
                continue
            inner = json.loads(row[2])
            if (
                isinstance(inner, list)
                and len(inner) >= 2
                and str(inner[1]).startswith(("http://", "https://"))
            ):
                return str(inner[1])
    raise ValueError("Google News decoded URL is missing")


def process_wsj_rss_feeds(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    http_client: httpx.Client,
    from_year: int,
    to_year: int,
    feed_urls: Iterable[str] = WSJ_RSS_ENDPOINTS,
) -> dict[str, object]:
    if spec.publisher != "wsj":
        raise ValueError("RSS discovery is only supported for WSJ")
    initialize_wsj_rss_schema(connection)
    rows: list[tuple[str, str, str, str]] = []
    feeds_checked = 0
    items_seen = 0
    errors: list[str] = []
    for feed_url in feed_urls:
        try:
            response = http_client.get(feed_url)
            response.raise_for_status()
            root = ElementTree.fromstring(response.content)
            items = root.findall("./channel/item")
            feeds_checked += 1
            items_seen += len(items)
            for item in items:
                original_url = (
                    (item.findtext("link") or "").strip()
                    or (item.findtext("guid") or "").strip()
                )
                canonical_url = normalize_article_url(spec, original_url)
                if canonical_url is None:
                    continue
                published_at = _parse_rss_datetime(
                    item.findtext("pubDate")
                )
                if published_at is None:
                    continue
                if not from_year <= published_at.year <= to_year:
                    continue
                rows.append(
                    (
                        canonical_url,
                        published_at.isoformat(),
                        feed_url,
                        _now_iso(),
                    )
                )
        except Exception as exc:
            errors.append(
                f"{feed_url}: {type(exc).__name__}: {exc}"
            )
    with connection:
        before = connection.total_changes
        connection.executemany(
            """
            INSERT OR IGNORE INTO wsj_rss_articles(
                canonical_url,
                published_at,
                feed_url,
                updated_at
            ) VALUES (?, ?, ?, ?)
            """,
            rows,
        )
        accepted = connection.total_changes - before
        connection.execute(
            """
            UPDATE wsj_rss_state
            SET polls=polls+1,
                feeds_checked=feeds_checked+?,
                items_seen=items_seen+?,
                urls_accepted=urls_accepted+?,
                last_error=?,
                updated_at=?
            WHERE singleton=1
            """,
            (
                feeds_checked,
                items_seen,
                accepted,
                "; ".join(errors) if errors else None,
                _now_iso(),
            ),
        )
    return {
        "feedsChecked": feeds_checked,
        "itemsSeen": items_seen,
        "accepted": accepted,
        "errors": errors,
    }


def wsj_bluesky_should_continue(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
) -> bool:
    initialize_wsj_bluesky_schema(connection)
    first_year = max(from_year, WSJ_BLUESKY_START_YEAR)
    last_year = min(to_year, datetime.now(timezone.utc).year)
    if first_year > last_year:
        return False
    if all(
        wsj_catalog_count_for_year(connection, year)
        >= WSJ_CATALOG_TARGET_PER_YEAR
        for year in range(first_year, last_year + 1)
    ):
        with connection:
            connection.execute(
                """
                UPDATE wsj_bluesky_state
                SET status='complete-target-met',
                    last_error=NULL,
                    updated_at=?
                WHERE singleton=1
                """,
                (_now_iso(),),
            )
        return False
    status = connection.execute(
        "SELECT status FROM wsj_bluesky_state WHERE singleton=1"
    ).fetchone()[0]
    return not str(status).startswith("complete")


def process_wsj_bluesky_page(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    http_client: httpx.Client,
    from_year: int,
    to_year: int,
) -> dict[str, object]:
    if spec.publisher != "wsj":
        raise ValueError("Bluesky discovery is only supported for WSJ")
    initialize_wsj_bluesky_schema(connection)
    cursor = connection.execute(
        "SELECT cursor FROM wsj_bluesky_state WHERE singleton=1"
    ).fetchone()[0]
    with connection:
        connection.execute(
            """
            UPDATE wsj_bluesky_state
            SET status='processing',
                last_error=NULL,
                updated_at=?
            WHERE singleton=1
            """,
            (_now_iso(),),
        )
    try:
        parameters = {
            "actor": "wsj.com",
            "limit": "100",
            "filter": "posts_with_links",
        }
        if cursor:
            parameters["cursor"] = str(cursor)
        response = http_client.get(
            WSJ_BLUESKY_ENDPOINT,
            params=parameters,
        )
        response.raise_for_status()
        payload = response.json()
        feed = payload.get("feed")
        if not isinstance(feed, list):
            raise ValueError("WSJ Bluesky response has no feed list")
        next_cursor = payload.get("cursor")
        rows: list[tuple[str, str, str, str]] = []
        post_dates: list[datetime] = []
        for item in feed:
            if not isinstance(item, dict):
                continue
            post = item.get("post")
            if not isinstance(post, dict):
                continue
            record = post.get("record")
            if not isinstance(record, dict):
                continue
            created_at = _parse_iso_datetime(record.get("createdAt"))
            if created_at is None:
                continue
            post_dates.append(created_at)
            embed = post.get("embed")
            if not isinstance(embed, dict):
                continue
            external = embed.get("external")
            if not isinstance(external, dict):
                continue
            original_url = external.get("uri")
            if not isinstance(original_url, str):
                continue
            canonical_url = normalize_article_url(spec, original_url)
            if canonical_url is None:
                continue
            if not from_year <= created_at.year <= to_year:
                continue
            post_uri = str(post.get("uri") or "")
            rows.append(
                (
                    canonical_url,
                    created_at.isoformat(),
                    post_uri,
                    _now_iso(),
                )
            )
        with connection:
            before = connection.total_changes
            connection.executemany(
                """
                INSERT INTO wsj_bluesky_articles(
                    canonical_url,
                    published_at,
                    post_uri,
                    updated_at
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(canonical_url) DO UPDATE SET
                    published_at=MIN(
                        wsj_bluesky_articles.published_at,
                        excluded.published_at
                    ),
                    post_uri=excluded.post_uri,
                    updated_at=excluded.updated_at
                """,
                rows,
            )
            accepted = connection.total_changes - before
            oldest = min(post_dates).isoformat() if post_dates else None
            first_year = max(from_year, WSJ_BLUESKY_START_YEAR)
            exhausted = (
                not feed
                or not next_cursor
                or (
                    bool(post_dates)
                    and min(post_dates).year < first_year
                )
            )
            status = "complete-history" if exhausted else "running"
            connection.execute(
                """
                UPDATE wsj_bluesky_state
                SET cursor=?,
                    status=?,
                    pages=pages+1,
                    posts_seen=posts_seen+?,
                    urls_accepted=urls_accepted+?,
                    oldest_at=COALESCE(?, oldest_at),
                    last_error=NULL,
                    updated_at=?
                WHERE singleton=1
                """,
                (
                    str(next_cursor) if next_cursor else None,
                    status,
                    len(feed),
                    accepted,
                    oldest,
                    _now_iso(),
                ),
            )
        target_met = not wsj_bluesky_should_continue(
            connection,
            from_year=from_year,
            to_year=to_year,
        )
        return {
            "status": (
                "complete-target-met"
                if target_met and not exhausted
                else status
            ),
            "seen": len(feed),
            "accepted": accepted,
            "oldestAt": oldest,
            "hasMore": not exhausted and not target_met,
        }
    except Exception as exc:
        with connection:
            connection.execute(
                """
                UPDATE wsj_bluesky_state
                SET status='error',
                    last_error=?,
                    updated_at=?
                WHERE singleton=1
                """,
                (f"{type(exc).__name__}: {exc}", _now_iso()),
            )
        raise


def wsj_catalog_count_for_year(
    connection: sqlite3.Connection,
    year: int,
    *,
    spec: ArchiveSourceSpec | None = None,
) -> int:
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
    selects = [
        f"""
        SELECT canonical_url
        FROM candidates
        WHERE substr(published_at, 1, 4)=?
        {hydration_filter}
        """
    ]
    parameters: list[object] = [str(year)]
    for table in (
        "wsj_bluesky_articles",
        "wsj_rss_articles",
        "wsj_google_news_articles",
    ):
        if not _table_exists(connection, table):
            continue
        selects.append(
            f"""
            SELECT canonical_url
            FROM {table}
            WHERE substr(published_at, 1, 4)=?
            """
        )
        parameters.append(str(year))
    if _table_exists(connection, "wsj_syndication_articles"):
        selects.append(
            """
            SELECT canonical_url
            FROM wsj_syndication_articles
            WHERE resolution_status='resolved'
              AND canonical_url IS NOT NULL
              AND substr(published_at, 1, 4)=?
            """
        )
        parameters.append(str(year))
    if _table_exists(connection, "wsj_infini_articles"):
        selects.append(
            """
            SELECT canonical_url
            FROM wsj_infini_articles
            WHERE substr(published_at, 1, 4)=?
            """
        )
        parameters.append(str(year))
    effective_spec = spec or archive_source_spec("wsj")
    return sum(
        normalize_article_url(effective_spec, str(canonical_url))
        == str(canonical_url)
        for (canonical_url,) in connection.execute(
            f"""
            SELECT DISTINCT canonical_url
            FROM (
                {" UNION ".join(selects)}
            )
            """,
            parameters,
        )
    )


def wsj_catalog_ready_for_capture(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
    minimum_catalog: int = PARSER_VALIDATION_CATALOG_MINIMUM_PER_YEAR,
    spec: ArchiveSourceSpec | None = None,
) -> bool:
    return all(
        wsj_catalog_count_for_year(connection, year, spec=spec)
        >= minimum_catalog
        for year in range(from_year, to_year + 1)
    )


def _wsj_external_articles(
    connection: sqlite3.Connection,
) -> dict[str, str]:
    result: dict[str, str] = {}
    for table in (
        "wsj_bluesky_articles",
        "wsj_rss_articles",
        "wsj_google_news_articles",
    ):
        if not _table_exists(connection, table):
            continue
        for canonical_url, published_at in connection.execute(
            f"""
            SELECT canonical_url, published_at
            FROM {table}
            ORDER BY canonical_url
            """
        ):
            previous = result.get(str(canonical_url))
            if previous is None or str(published_at) < previous:
                result[str(canonical_url)] = str(published_at)
    for canonical_url, article in wsj_syndication_articles(
        connection
    ).items():
        published_at = article["publishedAt"]
        previous = result.get(canonical_url)
        if previous is None or published_at < previous:
            result[canonical_url] = published_at
    for canonical_url, published_at in wsj_infini_articles(
        connection
    ).items():
        previous = result.get(canonical_url)
        if previous is None or published_at < previous:
            result[canonical_url] = published_at
    return result


def next_discovery_query(
    connection: sqlite3.Connection,
    *,
    preferred_year: int | None = None,
) -> tuple[str, str | None] | None:
    if preferred_year is not None and not 1900 <= preferred_year <= 2099:
        raise ValueError("preferred_year must be between 1900 and 2099")
    dashed_year = f"/{preferred_year}-" if preferred_year is not None else ""
    slashed_year = f"/{preferred_year}/" if preferred_year is not None else ""
    row = connection.execute(
        """
        SELECT pattern, resume_key
        FROM discovery_queries
        WHERE status != 'complete'
        ORDER BY
            CASE
                WHEN ? != ''
                     AND (
                         instr(pattern, ?) > 0
                         OR instr(pattern, ?) > 0
                     )
                THEN 0
                ELSE 1
            END,
            CASE
                WHEN pattern='online.wsj.com/article/*'
                     AND failures=0
                     AND CAST((
                         SELECT value
                         FROM discovery_metadata
                         WHERE key='from_year'
                     ) AS INTEGER) <= 2013
                THEN 0
                ELSE 1
            END,
            CASE WHEN failures=0 THEN 0 ELSE 1 END,
            -- Once every remaining query has seen at least one transient
            -- failure, rotate the least-failed pattern first. Without this
            -- tie-breaker the oldest broad prefix can monopolize every
            -- bounded continuation even while repeatedly timing out.
            failures ASC,
            CASE
                WHEN (
                    SELECT value
                    FROM discovery_metadata
                    WHERE key='collapse'
                )='urlkey'
                THEN pages
                ELSE 0
            END,
            rowid
        LIMIT 1
        """,
        (dashed_year, dashed_year, slashed_year),
    ).fetchone()
    return (row[0], row[1]) if row else None


def record_discovery_failure(
    connection: sqlite3.Connection,
    *,
    pattern: str,
    error: str,
) -> None:
    with connection:
        connection.execute(
            """
            UPDATE discovery_queries
            SET failures=failures+1,
                last_error=?,
                updated_at=?
            WHERE pattern=?
            """,
            (error, _now_iso(), pattern),
        )


def record_discovery_page(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    pattern: str,
    page: CDXPage,
) -> dict[str, int | bool]:
    accepted = 0
    rows: list[tuple[object, ...]] = []
    touched_urls: set[str] = set()
    window = dict(
        connection.execute(
            """
            SELECT key, value
            FROM discovery_metadata
            WHERE key IN ('from_year', 'to_year')
            """
        ).fetchall()
    )
    publication_start = (
        f"{int(window['from_year']):04d}-01-01"
        if "from_year" in window
        else None
    )
    publication_end = (
        f"{int(window['to_year']) + 1:04d}-01-01"
        if "to_year" in window
        else None
    )
    for capture in page.captures:
        canonical_url = normalize_article_url(spec, capture.original)
        if not canonical_url:
            continue
        published_at = (
            infer_published_at(canonical_url)
            or _timestamp_datetime(capture.timestamp).isoformat()
        )
        if (
            publication_start is not None
            and publication_end is not None
            and not publication_start <= published_at < publication_end
        ):
            continue
        rows.append(
            (
                canonical_url,
                published_at,
                capture.timestamp,
                capture.original,
                capture.digest or "",
                capture.mimetype,
                capture.status_code,
                capture.length,
                candidate_rank(capture.timestamp, published_at=published_at),
            )
        )
        touched_urls.add(canonical_url)
    with connection:
        before = connection.total_changes
        connection.executemany(
            """
            INSERT OR IGNORE INTO candidates(
                canonical_url,
                published_at,
                timestamp,
                original_url,
                digest,
                mimetype,
                status_code,
                byte_count,
                rank_score
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        accepted = connection.total_changes - before
        if touched_urls:
            placeholders = ",".join("?" for _ in touched_urls)
            connection.execute(
                f"""
                DELETE FROM candidates
                WHERE rowid IN (
                    SELECT rowid FROM (
                        SELECT
                            rowid,
                            ROW_NUMBER() OVER (
                                PARTITION BY canonical_url
                                ORDER BY rank_score, timestamp, digest
                            ) AS candidate_number
                        FROM candidates
                        WHERE canonical_url IN ({placeholders})
                    )
                    WHERE candidate_number > 3
                )
                """,
                sorted(touched_urls),
            )
        connection.execute(
            """
            UPDATE discovery_queries
            SET resume_key=?,
                status=?,
                pages=pages+1,
                rows_seen=rows_seen+?,
                rows_accepted=rows_accepted+?,
                failures=0,
                last_error=NULL,
                updated_at=?
            WHERE pattern=?
            """,
            (
                page.resume_key,
                "running" if page.resume_key else "complete",
                len(page.captures),
                accepted,
                _now_iso(),
                pattern,
            ),
        )
    return {
        "seen": len(page.captures),
        "accepted": accepted,
        "hasMore": bool(page.resume_key),
    }


def export_capture_manifest(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    destination: Path,
    from_year: int,
    to_year: int,
    capture_minimum_per_year: int = (
        PARSER_VALIDATION_CATALOG_MINIMUM_PER_YEAR
    ),
) -> dict[str, int | bool | str]:
    if capture_minimum_per_year < 1:
        raise ValueError("capture_minimum_per_year must be positive")
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
        SELECT
            canonical_url,
            published_at,
            timestamp,
            original_url,
            digest,
            mimetype,
            status_code,
            byte_count
        FROM candidates
        WHERE published_at >= ?
          AND published_at < ?
          {hydration_filter}
        ORDER BY canonical_url, rank_score, timestamp, digest
        """,
        (
            f"{from_year:04d}-01-01",
            f"{to_year + 1:04d}-01-01",
        ),
    )
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    opener = gzip.open if destination.suffix == ".gz" else open
    article_count = 0
    candidate_count = 0
    external_articles = _wsj_external_articles(connection)
    infini_candidates = wsj_infini_capture_candidates(connection)
    direct_infini_candidates = wsj_infini_direct_capture_candidates(
        connection
    )
    syndicated_articles = wsj_syndication_articles(connection)
    written_urls: set[str] = set()
    with opener(temporary, "wt", encoding="utf-8") as handle:
        current_url: str | None = None
        current_published_at: str | None = None
        candidates: list[dict] = []
        for row in rows:
            canonical_url = str(row[0])
            if normalize_article_url(spec, canonical_url) != canonical_url:
                continue
            if current_url is not None and canonical_url != current_url:
                preferred_candidates = []
                if current_url in direct_infini_candidates:
                    preferred_candidates.append(
                        direct_infini_candidates[current_url]
                    )
                if current_url in infini_candidates:
                    preferred_candidates.append(infini_candidates[current_url])
                if preferred_candidates:
                    candidates = _merge_capture_candidates(
                        preferred_candidates,
                        candidates,
                    )
                if current_url in external_articles:
                    current_published_at = external_articles[current_url]
                    candidates = _merge_capture_candidates(
                        candidates,
                        _approximate_wayback_candidates(
                            current_url,
                            published_at=current_published_at,
                        ),
                    )
                if current_url in syndicated_articles:
                    candidates = _merge_capture_candidates(
                        [
                            _wsj_syndication_candidate(
                                syndicated_articles[current_url]
                            )
                        ],
                        candidates,
                    )
                _write_manifest_row(
                    handle,
                    spec=spec,
                    canonical_url=current_url,
                    published_at=current_published_at,
                    candidates=candidates,
                )
                article_count += 1
                candidate_count += len(candidates)
                written_urls.add(current_url)
                candidates = []
            current_url = canonical_url
            current_published_at = row[1]
            captured_at = _timestamp_datetime(row[2])
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
        if current_url is not None:
            preferred_candidates = []
            if current_url in direct_infini_candidates:
                preferred_candidates.append(direct_infini_candidates[current_url])
            if current_url in infini_candidates:
                preferred_candidates.append(infini_candidates[current_url])
            if preferred_candidates:
                candidates = _merge_capture_candidates(
                    preferred_candidates,
                    candidates,
                )
            if current_url in external_articles:
                current_published_at = external_articles[current_url]
                candidates = _merge_capture_candidates(
                    candidates,
                    _approximate_wayback_candidates(
                        current_url,
                        published_at=current_published_at,
                    ),
                )
            if current_url in syndicated_articles:
                candidates = _merge_capture_candidates(
                    [
                        _wsj_syndication_candidate(
                            syndicated_articles[current_url]
                        )
                    ],
                    candidates,
                )
            _write_manifest_row(
                handle,
                spec=spec,
                canonical_url=current_url,
                published_at=current_published_at,
                candidates=candidates,
            )
            article_count += 1
            candidate_count += len(candidates)
            written_urls.add(current_url)
        for canonical_url, published_at in sorted(external_articles.items()):
            if canonical_url in written_urls:
                continue
            if normalize_article_url(spec, canonical_url) != canonical_url:
                continue
            candidates = []
            if canonical_url in direct_infini_candidates:
                candidates.append(direct_infini_candidates[canonical_url])
            if canonical_url in infini_candidates:
                candidates.append(infini_candidates[canonical_url])
            candidates = _merge_capture_candidates(
                candidates,
                _approximate_wayback_candidates(
                    canonical_url,
                    published_at=published_at,
                ),
            )
            if canonical_url in syndicated_articles:
                candidates = _merge_capture_candidates(
                    [
                        _wsj_syndication_candidate(
                            syndicated_articles[canonical_url]
                        )
                    ],
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
    incomplete = connection.execute(
        "SELECT COUNT(*) FROM discovery_queries WHERE status != 'complete'"
    ).fetchone()[0]
    archived_dates = archived_date_summary(connection)
    if archived_dates is not None and archived_dates["remaining"] > 0:
        incomplete += 1
    if _table_exists(connection, "wsj_bluesky_state"):
        bluesky_status = connection.execute(
            "SELECT status FROM wsj_bluesky_state WHERE singleton=1"
        ).fetchone()[0]
        if not str(bluesky_status).startswith("complete"):
            incomplete += 1
    if _table_exists(connection, "wsj_google_news_state"):
        google_news_status = connection.execute(
            "SELECT status FROM wsj_google_news_state WHERE singleton=1"
        ).fetchone()[0]
        if not str(google_news_status).startswith("complete"):
            incomplete += 1
    if wsj_syndication_should_continue(connection):
        incomplete += 1
    if wsj_infini_should_continue(connection):
        incomplete += 1
    if wsj_infini_direct_should_continue(connection):
        incomplete += 1
    year_counts = {
        str(year): wsj_catalog_count_for_year(
            connection,
            year,
            spec=spec,
        )
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


def discovered_wayback_articles(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
) -> dict[str, tuple[str | None, list[dict[str, object]]]]:
    if from_year > to_year:
        raise ValueError("from_year must not exceed to_year")
    if not _table_exists(connection, "candidates"):
        return {}
    result: dict[
        str,
        tuple[str | None, list[dict[str, object]]],
    ] = {}
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
    for (
        canonical_url,
        published_at,
        timestamp,
        original_url,
        digest,
        mimetype,
        status_code,
        byte_count,
    ) in connection.execute(
        f"""
        SELECT
            canonical_url,
            published_at,
            timestamp,
            original_url,
            digest,
            mimetype,
            status_code,
            byte_count
        FROM candidates
        WHERE published_at >= ?
          AND published_at < ?
          {hydration_filter}
        ORDER BY canonical_url, rank_score, timestamp, digest
        """,
        (
            f"{from_year:04d}-01-01",
            f"{to_year + 1:04d}-01-01",
        ),
    ):
        key = str(canonical_url)
        existing_published_at, candidates = result.get(
            key,
            (str(published_at) if published_at else None, []),
        )
        captured_at = _timestamp_datetime(str(timestamp))
        candidates.append(
            {
                "provider": "wayback",
                "snapshotUrl": (
                    "https://web.archive.org/web/"
                    f"{timestamp}id_/{original_url}"
                ),
                "capturedAt": captured_at.isoformat(),
                **({"digest": str(digest)} if digest else {}),
                "mimeType": str(mimetype),
                "statusCode": int(status_code),
                **(
                    {"byteCount": int(byte_count)}
                    if byte_count is not None
                    else {}
                ),
            }
        )
        result[key] = (existing_published_at, candidates)
    return result


def discovery_summary(connection: sqlite3.Connection) -> dict[str, object]:
    query_counts = dict(
        connection.execute(
            "SELECT status, COUNT(*) FROM discovery_queries GROUP BY status"
        ).fetchall()
    )
    totals = connection.execute(
        """
        SELECT
            COALESCE(SUM(pages), 0),
            COALESCE(SUM(rows_seen), 0),
            COALESCE(SUM(rows_accepted), 0)
        FROM discovery_queries
        """
    ).fetchone()
    article_urls = {
        str(row[0])
        for row in connection.execute(
            "SELECT DISTINCT canonical_url FROM candidates"
        )
    }
    article_urls.update(_wsj_external_articles(connection))
    result = {
        "queriesByStatus": query_counts,
        "pages": int(totals[0]),
        "rowsSeen": int(totals[1]),
        "rowsAccepted": int(totals[2]),
        "articles": len(article_urls),
        "shouldContinue": sum(
            count
            for status, count in query_counts.items()
            if status != "complete"
        )
        > 0,
    }
    if _table_exists(connection, "wsj_bluesky_state"):
        row = connection.execute(
            """
            SELECT
                status,
                pages,
                posts_seen,
                urls_accepted,
                oldest_at,
                last_error
            FROM wsj_bluesky_state
            WHERE singleton=1
            """
        ).fetchone()
        result["wsjBluesky"] = {
            "status": str(row[0]),
            "pages": int(row[1]),
            "postsSeen": int(row[2]),
            "urlsAccepted": int(row[3]),
            "oldestAt": row[4],
            "lastError": row[5],
        }
        result["shouldContinue"] = bool(result["shouldContinue"]) or not str(
            row[0]
        ).startswith("complete")
    if _table_exists(connection, "wsj_rss_state"):
        row = connection.execute(
            """
            SELECT
                polls,
                feeds_checked,
                items_seen,
                urls_accepted,
                last_error
            FROM wsj_rss_state
            WHERE singleton=1
            """
        ).fetchone()
        result["wsjRss"] = {
            "polls": int(row[0]),
            "feedsChecked": int(row[1]),
            "itemsSeen": int(row[2]),
            "urlsAccepted": int(row[3]),
            "lastError": row[4],
        }
    if _table_exists(connection, "wsj_google_news_state"):
        row = connection.execute(
            """
            SELECT
                status,
                polls,
                items_seen,
                decodes_attempted,
                urls_accepted,
                last_error
            FROM wsj_google_news_state
            WHERE singleton=1
            """
        ).fetchone()
        result["wsjGoogleNews"] = {
            "status": str(row[0]),
            "polls": int(row[1]),
            "itemsSeen": int(row[2]),
            "decodesAttempted": int(row[3]),
            "urlsAccepted": int(row[4]),
            "lastError": row[5],
        }
        result["shouldContinue"] = bool(result["shouldContinue"]) or not str(
            row[0]
        ).startswith("complete")
    syndication = wsj_syndication_summary(connection)
    if syndication is not None:
        result["wsjSyndication"] = syndication
        result["shouldContinue"] = bool(
            result["shouldContinue"]
        ) or wsj_syndication_should_continue(connection)
    infini = wsj_infini_summary(connection)
    if infini is not None:
        result["wsjInfini"] = infini
        result["shouldContinue"] = bool(
            result["shouldContinue"]
        ) or wsj_infini_should_continue(connection)
    infini_direct = wsj_infini_direct_summary(connection)
    if infini_direct is not None:
        result["wsjInfiniDirect"] = infini_direct
        result["shouldContinue"] = bool(
            result["shouldContinue"]
        ) or wsj_infini_direct_should_continue(connection)
    legacy_dates = wsj_legacy_date_summary(connection)
    if legacy_dates is not None:
        result["wsjLegacyDates"] = legacy_dates
        result["shouldContinue"] = bool(
            result["shouldContinue"]
        ) or legacy_dates["remaining"] > 0
    archived_dates = archived_date_summary(connection)
    if archived_dates is not None:
        result["archivedDates"] = archived_dates
        result["shouldContinue"] = bool(
            result["shouldContinue"]
        ) or archived_dates["remaining"] > 0
    return result


def infer_published_at(canonical_url: str) -> str | None:
    parsed = urlsplit(canonical_url)
    ap_hosted_published = ap_hosted_publication_datetime(canonical_url)
    if ap_hosted_published is not None:
        return ap_hosted_published.isoformat()
    hostname = (parsed.hostname or "").casefold().removeprefix("www.")
    patterns: list[str] = []
    if hostname == "caixin.com" or hostname.endswith(".caixin.com"):
        patterns.append(r"/(20\d{2})-(\d{2})-(\d{2})(?:/|$)")
    if hostname == "zaobao.com.sg":
        patterns.append(r"/story(20\d{2})(\d{2})(\d{2})(?:[-/]|$)")
    if hostname == "aljazeera.com":
        # The legacy Al Jazeera CMS encoded the exact day inside a compact
        # numeric story id whose boundary is ambiguous for single-digit
        # days.  The surrounding URL still supplies an authoritative year
        # and month, which is sufficient for year-stratified discovery and
        # selecting a publication-near archive capture.  Use the first day
        # of that month as the conservative catalog timestamp; the article
        # parser recovers the precise visible/structured timestamp later.
        legacy_match = re.search(
            r"/(?:[a-z0-9-]+/){1,2}(20\d{2})/(\d{2})/"
            r"20\d{6,}\.html(?:/|$)",
            canonical_url,
        )
        if legacy_match is not None:
            try:
                return datetime(
                    int(legacy_match.group(1)),
                    int(legacy_match.group(2)),
                    1,
                    tzinfo=timezone.utc,
                ).isoformat()
            except ValueError:
                return None
        patterns.append(
            r"/(?:news|features|opinions)/(20\d{2})/"
            r"(\d{1,2})/(\d{1,2})(?:/|$)"
        )
        patterns.append(
            r"/(?:[a-z0-9-]+/)?(20\d{2})/"
            r"(\d{1,2})/(\d{1,2})(?:/|$)"
        )
    patterns.extend([
        r"/article/(?:0(?:%2C|,){2})?BT-CO-"
        r"(20\d{2})(\d{2})(\d{2})-",
        r"/(20\d{2})/(\d{2})/(\d{2})(?:/|$)",
        r"/articles/(20\d{2})-(\d{2})-(\d{2})(?:/|$)",
        r"-(20\d{2})-(\d{2})-(\d{2})(?:/|$)",
    ])
    if (
        hostname == "reuters.com"
        and parsed.path.startswith("/article/")
    ):
        patterns.insert(
            0,
            r"((?:19|20)\d{2})(\d{2})(\d{2})(?:[^0-9]|$)",
        )
    for pattern in patterns:
        match = re.search(pattern, canonical_url)
        if not match:
            continue
        try:
            value = datetime(
                int(match.group(1)),
                int(match.group(2)),
                int(match.group(3)),
                tzinfo=timezone.utc,
            )
        except ValueError:
            return None
        return value.isoformat()
    if (
        hostname == "wsj.com"
    ):
        published = wsj_article_publication_datetime(canonical_url)
        if published is not None:
            return published.isoformat()
    return None


def candidate_rank(timestamp: str, *, published_at: str | None) -> int:
    captured = _timestamp_datetime(timestamp)
    if not published_at:
        return int(timestamp)
    published = datetime.fromisoformat(published_at)
    difference = int((captured - published).total_seconds())
    if difference >= 0:
        return difference
    return abs(difference) + 20 * 365 * 24 * 60 * 60


def _write_manifest_row(
    handle,
    *,
    spec: ArchiveSourceSpec,
    canonical_url: str,
    published_at: str | None,
    candidates: list[dict],
) -> None:
    candidates = with_current_year_live_fallback(
        candidates,
        canonical_url=canonical_url,
        published_at=published_at,
    )
    row = {
        "formatVersion": MANIFEST_FORMAT_VERSION,
        "publisher": spec.publisher,
        "canonicalUrl": canonical_url,
        **({"publishedAt": published_at} if published_at else {}),
        "candidates": candidates,
    }
    handle.write(
        json.dumps(
            row,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n"
    )


def with_current_year_live_fallback(
    candidates: list[dict[str, object]],
    *,
    canonical_url: str,
    published_at: str | None,
) -> list[dict[str, object]]:
    if not published_at:
        return candidates
    try:
        published = datetime.fromisoformat(published_at)
    except (TypeError, ValueError, OverflowError):
        return candidates
    if published.year != datetime.now(timezone.utc).year:
        return candidates
    if any(
        candidate.get("provider") == "live-origin"
        for candidate in candidates
    ):
        return candidates
    return [
        *candidates,
        {
            "provider": "live-origin",
            "snapshotUrl": canonical_url,
        },
    ]


def _approximate_wayback_candidates(
    canonical_url: str,
    *,
    published_at: str,
) -> list[dict[str, object]]:
    published = _parse_iso_datetime(published_at)
    if published is None:
        return [
            {
                "provider": "wayback",
                "snapshotUrl": (
                    "https://web.archive.org/web/2id_/" + canonical_url
                ),
            }
        ]
    result: list[dict[str, object]] = []
    for delta in (timedelta(days=1), timedelta(days=7), timedelta(days=30)):
        timestamp = (published + delta).strftime("%Y%m%d%H%M%S")
        result.append(
            {
                "provider": "wayback",
                "snapshotUrl": (
                    f"https://web.archive.org/web/{timestamp}id_/"
                    f"{canonical_url}"
                ),
            }
        )
    return result


def _merge_capture_candidates(
    first: list[dict],
    second: list[dict[str, object]],
) -> list[dict]:
    result: list[dict] = []
    seen: set[str] = set()
    for candidate in [*first, *second]:
        snapshot_url = str(candidate.get("snapshotUrl") or "")
        if not snapshot_url or snapshot_url in seen:
            continue
        seen.add(snapshot_url)
        result.append(candidate)
    return result


def _wsj_syndication_candidate(
    article: dict[str, str],
) -> dict[str, object]:
    return {
        "provider": "other",
        "snapshotUrl": article["partnerUrl"],
        "expectedHeadline": article["expectedHeadline"],
    }


def _parse_iso_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_rss_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _timestamp_datetime(timestamp: str) -> datetime:
    return datetime.strptime(timestamp, "%Y%m%d%H%M%S").replace(
        tzinfo=timezone.utc
    )


def _spec_fingerprint(
    spec: ArchiveSourceSpec,
    *,
    from_year: int,
    to_year: int,
    collapse: str = "digest",
) -> str:
    payload = {
        "publisher": spec.publisher,
        "fromYear": from_year,
        "toYear": to_year,
        "patterns": spec.expanded_wayback_patterns(
            from_year=from_year,
            to_year=to_year,
        ),
    }
    # Preserve the original digest-mode fingerprint so deployed checkpoints
    # remain resumable. Alternate collapse modes get isolated fingerprints and
    # B2 shards.
    if collapse != "digest":
        payload["collapse"] = collapse
    value = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(value.encode()).hexdigest()


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
