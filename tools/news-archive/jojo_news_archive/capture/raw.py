from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import gzip
from html import escape
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import sqlite3
import time
import unicodedata
from threading import Lock
from typing import Callable, Iterable
from urllib.parse import (
    parse_qs,
    unquote,
    urlencode,
    urljoin,
    urlsplit,
    urlunsplit,
)
from xml.etree import ElementTree

from bs4 import BeautifulSoup
import brotli
from jojo_news_archive.capture import primitives as capture_primitives
from jojo_news_archive.capture.primitives import capture_hooks_for_source_url
from jojo_news_archive.discovery.client import ArchiveClient
from jojo_news_archive.sources.registry import (
    registered_sources,
    source_module,
)
from jojo_news_archive.sources.capture_contracts import (
    ArchiveFallbackPolicy,
    CandidateAssessment,
    ManifestItem,
    default_archive_fallback_policy,
)
from jojo_news_archive.sources.runtime import capture_hooks
from jojo_news_archive.discovery.common_crawl import (
    discover_common_crawl_candidates,
    fetch_common_crawl_candidate,
)
from jojo_news_archive.discovery.infini_news import (
    INFINI_DATASET,
    INFINI_DATASET_ROWS_ENDPOINT,
)
from jojo_news_archive.discovery.ghostarchive import (
    fetch_ghostarchive_candidate,
    is_ghostarchive_candidate_url,
)
from jojo_news_archive.models import (
    BlobReference,
    CaptureCandidate,
    CaptureProvider,
    CaptureRepresentation,
    ContentType,
    DependentResource,
    RawCapture,
)


SCHEMA_VERSION = "jojo-raw-capture-state/1"
ACCEPTED_HTTP_STATUSES = {200, 206}
WAYBACK_TIMEMAP_ENDPOINT = "https://web.archive.org/web/timemap/json"
WAYBACK_TIMEMAP_MAXIMUM_BYTES = 2_000_000
WAYBACK_TIMEMAP_MAXIMUM_CANDIDATES = 8
SYNDICATION_SEARCH_ENDPOINT = "https://search.yahoo.com/search"
SYNDICATION_SEARCH_MAXIMUM_BYTES = 2_000_000
ARQUIVO_PT_CDX_ENDPOINT = "https://arquivo.pt/wayback/cdx"
ARQUIVO_PT_REPLAY_ENDPOINT = "https://arquivo.pt/noFrame/replay"
ARQUIVO_PT_INDEX_MAXIMUM_BYTES = 2_000_000
ARQUIVO_PT_MAXIMUM_CANDIDATES = 3
_HTML_MARKERS = (
    b"<!doctype html",
    b"<html",
    b"<article",
    b"application/ld+json",
)
_ARCHIVE_ERROR_MARKERS = (
    b"wayback machine doesn't have that page archived",
    b"this url has been excluded from the wayback machine",
    b"cannot be crawled or displayed due to robots.txt",
    b'class="missing-404"',
    b"class='missing-404'",
)
_SERVER_PLACEHOLDER_MARKERS = (
    b"<title>welcome to nginx!</title>",
    b"<h1>welcome to nginx!</h1>",
    b"<title>test page for the nginx http server",
    b"<title>apache2 ubuntu default page",
    b"<title>apache http server test page",
    b"<title>iis windows server</title>",
)
_SERVER_PLACEHOLDER_MAXIMUM_BYTES = 100_000
_AUTH_SHELL_MARKERS = (
    b"<title>log in - ",
    b"<title>sign in - ",
    b"/auth/login?",
    b"sign in to continue",
    b"log in to continue",
    b'id="myaccountauth"',
)
_ACCESS_CHALLENGE_MARKERS = (
    b"are you a robot?",
    b"we've detected unusual activity",
    b"verify you are human",
    b"checking if the site connection is secure",
    b"<title>client challenge</title>",
    b"javascript is disabled in your browser",
    b"a required part of this site couldn",
    b"terms of service violation",
    b"distil_r_captcha",
    b'id="distil_ident_block"',
)
_REDIRECT_SHELL_MARKERS = (
    b"window.location = fullurl",
    b"window.location=fullurl",
)
_SUBSCRIPTION_SHELL_MARKERS = (
    b"<title>register to read",
    b"<title>subscribe to read",
    b'id="barrier-page"',
    b"barrier-grid__article-title",
    b"subscribe to unlock this article",
    b"to read the full story, subscribe or sign in",
)
_PARSED_PAYWALL_PHRASES = (
    "subscribe to read",
    "subscribe to continue",
    "sign in to continue",
    "already a subscriber",
    "unlock this article",
)
_PARSED_PAYWALL_MAXIMUM_BODY_CHARACTERS = 1_000
_ARTICLE_BODY_MARKERS = (
    b"article__content-body",
    b'id="article-body"',
    b'id="storycontent"',
    b"data-trackable=\"article-body\"",
    b"data-testid=\"article-body\"",
    b"story-body",
)
_SYNDICATION_STOP_WORDS = {
    "a", "after", "an", "and", "as", "at", "by", "for", "from",
    "in", "of", "on", "s", "the", "to", "with",
}
_WAYBACK_FINAL_RE = re.compile(
    r"https?://web\.archive\.org/web/(\d{14})(?:id_|im_|js_|cs_)?/",
    re.IGNORECASE,
)


def initialize_capture_schema(
    connection: sqlite3.Connection,
    *,
    publisher: str,
    authorization_reference: str,
    recover_interrupted: bool = True,
) -> None:
    if not authorization_reference.strip():
        raise ValueError("authorization_reference must not be empty")
    connection.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;

        CREATE TABLE IF NOT EXISTS archive_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS captures (
            canonical_url TEXT PRIMARY KEY,
            article_id TEXT NOT NULL,
            publisher TEXT NOT NULL,
            published_at TEXT,
            section TEXT,
            candidates_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            selected_candidate_json TEXT,
            final_url TEXT,
            http_status INTEGER,
            content_type TEXT,
            quality_score INTEGER,
            quality_signals_json TEXT,
            dependent_resources_json TEXT,
            raw_path TEXT,
            raw_sha256 TEXT,
            raw_bytes INTEGER,
            stored_bytes INTEGER,
            record_path TEXT,
            last_error TEXT,
            retrieved_at TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_captures_status
            ON captures(status);
        CREATE INDEX IF NOT EXISTS idx_captures_published_at
            ON captures(published_at);
        """
    )
    capture_columns = {
        str(row[1])
        for row in connection.execute("PRAGMA table_info(captures)")
    }
    if "dependent_resources_json" not in capture_columns:
        connection.execute(
            "ALTER TABLE captures ADD COLUMN dependent_resources_json TEXT"
        )
    capture_policy_version = source_module(publisher).capture_policy_version
    previous_policy = connection.execute(
        """
        SELECT value
        FROM archive_metadata
        WHERE key='capture_policy_version'
        """
    ).fetchone()
    policy_changed = (
        previous_policy is None
        or str(previous_policy[0]) != capture_policy_version
    )
    metadata = {
        "schema_version": SCHEMA_VERSION,
        "publisher": publisher,
        "authorization_reference": authorization_reference,
        "capture_policy_version": capture_policy_version,
    }
    connection.executemany(
        """
        INSERT INTO archive_metadata(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        metadata.items(),
    )
    if policy_changed:
        connection.execute(
            """
            UPDATE captures
            SET status='pending',
                attempts=0,
                last_error=NULL,
                updated_at=?
            WHERE status='error'
            """,
            (_now_iso(),),
        )
    if recover_interrupted:
        connection.execute(
            """
            UPDATE captures
            SET status='pending',
                attempts=CASE
                    WHEN attempts > 0 THEN attempts - 1
                    ELSE 0
                END,
                last_error='interrupted before completion',
                updated_at=?
            WHERE status='downloading'
            """,
            (_now_iso(),),
        )
    # Earlier scoring gave a 200 response containing only an archive-side
    # burn comment a score of 70 and marked it complete.  Requeue those tiny
    # HTML shells on checkpoint restore so an alternate Timemap capture can
    # replace the bad raw object.
    connection.execute(
        """
        UPDATE captures
        SET status='pending',
            attempts=0,
            last_error='quality-recheck:tiny-html-shell',
            updated_at=?
        WHERE status='complete'
          AND raw_bytes > 0
          AND raw_bytes < 512
          AND LOWER(COALESCE(content_type, '')) LIKE '%html%'
          AND COALESCE(quality_score, 0) <= 70
        """,
        (_now_iso(),),
    )
    connection.commit()


def load_capture_manifest(
    connection: sqlite3.Connection,
    *,
    manifest_path: Path,
    publisher: str,
) -> dict[str, int]:
    inserted = 0
    seen = 0
    batch: list[tuple[object, ...]] = []
    for row in _read_jsonl(manifest_path):
        item = manifest_item_from_row(row, publisher=publisher)
        seen += 1
        if not item.candidates:
            continue
        batch.append(
            (
                item.canonical_url,
                item.article_id,
                item.publisher,
                item.published_at,
                item.section,
                json.dumps(
                    [
                        candidate.model_dump(
                            mode="json",
                            by_alias=True,
                            exclude_none=True,
                        )
                        for candidate in item.candidates
                    ],
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                _now_iso(),
            )
        )
        if len(batch) >= 1_000:
            inserted += _insert_manifest_batch(connection, batch)
            batch.clear()
    if batch:
        inserted += _insert_manifest_batch(connection, batch)
    connection.commit()
    return {"manifestRows": seen, "inserted": inserted}


def manifest_item_from_row(row: dict, *, publisher: str) -> ManifestItem:
    row_publisher = str(row.get("publisher") or publisher).strip().lower()
    if row_publisher != publisher:
        raise ValueError(
            f"manifest publisher {row_publisher!r} does not match {publisher!r}"
        )
    canonical_url = str(
        row.get("canonical_url")
        or row.get("canonicalUrl")
        or row.get("url")
        or ""
    ).strip()
    if not canonical_url.startswith(("http://", "https://")):
        raise ValueError(f"manifest row has invalid canonical URL: {canonical_url!r}")
    normalize_manifest_url = capture_hooks(publisher).normalize_manifest_url
    if normalize_manifest_url is not None:
        normalized_url = normalize_manifest_url(canonical_url)
        if normalized_url is None:
            raise ValueError(
                f"manifest row has invalid {publisher} article URL: {canonical_url!r}"
            )
        canonical_url = normalized_url

    raw_candidates = row.get("candidates")
    candidates: list[CaptureCandidate] = []
    if isinstance(raw_candidates, list):
        for candidate in raw_candidates:
            candidates.append(CaptureCandidate.model_validate(candidate))
    else:
        snapshot_url = str(row.get("wayback_snapshot_url") or "").strip()
        timestamp = str(row.get("wayback_timestamp") or "").strip()
        if snapshot_url:
            candidates.append(
                CaptureCandidate(
                    provider=CaptureProvider.WAYBACK,
                    snapshot_url=snapshot_url,
                    captured_at=_wayback_datetime(timestamp),
                    digest=_optional_string(row.get("wayback_digest")),
                    mime_type=_optional_string(row.get("wayback_mimetype")),
                    status_code=_optional_int(row.get("wayback_status_code")) or 200,
                )
            )
    published_at = _optional_string(
        row.get("published_at")
        or row.get("publishedAt")
        or row.get("catalog_date")
    )
    return ManifestItem(
        publisher=publisher,
        canonical_url=canonical_url,
        published_at=published_at,
        section=_optional_string(row.get("section")),
        candidates=tuple(candidates),
    )


def pending_captures(
    connection: sqlite3.Connection,
    *,
    retry_errors: bool,
    maximum: int | None,
    maximum_record_attempts: int,
    prioritize_parser_validation: bool = False,
    parser_validation_only: bool = False,
    validation_from_year: int | None = None,
    validation_to_year: int | None = None,
    parser_validation_schema_initialized: bool = False,
) -> list[ManifestItem]:
    if maximum_record_attempts < 1:
        raise ValueError("maximum_record_attempts must be positive")
    if parser_validation_only and not prioritize_parser_validation:
        raise ValueError(
            "parser_validation_only requires prioritize_parser_validation"
        )
    repair_limit = -1 if maximum is None else maximum
    priority_urls = []
    if not parser_validation_only:
        priority_urls = [
            str(row[0])
            for row in connection.execute(
                """
                SELECT canonical_url
                FROM captures
                WHERE status='pending'
                  AND last_error LIKE 'quality-recheck:%'
                ORDER BY updated_at, canonical_url
                LIMIT ?
                """,
                (repair_limit,),
            )
        ]
    if prioritize_parser_validation:
        from jojo_news_archive.parsing.validation import pending_parser_validation_urls

        validation_limit = (
            None
            if maximum is None
            else max(0, maximum - len(priority_urls))
        )
        validation_urls = pending_parser_validation_urls(
            connection,
            maximum=validation_limit,
            maximum_record_attempts=maximum_record_attempts,
            from_year=validation_from_year,
            to_year=validation_to_year,
            initialize_schema=not parser_validation_schema_initialized,
        )
        priority_urls.extend(
            url for url in validation_urls if url not in priority_urls
        )
    priority_rows: list[tuple] = []
    if priority_urls:
        placeholders = ",".join("?" for _ in priority_urls)
        rows_by_url = {
            row[1]: row
            for row in connection.execute(
                f"""
                SELECT
                    publisher,
                    canonical_url,
                    published_at,
                    section,
                    candidates_json
                FROM captures
                WHERE canonical_url IN ({placeholders})
                """,
                priority_urls,
            ).fetchall()
        }
        priority_rows = [
            rows_by_url[url] for url in priority_urls if url in rows_by_url
        ]

    if parser_validation_only:
        return [
            _manifest_item_from_capture_row(row) for row in priority_rows
        ]

    remaining = (
        None
        if maximum is None
        else max(0, maximum - len(priority_rows))
    )
    if remaining == 0:
        rows = priority_rows
        return [_manifest_item_from_capture_row(row) for row in rows]

    statuses = ("pending", "error") if retry_errors else ("pending",)
    placeholders = ",".join("?" for _ in statuses)
    query = f"""
        SELECT publisher, canonical_url, published_at, section, candidates_json
        FROM captures
        WHERE status IN ({placeholders})
          AND (status='pending' OR attempts < ?)
        ORDER BY COALESCE(published_at, ''), canonical_url
    """
    parameters: list[object] = [*statuses, maximum_record_attempts]
    if priority_urls:
        excluded = ",".join("?" for _ in priority_urls)
        query = query.replace(
            "ORDER BY COALESCE(published_at, ''), canonical_url",
            f"""
              AND canonical_url NOT IN ({excluded})
            ORDER BY COALESCE(published_at, ''), canonical_url
            """,
        )
        parameters.extend(priority_urls)
    if remaining is not None:
        query += " LIMIT ?"
        parameters.append(remaining)
    rows = priority_rows + connection.execute(query, parameters).fetchall()
    return [_manifest_item_from_capture_row(row) for row in rows]


def lease_pending_captures(
    connection: sqlite3.Connection,
    *,
    retry_errors: bool,
    maximum: int | None,
    maximum_record_attempts: int,
    prioritize_parser_validation: bool = False,
    parser_validation_only: bool = False,
    validation_from_year: int | None = None,
    validation_to_year: int | None = None,
) -> list[ManifestItem]:
    """Atomically reserve a capture batch for one local worker process."""

    if prioritize_parser_validation:
        from jojo_news_archive.parsing.validation import initialize_parser_validation_schema

        # Schema setup commits by design. Perform it before taking the write
        # lease so selection plus status transition remains one transaction.
        initialize_parser_validation_schema(
            connection,
            invalidate_stale_results=False,
        )
    _begin_immediate_with_retry(connection)
    try:
        items = pending_captures(
            connection,
            retry_errors=retry_errors,
            maximum=maximum,
            maximum_record_attempts=maximum_record_attempts,
            prioritize_parser_validation=prioritize_parser_validation,
            parser_validation_only=parser_validation_only,
            validation_from_year=validation_from_year,
            validation_to_year=validation_to_year,
            parser_validation_schema_initialized=(
                prioritize_parser_validation
            ),
        )
        now = _now_iso()
        connection.executemany(
            """
            UPDATE captures
            SET status='downloading',
                attempts=attempts+1,
                last_error=NULL,
                updated_at=?
            WHERE canonical_url=?
            """,
            ((now, item.canonical_url) for item in items),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    return items


def _begin_immediate_with_retry(
    connection: sqlite3.Connection,
    *,
    maximum_attempts: int = 20,
) -> None:
    """Acquire a write lease despite brief concurrent SQLite checkpoints."""

    for attempt in range(maximum_attempts):
        try:
            connection.execute("BEGIN IMMEDIATE")
            return
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc).casefold() or attempt + 1 >= maximum_attempts:
                raise
            time.sleep(min(0.05 * (2 ** min(attempt, 3)), 0.4))


def release_capture_leases(
    connection: sqlite3.Connection,
    items: Iterable[ManifestItem],
) -> int:
    """Release this process's reserved rows that it did not finish."""

    urls = tuple(dict.fromkeys(item.canonical_url for item in items))
    if not urls:
        return 0
    released = 0
    now = _now_iso()
    for offset in range(0, len(urls), 500):
        chunk = urls[offset : offset + 500]
        placeholders = ",".join("?" for _ in chunk)
        cursor = connection.execute(
            f"""
            UPDATE captures
            SET status='pending',
                attempts=CASE
                    WHEN attempts > 0 THEN attempts - 1
                    ELSE 0
                END,
                last_error='lease released before submission',
                updated_at=?
            WHERE status='downloading'
              AND canonical_url IN ({placeholders})
            """,
            (now, *chunk),
        )
        released += max(0, cursor.rowcount)
    connection.commit()
    return released


def _manifest_item_from_capture_row(row: tuple) -> ManifestItem:
    return ManifestItem(
        publisher=row[0],
        canonical_url=row[1],
        published_at=row[2],
        section=row[3],
        candidates=tuple(
            CaptureCandidate.model_validate(candidate)
            for candidate in json.loads(row[4])
        ),
    )


def mark_capture_downloading(
    connection: sqlite3.Connection,
    item: ManifestItem,
) -> None:
    connection.execute(
        """
        UPDATE captures
        SET status='downloading',
            attempts=attempts+1,
            last_error=NULL,
            updated_at=?
        WHERE canonical_url=?
        """,
        (_now_iso(), item.canonical_url),
    )
    connection.commit()


CaptureResponse = tuple[
    CaptureCandidate,
    int,
    bytes,
    str,
    str,
    int,
    dict[str, object],
]


class CaptureSession:
    """Shared transport/state engine driven by one vertical source strategy."""

    def __init__(
        self,
        item: ManifestItem,
        *,
        archive_client: ArchiveClient,
        output_dir: Path,
        maximum_html_bytes: int,
        enable_wayback_timemap_fallback: bool,
        enable_common_crawl_fallback: bool,
        enable_arquivo_pt_fallback: bool,
        source_options: dict[str, object],
    ) -> None:
        self.item = item
        self.archive_client = archive_client
        self.output_dir = output_dir
        self.maximum_html_bytes = maximum_html_bytes
        self.enable_wayback_timemap_fallback = enable_wayback_timemap_fallback
        self.enable_common_crawl_fallback = enable_common_crawl_fallback
        self.enable_arquivo_pt_fallback = enable_arquivo_pt_fallback
        self.source_options = source_options
        self.source_capture = capture_hooks(item.publisher)
        self.failures: list[str] = []
        self.candidates_considered = list(item.candidates)
        self.best_response: CaptureResponse | None = None
        self.state: dict[str, object] = {}
        self.wayback_timemap_attempted = False
        self.arquivo_pt_attempted = False

    def fail(self, label: str, exc: BaseException | str) -> None:
        detail = type(exc).__name__ if isinstance(exc, BaseException) else str(exc)
        self.failures.append(f"{label}:{detail}")

    def unique_candidates(
        self, candidates: Iterable[CaptureCandidate]
    ) -> tuple[CaptureCandidate, ...]:
        seen = {
            (
                candidate.snapshot_url,
                candidate.warc_offset,
                candidate.warc_length,
            )
            for candidate in self.candidates_considered
        }
        result: list[CaptureCandidate] = []
        for candidate in candidates:
            key = (
                candidate.snapshot_url,
                candidate.warc_offset,
                candidate.warc_length,
            )
            if key in seen:
                continue
            seen.add(key)
            result.append(candidate)
        return tuple(result)

    def add_candidates(
        self, candidates: Iterable[CaptureCandidate]
    ) -> tuple[CaptureCandidate, ...]:
        fresh = self.unique_candidates(candidates)
        self.candidates_considered.extend(fresh)
        return fresh

    def observe_candidate_response(
        self, candidate: CaptureCandidate, content: bytes, final_url: str
    ) -> None:
        hook = self.source_capture.observe_candidate_response
        if hook is not None:
            hook(self, candidate, content=content, final_url=final_url)

    def consider(self, candidates: Iterable[CaptureCandidate]) -> None:
        skip_hook = self.source_capture.should_skip_candidate
        validate_hook = self.source_capture.validate_candidate_response
        for candidate in candidates:
            if skip_hook is not None and skip_hook(self, candidate):
                continue
            response, failure = _fetch_usable_candidate(
                candidate,
                archive_client=self.archive_client,
                maximum_html_bytes=self.maximum_html_bytes,
                canonical_url=self.item.canonical_url,
                publisher=self.item.publisher,
                response_observer=self.observe_candidate_response,
            )
            if failure:
                self.failures.append(failure)
            if response is None:
                continue
            if validate_hook is not None:
                response, failure = validate_hook(self, candidate, response)
                if failure:
                    self.failures.append(failure)
                if response is None:
                    continue
            if self.best_response is None or response[5] > self.best_response[5]:
                self.best_response = response
            if response[5] == 100:
                break

    def discover_wayback(
        self,
        item: ManifestItem | None = None,
        *,
        maximum_candidates: int | None = None,
        label: str = "wayback-timemap",
    ) -> tuple[CaptureCandidate, ...]:
        self.wayback_timemap_attempted = True
        try:
            kwargs = (
                {"maximum_candidates": maximum_candidates}
                if maximum_candidates is not None
                else {}
            )
            candidates = discover_wayback_timemap_candidates(
                item or self.item,
                archive_client=self.archive_client,
                **kwargs,
            )
        except Exception as exc:
            self.fail(label, exc)
            return ()
        fresh = self.add_candidates(candidates)
        self.consider(fresh)
        return fresh

    def discover_common_crawl(self, url: str) -> tuple[CaptureCandidate, ...]:
        try:
            candidates = discover_common_crawl_candidates(
                url,
                published_at=self.item.published_at,
                archive_client=self.archive_client,
            )
        except Exception as exc:
            self.fail("commoncrawl-index", exc)
            return ()
        fresh = self.add_candidates(candidates)
        self.consider(fresh)
        return fresh

    def discover_arquivo(
        self, item: ManifestItem | None = None
    ) -> tuple[CaptureCandidate, ...]:
        self.arquivo_pt_attempted = True
        try:
            candidates = discover_arquivo_pt_candidates(
                item or self.item,
                archive_client=self.archive_client,
            )
        except Exception as exc:
            self.fail("arquivo-pt-index", exc)
            return ()
        fresh = self.add_candidates(candidates)
        self.consider(fresh)
        return fresh

    def consider_common_crawl(self) -> None:
        if (
            not self.enable_common_crawl_fallback
            or not source_module(self.item.publisher).common_crawl_fallback
            or (self.best_response is not None and self.best_response[5] >= 100)
        ):
            return
        for url in _common_crawl_discovery_urls(self.item):
            if self.discover_common_crawl(url):
                break

    def consider_arquivo(self) -> None:
        if (
            self.arquivo_pt_attempted
            or not self.enable_arquivo_pt_fallback
            or not source_module(self.item.publisher).arquivo_pt_fallback
            or (self.best_response is not None and self.best_response[5] >= 100)
        ):
            return
        for url in _common_crawl_discovery_urls(self.item):
            lookup_item = ManifestItem(
                publisher=self.item.publisher,
                canonical_url=url,
                published_at=self.item.published_at,
                section=self.item.section,
                candidates=self.item.candidates,
            )
            if self.discover_arquivo(lookup_item):
                break

    def generic_timemap_items(self) -> tuple[ManifestItem, ...]:
        hook = self.source_capture.timemap_items
        if hook is not None:
            return tuple(hook(self))
        urls = [self.item.canonical_url]
        for candidate in self.candidates_considered:
            if candidate.provider != CaptureProvider.WAYBACK:
                continue
            original = _wayback_snapshot_original_url(candidate.snapshot_url)
            if (
                original
                and original not in urls
                and _same_article_url(original, self.item.canonical_url)
            ):
                urls.append(original)
        return tuple(
            ManifestItem(
                publisher=self.item.publisher,
                canonical_url=url,
                published_at=self.item.published_at,
                section=self.item.section,
                candidates=self.item.candidates,
            )
            for url in urls
        )

    def consider_wayback(self) -> None:
        if (
            self.best_response is not None
            or self.wayback_timemap_attempted
            or not self.enable_wayback_timemap_fallback
            or not source_module(self.item.publisher).wayback_timemap_fallback
        ):
            return
        for item in self.generic_timemap_items():
            if self.best_response is not None:
                break
            self.discover_wayback(item)

    def run_default(self) -> None:
        rank_hook = self.source_capture.rank_manifest_candidates
        candidates = (
            rank_hook(self.item.candidates, published_at=self.item.published_at)
            if rank_hook is not None
            else self.item.candidates
        )
        self.consider(candidates)
        self.consider_common_crawl()
        self.consider_wayback()
        self.consider_arquivo()

    def finish(self) -> dict:
        if self.best_response is None:
            return {
                "canonicalUrl": self.item.canonical_url,
                "status": "error",
                "capture": None,
                "recordPath": None,
                "error": "; ".join(self.failures[-8:]) or "no usable capture candidates",
            }
        candidate, status_code, content, final_url, content_type, quality_score, signals = self.best_response
        raw_reference = store_raw_html(self.output_dir, content)
        resource_hook = self.source_capture.capture_dependent_resources
        dependent_resources = (
            resource_hook(
                self.item,
                candidate=candidate,
                html_bytes=content,
                archive_client=self.archive_client,
                output_dir=self.output_dir,
            )
            if resource_hook is not None
            else []
        )
        selected_candidate = resolved_capture_candidate(
            candidate,
            final_url=final_url,
            http_status=status_code,
            content_type=content_type,
            byte_count=len(content),
        )
        capture = RawCapture(
            article_id=self.item.article_id,
            publisher=self.item.publisher,
            canonical_url=self.item.canonical_url,
            published_at=self.item.published_at,
            section=self.item.section,
            selected_candidate=selected_candidate,
            candidates_considered=self.candidates_considered,
            retrieved_at=datetime.now(timezone.utc),
            final_url=final_url,
            http_status=status_code,
            content_type=content_type or "text/html",
            representation=(
                CaptureRepresentation.DERIVED_HTML
                if candidate.provider == CaptureProvider.INFINI_NEWS
                else CaptureRepresentation.RAW_HTML
            ),
            quality_score=quality_score,
            quality_signals=signals,
            raw_html=raw_reference,
            dependent_resources=dependent_resources,
        )
        existing_record = reusable_capture_record(self.output_dir, capture)
        if existing_record is not None:
            capture, record_path = existing_record
        else:
            record_path = store_capture_record(self.output_dir, capture)
        return {
            "canonicalUrl": self.item.canonical_url,
            "status": "complete",
            "capture": capture,
            "recordPath": record_path,
            "error": None,
        }


def capture_item(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
    output_dir: Path,
    maximum_html_bytes: int,
    enable_wayback_timemap_fallback: bool = True,
    enable_common_crawl_fallback: bool = False,
    enable_arquivo_pt_fallback: bool = False,
    **source_options: object,
) -> dict:
    # Existing source-specific keyword arguments remain accepted through this
    # opaque mapping; only the selected vertical source strategy interprets
    # them.
    session = CaptureSession(
        item,
        archive_client=archive_client,
        output_dir=output_dir,
        maximum_html_bytes=maximum_html_bytes,
        enable_wayback_timemap_fallback=enable_wayback_timemap_fallback,
        enable_common_crawl_fallback=enable_common_crawl_fallback,
        enable_arquivo_pt_fallback=enable_arquivo_pt_fallback,
        source_options=source_options,
    )
    strategy = session.source_capture.run_capture
    if strategy is None:
        session.run_default()
    else:
        strategy(session)
    return session.finish()


def archive_fallback_policy(
    *,
    publisher: str,
    parser_validation_enabled: bool,
    prior_attempts: int,
) -> ArchiveFallbackPolicy:
    if prior_attempts < 0:
        raise ValueError("prior_attempts must not be negative")
    hook = capture_hooks(publisher).archive_fallback_policy
    if hook is None:
        hook = default_archive_fallback_policy
    return hook(
        parser_validation_enabled=parser_validation_enabled,
        prior_attempts=prior_attempts,
    )


def defer_expensive_archive_fallbacks(
    *,
    publisher: str,
    parser_validation_enabled: bool,
    prior_attempts: int,
) -> bool:
    policy = archive_fallback_policy(
        publisher=publisher,
        parser_validation_enabled=parser_validation_enabled,
        prior_attempts=prior_attempts,
    )
    return not any(
        (policy.wayback_timemap, policy.common_crawl, policy.arquivo_pt)
    )


def _fetch_infini_news_candidate(
    candidate: CaptureCandidate,
    *,
    archive_client: ArchiveClient,
    maximum_html_bytes: int,
    canonical_url: str,
) -> tuple[int, dict[str, str], bytes, str]:
    parsed = urlsplit(candidate.snapshot_url)
    expected_endpoint = urlsplit(INFINI_DATASET_ROWS_ENDPOINT)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if (
        parsed.scheme != "https"
        or parsed.hostname != expected_endpoint.hostname
        or parsed.path != expected_endpoint.path
        or query.get("dataset") != [INFINI_DATASET]
        or query.get("split") != ["train"]
        or query.get("length") != ["1"]
        or len(query.get("config", [])) != 1
        or re.fullmatch(r"year_\d{4}", query["config"][0]) is None
        or len(query.get("offset", [])) != 1
        or re.fullmatch(r"\d+", query["offset"][0]) is None
        or not candidate.source_url
    ):
        raise ValueError("invalid Infini-News dataset row candidate")
    status_code, headers, payload, _ = _fetch_limited_archive(
        archive_client,
        candidate.snapshot_url,
        maximum_bytes=max(maximum_html_bytes, 2_000_000),
        attempts=2,
        timeout=45.0,
    )
    content_type = headers.get("content-type", "").casefold()
    if status_code != 200 or not payload:
        raise ValueError(f"Infini-News row returned HTTP {status_code}")
    if "json" not in content_type and not payload.lstrip().startswith(b"{"):
        raise ValueError("Infini-News row did not return JSON")
    decoded = json.loads(payload)
    rows = decoded.get("rows") if isinstance(decoded, dict) else None
    row_wrapper = rows[0] if isinstance(rows, list) and len(rows) == 1 else None
    row = row_wrapper.get("row") if isinstance(row_wrapper, dict) else None
    if not isinstance(row, dict):
        raise ValueError("Infini-News row response is invalid")
    expected_index = int(query["offset"][0])
    if row_wrapper.get("row_idx") != expected_index:
        raise ValueError("Infini-News row index mismatch")
    expected_year = int(query["config"][0].removeprefix("year_"))
    if row.get("year") != expected_year:
        raise ValueError("Infini-News row year mismatch")
    source_url = str(row.get("url") or "").strip()
    if not _same_article_url(source_url, candidate.source_url):
        raise ValueError("Infini-News source URL mismatch")
    expected_headline = candidate.expected_headline or ""
    headline = str(row.get("title") or "").strip()
    if (
        len(_significant_tokens(expected_headline)) < 4
        or _headline_text_overlap(expected_headline, headline) < 0.8
    ):
        raise ValueError("Infini-News headline mismatch")
    text = str(row.get("text") or "").strip()
    source_url_capture = capture_hooks_for_source_url(candidate.source_url)
    minimum_hook = (
        source_url_capture.infini_minimum_body_characters
        if source_url_capture is not None
        else None
    )
    minimum_body_characters = (
        int(minimum_hook(candidate.source_url))
        if minimum_hook is not None
        else 400
    )
    if len(text) < minimum_body_characters:
        raise ValueError("Infini-News document body is too short")
    warc_filename = str(row.get("warc_filename") or "").strip()
    if not candidate.warc_filename:
        raise ValueError("Infini-News candidate WARC provenance is missing")
    if warc_filename != candidate.warc_filename:
        raise ValueError("Infini-News WARC provenance mismatch")
    if (
        not warc_filename.startswith("CC-NEWS-")
        or not warc_filename.endswith(".warc.gz")
    ):
        raise ValueError("Infini-News WARC provenance is missing")
    derived_html = _infini_news_derived_html(
        row,
        canonical_url=canonical_url,
        source_url=source_url,
        headline=headline,
        text=text,
    )
    if len(derived_html) > maximum_html_bytes:
        raise ValueError("Infini-News derived HTML exceeds the capture limit")
    return (
        200,
        {"content-type": "text/html; charset=utf-8"},
        derived_html,
        source_url,
    )


def _infini_news_derived_html(
    row: dict[str, object],
    *,
    canonical_url: str,
    source_url: str,
    headline: str,
    text: str,
) -> bytes:
    published_at = str(
        row.get("publish_date") or row.get("date") or ""
    ).strip()
    author = str(row.get("author") or "").strip()
    description = str(row.get("description") or "").strip()
    structured = {
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        "url": canonical_url,
        "mainEntityOfPage": canonical_url,
        "isBasedOn": source_url,
        "headline": headline,
        **({"datePublished": published_at} if published_at else {}),
        **({"author": {"@type": "Person", "name": author}} if author else {}),
        **({"description": description} if description else {}),
    }
    structured_json = json.dumps(
        structured,
        ensure_ascii=False,
        separators=(",", ":"),
    ).replace("</", "<\\/")
    paragraphs = [line.strip() for line in text.splitlines() if line.strip()]
    body_html = "".join(f"<p>{escape(line)}</p>" for line in paragraphs)
    html = (
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        f"<title>{escape(headline)}</title>"
        f"<link rel=\"canonical\" href=\"{escape(canonical_url, quote=True)}\">"
        f"<link rel=\"alternate\" href=\"{escape(source_url, quote=True)}\">"
        f"<script type=\"application/ld+json\">{structured_json}</script>"
        "</head><body>"
        f"<article data-jojo-representation=\"derived-infini-news\">"
        f"<h1>{escape(headline)}</h1>"
        f"<div data-trackable=\"article-body\">{body_html}</div>"
        "</article>"
        "</body></html>"
    )
    return html.encode("utf-8")


def _fetch_usable_candidate(
    candidate: CaptureCandidate,
    *,
    archive_client: ArchiveClient,
    maximum_html_bytes: int,
    canonical_url: str,
    publisher: str,
    response_observer: Callable[
        [CaptureCandidate, bytes, str],
        None,
    ]
    | None = None,
) -> tuple[
    tuple[
        CaptureCandidate,
        int,
        bytes,
        str,
        str,
        int,
        dict[str, object],
    ]
    | None,
    str | None,
]:
    transport_signals: dict[str, object] = {}
    source_capture = capture_hooks(publisher)
    try:
        skip_hook = source_capture.skip_candidate
        if skip_hook is not None and skip_hook(candidate):
            return None, None
        custom_fetch = source_capture.fetch_candidate
        custom_response = (
            custom_fetch(
                candidate,
                archive_client=archive_client,
                maximum_html_bytes=maximum_html_bytes,
                canonical_url=canonical_url,
            )
            if custom_fetch is not None
            else None
        )
        if custom_response is not None:
            status_code, headers, content, final_url = custom_response
        elif candidate.provider == CaptureProvider.COMMON_CRAWL:
            status_code, headers, content, final_url = (
                fetch_common_crawl_candidate(
                    candidate,
                    archive_client=archive_client,
                    maximum_html_bytes=maximum_html_bytes,
                )
            )
        elif candidate.provider == CaptureProvider.INFINI_NEWS:
            if not source_capture.supports_infini_news:
                raise ValueError("Infini-News is not supported by this source")
            status_code, headers, content, final_url = (
                _fetch_infini_news_candidate(
                    candidate,
                    archive_client=archive_client,
                    maximum_html_bytes=maximum_html_bytes,
                    canonical_url=canonical_url,
                )
            )
        elif (
            candidate.provider == CaptureProvider.OTHER
            and is_ghostarchive_candidate_url(candidate.snapshot_url)
        ):
            (
                status_code,
                headers,
                content,
                final_url,
                transport_signals,
            ) = fetch_ghostarchive_candidate(
                candidate,
                canonical_url=canonical_url,
                archive_client=archive_client,
                maximum_html_bytes=maximum_html_bytes,
            )
        else:
            status_code, headers, content, final_url = archive_client.fetch(
                candidate.snapshot_url,
                maximum_bytes=maximum_html_bytes,
            )
    except Exception as exc:
        return None, f"{candidate.provider.value}:{type(exc).__name__}"
    try:
        content, decoding_signals = _decode_archived_html_content(
            content,
            headers=headers,
            maximum_bytes=maximum_html_bytes,
        )
    except ValueError:
        return None, f"{candidate.provider.value}:decoded-response-too-large"
    transport_signals = transport_signals | decoding_signals
    if (
        candidate.provider == CaptureProvider.COMMON_CRAWL
        and not _same_article_url(final_url, canonical_url)
    ):
        return None, "commoncrawl:target-mismatch"
    if (
        candidate.provider == CaptureProvider.ARQUIVO_PT
        and not _arquivo_pt_replay_matches(final_url, canonical_url)
    ):
        return None, "arquivo-pt:target-mismatch"
    target_hook = source_capture.candidate_target_rejection
    if target_hook is not None:
        target_rejection = target_hook(
            candidate,
            canonical_url=canonical_url,
            final_url=final_url,
        )
        if target_rejection is not None:
            return None, target_rejection
    content_type = headers.get("content-type", "").split(";", 1)[0].strip()
    quality_score, signals = score_raw_capture(
        content,
        http_status=status_code,
        content_type=content_type,
        final_url=final_url,
        publisher=publisher,
    )
    signals = signals | transport_signals
    if response_observer is not None:
        response_observer(candidate, content, final_url)
    assessment_hook = source_capture.assess_candidate
    assessment = (
        assessment_hook(
            candidate,
            content=content,
            canonical_url=canonical_url,
            final_url=final_url,
            quality_score=quality_score,
            signals=signals,
        )
        if assessment_hook is not None
        else CandidateAssessment(quality_score=quality_score, signals=signals)
    )
    quality_score = assessment.quality_score
    signals = assessment.signals
    rejection_reasons = _candidate_rejection_reasons(
        status_code=status_code,
        content=content,
        signals=signals,
        source_rejection_reasons=assessment.rejection_reasons,
    )
    if rejection_reasons:
        return (
            None,
            f"{candidate.provider.value}:http-{status_code}:"
            f"score-{quality_score}:reject-{','.join(rejection_reasons)}",
        )
    if candidate.provider == CaptureProvider.COMMON_CRAWL:
        signals = signals | {
            "commonCrawlWarcValidated": True,
            "commonCrawlWarcFilename": candidate.warc_filename,
            "commonCrawlWarcOffset": candidate.warc_offset,
            "commonCrawlWarcLength": candidate.warc_length,
        }
    elif candidate.provider == CaptureProvider.ARQUIVO_PT:
        signals = signals | {
            "arquivoPtReplayValidated": True,
            "arquivoPtCapturedAt": (
                candidate.captured_at.isoformat()
                if candidate.captured_at is not None
                else None
            ),
        }
    elif candidate.provider == CaptureProvider.INFINI_NEWS:
        signals = signals | {
            "infiniNewsValidated": True,
            "infiniNewsDerivedHtml": True,
            "infiniNewsDatasetRowUrl": candidate.snapshot_url,
            "infiniNewsSourceUrl": candidate.source_url,
            "infiniNewsWarcFilename": candidate.warc_filename,
            "infiniNewsDerivedHtmlSha256": hashlib.sha256(content).hexdigest(),
        }
    return (
        (
            candidate,
            status_code,
            content,
            final_url,
            content_type,
            quality_score,
            signals,
        ),
        None,
    )


def _candidate_rejection_reasons(
    *,
    status_code: int,
    content: bytes,
    signals: dict[str, object],
    source_rejection_reasons: tuple[str, ...] = (),
) -> tuple[str, ...]:
    """Return stable diagnostics for every candidate rejection predicate."""

    reasons: list[str] = []
    if status_code not in ACCEPTED_HTTP_STATUSES:
        reasons.append("http-status")
    if not content:
        reasons.append("empty-content")
    if not signals["looksLikeHtml"]:
        reasons.append("non-html")
    if signals["archiveErrorPage"]:
        reasons.append("archive-error-page")
    if signals.get("serverPlaceholderShell"):
        reasons.append("server-placeholder-shell")
    if signals.get("tinyHtmlShell"):
        reasons.append("tiny-html-shell")
    if signals["authenticationShell"] and not signals.get("allowAuthenticationShell"):
        reasons.append("authentication-shell")
    if signals["accessChallengeShell"]:
        reasons.append("access-challenge-shell")
    if signals["subscriptionShell"] and not signals.get("allowSubscriptionShell"):
        reasons.append("subscription-shell")
    if signals["redirectShell"]:
        reasons.append("redirect-shell")
    reasons.extend(source_rejection_reasons)
    return tuple(reasons)


def arquivo_pt_cdx_url(item: ManifestItem) -> str:
    return ARQUIVO_PT_CDX_ENDPOINT + "?" + urlencode(
        [
            ("url", item.canonical_url),
            ("output", "json"),
            ("filter", "status:200"),
            ("filter", "mime:text/html"),
            ("collapse", "digest"),
        ]
    )


def arquivo_pt_prefix_cdx_url(
    *,
    publisher: str,
    year: int,
    limit: int = 100_000,
) -> str:
    prefix_url = source_module(publisher).arquivo_pt_prefix_url
    if prefix_url is None:
        raise ValueError(f"unsupported Arquivo.pt prefix publisher: {publisher}")
    if year < 1900 or year > 2100:
        raise ValueError("year is outside the supported range")
    if limit < 1:
        raise ValueError("limit must be positive")
    return ARQUIVO_PT_CDX_ENDPOINT + "?" + urlencode(
        [
            ("url", prefix_url),
            ("output", "json"),
            ("filter", "status:200"),
            ("filter", "mime:text/html"),
            ("from", str(year)),
            ("to", str(year)),
            ("limit", str(limit)),
        ]
    )


def preindex_arquivo_pt_prefix_candidates(
    connection: sqlite3.Connection,
    *,
    publisher: str,
    year: int,
    rows: Iterable[dict[str, object]],
    maximum_candidates: int = ARQUIVO_PT_MAXIMUM_CANDIDATES,
) -> dict[str, int]:
    if source_module(publisher).arquivo_pt_prefix_url is None:
        raise ValueError(f"unsupported Arquivo.pt prefix publisher: {publisher}")
    if maximum_candidates < 1:
        raise ValueError("maximum_candidates must be positive")
    capture_rows = connection.execute(
        """
        SELECT canonical_url, published_at, candidates_json
        FROM captures
        WHERE publisher=?
          AND SUBSTR(COALESCE(published_at, ''), 1, 4)=?
          AND status IN ('pending', 'error', 'downloading')
        """,
        (publisher, str(year)),
    ).fetchall()
    targets = {
        _archive_url_match_key(str(canonical_url)): (
            str(canonical_url),
            str(published_at or ""),
            str(candidates_json),
        )
        for canonical_url, published_at, candidates_json in capture_rows
    }
    candidates_by_url: dict[str, list[CaptureCandidate]] = {}
    rows_read = 0
    rows_matched = 0
    for row in rows:
        rows_read += 1
        if not isinstance(row, dict):
            continue
        original = str(row.get("url") or row.get("original") or "").strip()
        target = targets.get(_archive_url_match_key(original))
        timestamp = str(row.get("timestamp") or "").strip()
        mime_type = str(
            row.get("mime") or row.get("mimetype") or ""
        ).strip()
        archived_status = str(
            row.get("status") or row.get("statuscode") or ""
        ).strip()
        if (
            target is None
            or not _same_article_url(original, target[0])
            or not re.fullmatch(r"\d{14}", timestamp)
            or not timestamp.startswith(str(year))
            or archived_status != "200"
            or mime_type.casefold() != "text/html"
        ):
            continue
        rows_matched += 1
        candidates_by_url.setdefault(target[0], []).append(
            CaptureCandidate(
                provider=CaptureProvider.ARQUIVO_PT,
                snapshot_url=(
                    f"{ARQUIVO_PT_REPLAY_ENDPOINT}/{timestamp}/{original}"
                ),
                captured_at=_wayback_datetime(timestamp),
                digest=_optional_string(row.get("digest")),
                mime_type=mime_type,
                status_code=200,
                byte_count=_optional_int(row.get("length")),
            )
        )

    updates: list[tuple[str, str, str]] = []
    selected_candidates = 0
    for canonical_url, candidates in candidates_by_url.items():
        _, published_at, candidates_json = targets[
            _archive_url_match_key(canonical_url)
        ]
        deduplicated: list[CaptureCandidate] = []
        seen: set[str] = set()
        for candidate in sorted(
            candidates,
            key=lambda value: _timemap_candidate_sort_key(
                value,
                published_at=published_at,
            ),
        ):
            key = candidate.digest or candidate.snapshot_url
            if key in seen:
                continue
            seen.add(key)
            deduplicated.append(candidate)
            if len(deduplicated) >= maximum_candidates:
                break
        try:
            parsed_existing = json.loads(candidates_json)
        except (TypeError, ValueError):
            parsed_existing = []
        if not isinstance(parsed_existing, list):
            parsed_existing = []
        existing = [
            value
            for value in parsed_existing
            if not (
                isinstance(value, dict)
                and value.get("provider") == CaptureProvider.ARQUIVO_PT.value
            )
        ]
        serialized = [
            candidate.model_dump(
                mode="json",
                by_alias=True,
                exclude_none=True,
            )
            for candidate in deduplicated
        ]
        selected_candidates += len(serialized)
        updates.append(
            (
                json.dumps(
                    [*serialized, *existing],
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                _now_iso(),
                canonical_url,
            )
        )
    with connection:
        connection.executemany(
            """
            UPDATE captures
            SET candidates_json=?, updated_at=?
            WHERE canonical_url=?
            """,
            updates,
        )
    return {
        "rowsRead": rows_read,
        "rowsMatched": rows_matched,
        "targetsMatched": len(candidates_by_url),
        "capturesUpdated": len(updates),
        "candidatesSelected": selected_candidates,
    }


def discover_arquivo_pt_candidates(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
    maximum_candidates: int = ARQUIVO_PT_MAXIMUM_CANDIDATES,
) -> tuple[CaptureCandidate, ...]:
    if maximum_candidates < 1:
        raise ValueError("maximum_candidates must be positive")
    query_url = arquivo_pt_cdx_url(item)
    status_code, headers, content, _ = _fetch_limited_archive(
        archive_client,
        query_url,
        maximum_bytes=ARQUIVO_PT_INDEX_MAXIMUM_BYTES,
        attempts=2,
        timeout=30.0,
    )
    if status_code == 404 or not content:
        return ()
    if status_code != 200:
        raise ValueError(f"Arquivo.pt CDX returned HTTP {status_code}")
    content_type = headers.get("content-type", "").casefold()
    if "json" not in content_type and not content.lstrip().startswith(b"{"):
        raise ValueError("Arquivo.pt CDX did not return NDJSON")

    candidates: list[CaptureCandidate] = []
    seen: set[str] = set()
    for line in content.splitlines():
        try:
            row = json.loads(line)
        except (TypeError, ValueError):
            continue
        if not isinstance(row, dict):
            continue
        original = str(row.get("url") or row.get("original") or "").strip()
        timestamp = str(row.get("timestamp") or "").strip()
        mime_type = str(
            row.get("mime") or row.get("mimetype") or ""
        ).strip()
        archived_status = str(
            row.get("status") or row.get("statuscode") or ""
        ).strip()
        if (
            not _same_article_url(original, item.canonical_url)
            or not re.fullmatch(r"\d{14}", timestamp)
            or archived_status != "200"
            or mime_type.casefold() != "text/html"
        ):
            continue
        digest = _optional_string(row.get("digest"))
        deduplication_key = digest or f"{timestamp}:{original}"
        if deduplication_key in seen:
            continue
        seen.add(deduplication_key)
        candidates.append(
            CaptureCandidate(
                provider=CaptureProvider.ARQUIVO_PT,
                snapshot_url=(
                    f"{ARQUIVO_PT_REPLAY_ENDPOINT}/{timestamp}/{original}"
                ),
                captured_at=_wayback_datetime(timestamp),
                digest=digest,
                mime_type=mime_type,
                status_code=200,
                byte_count=_optional_int(row.get("length")),
            )
        )
    candidates.sort(
        key=lambda candidate: _timemap_candidate_sort_key(
            candidate,
            published_at=item.published_at,
        )
    )
    return tuple(candidates[:maximum_candidates])


def discover_wayback_timemap_candidates(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
    maximum_candidates: int = WAYBACK_TIMEMAP_MAXIMUM_CANDIDATES,
    _include_companions: bool = True,
) -> tuple[CaptureCandidate, ...]:
    if maximum_candidates < 1:
        raise ValueError("maximum_candidates must be positive")
    companion_candidates: tuple[CaptureCandidate, ...] | None = None
    companion_items: tuple[ManifestItem, ...] = ()
    companion_hook = capture_hooks(item.publisher).timemap_companion_urls
    if _include_companions and companion_hook is not None:
        companion_items = tuple(
            ManifestItem(
                publisher=item.publisher,
                canonical_url=url,
                published_at=item.published_at,
                section=item.section,
                candidates=(),
            )
            for url in companion_hook(item.canonical_url)
            if url != item.canonical_url
        )

    def fallback_companion_candidates() -> tuple[CaptureCandidate, ...]:
        nonlocal companion_candidates
        if companion_candidates is not None:
            return companion_candidates
        collected: list[CaptureCandidate] = []
        for companion_item in companion_items:
            try:
                collected.extend(
                    discover_wayback_timemap_candidates(
                        companion_item,
                        archive_client=archive_client,
                        maximum_candidates=maximum_candidates,
                        _include_companions=False,
                    )
                )
            except Exception:
                continue
        companion_candidates = tuple(collected[:maximum_candidates])
        return companion_candidates
    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?" + urlencode(
        {"url": item.canonical_url}
    )
    try:
        configured_attempts = int(archive_client.attempts)
    except AttributeError:
        configured_attempts = 2
    try:
        configured_timeout = float(archive_client.timeout)
    except AttributeError:
        configured_timeout = 35.0
    status_code, headers, content, _ = _fetch_limited_archive(
        archive_client,
        timemap_url,
        maximum_bytes=WAYBACK_TIMEMAP_MAXIMUM_BYTES,
        # Respect the batch-level bounds. The old fixed 2 x 35 second policy
        # made one missing Timemap occupy a worker for up to 70 seconds even
        # when the caller explicitly selected a short, single-attempt probe.
        attempts=min(
            2,
            max(1, configured_attempts),
        ),
        timeout=min(
            35.0,
            max(0.1, configured_timeout),
        ),
    )
    content_type = headers.get("content-type", "").casefold()
    if status_code != 200 or not content:
        companions = fallback_companion_candidates()
        if companions:
            return companions[:maximum_candidates]
        raise ValueError(f"Wayback timemap returned HTTP {status_code}")
    if "json" not in content_type and not content.lstrip().startswith(b"["):
        companions = fallback_companion_candidates()
        if companions:
            return companions[:maximum_candidates]
        raise ValueError("Wayback timemap did not return JSON")
    payload = json.loads(content)
    if not isinstance(payload, list) or not payload:
        companions = fallback_companion_candidates()
        if companions:
            return companions[:maximum_candidates]
        return ()
    header = payload[0]
    if not isinstance(header, list):
        companions = fallback_companion_candidates()
        if companions:
            return companions[:maximum_candidates]
        raise ValueError("Wayback timemap header is invalid")
    columns = {str(value).casefold(): index for index, value in enumerate(header)}
    required = {"timestamp", "original", "mimetype", "statuscode"}
    if not required.issubset(columns):
        companions = fallback_companion_candidates()
        if companions:
            return companions[:maximum_candidates]
        raise ValueError("Wayback timemap is missing required columns")

    candidates: list[CaptureCandidate] = []
    seen: set[str] = set()
    for row in payload[1:]:
        if not isinstance(row, list):
            continue
        timestamp = _timemap_value(row, columns, "timestamp")
        original = _timemap_value(row, columns, "original")
        mime_type = _timemap_value(row, columns, "mimetype")
        status = _optional_int(_timemap_value(row, columns, "statuscode"))
        if (
            _wayback_datetime(timestamp) is None
            or status != 200
            or mime_type.casefold() != "text/html"
            or not _same_article_url(
                original,
                item.canonical_url,
            )
        ):
            continue
        digest = _optional_string(_timemap_value(row, columns, "digest"))
        deduplication_key = digest or f"{timestamp}:{original}"
        if deduplication_key in seen:
            continue
        seen.add(deduplication_key)
        candidates.append(
            CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=(
                    f"https://web.archive.org/web/{timestamp}id_/{original}"
                ),
                captured_at=_wayback_datetime(timestamp),
                digest=digest,
                mime_type=mime_type,
                status_code=status,
                byte_count=_optional_int(
                    _timemap_value(row, columns, "length")
                ),
            )
        )

    companions = fallback_companion_candidates() if not candidates else ()
    seen_urls = {candidate.snapshot_url for candidate in candidates}
    for candidate in companions:
        if candidate.snapshot_url not in seen_urls:
            candidates.append(candidate)
            seen_urls.add(candidate.snapshot_url)

    candidates.sort(
        key=lambda candidate: _timemap_candidate_sort_key(
            candidate,
            published_at=item.published_at,
        )
    )
    selection_hook = capture_hooks(item.publisher).select_timemap_candidates
    if selection_hook is None:
        return tuple(candidates[:maximum_candidates])
    return selection_hook(
        tuple(candidates),
        maximum_candidates=maximum_candidates,
        published_at=item.published_at,
    )


def _largest_distinct_timemap_candidates(
    candidates: tuple[CaptureCandidate, ...],
    *,
    maximum_candidates: int,
    published_at: str | None,
) -> tuple[CaptureCandidate, ...]:
    """Balance large digests with publication-near rows in a bounded set."""

    largest = sorted(
        candidates,
        key=lambda candidate: (
            candidate.byte_count is None,
            -(candidate.byte_count or 0),
            _timemap_candidate_sort_key(
                candidate,
                published_at=published_at,
            ),
        ),
    )
    selected: list[CaptureCandidate] = []
    seen_urls: set[str] = set()

    def append(candidate: CaptureCandidate) -> None:
        if (
            candidate.snapshot_url not in seen_urls
            and len(selected) < maximum_candidates
        ):
            seen_urls.add(candidate.snapshot_url)
            selected.append(candidate)

    largest_slots = max(1, maximum_candidates // 2)
    for candidate in largest[:largest_slots]:
        append(candidate)
    for candidate in candidates:
        append(candidate)
    for candidate in largest:
        append(candidate)
    return tuple(selected)


























def _headline_slug(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    ascii_value = normalized.encode("ascii", errors="ignore").decode()
    return re.sub(
        r"[^a-z0-9]+",
        "-",
        ascii_value.casefold(),
    ).strip("-")


def _syndication_search_url(
    item: ManifestItem,
    *,
    publisher_label: str,
) -> str:
    parsed = urlsplit(item.canonical_url)
    slug = parsed.path.rstrip("/").rsplit("/", 1)[-1]
    slug_hook = capture_hooks(item.publisher).syndication_search_slug
    if slug_hook is not None:
        slug = slug_hook(slug)
    words = " ".join(part for part in slug.split("-") if part)
    query = f"{words} {publisher_label}"
    return SYNDICATION_SEARCH_ENDPOINT + "?" + urlencode({"p": query})








def _meta_tag_content(
    soup: BeautifulSoup,
    attribute: str,
    value: str,
) -> str | None:
    node = soup.select_one(f'meta[{attribute}="{value}"]')
    content = node.get("content") if node is not None else None
    return content.strip() if isinstance(content, str) and content.strip() else None


def _walk_json_dicts(value: object) -> Iterable[dict[str, object]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk_json_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_json_dicts(child)


def _decode_duckduckgo_search_result(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    absolute = (
        "https:" + value
        if value.startswith("//")
        else value
    )
    parsed = urlsplit(absolute)
    query = parse_qs(parsed.query)
    candidate_url = query.get("uddg", [absolute])[0]
    candidate = urlsplit(candidate_url)
    if candidate.scheme not in {"http", "https"} or not candidate.netloc:
        return None
    return candidate_url
































def _yahoo_search_results(
    soup: BeautifulSoup,
    *,
    clean_title: Callable[[str], str] | None = None,
) -> list[tuple[int, str, str]]:
    results: list[tuple[int, str, str]] = []
    for position, result in enumerate(soup.select("#web li")):
        anchor = (
            result.select_one(".compTitle > a")
            or result.select_one("h3 a")
            or result.select_one("a")
        )
        heading = result.select_one("h3")
        if anchor is None or heading is None:
            continue
        candidate_url = _decode_yahoo_search_result(anchor.get("href"))
        if candidate_url is None:
            continue
        raw_title = heading.get_text(" ", strip=True)
        result_title = clean_title(raw_title) if clean_title is not None else raw_title
        results.append((position, result_title, candidate_url))
    return results


def _discover_syndication_candidates(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
    search_url: str,
    excluded_publisher: str,
) -> tuple[CaptureCandidate, ...]:
    results = _fetch_syndication_search_results(
        item,
        archive_client=archive_client,
        search_url=search_url,
    )
    return _rank_syndication_candidates(
        results,
        excluded_publisher=excluded_publisher,
    )


def _fetch_syndication_search_results(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
    search_url: str,
) -> list[tuple[int, str, str]]:
    status_code, headers, content, _ = archive_client.fetch(
        search_url,
        maximum_bytes=SYNDICATION_SEARCH_MAXIMUM_BYTES,
    )
    content_type = headers.get("content-type", "").casefold()
    if status_code != 200 or not content:
        raise ValueError(
            f"{item.publisher} syndication search returned HTTP {status_code}"
        )
    if "html" not in content_type and b"<html" not in content[:1_000].lower():
        raise ValueError(
            f"{item.publisher} syndication search did not return HTML"
        )

    soup = BeautifulSoup(content, "html.parser")
    results: list[tuple[int, str, str]] = []
    for position, result in enumerate(soup.select("#web li")):
        anchor = result.select_one("h3 a") or result.select_one("a")
        heading = result.select_one("h3")
        if anchor is None:
            continue
        candidate_url = _decode_yahoo_search_result(anchor.get("href"))
        if candidate_url is None:
            continue
        cleaner = (
            capture_hooks(item.publisher).clean_syndication_search_title
            or _clean_syndication_search_title
        )
        title = (
            cleaner(heading.get_text(" ", strip=True))
            if heading is not None
            else ""
        )
        results.append((position, title, candidate_url))
    return results


def _rank_syndication_candidates(
    results: Iterable[tuple[int, str, str]],
    *,
    excluded_publisher: str,
    expected_headline: str | None = None,
) -> tuple[CaptureCandidate, ...]:
    ranked: list[tuple[float, int, int, str]] = []
    source_capture = capture_hooks(excluded_publisher)
    normalize_url = source_capture.normalize_syndication_candidate_url or (lambda value: value)
    url_priority = source_capture.syndication_candidate_priority or (lambda value: 0)
    maximum_candidates = source_capture.syndication_maximum_candidates
    seen: set[str] = set()
    for position, result_title, candidate_url in results:
        candidate_url = normalize_url(candidate_url)
        if (
            candidate_url in seen
            or not _is_public_syndication_url(
                candidate_url,
                excluded_publisher=excluded_publisher,
            )
        ):
            continue
        headline_overlap = (
            _headline_text_overlap(expected_headline, result_title)
            if expected_headline and result_title
            else 0.0
        )
        if expected_headline and headline_overlap < 0.35:
            continue
        seen.add(candidate_url)
        ranked.append(
            (
                -headline_overlap,
                url_priority(candidate_url),
                position,
                candidate_url,
            )
        )
    ranked.sort()
    return tuple(
        CaptureCandidate(
            provider=CaptureProvider.OTHER,
            snapshot_url=candidate_url,
            expected_headline=expected_headline,
        )
        for _, _, _, candidate_url in ranked[:maximum_candidates]
    )








def _is_archive_today_candidate_url(value: str) -> bool:
    parsed = urlsplit(value)
    return bool(
        parsed.scheme == "https"
        and (parsed.hostname or "").casefold()
        in {
            "archive.is",
            "archive.md",
            "archive.ph",
            "archive.today",
            "archive.vn",
        }
        and parsed.path not in {"", "/"}
    )


def _clean_syndication_search_title(value: str) -> str:
    return re.sub(r"\s*(?:…|\.\.\.)\s*$", "", value.strip()).strip()


def _decode_yahoo_search_result(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    match = re.search(r"/RU=([^/]+)/RK=", value)
    candidate_url = unquote(match.group(1)) if match else value
    parsed = urlsplit(candidate_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return candidate_url




def _html_links_to_article(html_value: str, canonical_url: str) -> bool:
    soup = BeautifulSoup(html_value, "html.parser")
    return any(
        _same_article_url(href, canonical_url)
        for anchor in soup.select("a[href]")
        if isinstance(href := anchor.get("href"), str)
    )


def _is_public_syndication_url(
    value: str,
    *,
    excluded_publisher: str,
) -> bool:
    parsed = urlsplit(value)
    host = (parsed.hostname or "").casefold().rstrip(".")
    if (
        parsed.scheme not in {"http", "https"}
        or not host
        or parsed.username
        or parsed.password
    ):
        return False
    try:
        if parsed.port not in {None, 80, 443}:
            return False
    except ValueError:
        return False
    if host == "localhost" or host.endswith(".localhost"):
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        return False
    source = source_module(excluded_publisher)
    excluded_domains = {
        source.archive_spec.canonical_host.casefold().removeprefix("www."),
        *(domain.casefold().removeprefix("www.") for domain in source.archive_spec.alternate_hosts),
        *(domain.casefold().removeprefix("www.") for domain in source.parser_spec.domains),
    }
    if any(host == domain or host.endswith("." + domain) for domain in excluded_domains):
        return False
    if (
        host in {"search.yahoo.com", "www.google.com", "www.bing.com"}
        or host.startswith("video.search.")
        or parsed.path.startswith(("/search", "/search/"))
    ):
        return False
    return True










def _short_parsed_paywall_shell(
    *,
    body_characters: int,
    plain_text: str,
) -> bool:
    prefix = plain_text[:1_500].casefold()
    return bool(
        body_characters < _PARSED_PAYWALL_MAXIMUM_BODY_CHARACTERS
        and any(phrase in prefix for phrase in _PARSED_PAYWALL_PHRASES)
    )






















def _syndication_headline_overlap(
    canonical_url: str,
    headline: str,
    *,
    strip_iso_date_suffix: bool = False,
) -> float:
    slug = urlsplit(canonical_url).path.rstrip("/").rsplit("/", 1)[-1]
    if strip_iso_date_suffix:
        slug = re.sub(r"-20\d{2}-\d{2}-\d{2}$", "", slug)
    slug_tokens = _significant_tokens(slug.replace("-", " "))
    headline_tokens = _significant_tokens(headline)
    if not slug_tokens or not headline_tokens:
        return 0.0
    return len(slug_tokens & headline_tokens) / min(
        len(slug_tokens),
        len(headline_tokens),
    )


def _headline_text_overlap(first: str, second: str) -> float:
    first_tokens = _significant_tokens(first)
    second_tokens = _significant_tokens(second)
    if not first_tokens or not second_tokens:
        return 0.0
    return len(first_tokens & second_tokens) / min(
        len(first_tokens),
        len(second_tokens),
    )


def _expected_date_visible(
    content: bytes,
    *,
    expected_date: datetime | None,
) -> bool:
    if expected_date is None:
        return False
    text = BeautifulSoup(content, "html.parser").get_text(" ", strip=True)
    raw = content.decode("utf-8", errors="ignore")
    month = expected_date.strftime("%B")
    abbreviated_month = expected_date.strftime("%b")
    values = (
        expected_date.strftime("%Y-%m-%d"),
        f"{month} {expected_date.day}, {expected_date.year}",
        f"{abbreviated_month} {expected_date.day}, {expected_date.year}",
        f"{expected_date.day} {month} {expected_date.year}",
        f"{expected_date.day} {abbreviated_month} {expected_date.year}",
    )
    haystack = raw.casefold() + "\n" + text.casefold()
    return any(value.casefold() in haystack for value in values)


def _nearest_visible_date_delta_days(
    visible_text: str,
    *,
    expected_date: datetime | None,
) -> int | None:
    if expected_date is None:
        return None
    patterns = (
        (r"\b20\d{2}-\d{2}-\d{2}\b", "%Y-%m-%d"),
        (
            r"\b(?:January|February|March|April|May|June|July|August|"
            r"September|October|November|December)\s+\d{1,2},?\s+"
            r"20\d{2}\b",
            "%B %d %Y",
        ),
        (
            r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
            r"\.?\s+\d{1,2},?\s+20\d{2}\b",
            "%b %d %Y",
        ),
        (
            r"\b\d{1,2}\s+(?:January|February|March|April|May|June|"
            r"July|August|September|October|November|December)\s+"
            r"20\d{2}\b",
            "%d %B %Y",
        ),
        (
            r"\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|"
            r"Oct|Nov|Dec)\.?\s+20\d{2}\b",
            "%d %b %Y",
        ),
    )
    deltas: list[int] = []
    date_text = visible_text[:4_000]
    for pattern, date_format in patterns:
        for match in re.finditer(pattern, date_text, flags=re.IGNORECASE):
            normalized = re.sub(
                r"(?<=\b[A-Za-z]{3})\.",
                "",
                match.group(0),
            ).replace(",", "")
            try:
                parsed = datetime.strptime(normalized, date_format)
            except ValueError:
                continue
            deltas.append(
                abs((parsed.date() - expected_date.date()).days)
            )
    return min(deltas) if deltas else None


def _significant_tokens(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", value.casefold())
        if token not in _SYNDICATION_STOP_WORDS
    }


def _timemap_value(
    row: list[object],
    columns: dict[str, int],
    name: str,
) -> str:
    index = columns.get(name)
    if index is None or index >= len(row):
        return ""
    return str(row[index]).strip()


def _fetch_limited_archive(
    archive_client: ArchiveClient,
    url: str,
    *,
    maximum_bytes: int,
    attempts: int,
    timeout: float,
) -> tuple[int, dict[str, str], bytes, str]:
    try:
        return archive_client.fetch_limited(
            url,
            maximum_bytes=maximum_bytes,
            attempts=attempts,
            timeout=timeout,
        )
    except AttributeError:
        return archive_client.fetch(
            url,
            maximum_bytes=maximum_bytes,
        )


def _same_article_url(first: str, second: str) -> bool:
    first_key = _archive_url_match_key(first)
    second_key = _archive_url_match_key(second)
    return bool(first_key[0]) and first_key == second_key


def _archive_url_match_key(value: str) -> tuple[str, str]:
    parts = urlsplit(value)
    host = (parts.hostname or "").casefold().removeprefix("www.")
    normalized_path = parts.path.rstrip("/")
    for source in registered_sources():
        domains = {
            domain.casefold().removeprefix("www.")
            for domain in source.parser_spec.domains
        }
        domains.add(source.archive_spec.canonical_host.casefold().removeprefix("www."))
        if host not in domains:
            continue
        hook = capture_hooks(source.id).archive_match_path
        if hook is not None:
            normalized_path = hook(host, normalized_path)
        break
    return host, normalized_path


def _wayback_snapshot_original_url(value: str) -> str | None:
    parts = urlsplit(value)
    if (parts.hostname or "").casefold() != "web.archive.org":
        return None
    match = re.match(
        r"^/web/\d{1,14}(?:[a-z_]+)?/(https?://.+)$",
        parts.path,
        flags=re.IGNORECASE,
    )
    if match is None:
        return None
    original = match.group(1)
    if parts.query:
        original += "?" + parts.query
    return original


def _common_crawl_discovery_urls(item: ManifestItem) -> tuple[str, ...]:
    hook = capture_hooks(item.publisher).archive_discovery_urls
    if hook is None:
        return (item.canonical_url,)
    return tuple(dict.fromkeys(hook(item.canonical_url)))










def _arquivo_pt_replay_matches(
    replay_url: str,
    canonical_url: str,
) -> bool:
    parsed = urlsplit(unquote(replay_url))
    host = (parsed.hostname or "").casefold().removeprefix("www.")
    marker = "/noFrame/replay/"
    if host != "arquivo.pt" or marker not in parsed.path:
        return False
    remainder = parsed.path.split(marker, 1)[1]
    _, separator, target_url = remainder.partition("/")
    return bool(
        separator
        and target_url.startswith(("http://", "https://"))
        and _same_article_url(target_url, canonical_url)
    )


def _timemap_candidate_sort_key(
    candidate: CaptureCandidate,
    *,
    published_at: str | None,
) -> tuple[float, str]:
    timestamp = candidate.captured_at
    if timestamp is None:
        return (float("inf"), candidate.snapshot_url)
    published = _parse_iso_datetime(published_at)
    if published is None:
        return (timestamp.timestamp(), candidate.snapshot_url)
    return (
        abs((timestamp - published).total_seconds()),
        candidate.snapshot_url,
    )


def _common_crawl_first_candidate_sort_key(
    candidate: CaptureCandidate,
    *,
    published_at: str | None,
) -> tuple[bool, bool, int, tuple[float, str]]:
    """Prefer larger Common Crawl records before metered Wayback shells."""
    return (
        candidate.provider != CaptureProvider.COMMON_CRAWL,
        candidate.byte_count is None,
        -(candidate.byte_count or 0),
        _timemap_candidate_sort_key(
            candidate,
            published_at=published_at,
        ),
    )






def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


# Compatibility aliases for legacy callers of ``capture.raw``. New vertical
# source modules import the public names from ``capture.primitives`` directly;
# the shared engine follows the same implementations to prevent policy drift.
discover_wayback_timemap_candidates = (
    capture_primitives.discover_wayback_timemap_candidates
)
_largest_distinct_timemap_candidates = (
    capture_primitives.largest_distinct_timemap_candidates
)
_headline_slug = capture_primitives.headline_slug
_syndication_search_url = capture_primitives.syndication_search_url
_meta_tag_content = capture_primitives.meta_tag_content
_walk_json_dicts = capture_primitives.walk_json_dicts
_decode_duckduckgo_search_result = (
    capture_primitives.decode_duckduckgo_search_result
)
_yahoo_search_results = capture_primitives.yahoo_search_results
_discover_syndication_candidates = capture_primitives.discover_syndication_candidates
_fetch_syndication_search_results = (
    capture_primitives.fetch_syndication_search_results
)
_rank_syndication_candidates = capture_primitives.rank_syndication_candidates
_is_archive_today_candidate_url = capture_primitives.is_archive_today_candidate_url
_clean_syndication_search_title = capture_primitives.clean_syndication_search_title
_html_links_to_article = capture_primitives.html_links_to_article
_is_public_syndication_url = capture_primitives.is_public_syndication_url
_short_parsed_paywall_shell = capture_primitives.short_parsed_paywall_shell
_syndication_headline_overlap = capture_primitives.syndication_headline_overlap
_headline_text_overlap = capture_primitives.headline_text_overlap
_expected_date_visible = capture_primitives.expected_date_visible
_nearest_visible_date_delta_days = capture_primitives.nearest_visible_date_delta_days
_significant_tokens = capture_primitives.significant_tokens
_fetch_limited_archive = capture_primitives.fetch_limited_archive
_same_article_url = capture_primitives.same_article_url
_archive_url_match_key = capture_primitives.archive_url_match_key
_common_crawl_discovery_urls = capture_primitives.common_crawl_discovery_urls
_timemap_candidate_sort_key = capture_primitives.timemap_candidate_sort_key
_common_crawl_first_candidate_sort_key = (
    capture_primitives.common_crawl_first_candidate_sort_key
)
_parse_iso_datetime = capture_primitives.parse_iso_datetime


def resolved_capture_candidate(
    candidate: CaptureCandidate,
    *,
    final_url: str,
    http_status: int,
    content_type: str,
    byte_count: int,
) -> CaptureCandidate:
    updates: dict[str, object] = {
        "status_code": http_status,
        "mime_type": content_type or candidate.mime_type,
        "byte_count": byte_count,
    }
    if candidate.provider == CaptureProvider.WAYBACK:
        match = _WAYBACK_FINAL_RE.search(final_url)
        if match:
            updates["snapshot_url"] = final_url
            updates["captured_at"] = _wayback_datetime(match.group(1))
    return candidate.model_copy(update=updates)




def _decode_archived_html_content(
    content: bytes,
    *,
    headers: dict[str, str],
    maximum_bytes: int,
) -> tuple[bytes, dict[str, object]]:
    content_type = headers.get("content-type", "").casefold()
    content_encoding = headers.get("content-encoding", "").casefold().strip()
    looks_like_html = any(
        marker in content[:4096].lower() for marker in _HTML_MARKERS
    )
    should_try_brotli = content_encoding == "br" or (
        "html" in content_type and content and not looks_like_html
    )
    if not should_try_brotli:
        return content, {}
    try:
        decoded = brotli.decompress(content)
    except brotli.error:
        return content, {}
    if len(decoded) > maximum_bytes:
        raise ValueError("decoded response exceeds maximum bytes")
    if not any(marker in decoded[:4096].lower() for marker in _HTML_MARKERS):
        return content, {}
    return decoded, {
        "archivedContentEncodingDecoded": "br",
        "archivedEncodedBytes": len(content),
        "archivedDecodedBytes": len(decoded),
    }






















def score_raw_capture(
    content: bytes,
    *,
    http_status: int,
    content_type: str,
    final_url: str = "",
    publisher: str | None = None,
) -> tuple[int, dict[str, object]]:
    sampled_content = (
        content
        if len(content) <= 2_000_000
        else content[:1_000_000] + content[-1_000_000:]
    )
    prefix = sampled_content.lower()
    looks_like_html = (
        "html" in content_type.casefold()
        or any(marker in prefix for marker in _HTML_MARKERS)
    )
    archive_error_page = any(marker in prefix for marker in _ARCHIVE_ERROR_MARKERS)
    server_placeholder_shell = bool(
        len(content) <= _SERVER_PLACEHOLDER_MAXIMUM_BYTES
        and any(marker in prefix for marker in _SERVER_PLACEHOLDER_MARKERS)
    )
    has_article_marker = b"<article" in prefix or b"newsarticle" in prefix
    final_url_lower = final_url.casefold()
    decoded_final_url = unquote(final_url_lower)
    authentication_shell = (
        not has_article_marker
        and (
            any(marker in prefix for marker in _AUTH_SHELL_MARKERS)
            or "/auth/login" in final_url_lower
            or "/auth/enter-email" in final_url_lower
            or "/account/login" in final_url_lower
            or "/glogin" in final_url_lower
            or "/signin" in final_url_lower
            or "/sign-in" in final_url_lower
            or (
                "/regauth2/" in decoded_final_url
                and "login.html" in decoded_final_url
            )
        )
    )
    access_challenge_shell = (
        not has_article_marker
        and (
            any(marker in prefix for marker in _ACCESS_CHALLENGE_MARKERS)
            or "/access-error/" in final_url_lower
            or "/tosv2.html" in final_url_lower
        )
    )
    has_strong_body_marker = (
        b'"articlebody"' in prefix
        or any(marker in prefix for marker in _ARTICLE_BODY_MARKERS)
    )
    source_signals: dict[str, object] = {}
    source_penalty = False
    source_modules = (
        (capture_hooks(publisher),)
        if publisher is not None
        else tuple(capture_hooks(source.id) for source in registered_sources())
    )
    for source_capture in source_modules:
        hook = source_capture.raw_shell_signals
        if hook is None:
            continue
        additions = dict(
            hook(
                sampled_content=sampled_content,
                prefix=prefix,
                final_url=final_url,
                has_article_marker=has_article_marker,
                has_strong_body_marker=has_strong_body_marker,
            )
        )
        source_penalty = source_penalty or bool(additions.pop("penalize", False))
        for aggregate_key in (
            "authenticationShell",
            "subscriptionShell",
            "redirectShell",
        ):
            if aggregate_key in additions:
                additions[aggregate_key] = bool(
                    additions[aggregate_key]
                    or source_signals.get(aggregate_key)
                )
        source_signals.update(additions)
    authentication_shell = bool(
        authentication_shell or source_signals.get("authenticationShell")
    )
    subscription_shell = bool(
        source_signals.get("subscriptionShell")
        or (
            not has_strong_body_marker
            and any(marker in prefix for marker in _SUBSCRIPTION_SHELL_MARKERS)
        )
    )
    redirect_shell = bool(
        source_signals.get("redirectShell")
        or (
            not has_strong_body_marker
            and any(marker in prefix for marker in _REDIRECT_SHELL_MARKERS)
        )
    )
    substantial = len(content) >= 2_048
    tiny_html_shell = bool(
        looks_like_html
        and len(content) < 512
        and not has_article_marker
        and not has_strong_body_marker
    )
    score = 0
    if http_status in ACCEPTED_HTTP_STATUSES:
        score += 35
    if looks_like_html:
        score += 25
    if substantial:
        score += 15
    if has_article_marker:
        score += 15
    if not archive_error_page:
        score += 10
    if (
        authentication_shell
        or access_challenge_shell
        or subscription_shell
        or redirect_shell
        or source_penalty
        or server_placeholder_shell
        or tiny_html_shell
    ):
        score = max(0, score - 60)
    return score, source_signals | {
        "looksLikeHtml": looks_like_html,
        "archiveErrorPage": archive_error_page,
        "serverPlaceholderShell": server_placeholder_shell,
        "tinyHtmlShell": tiny_html_shell,
        "hasArticleMarker": has_article_marker,
        "hasStrongBodyMarker": has_strong_body_marker,
        "authenticationShell": authentication_shell,
        "accessChallengeShell": access_challenge_shell,
        "subscriptionShell": subscription_shell,
        "redirectShell": redirect_shell,
        "substantialResponse": substantial,
        "rawBytes": len(content),
    }




def store_raw_html(output_dir: Path, content: bytes) -> BlobReference:
    digest = hashlib.sha256(content).hexdigest()
    relative = Path("objects") / "html" / digest[:2] / f"{digest}.html.gz"
    destination = output_dir / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    compressed = gzip.compress(content, compresslevel=9, mtime=0)
    if destination.exists():
        if destination.read_bytes() != compressed:
            raise RuntimeError(f"content-addressed object collision: {relative}")
    else:
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_bytes(compressed)
        temporary.replace(destination)
    return BlobReference(
        path=relative.as_posix(),
        sha256=digest,
        byte_count=len(content),
        stored_byte_count=len(compressed),
        content_encoding="gzip",
    )


def store_dependent_resource(
    output_dir: Path,
    content: bytes,
) -> BlobReference:
    digest = hashlib.sha256(content).hexdigest()
    relative = (
        Path("objects") / "resources" / digest[:2] / f"{digest}.bin.gz"
    )
    destination = output_dir / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    compressed = gzip.compress(content, compresslevel=9, mtime=0)
    if destination.exists():
        if destination.read_bytes() != compressed:
            raise RuntimeError(f"content-addressed object collision: {relative}")
    else:
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_bytes(compressed)
        temporary.replace(destination)
    return BlobReference(
        path=relative.as_posix(),
        sha256=digest,
        byte_count=len(content),
        stored_byte_count=len(compressed),
        content_encoding="gzip",
    )




def store_capture_record(output_dir: Path, capture: RawCapture) -> str:
    article_hash = capture.article_id.rsplit(":", 1)[-1]
    relative = Path("records") / article_hash[:2] / f"{article_hash}.json"
    destination = output_dir / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = (
        capture.model_dump_json(
            by_alias=True,
            exclude_none=True,
            indent=2,
        )
        + "\n"
    ).encode("utf-8")
    if destination.exists() and destination.read_bytes() != payload:
        raise RuntimeError(f"capture record changed after completion: {relative}")
    if not destination.exists():
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_bytes(payload)
        temporary.replace(destination)
    return relative.as_posix()


def reusable_capture_record(
    output_dir: Path,
    proposed: RawCapture,
) -> tuple[RawCapture, str] | None:
    """Reuse an orphaned immutable record when it is at least as good.

    A capture database can be rebuilt independently from the content-addressed
    object store. In that case the record may still exist even though the
    database row no longer points to it. Re-fetching the same article changes
    retrieval metadata and must not turn that recoverable state into an error.
    """
    article_hash = proposed.article_id.rsplit(":", 1)[-1]
    relative = Path("records") / article_hash[:2] / f"{article_hash}.json"
    source = output_dir / relative
    if not source.exists():
        return None
    existing = RawCapture.model_validate_json(source.read_text(encoding="utf-8"))
    if (
        existing.article_id != proposed.article_id
        or existing.publisher != proposed.publisher
        or existing.canonical_url != proposed.canonical_url
    ):
        raise RuntimeError(
            f"capture record identity mismatch: {relative}"
        )
    _read_capture_html(existing, archive_root=output_dir)
    if existing.quality_score < proposed.quality_score:
        return None
    return existing, relative.as_posix()


def record_capture_result(
    connection: sqlite3.Connection,
    result: dict,
) -> None:
    capture: RawCapture | None = result.get("capture")
    values = {
        "status": result["status"],
        "selected_candidate_json": None,
        "final_url": None,
        "http_status": None,
        "content_type": None,
        "quality_score": None,
        "quality_signals_json": None,
        "dependent_resources_json": None,
        "raw_path": None,
        "raw_sha256": None,
        "raw_bytes": None,
        "stored_bytes": None,
        "record_path": result.get("recordPath"),
        "last_error": result.get("error"),
        "retrieved_at": None,
    }
    if capture:
        values.update(
            {
                "selected_candidate_json": capture.selected_candidate.model_dump_json(
                    by_alias=True,
                    exclude_none=True,
                ),
                "final_url": capture.final_url,
                "http_status": capture.http_status,
                "content_type": capture.content_type,
                "quality_score": capture.quality_score,
                "quality_signals_json": json.dumps(
                    capture.quality_signals,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                "dependent_resources_json": json.dumps(
                    [
                        resource.model_dump(
                            mode="json",
                            by_alias=True,
                            exclude_none=True,
                        )
                        for resource in capture.dependent_resources
                    ],
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                "raw_path": capture.raw_html.path,
                "raw_sha256": capture.raw_html.sha256,
                "raw_bytes": capture.raw_html.byte_count,
                "stored_bytes": capture.raw_html.stored_byte_count,
                "retrieved_at": capture.retrieved_at.isoformat(),
            }
        )
    with connection:
        connection.execute(
            """
            UPDATE captures SET
                status=:status,
                selected_candidate_json=:selected_candidate_json,
                final_url=:final_url,
                http_status=:http_status,
                content_type=:content_type,
                quality_score=:quality_score,
                quality_signals_json=:quality_signals_json,
                dependent_resources_json=:dependent_resources_json,
                raw_path=:raw_path,
                raw_sha256=:raw_sha256,
                raw_bytes=:raw_bytes,
                stored_bytes=:stored_bytes,
                record_path=:record_path,
                last_error=:last_error,
                retrieved_at=:retrieved_at,
                updated_at=:updated_at
            WHERE canonical_url=:canonical_url
              AND NOT (
                status='complete'
                AND :status!='complete'
              )
            """,
            {
                **values,
                "canonical_url": result["canonicalUrl"],
                "updated_at": _now_iso(),
            },
        )


def completed_raw_capture(
    connection: sqlite3.Connection,
    *,
    canonical_url: str,
) -> RawCapture:
    capture_columns = {
        str(column[1])
        for column in connection.execute("PRAGMA table_info(captures)")
    }
    dependent_resources_expression = (
        "dependent_resources_json"
        if "dependent_resources_json" in capture_columns
        else "NULL AS dependent_resources_json"
    )
    row = connection.execute(
        f"""
        SELECT
            article_id,
            publisher,
            canonical_url,
            published_at,
            section,
            selected_candidate_json,
            candidates_json,
            retrieved_at,
            final_url,
            http_status,
            content_type,
            quality_score,
            quality_signals_json,
            {dependent_resources_expression},
            raw_path,
            raw_sha256,
            raw_bytes,
            stored_bytes
        FROM captures
        WHERE canonical_url=? AND status='complete'
        """,
        (canonical_url,),
    ).fetchone()
    if row is None:
        raise ValueError(
            f"completed capture not found for {canonical_url}"
        )
    required = {
        "selected_candidate_json": row[5],
        "retrieved_at": row[7],
        "final_url": row[8],
        "http_status": row[9],
        "content_type": row[10],
        "quality_score": row[11],
        "raw_path": row[14],
        "raw_sha256": row[15],
        "raw_bytes": row[16],
        "stored_bytes": row[17],
    }
    missing = [name for name, value in required.items() if value is None]
    if missing:
        raise ValueError(
            "completed capture is missing state fields: "
            + ", ".join(missing)
        )
    return RawCapture(
        article_id=str(row[0]),
        publisher=str(row[1]),
        canonical_url=str(row[2]),
        published_at=row[3],
        section=row[4],
        selected_candidate=CaptureCandidate.model_validate_json(
            str(row[5])
        ),
        candidates_considered=[
            CaptureCandidate.model_validate(candidate)
            for candidate in json.loads(str(row[6]))
        ],
        retrieved_at=str(row[7]),
        final_url=str(row[8]),
        http_status=int(row[9]),
        content_type=str(row[10]),
        quality_score=int(row[11]),
        quality_signals=(
            json.loads(str(row[12])) if row[12] is not None else {}
        ),
        raw_html=BlobReference(
            path=str(row[14]),
            sha256=str(row[15]),
            byte_count=int(row[16]),
            stored_byte_count=int(row[17]),
            content_encoding="gzip",
        ),
        dependent_resources=[
            DependentResource.model_validate(resource)
            for resource in (
                json.loads(str(row[13])) if row[13] is not None else []
            )
        ],
    )


def completed_capture_rejection_reason(
    capture: RawCapture,
    *,
    archive_root: Path,
) -> str | None:
    content = _read_capture_html(capture, archive_root=archive_root)
    source_capture = capture_hooks(capture.publisher)
    target_hook = source_capture.candidate_target_rejection
    if target_hook is not None:
        target_rejection = target_hook(
            capture.selected_candidate,
            canonical_url=capture.canonical_url,
            final_url=capture.final_url,
        )
        if target_rejection is not None:
            completed_target_hook = source_capture.completed_rejection_reason
            if completed_target_hook is not None:
                reason = completed_target_hook(
                    capture, content=content, signals={}
                )
                if reason is not None:
                    return reason
            return target_rejection
    _, signals = score_raw_capture(
        content,
        http_status=capture.http_status,
        content_type=capture.content_type,
        final_url=capture.final_url,
        publisher=capture.publisher,
    )
    assessment_hook = source_capture.assess_candidate
    if assessment_hook is not None:
        assessment = assessment_hook(
            capture.selected_candidate,
            content=content,
            canonical_url=capture.canonical_url,
            final_url=capture.final_url,
            quality_score=capture.quality_score,
            signals=signals,
        )
        signals = assessment.signals
    checks = (
        ("empty-response", not content),
        ("not-html", not bool(signals["looksLikeHtml"])),
        ("archive-error-page", bool(signals["archiveErrorPage"])),
        (
            "server-placeholder-shell",
            bool(signals["serverPlaceholderShell"]),
        ),
        (
            "authentication-shell",
            bool(signals["authenticationShell"] and not signals.get("allowAuthenticationShell")),
        ),
        ("access-challenge-shell", bool(signals["accessChallengeShell"])),
        (
            "subscription-shell",
            bool(signals["subscriptionShell"] and not signals.get("allowSubscriptionShell")),
        ),
        ("redirect-shell", bool(signals["redirectShell"])),
        ("tiny-html-shell", bool(signals["tinyHtmlShell"])),
    )
    for reason, rejected in checks:
        if rejected:
            return reason
    completed_hook = source_capture.completed_rejection_reason
    if completed_hook is not None:
        source_reason = completed_hook(capture, content=content, signals=signals)
        if source_reason is not None:
            return source_reason
    if capture.http_status not in ACCEPTED_HTTP_STATUSES:
        return f"http-{capture.http_status}"
    return None


def reset_completed_capture_for_retry(
    connection: sqlite3.Connection,
    *,
    canonical_url: str,
    reason: str,
) -> None:
    with connection:
        connection.execute(
            """
            UPDATE captures
            SET status='pending',
                attempts=0,
                last_error=?,
                updated_at=?
            WHERE canonical_url=? AND status='complete'
            """,
            (
                f"raw quality policy rejected stored capture: {reason}",
                _now_iso(),
                canonical_url,
            ),
        )


def _read_capture_html(
    capture: RawCapture,
    *,
    archive_root: Path,
) -> bytes:
    path = archive_root / capture.raw_html.path
    if capture.raw_html.content_encoding == "gzip":
        with gzip.open(path, "rb") as handle:
            content = handle.read()
    else:
        content = path.read_bytes()
    actual = hashlib.sha256(content).hexdigest()
    if actual != capture.raw_html.sha256:
        raise ValueError(
            "raw HTML checksum mismatch: "
            f"expected {capture.raw_html.sha256}, got {actual}"
        )
    return content


def capture_summary(
    connection: sqlite3.Connection,
    *,
    output_dir: Path,
) -> dict[str, object]:
    statuses = dict(
        connection.execute(
            "SELECT status, COUNT(*) FROM captures GROUP BY status"
        ).fetchall()
    )
    sizes = connection.execute(
        """
        SELECT
            COALESCE(SUM(raw_bytes), 0),
            COALESCE(SUM(stored_bytes), 0),
            COALESCE(AVG(quality_score), 0)
        FROM captures
        WHERE status='complete'
        """
    ).fetchone()
    result = {
        "formatVersion": SCHEMA_VERSION,
        "capturesByStatus": statuses,
        "rawHtmlBytes": int(sizes[0]),
        "storedHtmlBytes": int(sizes[1]),
        "averageQualityScore": round(float(sizes[2]), 2),
        "objectsOnDisk": sum(
            1 for path in (output_dir / "objects").rglob("*") if path.is_file()
        )
        if (output_dir / "objects").exists()
        else 0,
        "recordsOnDisk": sum(
            1 for path in (output_dir / "records").rglob("*.json") if path.is_file()
        )
        if (output_dir / "records").exists()
        else 0,
    }
    validation_table = connection.execute(
        """
        SELECT 1
        FROM sqlite_master
        WHERE type='table' AND name='parser_validation_config'
        """
    ).fetchone()
    if validation_table:
        from jojo_news_archive.parsing.validation import parser_validation_summary

        result["parserValidation"] = parser_validation_summary(connection)
    return result


def _insert_manifest_batch(
    connection: sqlite3.Connection,
    rows: list[tuple[object, ...]],
) -> int:
    # Normalization can collapse several malformed source aliases onto one
    # canonical article inside the same input batch. Merge their candidate
    # snapshots before the upsert; otherwise the last alias silently replaces
    # the valid canonical candidate.
    collapsed: dict[str, tuple[object, ...]] = {}
    for row in rows:
        canonical_url = str(row[0])
        previous = collapsed.get(canonical_url)
        if previous is None:
            collapsed[canonical_url] = row
            continue
        candidates: list[dict] = []
        seen_candidates: set[str] = set()
        for candidate in [
            *json.loads(str(previous[5])),
            *json.loads(str(row[5])),
        ]:
            identity = json.dumps(
                candidate,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            if identity in seen_candidates:
                continue
            seen_candidates.add(identity)
            candidates.append(candidate)
        collapsed[canonical_url] = (
            *previous[:3],
            row[3] or previous[3],
            row[4] or previous[4],
            json.dumps(
                candidates,
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            row[6],
        )
    rows = list(collapsed.values())
    canonical_urls = [str(row[0]) for row in rows]
    placeholders = ",".join("?" for _ in canonical_urls)
    persisted_candidates = {
        str(canonical_url): str(candidates_json)
        for canonical_url, candidates_json in connection.execute(
            f"""
            SELECT canonical_url, candidates_json
            FROM captures
            WHERE canonical_url IN ({placeholders})
            """,
            canonical_urls,
        ).fetchall()
    }
    merged_rows: list[tuple[object, ...]] = []
    for row in rows:
        manifest_candidates = json.loads(str(row[5]))
        existing_json = persisted_candidates.get(str(row[0]))
        if existing_json is not None:
            existing_candidates = json.loads(existing_json)
            source_capture = capture_hooks(str(row[2]))
            manifest_snapshot_urls = {
                str(candidate.get("snapshotUrl") or "")
                for candidate in manifest_candidates
                if isinstance(candidate, dict)
            }
            # Secondary-archive and partner rows do not live in source
            # manifests, so retain them across refreshes. Sources may reject
            # preservation for catalog-derived providers whose current
            # manifest policy is authoritative.
            preserved_derived_providers = {"arquivo-pt", "other"}
            preserve_infini = (
                source_capture.preserve_removed_infini_candidate
                or (lambda candidate: True)
            )
            if any(
                preserve_infini(candidate)
                for candidate in existing_candidates
                if isinstance(candidate, dict)
                and candidate.get("provider") == "infini-news"
            ):
                preserved_derived_providers.add("infini-news")
            derived_candidates = [
                candidate
                for candidate in existing_candidates
                if (
                    isinstance(candidate, dict)
                    and candidate.get("provider")
                    in preserved_derived_providers
                    and str(candidate.get("snapshotUrl") or "")
                    not in manifest_snapshot_urls
                )
            ]
            manifest_candidates = [
                *derived_candidates,
                *manifest_candidates,
            ]
        merged_rows.append(
            (
                *row[:5],
                json.dumps(
                    manifest_candidates,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                *row[6:],
            )
        )
    connection.executemany(
        """
        UPDATE captures
        SET published_at=?, updated_at=?
        WHERE canonical_url=?
          AND ? IS NOT NULL
          AND published_at IS NOT ?
        """,
        (
            (
                row[3],
                row[6],
                row[0],
                row[3],
                row[3],
            )
            for row in merged_rows
        ),
    )
    before = connection.total_changes
    connection.executemany(
        """
        INSERT INTO captures(
            canonical_url,
            article_id,
            publisher,
            published_at,
            section,
            candidates_json,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(canonical_url) DO UPDATE SET
            published_at=COALESCE(
                excluded.published_at,
                captures.published_at
            ),
            section=COALESCE(excluded.section, captures.section),
            candidates_json=excluded.candidates_json,
            status=CASE
                WHEN captures.status='error'
                 AND captures.candidates_json != excluded.candidates_json
                THEN 'pending'
                ELSE captures.status
            END,
            attempts=CASE
                WHEN captures.status='error'
                 AND captures.candidates_json != excluded.candidates_json
                THEN 0
                ELSE captures.attempts
            END,
            last_error=CASE
                WHEN captures.status='error'
                 AND captures.candidates_json != excluded.candidates_json
                THEN NULL
                ELSE captures.last_error
            END,
            updated_at=excluded.updated_at
        WHERE captures.status IN ('pending', 'error')
          AND (
            (
                excluded.published_at IS NOT NULL
                AND captures.published_at IS NOT excluded.published_at
            )
            OR (
                excluded.section IS NOT NULL
                AND captures.section IS NOT excluded.section
            )
            OR captures.candidates_json != excluded.candidates_json
          )
        """,
        merged_rows,
    )
    return connection.total_changes - before


def _read_jsonl(path: Path) -> Iterable[dict]:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"invalid JSON on manifest line {line_number}"
                ) from exc
            if not isinstance(row, dict):
                raise ValueError(
                    f"manifest line {line_number} must be a JSON object"
                )
            yield row


def _wayback_datetime(timestamp: str) -> datetime | None:
    if not re.fullmatch(r"\d{14}", timestamp):
        return None
    return datetime.strptime(timestamp, "%Y%m%d%H%M%S").replace(
        tzinfo=timezone.utc
    )


def _optional_string(value: object) -> str | None:
    if value is None:
        return None
    result = str(value).strip()
    return result or None


def _optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
