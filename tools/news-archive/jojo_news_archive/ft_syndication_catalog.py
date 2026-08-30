from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import ipaddress
import json
import math
from pathlib import Path
import re
import sqlite3
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit
from xml.etree import ElementTree

from bs4 import BeautifulSoup
import httpx

from .archive_sources import (
    ArchiveSourceSpec,
    archive_source_spec,
    normalize_article_url,
)
from .bloomberg_archive_download import GlobalRateLimiter
from .infini_news import (
    INFINI_DATASET,
    INFINI_DATASET_ROWS_ENDPOINT,
    infini_news_row_url,
)
from .news_models import CaptureCandidate, CaptureProvider
from .wayback_manifest import (
    GOOGLE_NEWS_RSS_ENDPOINT,
    _decode_google_news_url,
)


SCHEMA_VERSION = "jojo-ft-syndication-catalog/1"
INFINI_FIND_ENDPOINT = (
    "https://infini-news.uni-graz.at/api/v1/find"
)
INFINI_DOCUMENT_ENDPOINT = (
    "https://infini-news.uni-graz.at/api/v1/get_doc"
)
INFINI_QUERY = "Copyright The Financial Times Limited"
YAHOO_SEARCH_ENDPOINT = "https://search.yahoo.com/search"
YAHOO_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36"
)
RESOLUTION_TARGET_PER_YEAR = 750
MAXIMUM_OCCURRENCES_PER_YEAR = 1_000
DEFAULT_DOCUMENTS_PER_RUN = 500
DEFAULT_RESOLUTIONS_PER_RUN = 500
DEFAULT_WORKERS = 4
GOOGLE_NEWS_MAXIMUM_DECODES_PER_TITLE = 3
GOOGLE_NEWS_MAXIMUM_DATE_DELTA_DAYS = 2
_SIGNIFICANT_TOKEN_RE = re.compile(r"[a-z0-9]+")
_STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "has",
    "have",
    "in",
    "is",
    "it",
    "its",
    "of",
    "on",
    "or",
    "s",
    "that",
    "the",
    "this",
    "to",
    "was",
    "were",
    "will",
    "with",
}
_TRACKING_QUERY_KEYS = {
    "utm_campaign",
    "utm_content",
    "utm_medium",
    "utm_source",
    "utm_term",
}


@dataclass(frozen=True)
class FtSyndicationTitleEntry:
    partner_url: str
    published_date: date
    expected_headline: str
    source_year: int
    document_index: int
    warc_filename: str


class FtSyndicationTitleIndex:
    def __init__(self, entries: list[FtSyndicationTitleEntry]) -> None:
        by_year: dict[int, list[FtSyndicationTitleEntry]] = {}
        for entry in entries:
            by_year.setdefault(entry.published_date.year, []).append(entry)
        self._by_year = {
            year: tuple(
                sorted(
                    values,
                    key=lambda entry: (
                        entry.published_date,
                        entry.partner_url,
                    ),
                )
            )
            for year, values in by_year.items()
        }
        self.size = len(entries)

    def candidates_for(
        self,
        *,
        published_at: str | None,
        headline: str,
        maximum_matches: int = 3,
    ) -> tuple[CaptureCandidate, ...]:
        published_date = _optional_date(published_at)
        expected_tokens = _significant_tokens(headline)
        if (
            published_date is None
            or len(expected_tokens) < 4
            or maximum_matches < 1
        ):
            return ()
        ranked: list[tuple[float, int, FtSyndicationTitleEntry]] = []
        for entry in self._by_year.get(published_date.year, ()):
            entry_tokens = _significant_tokens(entry.expected_headline)
            matching_tokens = len(expected_tokens & entry_tokens)
            overlap = (
                matching_tokens / max(len(expected_tokens), len(entry_tokens))
                if entry_tokens
                else 0.0
            )
            date_delta = abs((entry.published_date - published_date).days)
            if overlap >= 0.9 and matching_tokens >= 4 and date_delta <= 2:
                ranked.append((overlap, -date_delta, entry))
        ranked.sort(
            key=lambda value: (
                -value[0],
                -value[1],
                value[2].partner_url,
            )
        )
        candidates: list[CaptureCandidate] = []
        seen_sources: set[str] = set()
        for _, _, entry in ranked:
            if entry.partner_url in seen_sources:
                continue
            seen_sources.add(entry.partner_url)
            candidates.extend(
                (
                    CaptureCandidate(
                        provider=CaptureProvider.OTHER,
                        snapshot_url=entry.partner_url,
                        expected_headline=headline,
                    ),
                    CaptureCandidate(
                        provider=CaptureProvider.INFINI_NEWS,
                        snapshot_url=infini_news_row_url(
                            entry.source_year,
                            entry.document_index,
                        ),
                        source_url=entry.partner_url,
                        expected_headline=headline,
                        warc_filename=entry.warc_filename,
                    ),
                )
            )
            if len(seen_sources) >= maximum_matches:
                break
        return tuple(candidates)


def load_ft_syndication_title_index(
    path: str | Path,
) -> FtSyndicationTitleIndex:
    catalog_path = Path(path)
    if not catalog_path.exists():
        return FtSyndicationTitleIndex([])
    connection = sqlite3.connect(
        f"file:{catalog_path.resolve().as_posix()}?mode=ro",
        uri=True,
    )
    try:
        table = connection.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type='table' AND name='ft_syndication_unresolved'
            """
        ).fetchone()
        if table is None:
            return FtSyndicationTitleIndex([])
        rows = connection.execute(
            """
            SELECT DISTINCT
                partner_url,
                published_at,
                expected_headline,
                source_year,
                document_index,
                warc_source
            FROM ft_syndication_unresolved
            WHERE document_index IS NOT NULL
              AND warc_source LIKE 'CC-NEWS-%.warc.gz'
            ORDER BY published_at, partner_url
            """
        ).fetchall()
    finally:
        connection.close()
    entries: list[FtSyndicationTitleEntry] = []
    for (
        partner_url,
        published_at,
        expected_headline,
        source_year,
        document_index,
        warc_filename,
    ) in rows:
        published_date = _optional_date(str(published_at))
        if published_date is None:
            continue
        entries.append(
            FtSyndicationTitleEntry(
                partner_url=str(partner_url),
                published_date=published_date,
                expected_headline=str(expected_headline),
                source_year=int(source_year),
                document_index=int(document_index),
                warc_filename=str(warc_filename),
            )
        )
    return FtSyndicationTitleIndex(entries)


def _optional_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError:
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None


def initialize_ft_syndication_schema(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
) -> None:
    if from_year > to_year:
        raise ValueError("from_year must not exceed to_year")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS ft_syndication_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ft_syndication_queries (
            year INTEGER PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'pending',
            occurrence_count INTEGER,
            shard_count INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ft_syndication_occurrences (
            year INTEGER NOT NULL,
            shard_index INTEGER NOT NULL,
            rank INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            partner_url TEXT,
            published_at TEXT,
            expected_headline TEXT,
            hostname TEXT,
            language TEXT,
            document_index INTEGER,
            document_length INTEGER,
            warc_source TEXT,
            last_error TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(year, shard_index, rank)
        );

        CREATE TABLE IF NOT EXISTS ft_syndication_unresolved (
            partner_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            expected_headline TEXT NOT NULL,
            source_year INTEGER NOT NULL,
            document_index INTEGER,
            warc_source TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ft_syndication_articles (
            canonical_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            partner_url TEXT NOT NULL,
            expected_headline TEXT NOT NULL,
            source_year INTEGER NOT NULL,
            document_index INTEGER,
            warc_source TEXT,
            mapping_method TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ft_syndication_occurrence_status
        ON ft_syndication_occurrences(status, year, rank);

        CREATE INDEX IF NOT EXISTS idx_ft_syndication_unresolved_status
        ON ft_syndication_unresolved(status, published_at);

        CREATE INDEX IF NOT EXISTS idx_ft_syndication_article_year
        ON ft_syndication_articles(published_at);
        """
    )
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "query": INFINI_QUERY,
                "fromYear": from_year,
                "toYear": to_year,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    existing = connection.execute(
        """
        SELECT value
        FROM ft_syndication_metadata
        WHERE key='fingerprint'
        """
    ).fetchone()
    if existing and str(existing[0]) != fingerprint:
        raise ValueError(
            "FT syndication state belongs to a different date window"
        )
    connection.executemany(
        """
        INSERT INTO ft_syndication_metadata(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        {
            "schema_version": SCHEMA_VERSION,
            "query": INFINI_QUERY,
            "from_year": str(from_year),
            "to_year": str(to_year),
            "fingerprint": fingerprint,
        }.items(),
    )
    now = _now_iso()
    connection.executemany(
        """
        INSERT OR IGNORE INTO ft_syndication_queries(
            year,
            updated_at
        ) VALUES (?, ?)
        """,
        ((year, now) for year in range(from_year, to_year + 1)),
    )
    connection.commit()


def process_ft_infini_queries(
    connection: sqlite3.Connection,
    *,
    http_client: httpx.Client,
    maximum_years: int,
) -> dict[str, object]:
    rows = connection.execute(
        """
        SELECT year
        FROM ft_syndication_queries
        WHERE status='pending'
           OR (status='error' AND attempts < 3)
        ORDER BY year DESC
        LIMIT ?
        """,
        (maximum_years,),
    ).fetchall()
    processed = 0
    occurrences = 0
    errors: list[str] = []
    for (year_value,) in rows:
        year = int(year_value)
        try:
            response = http_client.post(
                INFINI_FIND_ENDPOINT,
                json={
                    "query": INFINI_QUERY,
                    "index": "ccnews",
                    "year_min": year,
                    "year_max": year,
                },
            )
            response.raise_for_status()
            payload = response.json()
            segments = payload.get("segment_by_shard")
            shard_years = payload.get("shard_years")
            if (
                not isinstance(segments, list)
                or not isinstance(shard_years, list)
                or len(segments) != len(shard_years)
            ):
                raise ValueError("Infini-News find response is invalid")
            if any(str(value) != str(year) for value in shard_years):
                raise ValueError("Infini-News shard year does not match")
            sampled = _sample_occurrence_ranks(
                segments,
                maximum=MAXIMUM_OCCURRENCES_PER_YEAR,
            )
            now = _now_iso()
            with connection:
                connection.executemany(
                    """
                    INSERT OR IGNORE INTO ft_syndication_occurrences(
                        year,
                        shard_index,
                        rank,
                        updated_at
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (
                        (year, shard_index, rank, now)
                        for shard_index, rank in sampled
                    ),
                )
                connection.execute(
                    """
                    UPDATE ft_syndication_queries
                    SET status='complete',
                        occurrence_count=?,
                        shard_count=?,
                        attempts=attempts+1,
                        last_error=NULL,
                        updated_at=?
                    WHERE year=?
                    """,
                    (
                        int(payload.get("count") or len(sampled)),
                        len(segments),
                        now,
                        year,
                    ),
                )
            processed += 1
            occurrences += len(sampled)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            errors.append(f"{year}: {error}")
            with connection:
                connection.execute(
                    """
                    UPDATE ft_syndication_queries
                    SET status='error',
                        attempts=attempts+1,
                        last_error=?,
                        updated_at=?
                    WHERE year=?
                    """,
                    (error, _now_iso(), year),
                )
    return {
        "processed": processed,
        "occurrences": occurrences,
        "errors": errors,
    }


def process_ft_infini_documents(
    connection: sqlite3.Connection,
    *,
    http_client: httpx.Client,
    maximum: int = DEFAULT_DOCUMENTS_PER_RUN,
    workers: int = DEFAULT_WORKERS,
    minimum_request_interval: float = 0.5,
) -> dict[str, object]:
    rows = _next_document_rows(connection, maximum=maximum)
    limiter = GlobalRateLimiter(minimum_request_interval)

    def fetch(
        row: tuple[int, int, int],
    ) -> tuple[tuple[int, int, int], dict[str, object] | None, str | None]:
        year, shard_index, rank = row
        try:
            limiter.wait()
            response = http_client.post(
                INFINI_DOCUMENT_ENDPOINT,
                json={
                    "query": INFINI_QUERY,
                    "index": "ccnews",
                    "year_min": year,
                    "year_max": year,
                    "s": shard_index,
                    "rank": rank,
                    "max_ctx_len": 1,
                },
            )
            response.raise_for_status()
            payload = response.json()
            parsed = _parse_infini_document(payload)
            return row, parsed, None
        except Exception as exc:
            return row, None, f"{type(exc).__name__}: {exc}"

    accepted = 0
    rejected = 0
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = {executor.submit(fetch, row): row for row in rows}
        for future in as_completed(futures):
            row, parsed, error = future.result()
            year, shard_index, rank = row
            if error is not None:
                errors.append(f"{year}/{shard_index}/{rank}: {error}")
                _record_document_error(
                    connection,
                    year=year,
                    shard_index=shard_index,
                    rank=rank,
                    error=error,
                )
                continue
            assert parsed is not None
            reason = _document_rejection_reason(parsed)
            if reason is not None:
                rejected += 1
                _record_document_rejection(
                    connection,
                    year=year,
                    shard_index=shard_index,
                    rank=rank,
                    parsed=parsed,
                    reason=reason,
                )
                continue
            accepted += 1
            _record_document_acceptance(
                connection,
                year=year,
                shard_index=shard_index,
                rank=rank,
                parsed=parsed,
            )
    return {
        "attempted": len(rows),
        "accepted": accepted,
        "rejected": rejected,
        "errors": errors,
    }


def process_ft_syndication_resolutions(
    connection: sqlite3.Connection,
    *,
    http_client: httpx.Client,
    maximum: int = DEFAULT_RESOLUTIONS_PER_RUN,
    minimum_request_interval: float = 1.0,
) -> dict[str, object]:
    rows = _next_resolution_rows(connection, maximum=maximum)
    limiter = GlobalRateLimiter(minimum_request_interval)
    resolved_count = 0
    not_found = 0
    errors: list[str] = []
    spec = archive_source_spec("ft")
    attempted = 0
    consecutive_external_errors = 0
    for (
        partner_url,
        published_at,
        expected_headline,
        source_year,
        document_index,
        warc_source,
    ) in rows:
        attempted += 1
        try:
            limiter.wait()
            canonical_url = resolve_ft_original_url(
                str(expected_headline),
                expected_published_at=str(published_at),
                spec=spec,
                http_client=http_client,
            )
            if canonical_url is None:
                consecutive_external_errors = 0
                not_found += 1
                _record_resolution_error(
                    connection,
                    partner_url=str(partner_url),
                    error="not-found",
                )
                continue
            with connection:
                connection.execute(
                    """
                    INSERT INTO ft_syndication_articles(
                        canonical_url,
                        published_at,
                        partner_url,
                        expected_headline,
                        source_year,
                        document_index,
                        warc_source,
                        mapping_method,
                        updated_at
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?, ?, 'exact-headline-search', ?
                    )
                    ON CONFLICT(canonical_url) DO NOTHING
                    """,
                    (
                        canonical_url,
                        str(published_at),
                        str(partner_url),
                        str(expected_headline),
                        int(source_year),
                        document_index,
                        warc_source,
                        _now_iso(),
                    ),
                )
                connection.execute(
                    """
                    UPDATE ft_syndication_unresolved
                    SET status='resolved',
                        attempts=attempts+1,
                        last_error=NULL,
                        updated_at=?
                    WHERE partner_url=?
                    """,
                    (_now_iso(), str(partner_url)),
                )
            resolved_count += 1
            consecutive_external_errors = 0
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            errors.append(f"{partner_url}: {error}")
            _record_resolution_error(
                connection,
                partner_url=str(partner_url),
                error=error,
            )
            consecutive_external_errors += 1
            if consecutive_external_errors >= 5:
                break
    return {
        "attempted": attempted,
        "resolved": resolved_count,
        "notFound": not_found,
        "errors": errors,
    }


def resolve_ft_original_url(
    expected_headline: str,
    *,
    expected_published_at: str | None = None,
    spec: ArchiveSourceSpec,
    http_client: httpx.Client,
) -> str | None:
    try:
        yahoo_result = _resolve_ft_original_url_from_yahoo(
            expected_headline,
            spec=spec,
            http_client=http_client,
        )
    except httpx.HTTPError:
        yahoo_result = None
    if yahoo_result is not None:
        return yahoo_result
    if expected_published_at is None:
        return None
    return _resolve_ft_original_url_from_google_news(
        expected_headline,
        expected_published_at=expected_published_at,
        spec=spec,
        http_client=http_client,
    )


def _resolve_ft_original_url_from_yahoo(
    expected_headline: str,
    *,
    spec: ArchiveSourceSpec,
    http_client: httpx.Client,
) -> str | None:
    expected_tokens = _significant_tokens(expected_headline)
    if len(expected_tokens) < 4:
        return None
    for query in (
        f'"{expected_headline}" site:ft.com',
        f'"{expected_headline}"',
    ):
        try:
            result = _resolve_ft_original_url_from_yahoo_query(
                query,
                expected_tokens=expected_tokens,
                spec=spec,
                http_client=http_client,
            )
        except httpx.HTTPError:
            continue
        if result is not None:
            return result
    return None


def _resolve_ft_original_url_from_yahoo_query(
    query: str,
    *,
    expected_tokens: set[str],
    spec: ArchiveSourceSpec,
    http_client: httpx.Client,
) -> str | None:
    response = http_client.get(
        YAHOO_SEARCH_ENDPOINT,
        params={"p": query},
        headers={"User-Agent": YAHOO_USER_AGENT},
    )
    response.raise_for_status()
    soup = BeautifulSoup(response.content, "html.parser")
    ranked: list[tuple[float, int, str]] = []
    seen: set[str] = set()
    for position, result in enumerate(soup.select("#web li")):
        anchor = (
            result.select_one(".compTitle > a")
            or result.select_one("h3 a")
            or result.select_one("a")
        )
        heading = result.select_one("h3")
        if anchor is None or heading is None:
            continue
        decoded = _decode_yahoo_result(anchor.get("href"))
        canonical_url = (
            normalize_article_url(spec, decoded) if decoded else None
        )
        if canonical_url is None or canonical_url in seen:
            continue
        seen.add(canonical_url)
        result_tokens = _significant_tokens(
            _clean_search_title(heading.get_text(" ", strip=True))
        )
        coverage = (
            len(expected_tokens & result_tokens) / len(expected_tokens)
            if result_tokens
            else 0.0
        )
        if coverage < 0.8 or len(expected_tokens & result_tokens) < 4:
            continue
        ranked.append((coverage, -position, canonical_url))
    if not ranked:
        return None
    ranked.sort(reverse=True)
    return ranked[0][2]


def _resolve_ft_original_url_from_google_news(
    expected_headline: str,
    *,
    expected_published_at: str,
    spec: ArchiveSourceSpec,
    http_client: httpx.Client,
) -> str | None:
    normalized_expected_date = _parse_partner_date(expected_published_at)
    if normalized_expected_date is None:
        return None
    expected_date = datetime.fromisoformat(normalized_expected_date)
    expected_tokens = _significant_tokens(expected_headline)
    if len(expected_tokens) < 4:
        return None
    clean_headline = _clean_search_title(expected_headline)
    response = http_client.get(
        GOOGLE_NEWS_RSS_ENDPOINT,
        params={
            "q": f"{clean_headline} site:ft.com",
            "hl": "en-US",
            "gl": "US",
            "ceid": "US:en",
        },
        headers={"User-Agent": YAHOO_USER_AGENT},
    )
    response.raise_for_status()
    root = ElementTree.fromstring(response.content)
    ranked: list[tuple[float, float, int, str]] = []
    decodes_attempted = 0
    seen: set[str] = set()
    for position, item in enumerate(root.findall("./channel/item")):
        result_tokens = _significant_tokens(
            _clean_search_title(item.findtext("title") or "")
        )
        matching_tokens = len(expected_tokens & result_tokens)
        coverage = (
            matching_tokens / len(expected_tokens)
            if result_tokens
            else 0.0
        )
        if coverage < 0.8 or matching_tokens < 4:
            continue
        try:
            published_at = parsedate_to_datetime(
                item.findtext("pubDate") or ""
            )
        except (TypeError, ValueError, OverflowError):
            continue
        if published_at.tzinfo is None:
            published_at = published_at.replace(tzinfo=timezone.utc)
        date_delta_seconds = abs(
            (
                published_at.astimezone(timezone.utc)
                - expected_date
            ).total_seconds()
        )
        if date_delta_seconds > (
            GOOGLE_NEWS_MAXIMUM_DATE_DELTA_DAYS * 86_400
        ):
            continue
        google_news_url = (item.findtext("link") or "").strip()
        if not google_news_url:
            continue
        if decodes_attempted >= GOOGLE_NEWS_MAXIMUM_DECODES_PER_TITLE:
            break
        decodes_attempted += 1
        try:
            decoded_url = _decode_google_news_url(
                http_client,
                google_news_url,
            )
        except (httpx.HTTPError, ValueError):
            continue
        canonical_url = normalize_article_url(spec, decoded_url)
        if canonical_url is None or canonical_url in seen:
            continue
        seen.add(canonical_url)
        ranked.append(
            (
                coverage,
                -date_delta_seconds,
                -position,
                canonical_url,
            )
        )
    if not ranked:
        return None
    ranked.sort(reverse=True)
    return ranked[0][3]


def ft_syndication_articles(
    connection: sqlite3.Connection,
) -> dict[str, tuple[str, str, str]]:
    if not _table_exists(connection, "ft_syndication_articles"):
        return {}
    return {
        str(canonical_url): (
            str(published_at),
            str(partner_url),
            str(expected_headline),
        )
        for (
            canonical_url,
            published_at,
            partner_url,
            expected_headline,
        ) in connection.execute(
            """
            SELECT
                canonical_url,
                published_at,
                partner_url,
                expected_headline
            FROM ft_syndication_articles
            ORDER BY canonical_url
            """
        )
    }


def ft_syndication_summary(
    connection: sqlite3.Connection,
) -> dict[str, object] | None:
    if not _table_exists(connection, "ft_syndication_queries"):
        return None
    query_counts = dict(
        connection.execute(
            """
            SELECT status, COUNT(*)
            FROM ft_syndication_queries
            GROUP BY status
            """
        ).fetchall()
    )
    occurrence_counts = dict(
        connection.execute(
            """
            SELECT status, COUNT(*)
            FROM ft_syndication_occurrences
            GROUP BY status
            """
        ).fetchall()
    )
    resolution_counts = dict(
        connection.execute(
            """
            SELECT status, COUNT(*)
            FROM ft_syndication_unresolved
            GROUP BY status
            """
        ).fetchall()
    )
    by_year = {
        str(year): int(count)
        for year, count in connection.execute(
            """
            SELECT substr(published_at, 1, 4), COUNT(*)
            FROM ft_syndication_articles
            GROUP BY 1
            ORDER BY 1
            """
        )
    }
    return {
        "queriesByStatus": {
            str(key): int(value)
            for key, value in sorted(query_counts.items())
        },
        "occurrencesByStatus": {
            str(key): int(value)
            for key, value in sorted(occurrence_counts.items())
        },
        "resolutionsByStatus": {
            str(key): int(value)
            for key, value in sorted(resolution_counts.items())
        },
        "articlesByYear": by_year,
        "articles": sum(by_year.values()),
        "shouldContinue": ft_syndication_should_continue(connection),
    }


def ft_syndication_should_continue(
    connection: sqlite3.Connection,
) -> bool:
    if not _table_exists(connection, "ft_syndication_queries"):
        return False
    if connection.execute(
        """
        SELECT 1
        FROM ft_syndication_queries
        WHERE status='pending'
           OR (status='error' AND attempts < 3)
        LIMIT 1
        """
    ).fetchone():
        return True
    for table in (
        "ft_syndication_occurrences",
        "ft_syndication_unresolved",
    ):
        published_expression = (
            "CAST(item.year AS TEXT)"
            if table == "ft_syndication_occurrences"
            else "substr(item.published_at, 1, 4)"
        )
        row = connection.execute(
            f"""
            SELECT 1
            FROM {table} AS item
            WHERE (
                    item.status='pending'
                    OR (item.status='error' AND item.attempts < 3)
                  )
              AND (
                    SELECT COUNT(*)
                    FROM ft_syndication_articles AS article
                    WHERE substr(article.published_at, 1, 4)
                          = {published_expression}
                  ) < ?
            LIMIT 1
            """,
            (RESOLUTION_TARGET_PER_YEAR,),
        ).fetchone()
        if row:
            return True
    return False


def _next_document_rows(
    connection: sqlite3.Connection,
    *,
    maximum: int,
) -> list[tuple[int, int, int]]:
    return [
        (int(year), int(shard_index), int(rank))
        for year, shard_index, rank in connection.execute(
            """
            WITH eligible AS (
                SELECT
                    item.year,
                    item.shard_index,
                    item.rank,
                    ROW_NUMBER() OVER (
                        PARTITION BY item.year
                        ORDER BY item.shard_index, item.rank
                    ) AS year_position
                FROM ft_syndication_occurrences AS item
                WHERE (
                        item.status='pending'
                        OR (item.status='error' AND item.attempts < 3)
                      )
                  AND (
                        SELECT COUNT(*)
                        FROM ft_syndication_articles AS article
                        WHERE substr(article.published_at, 1, 4)
                              = CAST(item.year AS TEXT)
                      ) < ?
            )
            SELECT year, shard_index, rank
            FROM eligible
            ORDER BY year_position, year DESC
            LIMIT ?
            """,
            (RESOLUTION_TARGET_PER_YEAR, maximum),
        )
    ]


def _next_resolution_rows(
    connection: sqlite3.Connection,
    *,
    maximum: int,
) -> list[tuple[object, ...]]:
    return connection.execute(
        """
        WITH eligible AS (
            SELECT
                unresolved.partner_url,
                unresolved.published_at,
                unresolved.expected_headline,
                unresolved.source_year,
                unresolved.document_index,
                unresolved.warc_source,
                ROW_NUMBER() OVER (
                    PARTITION BY substr(unresolved.published_at, 1, 4)
                    ORDER BY
                        unresolved.published_at DESC,
                        unresolved.partner_url
                ) AS year_position
            FROM ft_syndication_unresolved AS unresolved
            WHERE (
                    unresolved.status='pending'
                    OR (
                        unresolved.status='error'
                        AND unresolved.attempts < 3
                    )
                  )
              AND (
                    SELECT COUNT(*)
                    FROM ft_syndication_articles AS article
                    WHERE substr(article.published_at, 1, 4)
                          = substr(unresolved.published_at, 1, 4)
                  ) < ?
        )
        SELECT
            partner_url,
            published_at,
            expected_headline,
            source_year,
            document_index,
            warc_source
        FROM eligible
        ORDER BY year_position, source_year DESC, partner_url
        LIMIT ?
        """,
        (RESOLUTION_TARGET_PER_YEAR, maximum),
    ).fetchall()


def _sample_occurrence_ranks(
    segments: list[object],
    *,
    maximum: int,
) -> list[tuple[int, int]]:
    normalized: list[tuple[int, int, int]] = []
    total = 0
    for shard_index, segment in enumerate(segments):
        if (
            not isinstance(segment, list)
            or len(segment) != 2
            or not all(isinstance(value, int) for value in segment)
        ):
            raise ValueError("Infini-News occurrence segment is invalid")
        start, end = segment
        if end < start:
            raise ValueError("Infini-News occurrence segment is reversed")
        length = end - start
        if length:
            normalized.append((shard_index, start, end))
            total += length
    if total == 0:
        return []
    sample_size = min(total, maximum)
    flat_positions = {
        min(total - 1, math.floor((index + 0.5) * total / sample_size))
        for index in range(sample_size)
    }
    result: list[tuple[int, int]] = []
    base = 0
    positions = sorted(flat_positions)
    position_index = 0
    for shard_index, start, end in normalized:
        length = end - start
        while (
            position_index < len(positions)
            and positions[position_index] < base + length
        ):
            result.append(
                (
                    shard_index,
                    start + positions[position_index] - base,
                )
            )
            position_index += 1
        base += length
    return result


def _parse_infini_document(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise ValueError("Infini-News document response is invalid")
    metadata = payload.get("metadata")
    if not isinstance(metadata, dict):
        raise ValueError("Infini-News document metadata is missing")
    return {
        "partnerUrl": _normalize_partner_url(metadata.get("url")),
        "publishedAt": _parse_partner_date(metadata.get("date")),
        "expectedHeadline": _clean_partner_title(metadata.get("title")),
        "hostname": str(metadata.get("hostname") or "").casefold(),
        "language": str(metadata.get("language") or "").casefold(),
        "documentIndex": _optional_int(payload.get("doc_ix")),
        "documentLength": _optional_int(payload.get("doc_len")),
        "warcSource": str(metadata.get("warc_source") or ""),
    }


def _document_rejection_reason(parsed: dict[str, object]) -> str | None:
    partner_url = parsed.get("partnerUrl")
    if not isinstance(partner_url, str):
        return "invalid-partner-url"
    if normalize_article_url(archive_source_spec("ft"), partner_url):
        return "canonical-origin-not-partner"
    published_at = parsed.get("publishedAt")
    if not isinstance(published_at, str):
        return "missing-publication-date"
    headline = parsed.get("expectedHeadline")
    if (
        not isinstance(headline, str)
        or len(_significant_tokens(headline)) < 4
    ):
        return "missing-headline"
    language = parsed.get("language")
    if language not in {"", "eng"}:
        return "non-english"
    document_length = parsed.get("documentLength")
    if not isinstance(document_length, int) or document_length < 400:
        return "document-too-short"
    warc_source = parsed.get("warcSource")
    if (
        not isinstance(warc_source, str)
        or not warc_source.startswith("CC-NEWS-")
        or not warc_source.endswith(".warc.gz")
    ):
        return "missing-warc-provenance"
    return None


def _record_document_acceptance(
    connection: sqlite3.Connection,
    *,
    year: int,
    shard_index: int,
    rank: int,
    parsed: dict[str, object],
) -> None:
    now = _now_iso()
    with connection:
        connection.execute(
            """
            UPDATE ft_syndication_occurrences
            SET status='accepted',
                attempts=attempts+1,
                partner_url=?,
                published_at=?,
                expected_headline=?,
                hostname=?,
                language=?,
                document_index=?,
                document_length=?,
                warc_source=?,
                last_error=NULL,
                updated_at=?
            WHERE year=? AND shard_index=? AND rank=?
            """,
            (
                parsed["partnerUrl"],
                parsed["publishedAt"],
                parsed["expectedHeadline"],
                parsed["hostname"],
                parsed["language"],
                parsed["documentIndex"],
                parsed["documentLength"],
                parsed["warcSource"],
                now,
                year,
                shard_index,
                rank,
            ),
        )
        connection.execute(
            """
            INSERT INTO ft_syndication_unresolved(
                partner_url,
                published_at,
                expected_headline,
                source_year,
                document_index,
                warc_source,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(partner_url) DO UPDATE SET
                published_at=excluded.published_at,
                expected_headline=excluded.expected_headline,
                source_year=excluded.source_year,
                document_index=excluded.document_index,
                warc_source=excluded.warc_source,
                updated_at=excluded.updated_at
            """,
            (
                parsed["partnerUrl"],
                parsed["publishedAt"],
                parsed["expectedHeadline"],
                year,
                parsed["documentIndex"],
                parsed["warcSource"],
                now,
            ),
        )


def _record_document_rejection(
    connection: sqlite3.Connection,
    *,
    year: int,
    shard_index: int,
    rank: int,
    parsed: dict[str, object],
    reason: str,
) -> None:
    with connection:
        connection.execute(
            """
            UPDATE ft_syndication_occurrences
            SET status='rejected',
                attempts=attempts+1,
                partner_url=?,
                published_at=?,
                expected_headline=?,
                hostname=?,
                language=?,
                document_index=?,
                document_length=?,
                warc_source=?,
                last_error=?,
                updated_at=?
            WHERE year=? AND shard_index=? AND rank=?
            """,
            (
                parsed.get("partnerUrl"),
                parsed.get("publishedAt"),
                parsed.get("expectedHeadline"),
                parsed.get("hostname"),
                parsed.get("language"),
                parsed.get("documentIndex"),
                parsed.get("documentLength"),
                parsed.get("warcSource"),
                reason,
                _now_iso(),
                year,
                shard_index,
                rank,
            ),
        )


def _record_document_error(
    connection: sqlite3.Connection,
    *,
    year: int,
    shard_index: int,
    rank: int,
    error: str,
) -> None:
    with connection:
        connection.execute(
            """
            UPDATE ft_syndication_occurrences
            SET status='error',
                attempts=attempts+1,
                last_error=?,
                updated_at=?
            WHERE year=? AND shard_index=? AND rank=?
            """,
            (error, _now_iso(), year, shard_index, rank),
        )


def _record_resolution_error(
    connection: sqlite3.Connection,
    *,
    partner_url: str,
    error: str,
) -> None:
    with connection:
        connection.execute(
            """
            UPDATE ft_syndication_unresolved
            SET status='error',
                attempts=attempts+1,
                last_error=?,
                updated_at=?
            WHERE partner_url=?
            """,
            (error, _now_iso(), partner_url),
        )


def _normalize_partner_url(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    parsed = urlsplit(value.strip())
    hostname = (parsed.hostname or "").casefold()
    if (
        parsed.scheme not in {"http", "https"}
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or hostname == "localhost"
        or hostname.endswith(".localhost")
    ):
        return None
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        return None
    query = urlencode(
        [
            (key, value)
            for key, value in parse_qsl(
                parsed.query,
                keep_blank_values=True,
            )
            if key.casefold() not in _TRACKING_QUERY_KEYS
        ]
    )
    return urlunsplit(
        (
            "https",
            parsed.netloc.casefold(),
            parsed.path or "/",
            query,
            "",
        )
    )


def _parse_partner_date(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _clean_partner_title(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    title = BeautifulSoup(value, "html.parser").get_text(" ", strip=True)
    title = re.sub(
        r"\s+(?:[-–|]\s*)?(?:The\s+Irish\s+Times|SWI\s+swissinfo\.ch)$",
        "",
        title,
        flags=re.IGNORECASE,
    )
    return title.strip() or None


def _decode_yahoo_result(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    match = re.search(r"/RU=([^/]+)/RK=", value)
    candidate_url = unquote(match.group(1)) if match else value
    parsed = urlsplit(candidate_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return candidate_url


def _clean_search_title(value: str) -> str:
    result = re.sub(
        r"\s+(?:[-|]\s*)?(?:Financial\s+Times|FT\.com)\s*$",
        "",
        value.strip(),
        flags=re.IGNORECASE,
    )
    return re.sub(r"\s*(?:…|\.\.\.)\s*$", "", result).strip()


def _significant_tokens(value: str) -> set[str]:
    return {
        token
        for token in _SIGNIFICANT_TOKEN_RE.findall(value.casefold())
        if token not in _STOP_WORDS
    }


def _optional_int(value: object) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _table_exists(
    connection: sqlite3.Connection,
    table: str,
) -> bool:
    return (
        connection.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type='table' AND name=?
            """,
            (table,),
        ).fetchone()
        is not None
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
