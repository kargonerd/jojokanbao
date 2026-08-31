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

import httpx

from jojo_news_archive.sources.registry import (
    ArchiveSourceSpec,
    archive_source_spec,
    normalize_article_url,
)
from jojo_news_archive.sources.discovery_registry import (
    DISCOVERY_HOOKS,
    infer_published_at as registered_infer_published_at,
    source_discovery,
)
from jojo_news_archive.discovery.client import GlobalRateLimiter


CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx"
RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
DISCOVERY_SCHEMA_VERSION = "jojo-wayback-discovery/1"
MANIFEST_FORMAT_VERSION = "jojo-capture-manifest/1"
GOOGLE_NEWS_RSS_ENDPOINT = "https://news.google.com/rss/search"
GOOGLE_NEWS_DECODE_ENDPOINT = (
    "https://news.google.com/_/DotsSplashUi/data/batchexecute"
)
PARSER_VALIDATION_CATALOG_MINIMUM_PER_YEAR = 750
ARCHIVED_DATE_HYDRATION_PUBLISHERS = frozenset(
    hooks.publisher
    for hooks in DISCOVERY_HOOKS.values()
    if hooks.supports_archived_date_hydration
)
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
            source_priority INTEGER NOT NULL DEFAULT 0,
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
    if "source_priority" not in query_columns:
        connection.execute(
            "ALTER TABLE discovery_queries "
            "ADD COLUMN source_priority INTEGER NOT NULL DEFAULT 0"
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
    hooks = source_discovery(spec.publisher)
    query_priorities = {
        pattern: (
            hooks.wayback_query_priority(pattern, from_year, to_year)
            if hooks.wayback_query_priority is not None
            else 0
        )
        for pattern in patterns
    }
    connection.executemany(
        """
        INSERT INTO discovery_queries(pattern, source_priority, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(pattern) DO UPDATE SET
            source_priority=excluded.source_priority
        """,
        [
            (pattern, query_priorities[pattern], _now_iso())
            for pattern in patterns
        ],
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








def initialize_archived_date_schema(
    connection: sqlite3.Connection,
    *,
    publisher: str,
) -> None:
    """Track URL families whose publication year is absent from the URL."""
    if not source_discovery(publisher).supports_archived_date_hydration:
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
    extractor = source_discovery(publisher).archived_date_extractor
    if extractor is None:
        raise ValueError(
            f"archived date extraction is not supported for {publisher!r}"
        )
    return extractor(html)


















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
            CASE WHEN failures=0 THEN source_priority ELSE 0 END,
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
) -> dict[str, int | bool | str | object]:
    if capture_minimum_per_year < 1:
        raise ValueError("capture_minimum_per_year must be positive")
    hooks = source_discovery(spec.publisher)
    if hooks.wayback_manifest_exporter is not None:
        return hooks.wayback_manifest_exporter(
            connection,
            spec,
            destination,
            from_year,
            to_year,
            capture_minimum_per_year,
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
    grouped: dict[str, tuple[str | None, list[dict[str, object]]]] = {}
    for row in rows:
        canonical_url = str(row[0])
        if normalize_article_url(spec, canonical_url) != canonical_url:
            continue
        published_at, candidates = grouped.setdefault(
            canonical_url,
            (str(row[1]) if row[1] else None, []),
        )
        candidates.append(
            {
                "provider": "wayback",
                "snapshotUrl": (
                    f"https://web.archive.org/web/{row[2]}id_/{row[3]}"
                ),
                "capturedAt": _timestamp_datetime(str(row[2])).isoformat(),
                **({"digest": row[4]} if row[4] else {}),
                "mimeType": row[5],
                "statusCode": row[6],
                **({"byteCount": row[7]} if row[7] is not None else {}),
            }
        )

    temporary = destination.with_suffix(destination.suffix + ".tmp")
    opener = gzip.open if destination.suffix == ".gz" else open
    candidate_count = 0
    with opener(temporary, "wt", encoding="utf-8") as handle:
        for canonical_url, (published_at, candidates) in grouped.items():
            _write_manifest_row(
                handle,
                spec=spec,
                canonical_url=canonical_url,
                published_at=published_at,
                candidates=candidates,
            )
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
    year_counts = {
        str(year): sum(
            published_at is not None
            and published_at.startswith(f"{year:04d}-")
            for published_at, _ in grouped.values()
        )
        for year in range(from_year, to_year + 1)
    }
    return {
        "publisher": spec.publisher,
        "fromYear": from_year,
        "toYear": to_year,
        "complete": incomplete == 0,
        "captureReady": all(
            count >= capture_minimum_per_year
            for count in year_counts.values()
        ),
        "captureMinimumPerYear": capture_minimum_per_year,
        "yearCounts": year_counts,
        "remainingQueries": incomplete,
        "articles": len(grouped),
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
        SELECT COALESCE(SUM(pages), 0), COALESCE(SUM(rows_seen), 0),
               COALESCE(SUM(rows_accepted), 0)
        FROM discovery_queries
        """
    ).fetchone()
    result: dict[str, object] = {
        "queriesByStatus": query_counts,
        "pages": int(totals[0]),
        "rowsSeen": int(totals[1]),
        "rowsAccepted": int(totals[2]),
        "articles": int(
            connection.execute(
                "SELECT COUNT(DISTINCT canonical_url) FROM candidates"
            ).fetchone()[0]
        ),
        "shouldContinue": sum(
            count
            for status, count in query_counts.items()
            if status != "complete"
        ) > 0,
    }
    archived_dates = archived_date_summary(connection)
    if archived_dates is not None:
        result["archivedDates"] = archived_dates
        result["shouldContinue"] = bool(
            result["shouldContinue"]
        ) or archived_dates["remaining"] > 0
    publisher_row = connection.execute(
        "SELECT value FROM discovery_metadata WHERE key='publisher'"
    ).fetchone()
    if publisher_row is not None:
        hooks = source_discovery(str(publisher_row[0]))
        if hooks.wayback_summary is not None:
            result = hooks.wayback_summary(connection, result)
    return result


def infer_published_at(canonical_url: str) -> str | None:
    return registered_infer_published_at(canonical_url)


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


# Public discovery primitives consumed by source-owned catalog pipelines.
# Keep the private aliases above temporarily for backwards compatibility with
# older scripts, but vertical source modules must import these explicit names.
approximate_wayback_candidates = _approximate_wayback_candidates


def decode_google_news_url(
    http_client: httpx.Client,
    google_news_url: str,
) -> str:
    """Decode one Google News redirect through the shared public API."""

    # Keep runtime delegation so legacy callers that patch the former private
    # function still observe the same behavior during the transition.
    return _decode_google_news_url(http_client, google_news_url)


merge_capture_candidates = _merge_capture_candidates
parse_iso_datetime = _parse_iso_datetime
parse_rss_datetime = _parse_rss_datetime
table_exists = _table_exists
timestamp_datetime = _timestamp_datetime
utc_now_iso = _now_iso
write_manifest_row = _write_manifest_row
