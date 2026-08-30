from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, time, timezone
import hashlib
import ipaddress
import json
import math
import random
import re
import sqlite3
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit
from xml.etree import ElementTree as ET

from bs4 import BeautifulSoup

from .archive_sources import archive_source_spec, normalize_article_url
from .bloomberg_archive_download import ArchiveClient, GlobalRateLimiter
from .news_models import ArticleStatus
from .news_parser import parse_article
from .raw_archive_capture import (
    ManifestItem,
    discover_wayback_timemap_candidates,
)


SCHEMA_VERSION = "jojo-bloomberg-bnn-catalog/1"
BNN_FIRST_SUPPORTED_YEAR = 2025
BLOOMBERG_INFINI_FIRST_YEAR = 2017
BNN_DAILY_SITEMAP_TEMPLATE = (
    "https://www.bnnbloomberg.ca/arc/outboundfeeds/sitemap/"
    "{day}/?outputType=xml"
)
RESOLUTION_TARGET_PER_YEAR = 750
MAXIMUM_INFINI_OCCURRENCES_PER_YEAR = 3_000
INFINI_FIND_ENDPOINT = "https://infini-news.uni-graz.at/api/v1/find"
INFINI_DOCUMENT_ENDPOINT = (
    "https://infini-news.uni-graz.at/api/v1/get_doc"
)
YAHOO_SEARCH_ENDPOINT = "https://search.yahoo.com/search"
YAHOO_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36"
)
DEFAULT_SITEMAP_DAYS_PER_RUN = 50
DEFAULT_PAGES_PER_RUN = 500
MAXIMUM_SITEMAP_BYTES = 2_000_000
MAXIMUM_ARCHIVE_HTML_BYTES = 10_000_000
MINIMUM_BODY_CHARACTERS = 400
_BNN_HOSTS = {"bnnbloomberg.ca", "www.bnnbloomberg.ca"}
_BLOOMBERG_LINK_RE = re.compile(
    r"https?:(?:\\?/){2}(?:www\.)?bloomberg\.com"
    r"/(?:news|opinion)/articles/20\d{2}-\d{2}-\d{2}/"
    r"[a-z0-9][a-z0-9-]*",
    re.IGNORECASE,
)
_WAYBACK_PARTNER_RE = re.compile(
    r"^https?://web\.archive\.org/web/\d{14}(?:id_|im_|js_|cs_)?/"
    r"(https?://.+)$",
    re.IGNORECASE,
)
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


def initialize_bloomberg_bnn_schema(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
    today: date | None = None,
) -> None:
    if from_year > to_year:
        raise ValueError("from_year must not exceed to_year")
    current_day = today or datetime.now(timezone.utc).date()
    first_year = max(from_year, BNN_FIRST_SUPPORTED_YEAR)
    last_year = min(to_year, current_day.year)
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS bloomberg_bnn_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bloomberg_bnn_days (
            sitemap_day TEXT PRIMARY KEY,
            year INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            rows_seen INTEGER NOT NULL DEFAULT 0,
            rows_accepted INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bloomberg_bnn_pages (
            partner_url TEXT PRIMARY KEY,
            published_hint TEXT NOT NULL,
            source_day TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            canonical_url TEXT,
            archive_url TEXT,
            expected_headline TEXT,
            published_at TEXT,
            body_characters INTEGER,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bloomberg_bnn_articles (
            canonical_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            partner_url TEXT NOT NULL,
            archive_url TEXT NOT NULL,
            expected_headline TEXT NOT NULL,
            mapping_method TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bloomberg_infini_queries (
            year INTEGER PRIMARY KEY,
            query TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            occurrence_count INTEGER,
            shard_count INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bloomberg_infini_occurrences (
            year INTEGER NOT NULL,
            shard_index INTEGER NOT NULL,
            rank INTEGER NOT NULL,
            sample_order INTEGER NOT NULL,
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

        CREATE TABLE IF NOT EXISTS bloomberg_infini_pages (
            partner_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            expected_headline TEXT NOT NULL,
            source_year INTEGER NOT NULL,
            sample_order INTEGER NOT NULL,
            document_index INTEGER,
            warc_source TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            canonical_url TEXT,
            archive_url TEXT,
            body_characters INTEGER,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_bloomberg_bnn_day_status
            ON bloomberg_bnn_days(status, year, sitemap_day);
        CREATE INDEX IF NOT EXISTS idx_bloomberg_bnn_page_status
            ON bloomberg_bnn_pages(status, published_hint);
        CREATE INDEX IF NOT EXISTS idx_bloomberg_bnn_article_year
            ON bloomberg_bnn_articles(published_at);
        CREATE INDEX IF NOT EXISTS idx_bloomberg_infini_occurrence_status
            ON bloomberg_infini_occurrences(status, year, rank);
        CREATE INDEX IF NOT EXISTS idx_bloomberg_infini_page_status
            ON bloomberg_infini_pages(status, published_at);
        """
    )
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "fromYear": from_year,
                "toYear": to_year,
                "firstSupportedYear": BNN_FIRST_SUPPORTED_YEAR,
                "infiniFirstYear": BLOOMBERG_INFINI_FIRST_YEAR,
                "infiniMaximumPerYear": (
                    MAXIMUM_INFINI_OCCURRENCES_PER_YEAR
                ),
                "infiniQueryTemplate": _bloomberg_copyright_query(
                    2000
                ).replace("2000", "{year}"),
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    existing = connection.execute(
        """
        SELECT value
        FROM bloomberg_bnn_metadata
        WHERE key='fingerprint'
        """
    ).fetchone()
    if existing and str(existing[0]) != fingerprint:
        raise ValueError(
            "Bloomberg BNN state belongs to a different date window"
        )
    connection.executemany(
        """
        INSERT INTO bloomberg_bnn_metadata(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        {
            "schema_version": SCHEMA_VERSION,
            "from_year": str(from_year),
            "to_year": str(to_year),
            "fingerprint": fingerprint,
        }.items(),
    )
    now = _now_iso()
    rows: list[tuple[str, int, str]] = []
    for year in range(first_year, last_year + 1):
        first_day = date(year, 1, 1)
        final_day = min(date(year, 12, 31), current_day)
        ordinal = first_day.toordinal()
        while ordinal <= final_day.toordinal():
            value = date.fromordinal(ordinal)
            rows.append((value.isoformat(), year, now))
            ordinal += 1
    connection.executemany(
        """
        INSERT OR IGNORE INTO bloomberg_bnn_days(
            sitemap_day,
            year,
            updated_at
        ) VALUES (?, ?, ?)
        """,
        rows,
    )
    connection.executemany(
        """
        INSERT OR IGNORE INTO bloomberg_infini_queries(
            year,
            query,
            updated_at
        ) VALUES (?, ?, ?)
        """,
        (
            (
                year,
                _bloomberg_copyright_query(year),
                now,
            )
            for year in range(
                max(from_year, BLOOMBERG_INFINI_FIRST_YEAR),
                to_year + 1,
            )
        ),
    )
    connection.commit()


def process_bloomberg_bnn_sitemaps(
    connection: sqlite3.Connection,
    *,
    http_client: ArchiveClient,
    maximum_days: int = DEFAULT_SITEMAP_DAYS_PER_RUN,
) -> dict[str, object]:
    if maximum_days < 1:
        raise ValueError("maximum_days must be positive")
    rows = connection.execute(
        """
        SELECT day.sitemap_day, day.year
        FROM bloomberg_bnn_days AS day
        WHERE (
                day.status='pending'
                OR (day.status='error' AND day.attempts < 3)
              )
          AND (
                SELECT COUNT(*)
                FROM bloomberg_bnn_articles AS article
                WHERE substr(article.published_at, 1, 4)
                      = CAST(day.year AS TEXT)
              ) < ?
        ORDER BY substr(day.sitemap_day, 6, 5) DESC,
                 day.year DESC
        LIMIT ?
        """,
        (RESOLUTION_TARGET_PER_YEAR, maximum_days),
    ).fetchall()
    processed = 0
    seen = 0
    accepted = 0
    errors: list[str] = []
    for sitemap_day, year_value in rows:
        day_url = BNN_DAILY_SITEMAP_TEMPLATE.format(day=sitemap_day)
        try:
            status, headers, content, _ = http_client.fetch(
                day_url,
                maximum_bytes=MAXIMUM_SITEMAP_BYTES,
            )
            content_type = headers.get("content-type", "").casefold()
            if status != 200:
                raise ValueError(f"BNN sitemap returned HTTP {status}")
            if (
                "xml" not in content_type
                and not content.lstrip().startswith(b"<?xml")
            ):
                raise ValueError("BNN sitemap did not return XML")
            pages = parse_bloomberg_bnn_sitemap(
                content,
                from_year=int(year_value),
                to_year=int(year_value),
            )
            now = _now_iso()
            with connection:
                before = connection.total_changes
                connection.executemany(
                    """
                    INSERT OR IGNORE INTO bloomberg_bnn_pages(
                        partner_url,
                        published_hint,
                        source_day,
                        updated_at
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (
                        (
                            partner_url,
                            published_hint,
                            str(sitemap_day),
                            now,
                        )
                        for partner_url, published_hint in pages
                    ),
                )
                inserted = connection.total_changes - before
                connection.execute(
                    """
                    UPDATE bloomberg_bnn_days
                    SET status='complete',
                        attempts=attempts+1,
                        rows_seen=?,
                        rows_accepted=?,
                        last_error=NULL,
                        updated_at=?
                    WHERE sitemap_day=?
                    """,
                    (len(pages), inserted, now, sitemap_day),
                )
            processed += 1
            seen += len(pages)
            accepted += inserted
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            errors.append(f"{sitemap_day}: {error}")
            with connection:
                connection.execute(
                    """
                    UPDATE bloomberg_bnn_days
                    SET status='error',
                        attempts=attempts+1,
                        last_error=?,
                        updated_at=?
                    WHERE sitemap_day=?
                    """,
                    (error, _now_iso(), sitemap_day),
                )
    return {
        "processed": processed,
        "seen": seen,
        "accepted": accepted,
        "errors": errors,
    }


def parse_bloomberg_bnn_sitemap(
    content: bytes,
    *,
    from_year: int,
    to_year: int,
) -> list[tuple[str, str]]:
    root = ET.fromstring(content)
    result: list[tuple[str, str]] = []
    seen: set[str] = set()
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1] != "loc" or not node.text:
            continue
        partner_url = node.text.strip()
        parsed = urlsplit(partner_url)
        if (
            parsed.scheme != "https"
            or (parsed.hostname or "").casefold() not in _BNN_HOSTS
            or partner_url in seen
        ):
            continue
        match = re.search(
            r"/(20\d{2})/(\d{2})/(\d{2})/",
            parsed.path,
        )
        if not match:
            continue
        try:
            published_day = date(
                int(match.group(1)),
                int(match.group(2)),
                int(match.group(3)),
            )
        except ValueError:
            continue
        if not from_year <= published_day.year <= to_year:
            continue
        seen.add(partner_url)
        published_hint = datetime.combine(
            published_day,
            time(12),
            tzinfo=timezone.utc,
        ).isoformat()
        result.append((partner_url, published_hint))
    return result


def process_bloomberg_infini_queries(
    connection: sqlite3.Connection,
    *,
    http_client,
    maximum_years: int,
) -> dict[str, object]:
    rows = connection.execute(
        """
        SELECT year, query
        FROM bloomberg_infini_queries
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
    for year_value, query_value in rows:
        year = int(year_value)
        query = str(query_value)
        try:
            response = http_client.post(
                INFINI_FIND_ENDPOINT,
                json={
                    "query": query,
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
                maximum=MAXIMUM_INFINI_OCCURRENCES_PER_YEAR,
                seed=f"bloomberg:{year}:{query}",
            )
            now = _now_iso()
            with connection:
                connection.executemany(
                    """
                    INSERT OR IGNORE INTO bloomberg_infini_occurrences(
                        year,
                        shard_index,
                        rank,
                        sample_order,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        (
                            year,
                            shard_index,
                            rank,
                            sample_order,
                            now,
                        )
                        for sample_order, (
                            shard_index,
                            rank,
                        ) in enumerate(sampled)
                    ),
                )
                connection.execute(
                    """
                    UPDATE bloomberg_infini_queries
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
                    UPDATE bloomberg_infini_queries
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


def process_bloomberg_infini_documents(
    connection: sqlite3.Connection,
    *,
    http_client,
    maximum: int,
    workers: int = 4,
    minimum_request_interval: float = 0.5,
) -> dict[str, object]:
    rows = _next_infini_document_rows(connection, maximum=maximum)
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
                    "query": _bloomberg_copyright_query(year),
                    "index": "ccnews",
                    "year_min": year,
                    "year_max": year,
                    "s": shard_index,
                    "rank": rank,
                    "max_ctx_len": 1,
                },
            )
            response.raise_for_status()
            parsed = _parse_infini_document(response.json())
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
                _record_infini_document_error(
                    connection,
                    year=year,
                    shard_index=shard_index,
                    rank=rank,
                    error=error,
                )
                continue
            assert parsed is not None
            reason = _infini_document_rejection_reason(
                parsed,
                source_year=year,
            )
            if reason is not None:
                rejected += 1
                _record_infini_document_rejection(
                    connection,
                    year=year,
                    shard_index=shard_index,
                    rank=rank,
                    parsed=parsed,
                    reason=reason,
                )
                continue
            accepted += 1
            _record_infini_document_acceptance(
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


def process_bloomberg_infini_pages(
    connection: sqlite3.Connection,
    *,
    search_client,
    archive_client: ArchiveClient,
    maximum: int,
    minimum_request_interval: float = 1.0,
) -> dict[str, object]:
    rows = _next_infini_page_rows(connection, maximum=maximum)
    limiter = GlobalRateLimiter(minimum_request_interval)
    attempted = 0
    resolved = 0
    rejected = 0
    errors: list[str] = []
    consecutive_errors = 0
    for partner_url, published_at, expected_headline in rows:
        attempted += 1
        try:
            limiter.wait()
            validation, reason = validate_bloomberg_partner_page(
                str(partner_url),
                canonical_url=None,
                expected_headline=str(expected_headline),
                published_at=str(published_at),
                archive_client=archive_client,
            )
            if (
                validation is None
                and reason == "missing-embedded-original-link"
            ):
                canonical_url = resolve_bloomberg_original_url(
                    str(expected_headline),
                    http_client=search_client,
                )
                if canonical_url is not None:
                    validation, reason = validate_bloomberg_partner_page(
                        str(partner_url),
                        canonical_url=canonical_url,
                        expected_headline=str(expected_headline),
                        published_at=str(published_at),
                        archive_client=archive_client,
                    )
            if validation is None:
                rejected += 1
                _record_infini_page_rejection(
                    connection,
                    partner_url=str(partner_url),
                    reason=reason or "partner-validation-failed",
                )
                consecutive_errors = 0
                continue
            canonical_url = validation.get("canonicalUrl")
            if not isinstance(canonical_url, str):
                raise ValueError("validated partner omitted canonical URL")
            _record_infini_page_resolution(
                connection,
                partner_url=str(partner_url),
                canonical_url=canonical_url,
                validation=validation,
            )
            resolved += 1
            consecutive_errors = 0
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            errors.append(f"{partner_url}: {error}")
            _record_infini_page_error(
                connection,
                partner_url=str(partner_url),
                error=error,
            )
            consecutive_errors += 1
            if consecutive_errors >= 5:
                break
    return {
        "attempted": attempted,
        "resolved": resolved,
        "rejected": rejected,
        "errors": errors,
    }


def resolve_bloomberg_original_url(
    expected_headline: str,
    *,
    http_client,
) -> str | None:
    expected_tokens = _significant_tokens(expected_headline)
    if len(expected_tokens) < 4:
        return None
    response = http_client.get(
        YAHOO_SEARCH_ENDPOINT,
        params={
            "p": f'"{expected_headline}" site:bloomberg.com',
        },
        headers={"User-Agent": YAHOO_USER_AGENT},
    )
    response.raise_for_status()
    soup = BeautifulSoup(response.content, "html.parser")
    spec = archive_source_spec("bloomberg")
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
            _clean_bloomberg_search_title(
                heading.get_text(" ", strip=True)
            )
        )
        shared = len(expected_tokens & result_tokens)
        coverage = shared / len(expected_tokens) if result_tokens else 0.0
        if coverage < 0.8 or shared < 4:
            continue
        ranked.append((coverage, -position, canonical_url))
    if not ranked:
        return None
    ranked.sort(reverse=True)
    return ranked[0][2]


def validate_bloomberg_partner_page(
    partner_url: str,
    *,
    canonical_url: str | None,
    expected_headline: str,
    published_at: str,
    archive_client: ArchiveClient,
) -> tuple[dict[str, object] | None, str | None]:
    item = ManifestItem(
        publisher="bloomberg",
        canonical_url=partner_url,
        published_at=published_at,
        section=None,
        candidates=(),
    )
    candidates = discover_wayback_timemap_candidates(
        item,
        archive_client=archive_client,
        maximum_candidates=3,
    )
    if not candidates:
        return None, "no-wayback-snapshot"
    reasons: list[str] = []
    for candidate in candidates:
        try:
            status, headers, content, final_url = archive_client.fetch(
                candidate.snapshot_url,
                maximum_bytes=MAXIMUM_ARCHIVE_HTML_BYTES,
            )
        except Exception as exc:
            reasons.append(f"fetch-{type(exc).__name__}")
            continue
        content_type = headers.get("content-type", "").casefold()
        if (
            status != 200
            or not content
            or (
                "html" not in content_type
                and b"<html" not in content[:1_000].lower()
            )
        ):
            reasons.append(f"snapshot-http-{status}")
            continue
        parsed, reason = _parse_bloomberg_partner_archive(
            content,
            partner_url=partner_url,
            archive_url=final_url,
            canonical_url=canonical_url,
            expected_headline=expected_headline,
            published_at=published_at,
        )
        if parsed is not None:
            return parsed, None
        reasons.append(reason or "validation-failed")
        if reason in {
            "missing-bloomberg-copyright",
            "missing-bloomberg-attribution",
            "headline-mismatch",
            "publication-date-mismatch",
        }:
            return None, reason
    return None, reasons[-1] if reasons else "no-usable-snapshot"


def _parse_bloomberg_partner_archive(
    content: bytes,
    *,
    partner_url: str,
    archive_url: str,
    canonical_url: str | None,
    expected_headline: str,
    published_at: str,
) -> tuple[dict[str, object] | None, str | None]:
    if not _archive_url_matches_partner(archive_url, partner_url):
        return None, "unexpected-wayback-partner"
    mapping_method = "exact-headline-search"
    resolved_canonical_url = canonical_url
    if resolved_canonical_url is None:
        resolved_canonical_url, original_overlap = _best_original_url(
            _embedded_bloomberg_urls(content),
            expected_headline,
        )
        if (
            resolved_canonical_url is None
            or original_overlap < 0.8
        ):
            return None, "missing-embedded-original-link"
        mapping_method = "embedded-original-link"
    try:
        article = parse_article(
            content,
            publisher="bloomberg",
            canonical_url=resolved_canonical_url,
            allow_generic_syndication=True,
        )
    except Exception as exc:
        return None, f"parser-{type(exc).__name__}"
    if article.quality.status != ArticleStatus.COMPLETE:
        return None, f"parser-{article.quality.status.value}"
    if article.quality.body_characters < MINIMUM_BODY_CHARACTERS:
        return None, "body-too-short"
    headline_overlap = _headline_overlap(
        expected_headline,
        article.headline or "",
    )
    if headline_overlap < 0.8:
        return None, "headline-mismatch"
    soup = BeautifulSoup(content, "html.parser")
    visible_text = soup.get_text(" ", strip=True)
    expected_date = _parse_datetime(published_at)
    copyright_attributed = (
        expected_date is not None
        and re.search(
            rf"(?i)(?:©|\(c\)|copyright)\s*{expected_date.year}\s+"
            r"bloomberg\s+l\.p\.",
            visible_text,
        )
        is not None
    )
    if not copyright_attributed:
        return None, "missing-bloomberg-copyright"
    author_text = " ".join(author.name for author in article.authors)
    attributed = re.search(
        r"(?i)(?:^|\W)bloomberg(?:\s+news)?(?:\W|$)",
        author_text + "\n" + visible_text[:5_000],
    ) is not None
    if not attributed:
        return None, "missing-bloomberg-attribution"
    if expected_date is None or article.published_at is None:
        return None, "missing-publication-date"
    date_delta_days = abs(
        (article.published_at.date() - expected_date.date()).days
    )
    if date_delta_days > 2:
        return None, "publication-date-mismatch"
    return {
        "canonicalUrl": resolved_canonical_url,
        "mappingMethod": mapping_method,
        "archiveUrl": archive_url,
        "publishedAt": article.published_at.astimezone(
            timezone.utc
        ).isoformat(),
        "bodyCharacters": article.quality.body_characters,
        "headlineOverlap": round(headline_overlap, 4),
        "dateDeltaDays": date_delta_days,
    }, None


def process_bloomberg_bnn_pages(
    connection: sqlite3.Connection,
    *,
    http_client: ArchiveClient,
    maximum: int = DEFAULT_PAGES_PER_RUN,
) -> dict[str, object]:
    if maximum < 1:
        raise ValueError("maximum must be positive")
    rows = _next_page_rows(connection, maximum=maximum)
    attempted = 0
    resolved = 0
    rejected = 0
    errors: list[str] = []
    consecutive_errors = 0
    for partner_url, published_hint in rows:
        attempted += 1
        try:
            result, reason = resolve_bloomberg_bnn_page(
                str(partner_url),
                published_hint=str(published_hint),
                http_client=http_client,
            )
            if result is None:
                rejected += 1
                _record_page_rejection(
                    connection,
                    partner_url=str(partner_url),
                    reason=reason or "not-a-validated-bloomberg-copy",
                )
            else:
                resolved += 1
                _record_page_resolution(
                    connection,
                    partner_url=str(partner_url),
                    result=result,
                )
            consecutive_errors = 0
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            errors.append(f"{partner_url}: {error}")
            _record_page_error(
                connection,
                partner_url=str(partner_url),
                error=error,
            )
            consecutive_errors += 1
            if consecutive_errors >= 5:
                break
    return {
        "attempted": attempted,
        "resolved": resolved,
        "rejected": rejected,
        "errors": errors,
    }


def resolve_bloomberg_bnn_page(
    partner_url: str,
    *,
    published_hint: str,
    http_client: ArchiveClient,
) -> tuple[dict[str, object] | None, str | None]:
    item = ManifestItem(
        publisher="bloomberg",
        canonical_url=partner_url,
        published_at=published_hint,
        section=None,
        candidates=(),
    )
    candidates = discover_wayback_timemap_candidates(
        item,
        archive_client=http_client,
        maximum_candidates=3,
    )
    if not candidates:
        return None, "no-wayback-snapshot"
    reasons: list[str] = []
    for candidate in candidates:
        try:
            status, headers, content, final_url = http_client.fetch(
                candidate.snapshot_url,
                maximum_bytes=MAXIMUM_ARCHIVE_HTML_BYTES,
            )
        except Exception as exc:
            reasons.append(f"fetch-{type(exc).__name__}")
            continue
        content_type = headers.get("content-type", "").casefold()
        if (
            status != 200
            or not content
            or (
                "html" not in content_type
                and b"<html" not in content[:1_000].lower()
            )
        ):
            reasons.append(f"snapshot-http-{status}")
            continue
        parsed, reason = parse_bloomberg_bnn_archive(
            content,
            partner_url=partner_url,
            archive_url=final_url,
            published_hint=published_hint,
        )
        if parsed is not None:
            return parsed, None
        reasons.append(reason or "validation-failed")
        if reason in {
            "missing-embedded-original-link",
            "missing-bloomberg-copyright",
            "missing-bloomberg-attribution",
            "original-link-headline-mismatch",
            "publication-date-mismatch",
        }:
            return None, reason
    return None, reasons[-1] if reasons else "no-usable-snapshot"


def parse_bloomberg_bnn_archive(
    content: bytes,
    *,
    partner_url: str,
    archive_url: str,
    published_hint: str,
) -> tuple[dict[str, object] | None, str | None]:
    if not _archive_url_matches_partner(archive_url, partner_url):
        return None, "unexpected-wayback-partner"
    embedded_urls = _embedded_bloomberg_urls(content)
    derived_url = _derived_bloomberg_url(partner_url)
    canonical_urls = [
        *embedded_urls,
        *(
            [derived_url]
            if derived_url is not None and derived_url not in embedded_urls
            else []
        ),
    ]
    if not canonical_urls:
        return None, "missing-embedded-original-link"
    try:
        article = parse_article(
            content,
            publisher="bloomberg",
            canonical_url=canonical_urls[0],
            allow_generic_syndication=True,
        )
    except Exception as exc:
        return None, f"parser-{type(exc).__name__}"
    if article.quality.status != ArticleStatus.COMPLETE:
        return None, f"parser-{article.quality.status.value}"
    if article.quality.body_characters < MINIMUM_BODY_CHARACTERS:
        return None, "body-too-short"
    if not article.headline:
        return None, "missing-headline"
    canonical_url, overlap = _best_original_url(
        canonical_urls,
        article.headline,
    )
    if canonical_url is None or overlap < 0.75:
        return None, "original-link-headline-mismatch"
    soup = BeautifulSoup(content, "html.parser")
    visible_text = soup.get_text(" ", strip=True)
    expected_date = _parse_datetime(published_hint)
    copyright_attributed = (
        expected_date is not None
        and re.search(
            rf"(?i)(?:©|\(c\)|copyright)\s*{expected_date.year}\s+"
            r"bloomberg\s+l\.p\.",
            visible_text,
        )
        is not None
    )
    if not copyright_attributed:
        return None, "missing-bloomberg-copyright"
    author_text = " ".join(author.name for author in article.authors)
    bloomberg_attributed = re.search(
        r"(?i)(?:^|\W)bloomberg(?:\s+news)?(?:\W|$)",
        author_text + "\n" + visible_text[:5_000],
    ) is not None
    if not bloomberg_attributed:
        return None, "missing-bloomberg-attribution"
    if expected_date is None or article.published_at is None:
        return None, "missing-publication-date"
    date_delta_days = abs(
        (article.published_at.date() - expected_date.date()).days
    )
    if date_delta_days > 2:
        return None, "publication-date-mismatch"
    return {
        "canonicalUrl": canonical_url,
        "archiveUrl": archive_url,
        "expectedHeadline": article.headline,
        "publishedAt": article.published_at.astimezone(
            timezone.utc
        ).isoformat(),
        "bodyCharacters": article.quality.body_characters,
        "headlineOverlap": round(overlap, 4),
        "dateDeltaDays": date_delta_days,
        "copyrightAttributed": True,
        "partnerUrl": partner_url,
        "mappingMethod": (
            "embedded-original-link"
            if canonical_url in embedded_urls
            else "mirrored-partner-slug"
        ),
    }, None


def bloomberg_bnn_summary(
    connection: sqlite3.Connection,
) -> dict[str, object] | None:
    if not _table_exists(connection, "bloomberg_bnn_days"):
        return None
    day_counts = _status_counts(connection, "bloomberg_bnn_days")
    page_counts = _status_counts(connection, "bloomberg_bnn_pages")
    infini_query_counts = _status_counts(
        connection,
        "bloomberg_infini_queries",
    )
    infini_occurrence_counts = _status_counts(
        connection,
        "bloomberg_infini_occurrences",
    )
    infini_page_counts = _status_counts(
        connection,
        "bloomberg_infini_pages",
    )
    by_year = {
        str(year): int(count)
        for year, count in connection.execute(
            """
            SELECT substr(published_at, 1, 4), COUNT(*)
            FROM bloomberg_bnn_articles
            GROUP BY 1
            ORDER BY 1
            """
        )
    }
    return {
        "daysByStatus": day_counts,
        "pagesByStatus": page_counts,
        "infiniQueriesByStatus": infini_query_counts,
        "infiniOccurrencesByStatus": infini_occurrence_counts,
        "infiniPagesByStatus": infini_page_counts,
        "articlesByYear": by_year,
        "articles": sum(by_year.values()),
        "shouldContinue": bloomberg_bnn_should_continue(connection),
    }


def bloomberg_bnn_should_continue(
    connection: sqlite3.Connection,
) -> bool:
    if not _table_exists(connection, "bloomberg_bnn_days"):
        return False
    for table, year_expression in (
        ("bloomberg_bnn_days", "CAST(item.year AS TEXT)"),
        (
            "bloomberg_bnn_pages",
            "substr(item.published_hint, 1, 4)",
        ),
    ):
        if connection.execute(
            f"""
            SELECT 1
            FROM {table} AS item
            WHERE (
                    item.status='pending'
                    OR (item.status='error' AND item.attempts < 3)
                  )
              AND (
                    SELECT COUNT(*)
                    FROM bloomberg_bnn_articles AS article
                    WHERE substr(article.published_at, 1, 4)
                          = {year_expression}
                  ) < ?
            LIMIT 1
            """,
            (RESOLUTION_TARGET_PER_YEAR,),
        ).fetchone():
            return True
    for table, year_expression in (
        ("bloomberg_infini_queries", "CAST(item.year AS TEXT)"),
        (
            "bloomberg_infini_occurrences",
            "CAST(item.year AS TEXT)",
        ),
        (
            "bloomberg_infini_pages",
            "substr(item.published_at, 1, 4)",
        ),
    ):
        if connection.execute(
            f"""
            SELECT 1
            FROM {table} AS item
            WHERE (
                    item.status='pending'
                    OR (item.status='error' AND item.attempts < 3)
                  )
              AND (
                    SELECT COUNT(*)
                    FROM bloomberg_bnn_articles AS article
                    WHERE substr(article.published_at, 1, 4)
                          = {year_expression}
                  ) < ?
            LIMIT 1
            """,
            (RESOLUTION_TARGET_PER_YEAR,),
        ).fetchone():
            return True
    return False


def _next_infini_document_rows(
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
                        ORDER BY item.sample_order
                    ) AS year_position
                FROM bloomberg_infini_occurrences AS item
                WHERE (
                        item.status='pending'
                        OR (item.status='error' AND item.attempts < 3)
                      )
                  AND (
                        SELECT COUNT(*)
                        FROM bloomberg_bnn_articles AS article
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


def _next_infini_page_rows(
    connection: sqlite3.Connection,
    *,
    maximum: int,
) -> list[tuple[str, str, str]]:
    return [
        (
            str(partner_url),
            str(published_at),
            str(expected_headline),
        )
        for partner_url, published_at, expected_headline in connection.execute(
            """
            WITH eligible AS (
                SELECT
                    page.partner_url,
                    page.published_at,
                    page.expected_headline,
                    page.source_year,
                    page.sample_order,
                    ROW_NUMBER() OVER (
                        PARTITION BY substr(page.published_at, 1, 4)
                        ORDER BY page.sample_order
                    ) AS year_position
                FROM bloomberg_infini_pages AS page
                WHERE (
                        page.status='pending'
                        OR (page.status='error' AND page.attempts < 3)
                      )
                  AND (
                        SELECT COUNT(*)
                        FROM bloomberg_bnn_articles AS article
                        WHERE substr(article.published_at, 1, 4)
                              = substr(page.published_at, 1, 4)
                      ) < ?
            )
            SELECT partner_url, published_at, expected_headline
            FROM eligible
            ORDER BY year_position, source_year DESC, partner_url
            LIMIT ?
            """,
            (RESOLUTION_TARGET_PER_YEAR, maximum),
        )
    ]


def _parse_infini_document(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise ValueError("Infini-News document response is invalid")
    metadata = payload.get("metadata")
    if not isinstance(metadata, dict):
        raise ValueError("Infini-News document metadata is missing")
    sitename = str(metadata.get("sitename") or "").strip()
    return {
        "partnerUrl": _normalize_partner_url(metadata.get("url")),
        "publishedAt": _parse_metadata_date(metadata.get("date")),
        "expectedHeadline": _clean_partner_title(
            metadata.get("title"),
            sitename=sitename,
        ),
        "hostname": str(metadata.get("hostname") or "").casefold(),
        "language": str(metadata.get("language") or "").casefold(),
        "documentIndex": _optional_int(payload.get("doc_ix")),
        "documentLength": _optional_int(payload.get("doc_len")),
        "warcSource": str(metadata.get("warc_source") or ""),
    }


def _infini_document_rejection_reason(
    parsed: dict[str, object],
    *,
    source_year: int,
) -> str | None:
    partner_url = parsed.get("partnerUrl")
    if not isinstance(partner_url, str):
        return "invalid-partner-url"
    if normalize_article_url(
        archive_source_spec("bloomberg"),
        partner_url,
    ):
        return "canonical-origin-not-partner"
    published_at = parsed.get("publishedAt")
    parsed_date = (
        _parse_datetime(published_at)
        if isinstance(published_at, str)
        else None
    )
    if parsed_date is None:
        return "missing-publication-date"
    if parsed_date.year != source_year:
        return "publication-year-mismatch"
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


def _record_infini_document_acceptance(
    connection: sqlite3.Connection,
    *,
    year: int,
    shard_index: int,
    rank: int,
    parsed: dict[str, object],
) -> None:
    now = _now_iso()
    occurrence = connection.execute(
        """
        SELECT sample_order
        FROM bloomberg_infini_occurrences
        WHERE year=? AND shard_index=? AND rank=?
        """,
        (year, shard_index, rank),
    ).fetchone()
    if occurrence is None:
        raise ValueError("Bloomberg Infini-News occurrence disappeared")
    sample_order = int(occurrence[0])
    with connection:
        connection.execute(
            """
            UPDATE bloomberg_infini_occurrences
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
            INSERT INTO bloomberg_infini_pages(
                partner_url,
                published_at,
                expected_headline,
                source_year,
                sample_order,
                document_index,
                warc_source,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(partner_url) DO UPDATE SET
                published_at=excluded.published_at,
                expected_headline=excluded.expected_headline,
                source_year=excluded.source_year,
                sample_order=MIN(
                    bloomberg_infini_pages.sample_order,
                    excluded.sample_order
                ),
                document_index=excluded.document_index,
                warc_source=excluded.warc_source,
                updated_at=excluded.updated_at
            """,
            (
                parsed["partnerUrl"],
                parsed["publishedAt"],
                parsed["expectedHeadline"],
                year,
                sample_order,
                parsed["documentIndex"],
                parsed["warcSource"],
                now,
            ),
        )


def _record_infini_document_rejection(
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
            UPDATE bloomberg_infini_occurrences
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


def _record_infini_document_error(
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
            UPDATE bloomberg_infini_occurrences
            SET status='error',
                attempts=attempts+1,
                last_error=?,
                updated_at=?
            WHERE year=? AND shard_index=? AND rank=?
            """,
            (error, _now_iso(), year, shard_index, rank),
        )


def _record_infini_page_resolution(
    connection: sqlite3.Connection,
    *,
    partner_url: str,
    canonical_url: str,
    validation: dict[str, object],
) -> None:
    row = connection.execute(
        """
        SELECT expected_headline
        FROM bloomberg_infini_pages
        WHERE partner_url=?
        """,
        (partner_url,),
    ).fetchone()
    if row is None:
        raise ValueError("Bloomberg partner page disappeared from state")
    expected_headline = str(row[0])
    now = _now_iso()
    with connection:
        connection.execute(
            """
            UPDATE bloomberg_infini_pages
            SET status='resolved',
                attempts=attempts+1,
                canonical_url=?,
                archive_url=?,
                published_at=?,
                body_characters=?,
                last_error=NULL,
                updated_at=?
            WHERE partner_url=?
            """,
            (
                canonical_url,
                validation["archiveUrl"],
                validation["publishedAt"],
                validation["bodyCharacters"],
                now,
                partner_url,
            ),
        )
        connection.execute(
            """
            INSERT INTO bloomberg_bnn_articles(
                canonical_url,
                published_at,
                partner_url,
                archive_url,
                expected_headline,
                mapping_method,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(canonical_url) DO NOTHING
            """,
            (
                canonical_url,
                validation["publishedAt"],
                partner_url,
                validation["archiveUrl"],
                expected_headline,
                validation["mappingMethod"],
                now,
            ),
        )


def _record_infini_page_rejection(
    connection: sqlite3.Connection,
    *,
    partner_url: str,
    reason: str,
) -> None:
    with connection:
        connection.execute(
            """
            UPDATE bloomberg_infini_pages
            SET status='rejected',
                attempts=attempts+1,
                last_error=?,
                updated_at=?
            WHERE partner_url=?
            """,
            (reason, _now_iso(), partner_url),
        )


def _record_infini_page_error(
    connection: sqlite3.Connection,
    *,
    partner_url: str,
    error: str,
) -> None:
    with connection:
        connection.execute(
            """
            UPDATE bloomberg_infini_pages
            SET status='error',
                attempts=attempts+1,
                last_error=?,
                updated_at=?
            WHERE partner_url=?
            """,
            (error, _now_iso(), partner_url),
        )


def _sample_occurrence_ranks(
    segments: list[object],
    *,
    maximum: int,
    seed: str,
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
    randomizer = random.Random(
        int.from_bytes(
            hashlib.sha256(seed.encode()).digest()[:8],
            byteorder="big",
        )
    )
    positions = randomizer.sample(range(total), sample_size)
    result: list[tuple[int, int]] = []
    boundaries: list[tuple[int, int, int, int]] = []
    base = 0
    for shard_index, start, end in normalized:
        next_base = base + end - start
        boundaries.append((base, next_base, shard_index, start))
        base = next_base
    for position in positions:
        for lower, upper, shard_index, start in boundaries:
            if lower <= position < upper:
                result.append(
                    (shard_index, start + position - lower)
                )
                break
    return result


def _next_page_rows(
    connection: sqlite3.Connection,
    *,
    maximum: int,
) -> list[tuple[str, str]]:
    years = [
        int(row[0])
        for row in connection.execute(
            """
            SELECT DISTINCT substr(page.published_hint, 1, 4)
            FROM bloomberg_bnn_pages AS page
            WHERE (
                    page.status='pending'
                    OR (page.status='error' AND page.attempts < 3)
                  )
              AND (
                    SELECT COUNT(*)
                    FROM bloomberg_bnn_articles AS article
                    WHERE substr(article.published_at, 1, 4)
                          = substr(page.published_hint, 1, 4)
                  ) < ?
            ORDER BY 1 DESC
            """,
            (RESOLUTION_TARGET_PER_YEAR,),
        )
    ]
    if not years:
        return []
    per_year = math.ceil(maximum / len(years))
    buckets: list[list[tuple[str, str]]] = []
    for year in years:
        buckets.append(
            [
                (str(partner_url), str(published_hint))
                for partner_url, published_hint in connection.execute(
                    """
                    SELECT partner_url, published_hint
                    FROM bloomberg_bnn_pages
                    WHERE substr(published_hint, 1, 4)=?
                      AND (
                            status='pending'
                            OR (status='error' AND attempts < 3)
                          )
                    ORDER BY published_hint DESC, partner_url
                    LIMIT ?
                    """,
                    (str(year), per_year),
                )
            ]
        )
    result: list[tuple[str, str]] = []
    index = 0
    while len(result) < maximum:
        added = False
        for bucket in buckets:
            if index < len(bucket):
                result.append(bucket[index])
                added = True
                if len(result) >= maximum:
                    break
        if not added:
            break
        index += 1
    return result


def _record_page_resolution(
    connection: sqlite3.Connection,
    *,
    partner_url: str,
    result: dict[str, object],
) -> None:
    now = _now_iso()
    with connection:
        connection.execute(
            """
            UPDATE bloomberg_bnn_pages
            SET status='resolved',
                attempts=attempts+1,
                canonical_url=?,
                archive_url=?,
                expected_headline=?,
                published_at=?,
                body_characters=?,
                last_error=NULL,
                updated_at=?
            WHERE partner_url=?
            """,
            (
                result["canonicalUrl"],
                result["archiveUrl"],
                result["expectedHeadline"],
                result["publishedAt"],
                result["bodyCharacters"],
                now,
                partner_url,
            ),
        )
        connection.execute(
            """
            INSERT INTO bloomberg_bnn_articles(
                canonical_url,
                published_at,
                partner_url,
                archive_url,
                expected_headline,
                mapping_method,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(canonical_url) DO NOTHING
            """,
            (
                result["canonicalUrl"],
                result["publishedAt"],
                partner_url,
                result["archiveUrl"],
                result["expectedHeadline"],
                result["mappingMethod"],
                now,
            ),
        )


def _record_page_rejection(
    connection: sqlite3.Connection,
    *,
    partner_url: str,
    reason: str,
) -> None:
    with connection:
        connection.execute(
            """
            UPDATE bloomberg_bnn_pages
            SET status='rejected',
                attempts=attempts+1,
                last_error=?,
                updated_at=?
            WHERE partner_url=?
            """,
            (reason, _now_iso(), partner_url),
        )


def _record_page_error(
    connection: sqlite3.Connection,
    *,
    partner_url: str,
    error: str,
) -> None:
    with connection:
        connection.execute(
            """
            UPDATE bloomberg_bnn_pages
            SET status='error',
                attempts=attempts+1,
                last_error=?,
                updated_at=?
            WHERE partner_url=?
            """,
            (error, _now_iso(), partner_url),
        )


def _bloomberg_copyright_query(year: int) -> str:
    return f"©{year} Bloomberg L.P."


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
        port = parsed.port
    except ValueError:
        return None
    if port not in {None, 80, 443}:
        return None
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        return None
    query = urlencode(
        [
            (key, item)
            for key, item in parse_qsl(
                parsed.query,
                keep_blank_values=True,
            )
            if key.casefold() not in _TRACKING_QUERY_KEYS
        ]
    )
    return urlunsplit(
        (
            "https",
            hostname,
            parsed.path or "/",
            query,
            "",
        )
    )


def _parse_metadata_date(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _clean_partner_title(
    value: object,
    *,
    sitename: str,
) -> str | None:
    if not isinstance(value, str):
        return None
    title = BeautifulSoup(value, "html.parser").get_text(" ", strip=True)
    if sitename:
        title = re.sub(
            rf"\s+(?:[-–|]\s*){re.escape(sitename)}\s*$",
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


def _clean_bloomberg_search_title(value: str) -> str:
    result = re.sub(
        r"\s+(?:[-|]\s*)?Bloomberg(?:\.com)?\s*$",
        "",
        value.strip(),
        flags=re.IGNORECASE,
    )
    return re.sub(r"\s*(?:…|\.\.\.)\s*$", "", result).strip()


def _headline_overlap(first: str, second: str) -> float:
    first_tokens = _significant_tokens(first)
    second_tokens = _significant_tokens(second)
    if not first_tokens or not second_tokens:
        return 0.0
    return len(first_tokens & second_tokens) / max(
        len(first_tokens),
        len(second_tokens),
    )


def _optional_int(value: object) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _embedded_bloomberg_urls(content: bytes) -> list[str]:
    text = content.decode("utf-8", errors="ignore")
    spec = archive_source_spec("bloomberg")
    result: list[str] = []
    seen: set[str] = set()
    for match in _BLOOMBERG_LINK_RE.finditer(text):
        raw_url = match.group(0).replace("\\/", "/")
        canonical_url = normalize_article_url(spec, raw_url)
        if canonical_url and canonical_url not in seen:
            seen.add(canonical_url)
            result.append(canonical_url)
    return result


def _derived_bloomberg_url(partner_url: str) -> str | None:
    parsed = urlsplit(partner_url)
    if (parsed.hostname or "").casefold() not in _BNN_HOSTS:
        return None
    match = re.fullmatch(
        r"/bloomberg/(20\d{2})/(\d{2})/(\d{2})/"
        r"([a-z0-9][a-z0-9-]*)/?",
        parsed.path,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    try:
        published_day = date(
            int(match.group(1)),
            int(match.group(2)),
            int(match.group(3)),
        )
    except ValueError:
        return None
    candidate = (
        "https://www.bloomberg.com/news/articles/"
        f"{published_day.isoformat()}/{match.group(4).casefold()}"
    )
    return normalize_article_url(
        archive_source_spec("bloomberg"),
        candidate,
    )


def _best_original_url(
    canonical_urls: list[str],
    headline: str,
) -> tuple[str | None, float]:
    expected_tokens = _significant_tokens(headline)
    if not expected_tokens:
        return None, 0.0
    ranked: list[tuple[float, str]] = []
    for canonical_url in canonical_urls:
        slug = urlsplit(canonical_url).path.rstrip("/").rsplit("/", 1)[-1]
        slug_tokens = _significant_tokens(slug.replace("-", " "))
        overlap = len(expected_tokens & slug_tokens) / len(expected_tokens)
        ranked.append((overlap, canonical_url))
    ranked.sort(reverse=True)
    return (ranked[0][1], ranked[0][0]) if ranked else (None, 0.0)


def _archive_url_matches_partner(
    archive_url: str,
    partner_url: str,
) -> bool:
    match = _WAYBACK_PARTNER_RE.match(archive_url)
    if not match:
        return False
    archived_partner = unquote(match.group(1))
    expected = urlsplit(partner_url)
    actual = urlsplit(archived_partner)
    return (
        expected.scheme == actual.scheme
        and (expected.hostname or "").casefold()
        == (actual.hostname or "").casefold()
        and expected.path.rstrip("/") == actual.path.rstrip("/")
    )


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _significant_tokens(value: str) -> set[str]:
    return {
        token
        for token in _SIGNIFICANT_TOKEN_RE.findall(value.casefold())
        if token not in _STOP_WORDS
    }


def _status_counts(
    connection: sqlite3.Connection,
    table: str,
) -> dict[str, int]:
    return {
        str(status): int(count)
        for status, count in connection.execute(
            f"""
            SELECT status, COUNT(*)
            FROM {table}
            GROUP BY status
            ORDER BY status
            """
        )
    }


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
