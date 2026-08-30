from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time

import httpx

from jojo_news_archive.sources.registry import ArchiveSourceSpec, normalize_article_url
from jojo_news_archive.discovery.client import GlobalRateLimiter
from jojo_news_archive.discovery.common_crawl import (
    COLLECTION_INFO_URL,
    DATA_BASE_URL,
    MAXIMUM_COMPRESSED_WARC_BYTES,
    CommonCrawlClient,
    fetch_common_crawl_candidate,
)
from jojo_news_archive.models import CaptureCandidate, CaptureProvider
from jojo_news_archive.parsing.parser import parse_article
from jojo_news_archive.sources.specs import publisher_spec
from jojo_news_archive.discovery.wayback import (
    ARCHIVED_DATE_HYDRATION_PUBLISHERS,
    candidate_rank,
    infer_published_at,
)


SCHEMA_VERSION = "jojo-common-crawl-prefix-discovery/2"
MANIFEST_FORMAT_VERSION = "jojo-capture-manifest/1"
RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
# FT article URLs are UUID-based and do not carry a publication year.  The
# parser already understands FT JSON-LD/Open Graph/legacy date fields, so the
# Common Crawl catalog can recover the year by hydrating a bounded WARC sample.
# Keep this set local to the prefix catalog: the Wayback manifest's archived
# date extractor has a separate publisher-specific implementation.
COMMON_CRAWL_DATE_HYDRATION_PUBLISHERS = frozenset(
    (*ARCHIVED_DATE_HYDRATION_PUBLISHERS, "ft", "wsj")
)


class CommonCrawlNoCapturesError(Exception):
    """The queried prefix or filtered index page contains no captures."""


@dataclass(frozen=True)
class PrefixCollection:
    identifier: str
    index_url: str
    from_at: datetime
    to_at: datetime


@dataclass(frozen=True)
class PrefixIndexPage:
    rows: tuple[dict[str, object], ...]


class CommonCrawlPrefixClient:
    def __init__(
        self,
        *,
        minimum_interval: float = 2.0,
        timeout: float = 45.0,
        attempts: int = 4,
        page_size: int | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        if minimum_interval < 0:
            raise ValueError("minimum_interval must not be negative")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        if attempts < 1:
            raise ValueError("attempts must be positive")
        if page_size is not None and page_size < 1:
            raise ValueError("page_size must be positive when provided")
        self.rate_limiter = GlobalRateLimiter(minimum_interval)
        self.timeout = timeout
        self.attempts = attempts
        self.page_size = page_size
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

    def collections(self) -> tuple[PrefixCollection, ...]:
        payload = self._get_json(COLLECTION_INFO_URL)
        if not isinstance(payload, list):
            raise ValueError("Common Crawl collection list is not an array")
        result: list[PrefixCollection] = []
        for row in payload:
            if not isinstance(row, dict):
                continue
            identifier = str(row.get("id") or "").strip()
            index_url = str(row.get("cdx-api") or "").strip()
            from_at = _parse_datetime(row.get("from"))
            to_at = _parse_datetime(row.get("to"))
            if (
                not identifier
                or not index_url.startswith(
                    "https://index.commoncrawl.org/"
                )
                or from_at is None
                or to_at is None
            ):
                continue
            result.append(
                PrefixCollection(
                    identifier=identifier,
                    index_url=index_url,
                    from_at=from_at,
                    to_at=to_at,
                )
            )
        if not result:
            raise ValueError("Common Crawl collection list is empty")
        return tuple(result)

    def page_count(self, *, index_url: str, pattern: str) -> int:
        try:
            payload = self._get_json(
                index_url,
                params=_query_parameters(pattern, page_size=self.page_size)
                + [("showNumPages", "true")],
            )
        except CommonCrawlNoCapturesError:
            return 0
        if not isinstance(payload, dict):
            raise ValueError("Common Crawl page count is not an object")
        pages = _optional_int(payload.get("pages"))
        if pages is None or pages < 0:
            raise ValueError("Common Crawl page count is invalid")
        return pages

    def page(
        self,
        *,
        index_url: str,
        pattern: str,
        page: int,
    ) -> PrefixIndexPage:
        if page < 0:
            raise ValueError("page must not be negative")
        try:
            lines = self._get_text_lines(
                index_url,
                params=_query_parameters(pattern, page_size=self.page_size)
                + [("page", str(page))],
            )
        except CommonCrawlNoCapturesError:
            return PrefixIndexPage(rows=())
        rows: list[dict[str, object]] = []
        for line in lines:
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError("Common Crawl index row is not an object")
            rows.append(value)
        return PrefixIndexPage(rows=tuple(rows))

    def _get(
        self,
        url: str,
        *,
        params: list[tuple[str, str]] | None = None,
        attempts: int | None = None,
    ) -> httpx.Response:
        request_attempts = self.attempts if attempts is None else attempts
        if request_attempts < 1:
            raise ValueError("attempts must be positive")
        last_status: int | None = None
        last_error: Exception | None = None
        for attempt in range(request_attempts):
            self.rate_limiter.wait()
            try:
                response = self._client.get(url, params=params)
                last_status = response.status_code
                if response.status_code == 404:
                    try:
                        message = str(response.json().get("message") or "")
                    except (ValueError, AttributeError):
                        message = ""
                    if message.startswith("No Captures found for:"):
                        raise CommonCrawlNoCapturesError(message)
                if response.status_code in RETRYABLE_STATUS_CODES:
                    raise RuntimeError(
                        f"retryable HTTP {response.status_code}"
                    )
                response.raise_for_status()
                return response
            except (httpx.HTTPError, RuntimeError, ValueError) as exc:
                last_error = exc
                if attempt + 1 >= request_attempts:
                    break
                time.sleep(min(30.0, 2.0**attempt))
        suffix = f" (last HTTP status {last_status})" if last_status else ""
        raise RuntimeError(
            f"Common Crawl index query failed after {request_attempts} attempts"
            f"{suffix}"
        ) from last_error

    def _get_json(
        self,
        url: str,
        *,
        params: list[tuple[str, str]] | None = None,
    ) -> object:
        """Fetch JSON while retrying successful-but-malformed responses."""
        last_error: Exception | None = None
        for attempt in range(self.attempts):
            try:
                response = self._get(url, params=params, attempts=1)
                return response.json()
            except CommonCrawlNoCapturesError:
                raise
            except (
                json.JSONDecodeError,
                RuntimeError,
                TypeError,
                ValueError,
            ) as exc:
                last_error = exc
                if attempt + 1 >= self.attempts:
                    break
                time.sleep(min(30.0, 2.0**attempt))
        raise RuntimeError(
            "Common Crawl JSON response could not be decoded after "
            f"{self.attempts} attempts"
        ) from last_error

    def _get_text_lines(
        self,
        url: str,
        *,
        params: list[tuple[str, str]] | None = None,
    ) -> tuple[str, ...]:
        """Fetch and validate an NDJSON page before recording it."""
        last_error: Exception | None = None
        for attempt in range(self.attempts):
            try:
                response = self._get(url, params=params, attempts=1)
                lines = tuple(
                    line for line in response.text.splitlines() if line.strip()
                )
                for line in lines:
                    value = json.loads(line)
                    if not isinstance(value, dict):
                        raise ValueError(
                            "Common Crawl index row is not an object"
                        )
                return lines
            except CommonCrawlNoCapturesError:
                raise
            except (
                json.JSONDecodeError,
                RuntimeError,
                TypeError,
                ValueError,
            ) as exc:
                last_error = exc
                if attempt + 1 >= self.attempts:
                    break
                time.sleep(min(30.0, 2.0**attempt))
        raise RuntimeError(
            "Common Crawl NDJSON response could not be decoded after "
            f"{self.attempts} attempts"
        ) from last_error


def prefix_patterns(
    spec: ArchiveSourceSpec,
    *,
    from_year: int,
    to_year: int,
) -> tuple[str, ...]:
    result: list[str] = []
    for pattern in spec.expanded_wayback_patterns(
        from_year=from_year,
        to_year=to_year,
    ):
        if pattern.count("*") != 1 or not pattern.endswith("*"):
            continue
        prefix = pattern[:-1]
        if prefix and prefix not in result:
            result.append(prefix)
    if spec.publisher == "npr":
        # NPR's pre-2010 CMS links remained widely captured after dated
        # canonical URLs were introduced. Their storyId is stable, while the
        # publication year must be recovered from archived article metadata.
        for prefix in (
            "www.npr.org/templates/story/story.php",
            "npr.org/templates/story/story.php",
        ):
            if prefix not in result:
                result.append(prefix)
    if not result:
        raise ValueError(
            f"publisher {spec.publisher!r} has no prefix-compatible pattern"
        )
    return tuple(result)


def initialize_prefix_schema(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    from_year: int,
    to_year: int,
    collections: tuple[PrefixCollection, ...],
) -> None:
    if from_year > to_year:
        raise ValueError("from_year must not exceed to_year")
    patterns = prefix_patterns(
        spec,
        from_year=from_year,
        to_year=to_year,
    )
    connection.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;

        CREATE TABLE IF NOT EXISTS prefix_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS prefix_queries (
            collection_id TEXT NOT NULL,
            index_url TEXT NOT NULL,
            pattern TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            total_pages INTEGER,
            next_page INTEGER NOT NULL DEFAULT 0,
            pages INTEGER NOT NULL DEFAULT 0,
            rows_seen INTEGER NOT NULL DEFAULT 0,
            rows_accepted INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(collection_id, pattern)
        );

        CREATE TABLE IF NOT EXISTS prefix_candidates (
            canonical_url TEXT NOT NULL,
            published_at TEXT NOT NULL,
            collection_id TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            original_url TEXT NOT NULL,
            digest TEXT NOT NULL DEFAULT '',
            mimetype TEXT NOT NULL,
            status_code INTEGER NOT NULL,
            byte_count INTEGER NOT NULL,
            warc_filename TEXT NOT NULL,
            warc_offset INTEGER NOT NULL,
            warc_length INTEGER NOT NULL,
            rank_score INTEGER NOT NULL,
            PRIMARY KEY(canonical_url, warc_filename, warc_offset)
        );

        CREATE INDEX IF NOT EXISTS idx_prefix_candidates_rank
            ON prefix_candidates(canonical_url, rank_score, timestamp);

        CREATE TABLE IF NOT EXISTS prefix_undated_candidates (
            canonical_url TEXT NOT NULL,
            collection_id TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            original_url TEXT NOT NULL,
            digest TEXT NOT NULL DEFAULT '',
            mimetype TEXT NOT NULL,
            status_code INTEGER NOT NULL,
            byte_count INTEGER NOT NULL,
            warc_filename TEXT NOT NULL,
            warc_offset INTEGER NOT NULL,
            warc_length INTEGER NOT NULL,
            rank_score INTEGER NOT NULL,
            PRIMARY KEY(canonical_url, warc_filename, warc_offset)
        );

        CREATE INDEX IF NOT EXISTS idx_prefix_undated_candidates_rank
            ON prefix_undated_candidates(
                canonical_url, rank_score, timestamp
            );

        CREATE TABLE IF NOT EXISTS prefix_date_hydration (
            canonical_url TEXT PRIMARY KEY,
            publisher TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            published_at TEXT,
            parser_status TEXT,
            body_characters INTEGER,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_prefix_date_hydration_status
            ON prefix_date_hydration(
                publisher, status, attempts, updated_at
            );
        """
    )
    fingerprint = _fingerprint(
        spec=spec,
        from_year=from_year,
        to_year=to_year,
        patterns=patterns,
    )
    existing = connection.execute(
        "SELECT value FROM prefix_metadata WHERE key='fingerprint'"
    ).fetchone()
    widened_scope = False
    if existing is not None and str(existing[0]) != fingerprint:
        previous_metadata = dict(
            connection.execute(
                """
                SELECT key, value FROM prefix_metadata
                WHERE key IN ('publisher', 'from_year', 'to_year')
                """
            ).fetchall()
        )
        previous_patterns = {
            str(row[0])
            for row in connection.execute(
                "SELECT DISTINCT pattern FROM prefix_queries"
            )
        }
        requested_metadata = {
            "publisher": spec.publisher,
            "from_year": str(from_year),
            "to_year": str(to_year),
        }
        same_scope = previous_metadata == requested_metadata
        same_publisher = previous_metadata.get("publisher") == spec.publisher
        try:
            previous_from_year = int(previous_metadata["from_year"])
            previous_to_year = int(previous_metadata["to_year"])
        except (KeyError, TypeError, ValueError):
            previous_from_year = from_year
            previous_to_year = to_year
            same_publisher = False
        widened_scope = (
            same_publisher
            and from_year <= previous_from_year
            and to_year >= previous_to_year
            and (from_year < previous_from_year or to_year > previous_to_year)
        )
        compatible_patterns = previous_patterns <= set(patterns)
        if not (same_scope or widened_scope) or not compatible_patterns:
            raise ValueError(
                "Common Crawl prefix state belongs to a different "
                "publisher, date window, or pattern set"
            )
    if widened_scope:
        # Date hydration deliberately retains authoritative dates for rows
        # outside the original output window. When the same publisher and
        # pattern set is widened, promote those already-fetched candidates
        # instead of downloading their WARC records again.
        widened_start = f"{from_year:04d}-01-01"
        widened_end = f"{to_year + 1:04d}-01-01"
        reusable_rows = connection.execute(
            """
            SELECT canonical_url, published_at
            FROM prefix_date_hydration
            WHERE publisher=? AND status='out-of-window'
              AND published_at >= ? AND published_at < ?
            """,
            (spec.publisher, widened_start, widened_end),
        ).fetchall()
        now = _now_iso()
        with connection:
            for canonical_url, published_at in reusable_rows:
                _promote_undated_candidates(
                    connection,
                    canonical_url=str(canonical_url),
                    published_at=str(published_at),
                )
                connection.execute(
                    """
                    UPDATE prefix_date_hydration
                    SET status='complete', last_error=NULL, updated_at=?
                    WHERE canonical_url=? AND publisher=?
                    """,
                    (now, str(canonical_url), spec.publisher),
                )
    hydration_parser_version = publisher_spec(spec.publisher).parser_version
    previous_hydration_version = connection.execute(
        "SELECT value FROM prefix_metadata "
        "WHERE key='hydration_parser_version'"
    ).fetchone()
    if (
        spec.publisher in COMMON_CRAWL_DATE_HYDRATION_PUBLISHERS
        and (
            previous_hydration_version is None
            or str(previous_hydration_version[0]) != hydration_parser_version
        )
    ):
        # A parser may learn a legacy date field after an archived page was
        # classified as no-date. Reopen only parser-dependent terminal rows;
        # an out-of-window date remains authoritative across parser versions.
        connection.execute(
            """
            UPDATE prefix_date_hydration
            SET status='pending', attempts=0, published_at=NULL,
                parser_status=NULL, body_characters=NULL, last_error=NULL,
                updated_at=?
            WHERE publisher=? AND status IN ('no-date', 'failed')
            """,
            (_now_iso(), spec.publisher),
        )
    metadata = {
        "schema_version": SCHEMA_VERSION,
        "publisher": spec.publisher,
        "from_year": str(from_year),
        "to_year": str(to_year),
        "fingerprint": fingerprint,
        "hydration_parser_version": hydration_parser_version,
    }
    connection.executemany(
        """
        INSERT INTO prefix_metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        metadata.items(),
    )
    now = _now_iso()
    connection.executemany(
        """
        INSERT OR IGNORE INTO prefix_queries(
            collection_id, index_url, pattern, updated_at
        ) VALUES (?, ?, ?, ?)
        """,
        (
            (collection.identifier, collection.index_url, pattern, now)
            for collection in collections
            for pattern in patterns
        ),
    )
    connection.commit()


def next_prefix_query(
    connection: sqlite3.Connection,
    *,
    collection_order: str = "newest",
) -> tuple[str, str, str, int | None, int] | None:
    if collection_order not in {"newest", "oldest"}:
        raise ValueError("collection_order must be 'newest' or 'oldest'")
    collection_direction = "DESC" if collection_order == "newest" else "ASC"
    row = connection.execute(
        f"""
        SELECT collection_id, index_url, pattern, total_pages, next_page
        FROM prefix_queries
        WHERE status NOT IN ('complete', 'target-complete')
        ORDER BY
            attempts,
            CASE
                -- Reuters' modern CMS moved articles below section roots
                -- (/world/, /business/, ...).  Probe those roots before the
                -- legacy /article/<letter> families so a newly-added source
                -- can contribute candidates without waiting for every old
                -- prefix/collection pair to be exhausted.
                WHEN pattern LIKE 'www.reuters.com/%/' THEN -3
                WHEN pattern LIKE '%/templates/story/story.php'
                  AND collection_id LIKE 'CC-MAIN-2018-%' THEN -2
                WHEN pattern LIKE '%/templates/story/story.php' THEN -1
                WHEN instr(pattern, '/20') > 0 THEN 0
                ELSE 1
            END,
            CAST(
                substr(pattern, instr(pattern, '/20') + 1, 4)
                AS INTEGER
            ),
            collection_id {collection_direction},
            pattern,
            updated_at
        LIMIT 1
        """
    ).fetchone()
    if row is None:
        return None
    return str(row[0]), str(row[1]), str(row[2]), row[3], int(row[4])


def reconcile_prefix_year_targets(
    connection: sqlite3.Connection,
    *,
    target_articles_per_year: int | None,
) -> int:
    if target_articles_per_year is not None and target_articles_per_year < 1:
        raise ValueError("target_articles_per_year must be positive")
    with connection:
        existing_row = connection.execute(
            "SELECT value FROM prefix_metadata "
            "WHERE key='target_articles_per_year'"
        ).fetchone()
        existing_target = str(existing_row[0]) if existing_row else None
        requested_target = (
            str(target_articles_per_year)
            if target_articles_per_year is not None
            else None
        )
        if existing_target != requested_target:
            connection.execute(
                """
                UPDATE prefix_queries
                SET status='pending', updated_at=?
                WHERE status='target-complete'
                """,
                (_now_iso(),),
            )
            if requested_target is None:
                connection.execute(
                    "DELETE FROM prefix_metadata "
                    "WHERE key='target_articles_per_year'"
                )
            else:
                connection.execute(
                    """
                    INSERT INTO prefix_metadata(key, value)
                    VALUES ('target_articles_per_year', ?)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value
                    """,
                    (requested_target,),
                )
        if target_articles_per_year is None:
            return 0
        satisfied_years = [
            str(year)
            for year, count in connection.execute(
                """
                SELECT substr(published_at, 1, 4),
                       COUNT(DISTINCT canonical_url)
                FROM prefix_candidates
                GROUP BY substr(published_at, 1, 4)
                HAVING COUNT(DISTINCT canonical_url) >= ?
                """,
                (target_articles_per_year,),
            )
        ]
        before = connection.total_changes
        for year in satisfied_years:
            connection.execute(
                """
                UPDATE prefix_queries
                SET status='target-complete', last_error=NULL, updated_at=?
                WHERE status NOT IN ('complete', 'target-complete')
                  AND substr(pattern, instr(pattern, '/20') + 1, 4)=?
                """,
                (_now_iso(), year),
            )
        window = dict(
            connection.execute(
                "SELECT key, value FROM prefix_metadata "
                "WHERE key IN ('from_year', 'to_year')"
            )
        )
        configured_years = {
            str(year)
            for year in range(
                int(window["from_year"]),
                int(window["to_year"]) + 1,
            )
        }
        if configured_years and configured_years.issubset(satisfied_years):
            # Undated legacy URL families (currently NPR storyId links) can
            # contribute to any configured year after HTML hydration. Once
            # every year has reached its target, scanning them further is no
            # longer useful; reopen them automatically if the target grows.
            connection.execute(
                """
                UPDATE prefix_queries
                SET status='target-complete', last_error=NULL, updated_at=?
                WHERE status NOT IN ('complete', 'target-complete')
                  AND instr(pattern, '/20')=0
                """,
                (_now_iso(),),
            )
        return connection.total_changes - before


def _prefix_year_targets_satisfied(
    connection: sqlite3.Connection,
    *,
    target_articles_per_year: int | None = None,
) -> bool:
    """Return whether every configured publication year has its target.

    Date hydration can leave a very large tail of undated candidates. Once
    every configured year already has enough dated canonical URLs, that tail
    cannot improve the validation catalog and should not keep an auto-resumed
    source workflow alive.
    """
    if target_articles_per_year is None:
        target_row = connection.execute(
            "SELECT value FROM prefix_metadata "
            "WHERE key='target_articles_per_year'"
        ).fetchone()
        if target_row is None:
            return False
        target_articles_per_year = int(target_row[0])
    if target_articles_per_year < 1:
        raise ValueError("target_articles_per_year must be positive")
    window = dict(
        connection.execute(
            "SELECT key, value FROM prefix_metadata "
            "WHERE key IN ('from_year', 'to_year')"
        )
    )
    if "from_year" not in window or "to_year" not in window:
        return False
    configured_years = tuple(
        str(year)
        for year in range(int(window["from_year"]), int(window["to_year"]) + 1)
    )
    if not configured_years:
        return False
    counts = {
        str(year): int(count)
        for year, count in connection.execute(
            """
            SELECT substr(published_at, 1, 4),
                   COUNT(DISTINCT canonical_url)
            FROM prefix_candidates
            GROUP BY substr(published_at, 1, 4)
            """
        )
    }
    return all(
        counts.get(year, 0) >= target_articles_per_year
        for year in configured_years
    )


def record_prefix_page_count(
    connection: sqlite3.Connection,
    *,
    collection_id: str,
    pattern: str,
    total_pages: int,
) -> None:
    if total_pages < 0:
        raise ValueError("total_pages must not be negative")
    with connection:
        connection.execute(
            """
            UPDATE prefix_queries
            SET total_pages=?, status=?, last_error=NULL, updated_at=?
            WHERE collection_id=? AND pattern=?
            """,
            (
                total_pages,
                "complete" if total_pages == 0 else "running",
                _now_iso(),
                collection_id,
                pattern,
            ),
        )


def record_prefix_error(
    connection: sqlite3.Connection,
    *,
    collection_id: str,
    pattern: str,
    error: str,
) -> None:
    with connection:
        connection.execute(
            """
            UPDATE prefix_queries
            SET attempts=attempts+1, last_error=?, updated_at=?
            WHERE collection_id=? AND pattern=?
            """,
            (error[:1_000], _now_iso(), collection_id, pattern),
        )


def record_prefix_page(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    collection_id: str,
    pattern: str,
    page_number: int,
    total_pages: int,
    page: PrefixIndexPage,
) -> dict[str, int | bool]:
    if not 0 <= page_number < total_pages:
        raise ValueError("page_number is outside total_pages")
    window = dict(
        connection.execute(
            """
            SELECT key, value FROM prefix_metadata
            WHERE key IN ('from_year', 'to_year')
            """
        ).fetchall()
    )
    start = f"{int(window['from_year']):04d}-01-01"
    end = f"{int(window['to_year']) + 1:04d}-01-01"
    dated_rows: list[tuple[object, ...]] = []
    undated_rows: list[tuple[object, ...]] = []
    dated_urls: set[str] = set()
    undated_urls: set[str] = set()
    for value in page.rows:
        original_url = str(value.get("url") or "").strip()
        canonical_url = normalize_article_url(spec, original_url)
        if canonical_url is None:
            continue
        published_at = infer_published_at(canonical_url)
        if published_at is None:
            existing_date = connection.execute(
                "SELECT published_at FROM prefix_candidates "
                "WHERE canonical_url=? LIMIT 1",
                (canonical_url,),
            ).fetchone()
            if existing_date is not None:
                published_at = str(existing_date[0])
        timestamp = str(value.get("timestamp") or "").strip()
        captured_at = _parse_crawl_timestamp(timestamp)
        status_code = _optional_int(value.get("status"))
        mimetype = str(value.get("mime") or "").strip()
        byte_count = _optional_int(value.get("length"))
        warc_offset = _optional_int(value.get("offset"))
        warc_filename = str(value.get("filename") or "").strip()
        if (
            captured_at is None
            or status_code != 200
            or mimetype.casefold() != "text/html"
            or byte_count is None
            or not 0 < byte_count <= MAXIMUM_COMPRESSED_WARC_BYTES
            or warc_offset is None
            or warc_offset < 0
            or not warc_filename.startswith("crawl-data/")
        ):
            continue
        common_values = (
            canonical_url,
            collection_id,
            timestamp,
            original_url,
            str(value.get("digest") or ""),
            mimetype,
            status_code,
            byte_count,
            warc_filename,
            warc_offset,
            byte_count,
        )
        if published_at is not None:
            if not start <= published_at < end:
                continue
            dated_rows.append(
                (
                    canonical_url,
                    published_at,
                    *common_values[1:],
                    candidate_rank(timestamp, published_at=published_at),
                )
            )
            dated_urls.add(canonical_url)
        elif spec.publisher in COMMON_CRAWL_DATE_HYDRATION_PUBLISHERS:
            undated_rows.append(
                (*common_values, candidate_rank(timestamp, published_at=None))
            )
            undated_urls.add(canonical_url)
    with connection:
        undated_counts_before = {
            canonical_url: int(
                connection.execute(
                    "SELECT COUNT(*) FROM prefix_undated_candidates "
                    "WHERE canonical_url=?",
                    (canonical_url,),
                ).fetchone()[0]
            )
            for canonical_url in undated_urls
        }
        before = connection.total_changes
        connection.executemany(
            """
            INSERT OR IGNORE INTO prefix_candidates(
                canonical_url, published_at, collection_id, timestamp,
                original_url, digest, mimetype, status_code, byte_count,
                warc_filename, warc_offset, warc_length, rank_score
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            dated_rows,
        )
        dated_accepted = connection.total_changes - before
        before = connection.total_changes
        connection.executemany(
            """
            INSERT OR IGNORE INTO prefix_undated_candidates(
                canonical_url, collection_id, timestamp, original_url,
                digest, mimetype, status_code, byte_count, warc_filename,
                warc_offset, warc_length, rank_score
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            undated_rows,
        )
        undated_accepted = connection.total_changes - before
        connection.executemany(
            """
            INSERT OR IGNORE INTO prefix_date_hydration(
                canonical_url, publisher, updated_at
            ) VALUES (?, ?, ?)
            """,
            (
                (canonical_url, spec.publisher, _now_iso())
                for canonical_url in sorted(undated_urls)
            ),
        )
        newly_expanded_urls = {
            canonical_url
            for canonical_url, prior_count in undated_counts_before.items()
            if int(
                connection.execute(
                    "SELECT COUNT(*) FROM prefix_undated_candidates "
                    "WHERE canonical_url=?",
                    (canonical_url,),
                ).fetchone()[0]
            )
            > prior_count
        }
        if newly_expanded_urls:
            placeholders = ",".join("?" for _ in newly_expanded_urls)
            connection.execute(
                f"""
                UPDATE prefix_date_hydration
                SET status='pending', attempts=0, last_error=NULL,
                    updated_at=?
                WHERE canonical_url IN ({placeholders})
                  AND status IN ('no-date', 'failed')
                """,
                (_now_iso(), *sorted(newly_expanded_urls)),
            )
        _trim_prefix_candidates(
            connection,
            table="prefix_candidates",
            canonical_urls=dated_urls,
        )
        _trim_prefix_candidates(
            connection,
            table="prefix_undated_candidates",
            canonical_urls=undated_urls,
            maximum=9,
        )
        accepted = dated_accepted + undated_accepted
        next_page = page_number + 1
        connection.execute(
            """
            UPDATE prefix_queries
            SET next_page=?, pages=pages+1, rows_seen=rows_seen+?,
                rows_accepted=rows_accepted+?, attempts=0,
                status=?, last_error=NULL, updated_at=?
            WHERE collection_id=? AND pattern=?
            """,
            (
                next_page,
                len(page.rows),
                accepted,
                "complete" if next_page >= total_pages else "running",
                _now_iso(),
                collection_id,
                pattern,
            ),
        )
    result: dict[str, int | bool] = {
        "seen": len(page.rows),
        "accepted": accepted,
        "complete": next_page >= total_pages,
    }
    if undated_accepted:
        result["datedAccepted"] = dated_accepted
        result["undatedAccepted"] = undated_accepted
    return result


def _trim_prefix_candidates(
    connection: sqlite3.Connection,
    *,
    table: str,
    canonical_urls: set[str],
    maximum: int = 3,
) -> None:
    if table not in {"prefix_candidates", "prefix_undated_candidates"}:
        raise ValueError("unsupported Common Crawl candidate table")
    if not canonical_urls:
        return
    if maximum < 1:
        raise ValueError("candidate maximum must be positive")
    placeholders = ",".join("?" for _ in canonical_urls)
    connection.execute(
        f"""
        DELETE FROM {table}
        WHERE rowid IN (
            SELECT rowid FROM (
                SELECT rowid,
                    ROW_NUMBER() OVER (
                        PARTITION BY canonical_url
                        ORDER BY rank_score, timestamp,
                                 collection_id, warc_filename, warc_offset
                    ) AS candidate_number
                FROM {table}
                WHERE canonical_url IN ({placeholders})
            ) WHERE candidate_number > ?
        )
        """,
        (*sorted(canonical_urls), maximum),
    )


def process_prefix_date_hydration(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    archive_client: CommonCrawlClient,
    maximum: int,
    target_articles_per_year: int | None = None,
    maximum_html_bytes: int = 15_000_000,
    maximum_attempts: int = 3,
) -> dict[str, object]:
    """Recover publication dates for canonical URLs without a date key."""
    if spec.publisher not in COMMON_CRAWL_DATE_HYDRATION_PUBLISHERS:
        raise ValueError(
            "Common Crawl date hydration is not supported for "
            f"{spec.publisher!r}"
        )
    if maximum < 1 or maximum_html_bytes < 1 or maximum_attempts < 1:
        raise ValueError("hydration limits must be positive")
    if (
        target_articles_per_year is not None
        and target_articles_per_year < 1
    ):
        raise ValueError("target_articles_per_year must be positive")
    window = dict(
        connection.execute(
            """
            SELECT key, value FROM prefix_metadata
            WHERE key IN ('from_year', 'to_year')
            """
        )
    )
    pending_rows = connection.execute(
        """
        WITH first_capture AS (
            SELECT canonical_url, MIN(timestamp) AS first_timestamp
            FROM prefix_undated_candidates
            GROUP BY canonical_url
        )
        SELECT hydration.canonical_url, hydration.attempts
        FROM prefix_date_hydration AS hydration
        LEFT JOIN first_capture
          ON first_capture.canonical_url=hydration.canonical_url
        WHERE hydration.publisher=?
          AND hydration.status IN ('pending', 'retry')
          AND hydration.attempts < ?
        ORDER BY
            hydration.attempts,
            CASE
                WHEN substr(first_capture.first_timestamp, 1, 4)
                     BETWEEN ? AND ? THEN 0
                ELSE 1
            END,
            first_capture.first_timestamp,
            hydration.updated_at,
            hydration.canonical_url
        """,
        (
            spec.publisher,
            maximum_attempts,
            str(int(window["from_year"])),
            str(int(window["to_year"])),
        ),
    ).fetchall()
    if spec.publisher == "nikkei":
        from_year = int(window["from_year"])
        to_year = int(window["to_year"])
        midpoint = (from_year + to_year) // 2
        # Nikkei's opaque-looking article key usually embeds the publication
        # year (for example, ``...C10A...`` for 2010).  Common Crawl first
        # saw much of the historical corpus in 2019, so capture timestamp
        # ordering otherwise puts hundreds of thousands of newer articles in
        # front of the requested legacy year.  Treat this only as a queue
        # hint: the archived HTML is still fetched and its parsed publication
        # date remains authoritative.
        pending_rows.sort(
            key=lambda row: (
                not (
                    (year_hint := _nikkei_article_year_hint(str(row[0])))
                    is not None
                    and from_year <= year_hint <= to_year
                ),
                int(row[1]),
                (
                    abs(year_hint - midpoint)
                    if year_hint is not None
                    else 10_000
                ),
            )
        )
    start = f"{int(window['from_year']):04d}-01-01"
    end = f"{int(window['to_year']) + 1:04d}-01-01"
    if spec.publisher == "npr":
        target_story_ids = sorted(
            story_id
            for (canonical_url,) in connection.execute(
                """
                SELECT DISTINCT canonical_url FROM prefix_candidates
                WHERE published_at >= ? AND published_at < ?
                """,
                (start, end),
            )
            if (story_id := _npr_story_id(str(canonical_url))) is not None
        )
        if target_story_ids:
            lower = target_story_ids[len(target_story_ids) // 100]
            upper = target_story_ids[len(target_story_ids) * 99 // 100]
            midpoint = (lower + upper) // 2
            pending_rows.sort(
                key=lambda row: (
                    int(row[1]),
                    not (
                        (story_id := _npr_story_id(str(row[0]))) is not None
                        and lower <= story_id <= upper
                    ),
                    abs((story_id or 0) - midpoint),
                    str(row[0]),
                )
            )
    rows = pending_rows[:maximum]
    found = 0
    outside_window = 0
    no_date = 0
    failed = 0
    attempted = 0
    errors: list[str] = []
    for canonical_url_value, prior_attempts in rows:
        if (
            target_articles_per_year is not None
            and _prefix_year_targets_satisfied(
                connection,
                target_articles_per_year=target_articles_per_year,
            )
        ):
            break
        attempted += 1
        canonical_url = str(canonical_url_value)
        candidate_rows = connection.execute(
            """
            SELECT collection_id, timestamp, original_url, digest, mimetype,
                   status_code, byte_count, warc_filename, warc_offset,
                   warc_length
            FROM prefix_undated_candidates
            WHERE canonical_url=?
            ORDER BY rank_score, timestamp, collection_id
            LIMIT 3
            OFFSET ?
            """,
            (canonical_url, int(prior_attempts) * 3),
        ).fetchall()
        published_at: str | None = None
        parser_status: str | None = None
        body_characters: int | None = None
        successful_response = False
        request_errors: list[str] = []
        for candidate_row in candidate_rows:
            captured_at = _parse_crawl_timestamp(str(candidate_row[1]))
            if captured_at is None:
                request_errors.append("ValueError: invalid crawl timestamp")
                continue
            candidate = CaptureCandidate(
                provider=CaptureProvider.COMMON_CRAWL,
                snapshot_url=DATA_BASE_URL + str(candidate_row[7]),
                source_url=str(candidate_row[2]),
                captured_at=captured_at,
                digest=str(candidate_row[3]) or None,
                mime_type=str(candidate_row[4]),
                status_code=int(candidate_row[5]),
                byte_count=int(candidate_row[6]),
                warc_filename=str(candidate_row[7]),
                warc_offset=int(candidate_row[8]),
                warc_length=int(candidate_row[9]),
            )
            try:
                status, _, content, _ = fetch_common_crawl_candidate(
                    candidate,
                    archive_client=archive_client,
                    maximum_html_bytes=maximum_html_bytes,
                )
                if status != 200 or not content:
                    raise ValueError(
                        f"embedded Common Crawl response returned HTTP {status}"
                    )
                article = parse_article(
                    content,
                    publisher=spec.publisher,
                    canonical_url=canonical_url,
                )
                successful_response = True
                parser_status = article.quality.status.value
                body_characters = article.quality.body_characters
                if article.published_at is not None:
                    published_at = article.published_at.isoformat()
                    break
            except Exception as exc:
                request_errors.append(f"{type(exc).__name__}: {exc}")
        attempts = int(prior_attempts) + 1
        if published_at is not None and start <= published_at < end:
            status = "complete"
            error = None
            found += 1
        elif published_at is not None:
            status = "out-of-window"
            error = None
            outside_window += 1
        elif successful_response and not request_errors:
            status = "no-date"
            error = None
            no_date += 1
        elif attempts >= maximum_attempts:
            status = "failed"
            error = "; ".join(request_errors) or "no usable WARC response"
            failed += 1
        else:
            status = "retry"
            error = "; ".join(request_errors) or "no usable WARC response"
        if error:
            errors.append(f"{canonical_url}: {error}")
        with connection:
            connection.execute(
                """
                UPDATE prefix_date_hydration
                SET status=?, attempts=?, published_at=?, parser_status=?,
                    body_characters=?, last_error=?, updated_at=?
                WHERE canonical_url=? AND publisher=?
                """,
                (
                    status,
                    attempts,
                    published_at,
                    parser_status,
                    body_characters,
                    error,
                    _now_iso(),
                    canonical_url,
                    spec.publisher,
                ),
            )
            if status == "complete" and published_at is not None:
                _promote_undated_candidates(
                    connection,
                    canonical_url=canonical_url,
                    published_at=published_at,
                )
        if (
            target_articles_per_year is not None
            and _prefix_year_targets_satisfied(
                connection,
                target_articles_per_year=target_articles_per_year,
            )
        ):
            break
    remaining = int(
        connection.execute(
            """
            SELECT COUNT(*) FROM prefix_date_hydration
            WHERE publisher=?
              AND status IN ('pending', 'retry')
              AND attempts < ?
            """,
            (spec.publisher, maximum_attempts),
        ).fetchone()[0]
    )
    return {
        "attempted": attempted,
        "found": found,
        "outOfWindow": outside_window,
        "noDate": no_date,
        "failed": failed,
        "remaining": remaining,
        "errors": errors,
    }


def _npr_story_id(value: str) -> int | None:
    match = re.search(
        r"(?i)(?:storyId=|/)(\d{6,})(?:[/?&#]|$)",
        value,
    )
    return int(match.group(1)) if match is not None else None


def _nikkei_article_year_hint(value: str) -> int | None:
    article_key = value.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]
    encoded_years = re.findall(r"C(\d{2})A", article_key)
    if encoded_years:
        return 2000 + int(encoded_years[-1])
    # Some keys use the shorter ``_<letter><year digit>A`` form without a
    # two-digit C-year segment.  That family was introduced in the 2010s.
    short_match = re.search(r"_[A-Z](\d)A", article_key)
    if short_match is not None:
        return 2010 + int(short_match.group(1))
    return None


def _promote_undated_candidates(
    connection: sqlite3.Connection,
    *,
    canonical_url: str,
    published_at: str,
) -> None:
    rows = connection.execute(
        """
        SELECT collection_id, timestamp, original_url, digest, mimetype,
               status_code, byte_count, warc_filename, warc_offset,
               warc_length
        FROM prefix_undated_candidates
        WHERE canonical_url=?
        """,
        (canonical_url,),
    ).fetchall()
    connection.executemany(
        """
        INSERT OR IGNORE INTO prefix_candidates(
            canonical_url, published_at, collection_id, timestamp,
            original_url, digest, mimetype, status_code, byte_count,
            warc_filename, warc_offset, warc_length, rank_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (
                canonical_url,
                published_at,
                *row,
                candidate_rank(str(row[1]), published_at=published_at),
            )
            for row in rows
        ),
    )
    connection.execute(
        "DELETE FROM prefix_undated_candidates WHERE canonical_url=?",
        (canonical_url,),
    )
    _trim_prefix_candidates(
        connection,
        table="prefix_candidates",
        canonical_urls={canonical_url},
    )


def prefix_date_hydration_summary(
    connection: sqlite3.Connection,
) -> dict[str, int] | None:
    total = int(
        connection.execute(
            "SELECT COUNT(*) FROM prefix_date_hydration"
        ).fetchone()[0]
    )
    if total == 0:
        return None
    row = connection.execute(
        """
        SELECT
            SUM(status='complete'),
            SUM(status='out-of-window'),
            SUM(status='no-date'),
            SUM(status='failed'),
            SUM(status IN ('pending', 'retry') AND attempts < 3)
        FROM prefix_date_hydration
        """
    ).fetchone()
    return {
        "total": total,
        "complete": int(row[0] or 0),
        "outOfWindow": int(row[1] or 0),
        "noDate": int(row[2] or 0),
        "failed": int(row[3] or 0),
        "remaining": int(row[4] or 0),
    }


def export_prefix_manifest(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    destination: Path,
) -> dict[str, object]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    opener = gzip.open if destination.suffix == ".gz" else open
    rows = connection.execute(
        """
        SELECT canonical_url, published_at, collection_id, timestamp,
               original_url, digest, mimetype, status_code, byte_count,
               warc_filename, warc_offset, warc_length
        FROM prefix_candidates
        ORDER BY canonical_url, rank_score, timestamp, collection_id
        """
    )
    article_count = 0
    candidate_count = 0
    with opener(temporary, "wt", encoding="utf-8") as handle:
        current_url: str | None = None
        current_published_at: str | None = None
        candidates: list[dict[str, object]] = []
        for row in rows:
            canonical_url = str(row[0])
            if current_url is not None and canonical_url != current_url:
                _write_row(
                    handle,
                    spec=spec,
                    canonical_url=current_url,
                    published_at=current_published_at,
                    candidates=candidates,
                )
                article_count += 1
                candidate_count += len(candidates)
                candidates = []
            current_url = canonical_url
            current_published_at = str(row[1])
            captured_at = _parse_crawl_timestamp(str(row[3]))
            candidates.append(
                {
                    "provider": "commoncrawl",
                    "snapshotUrl": DATA_BASE_URL + str(row[9]),
                    "capturedAt": captured_at.isoformat(),
                    **({"digest": str(row[5])} if row[5] else {}),
                    "mimeType": str(row[6]),
                    "statusCode": int(row[7]),
                    "byteCount": int(row[8]),
                    "warcFilename": str(row[9]),
                    "warcOffset": int(row[10]),
                    "warcLength": int(row[11]),
                }
            )
        if current_url is not None:
            _write_row(
                handle,
                spec=spec,
                canonical_url=current_url,
                published_at=current_published_at,
                candidates=candidates,
            )
            article_count += 1
            candidate_count += len(candidates)
    temporary.replace(destination)
    return {
        "publisher": spec.publisher,
        "articles": article_count,
        "candidates": candidate_count,
        "output": str(destination),
    }


def prefix_summary(connection: sqlite3.Connection) -> dict[str, object]:
    query_status = {
        str(status): int(count)
        for status, count in connection.execute(
            "SELECT status, COUNT(*) FROM prefix_queries GROUP BY status"
        )
    }
    years = {
        str(year): int(count)
        for year, count in connection.execute(
            """
            SELECT substr(published_at, 1, 4), COUNT(DISTINCT canonical_url)
            FROM prefix_candidates
            GROUP BY substr(published_at, 1, 4)
            ORDER BY 1
            """
        )
    }
    remaining = int(
        connection.execute(
            "SELECT COUNT(*) FROM prefix_queries "
            "WHERE status NOT IN ('complete', 'target-complete')"
        ).fetchone()[0]
    )
    hydration = prefix_date_hydration_summary(connection)
    target_complete = _prefix_year_targets_satisfied(connection)
    result: dict[str, object] = {
        "formatVersion": SCHEMA_VERSION,
        "queryStatus": query_status,
        "articlesByYear": years,
        "queriesRemaining": remaining,
        "targetComplete": target_complete,
        "shouldContinue": (
            not target_complete
            and (
                remaining > 0
                or bool(hydration and hydration["remaining"] > 0)
            )
        ),
    }
    if hydration is not None:
        result["dateHydration"] = hydration
    return result


def _query_parameters(
    pattern: str,
    *,
    page_size: int | None = None,
) -> list[tuple[str, str]]:
    parameters = [
        ("url", pattern),
        ("output", "json"),
        ("filter", "status:200"),
        ("filter", "mime:text/html"),
        ("matchType", "prefix"),
        ("collapse", "urlkey"),
    ]
    if page_size is not None:
        parameters.append(("pageSize", str(page_size)))
    return parameters


def _write_row(
    handle,
    *,
    spec: ArchiveSourceSpec,
    canonical_url: str,
    published_at: str | None,
    candidates: list[dict[str, object]],
) -> None:
    handle.write(
        json.dumps(
            {
                "formatVersion": MANIFEST_FORMAT_VERSION,
                "publisher": spec.publisher,
                "canonicalUrl": canonical_url,
                **({"publishedAt": published_at} if published_at else {}),
                "candidates": candidates,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n"
    )


def _fingerprint(
    *,
    spec: ArchiveSourceSpec,
    from_year: int,
    to_year: int,
    patterns: tuple[str, ...],
) -> str:
    value = json.dumps(
        {
            "publisher": spec.publisher,
            "fromYear": from_year,
            "toYear": to_year,
            "patterns": patterns,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(value.encode()).hexdigest()


def _parse_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_crawl_timestamp(value: str) -> datetime | None:
    if re.fullmatch(r"\d{14}", value) is None:
        return None
    try:
        return datetime.strptime(value, "%Y%m%d%H%M%S").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None


def _optional_int(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError, OverflowError):
        return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
