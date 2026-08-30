from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
import hashlib
import json
import re
import sqlite3
import struct
import threading
import time
from typing import Iterable
from urllib.parse import quote, urlsplit, urlunsplit

import pyarrow as pa
import pyarrow.parquet as pq

from .archive_sources import archive_source_spec, normalize_article_url
from .infini_news import (
    infini_news_row_url,
    is_ft_subscription_headline,
)
from .news_models import CaptureCandidate, CaptureProvider


INFINI_DATASET = "ruggsea/infini-news-corpus"
HUGGING_FACE_TREE_ENDPOINT = (
    "https://huggingface.co/api/datasets/"
    f"{INFINI_DATASET}/tree/main"
)
HUGGING_FACE_RESOLVE_ENDPOINT = (
    "https://huggingface.co/datasets/"
    f"{INFINI_DATASET}/resolve/main"
)
DEFAULT_TARGET_ARTICLES = 850
DEFAULT_MAXIMUM_FILES_PER_RUN = 1_200
# Hugging Face throttles ranged requests to the public dataset.  A large
# metadata fan-out looks attractive, but it turns a resumable discovery pass
# into a wall of 429s and leaves the same files unresolved on every
# continuation.  Keep the default conservative; callers can still override
# it explicitly in tests or controlled experiments.
DEFAULT_METADATA_WORKERS = 4
DEFAULT_SCAN_WORKERS = 4
DEFAULT_METADATA_ATTEMPTS = 6
DEFAULT_REQUEST_INTERVAL = 0.2
RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
MINIMUM_TEXT_CHARACTERS = 1_000
PARQUET_FOOTER_PROBE_BYTES = 32 * 1024
_SIGNIFICANT_TOKEN_RE = re.compile(r"[a-z0-9]+")


class _RequestGate:
    """Serialize public-dataset requests without serializing file workers."""

    def __init__(self, minimum_interval: float = DEFAULT_REQUEST_INTERVAL):
        self.minimum_interval = max(0.0, float(minimum_interval))
        self._lock = threading.Lock()
        self._next_request_at = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            delay = max(0.0, self._next_request_at - now)
            self._next_request_at = (
                max(now, self._next_request_at) + self.minimum_interval
            )
        if delay:
            time.sleep(delay)


def _retry_after_seconds(response) -> float | None:
    headers = getattr(response, "headers", None)
    if not headers:
        return None
    value = headers.get("retry-after") or headers.get("Retry-After")
    if value is None:
        return None
    try:
        return max(0.0, float(str(value).strip()))
    except (TypeError, ValueError):
        return None


def _get_with_retries(
    http_client,
    url: str,
    *,
    params: dict[str, object] | None = None,
    headers: dict[str, str] | None = None,
    request_gate: _RequestGate | None = None,
    attempts: int = DEFAULT_METADATA_ATTEMPTS,
):
    """Fetch a public dataset object while respecting transient throttling."""

    if attempts < 1:
        raise ValueError("attempts must be positive")
    for attempt in range(attempts):
        if request_gate is not None:
            request_gate.wait()
        request_kwargs: dict[str, object] = {}
        if params is not None:
            request_kwargs["params"] = params
        if headers is not None:
            request_kwargs["headers"] = headers
        response = http_client.get(url, **request_kwargs)
        status_code = int(getattr(response, "status_code", 200))
        if status_code not in RETRYABLE_STATUS_CODES or attempt == attempts - 1:
            return response
        retry_after = _retry_after_seconds(response)
        delay = min(
            30.0,
            max(
                0.5 * (2**attempt),
                retry_after if retry_after is not None else 0.0,
            ),
        )
        time.sleep(delay)
    raise AssertionError("retry loop returned without a response")


def initialize_ft_infini_direct_schema(
    connection: sqlite3.Connection,
) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS ft_infini_parquet_files (
            source_year INTEGER NOT NULL,
            file_path TEXT NOT NULL,
            byte_count INTEGER NOT NULL,
            row_count INTEGER,
            global_offset INTEGER,
            scan_priority TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(source_year, file_path)
        );

        CREATE INDEX IF NOT EXISTS idx_ft_infini_parquet_scan
            ON ft_infini_parquet_files(
                source_year,
                status,
                scan_priority
            );

        CREATE TABLE IF NOT EXISTS ft_infini_direct_articles (
            canonical_url TEXT PRIMARY KEY,
            source_url TEXT NOT NULL,
            published_at TEXT NOT NULL,
            expected_headline TEXT NOT NULL,
            source_year INTEGER NOT NULL,
            document_index INTEGER NOT NULL,
            text_length INTEGER NOT NULL,
            warc_filename TEXT NOT NULL,
            parquet_path TEXT NOT NULL,
            parquet_row_index INTEGER NOT NULL,
            sample_priority TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ft_infini_direct_year
            ON ft_infini_direct_articles(
                source_year,
                sample_priority
            );
        """
    )
    connection.commit()


def discover_ft_infini_direct_candidates(
    connection: sqlite3.Connection,
    *,
    year: int,
    http_client,
    target_articles: int = DEFAULT_TARGET_ARTICLES,
    maximum_files_per_run: int = DEFAULT_MAXIMUM_FILES_PER_RUN,
    metadata_workers: int = DEFAULT_METADATA_WORKERS,
    scan_workers: int = DEFAULT_SCAN_WORKERS,
) -> dict[str, object]:
    if year < 2016 or year > 2200:
        raise ValueError("Infini-News year is outside the supported range")
    if target_articles < 1:
        raise ValueError("target_articles must be positive")
    if maximum_files_per_run < 1:
        raise ValueError("maximum_files_per_run must be positive")
    if metadata_workers < 1 or scan_workers < 1:
        raise ValueError("worker counts must be positive")

    initialize_ft_infini_direct_schema(connection)
    request_gate = _RequestGate()
    files = _list_year_parquet_files(
        http_client,
        year=year,
        request_gate=request_gate,
    )
    _store_file_catalog(connection, year=year, files=files)
    metadata_result = _resolve_file_metadata(
        connection,
        year=year,
        http_client=http_client,
        workers=metadata_workers,
        request_gate=request_gate,
    )
    unresolved_metadata = int(
        connection.execute(
            """
            SELECT COUNT(*)
            FROM ft_infini_parquet_files
            WHERE source_year=? AND row_count IS NULL
            """,
            (year,),
        ).fetchone()[0]
    )
    if unresolved_metadata:
        return {
            "year": year,
            "files": len(files),
            "metadata": metadata_result,
            "metadataReady": False,
            "unresolvedMetadata": unresolved_metadata,
            "scannedFiles": 0,
            "discoveredArticles": _article_count(connection, year),
            "mergedCandidates": 0,
        }

    _assign_global_offsets(connection, year=year)
    current_articles = _article_count(connection, year)
    scan_result: dict[str, object] = {
        "attempted": 0,
        "accepted": 0,
        "errors": [],
    }
    if current_articles < target_articles:
        scan_result = _scan_pending_files(
            connection,
            year=year,
            target_articles=target_articles,
            maximum_files=maximum_files_per_run,
            workers=scan_workers,
        )
    merged = merge_ft_infini_direct_candidates(
        connection,
        year=year,
    )
    return {
        "year": year,
        "files": len(files),
        "metadata": metadata_result,
        "metadataReady": True,
        "unresolvedMetadata": 0,
        "scannedFiles": int(scan_result["attempted"]),
        "scanAccepted": int(scan_result["accepted"]),
        "scanErrors": list(scan_result["errors"]),
        "discoveredArticles": _article_count(connection, year),
        "mergedCandidates": merged,
    }


def merge_ft_infini_direct_candidates(
    connection: sqlite3.Connection,
    *,
    year: int,
) -> int:
    rows = connection.execute(
        """
        SELECT
            article.canonical_url,
            article.source_url,
            article.expected_headline,
            article.published_at,
            article.document_index,
            article.warc_filename,
            capture.candidates_json,
            capture.status
        FROM ft_infini_direct_articles AS article
        LEFT JOIN captures AS capture
          ON capture.canonical_url=article.canonical_url
        WHERE article.source_year=?
        ORDER BY article.sample_priority
        """,
        (year,),
    ).fetchall()
    merged = 0
    now = _now_iso()
    with connection:
        for (
            canonical_url,
            source_url,
            expected_headline,
            published_at,
            document_index,
            warc_filename,
            candidates_json,
            status,
        ) in rows:
            candidates = (
                json.loads(str(candidates_json))
                if candidates_json is not None
                else []
            )
            snapshot_url = infini_news_row_url(
                year,
                int(document_index),
            )
            if any(
                str(item.get("provider") or "") == "infini-news"
                and str(item.get("snapshotUrl") or "") == snapshot_url
                for item in candidates
                if isinstance(item, dict)
            ):
                continue
            candidate = CaptureCandidate(
                provider=CaptureProvider.INFINI_NEWS,
                snapshot_url=snapshot_url,
                source_url=str(source_url),
                expected_headline=str(expected_headline),
                warc_filename=str(warc_filename),
            )
            candidates.insert(
                0,
                candidate.model_dump(
                    mode="json",
                    by_alias=True,
                    exclude_none=True,
                ),
            )
            candidate_json = json.dumps(
                candidates,
                ensure_ascii=False,
                separators=(",", ":"),
            )
            if status is None:
                # A direct Infini row can be the first provenance source for
                # an FT article.  Materialize it as a normal pending capture
                # so the existing capture worker, derived-HTML safeguards,
                # parser, and 800-item validation gate handle it identically
                # to a manifest row.
                article_id = (
                    "ft:"
                    + hashlib.sha256(
                        str(canonical_url).encode("utf-8")
                    ).hexdigest()
                )
                capture_published_at = str(published_at)
                if len(capture_published_at) == 10:
                    capture_published_at += "T00:00:00+00:00"
                connection.execute(
                    """
                    INSERT INTO captures(
                        canonical_url,
                        article_id,
                        publisher,
                        published_at,
                        section,
                        candidates_json,
                        status,
                        attempts,
                        updated_at
                    ) VALUES (?, ?, 'ft', ?, NULL, ?, 'pending', 0, ?)
                    ON CONFLICT(canonical_url) DO NOTHING
                    """,
                    (
                        str(canonical_url),
                        article_id,
                        capture_published_at,
                        candidate_json,
                        now,
                    ),
                )
                merged += 1
                continue
            reset = str(status) != "complete"
            connection.execute(
                """
                UPDATE captures
                SET candidates_json=?,
                    status=CASE WHEN ? THEN 'pending' ELSE status END,
                    attempts=CASE WHEN ? THEN 0 ELSE attempts END,
                    last_error=CASE WHEN ? THEN NULL ELSE last_error END,
                    updated_at=?
                WHERE canonical_url=?
                """,
                (
                    json.dumps(
                        candidates,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    int(reset),
                    int(reset),
                    int(reset),
                    now,
                    str(canonical_url),
                ),
            )
            merged += 1
    return merged


def _list_year_parquet_files(
    http_client,
    *,
    year: int,
    request_gate: _RequestGate | None = None,
) -> list[tuple[str, int]]:
    files: dict[str, int] = {}
    for month in range(1, 13):
        tree_path = f"data/year={year}/month={month:02d}"
        url = HUGGING_FACE_TREE_ENDPOINT + "/" + quote(
            tree_path,
            safe="",
        )
        while url:
            response = _get_with_retries(
                http_client,
                url,
                params={
                    "recursive": "false",
                    "expand": "false",
                    "limit": 1000,
                }
                if "cursor=" not in url
                else None,
                request_gate=request_gate,
            )
            if response.status_code == 404:
                # The corpus starts in August 2016 and the latest year can be
                # incomplete, so absent month partitions are expected.
                break
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list):
                raise ValueError("Hugging Face tree response is invalid")
            for entry in payload:
                if (
                    isinstance(entry, dict)
                    and entry.get("type") == "file"
                    and str(entry.get("path") or "").endswith(".parquet")
                ):
                    path = str(entry["path"])
                    files[path] = int(entry.get("size") or 0)
            next_link = response.links.get("next")
            url = (
                str(next_link.get("url"))
                if isinstance(next_link, dict) and next_link.get("url")
                else ""
            )
    return sorted(files.items())


def _store_file_catalog(
    connection: sqlite3.Connection,
    *,
    year: int,
    files: Iterable[tuple[str, int]],
) -> None:
    now = _now_iso()
    with connection:
        connection.executemany(
            """
            INSERT INTO ft_infini_parquet_files(
                source_year,
                file_path,
                byte_count,
                scan_priority,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source_year, file_path) DO UPDATE SET
                byte_count=excluded.byte_count,
                updated_at=excluded.updated_at
            """,
            (
                (
                    year,
                    path,
                    byte_count,
                    hashlib.sha256(
                        f"ft-infini-direct-v1\0{year}\0{path}".encode()
                    ).hexdigest(),
                    now,
                )
                for path, byte_count in files
            ),
        )


def _resolve_file_metadata(
    connection: sqlite3.Connection,
    *,
    year: int,
    http_client,
    workers: int,
    request_gate: _RequestGate | None = None,
) -> dict[str, object]:
    rows = connection.execute(
        """
        SELECT file_path, byte_count
        FROM ft_infini_parquet_files
        WHERE source_year=?
          AND row_count IS NULL
          AND attempts < ?
        ORDER BY file_path
        """,
        (year, DEFAULT_METADATA_ATTEMPTS),
    ).fetchall()
    completed = 0
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(
                _read_parquet_row_count,
                http_client,
                str(path),
                int(byte_count),
                request_gate=request_gate,
            ): str(path)
            for path, byte_count in rows
        }
        for future in as_completed(futures):
            path = futures[future]
            try:
                row_count = int(future.result())
                if row_count < 0:
                    raise ValueError("Parquet row count is negative")
                with connection:
                    connection.execute(
                        """
                        UPDATE ft_infini_parquet_files
                        SET row_count=?,
                            attempts=attempts+1,
                            last_error=NULL,
                            updated_at=?
                        WHERE source_year=? AND file_path=?
                        """,
                        (row_count, _now_iso(), year, path),
                    )
                completed += 1
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
                errors.append(f"{path}: {error}")
                with connection:
                    connection.execute(
                        """
                        UPDATE ft_infini_parquet_files
                        SET attempts=attempts+1,
                            last_error=?,
                            updated_at=?
                        WHERE source_year=? AND file_path=?
                        """,
                        (error, _now_iso(), year, path),
                    )
    return {
        "attempted": len(rows),
        "completed": completed,
        "errors": errors[:20],
    }


def _read_parquet_row_count(
    http_client,
    path: str,
    byte_count: int,
    *,
    request_gate: _RequestGate | None = None,
) -> int:
    if byte_count < 12:
        raise ValueError("Parquet file is too small")
    url = _resolve_url(path)
    probe_start = max(0, byte_count - PARQUET_FOOTER_PROBE_BYTES)
    probe = _get_with_retries(
        http_client,
        url,
        headers={"Range": f"bytes={probe_start}-{byte_count - 1}"},
        request_gate=request_gate,
    )
    probe.raise_for_status()
    expected_probe_size = byte_count - probe_start
    if len(probe.content) != expected_probe_size:
        raise ValueError("Parquet footer probe range is incomplete")
    trailer = probe.content[-8:]
    if len(trailer) != 8 or trailer[4:] != b"PAR1":
        raise ValueError("Parquet trailer is invalid")
    footer_size = struct.unpack("<I", trailer[:4])[0]
    footer_start = byte_count - 8 - footer_size
    if footer_start < 4:
        raise ValueError("Parquet footer size is invalid")
    expected_size = footer_size + 8
    if footer_start >= probe_start:
        footer_content = probe.content[footer_start - probe_start :]
    else:
        footer = _get_with_retries(
            http_client,
            url,
            headers={"Range": f"bytes={footer_start}-{byte_count - 1}"},
            request_gate=request_gate,
        )
        footer.raise_for_status()
        footer_content = footer.content
    if len(footer_content) != expected_size:
        raise ValueError("Parquet footer range is incomplete")
    metadata = pq.read_metadata(
        pa.BufferReader(b"PAR1" + footer_content)
    )
    return int(metadata.num_rows)


def _assign_global_offsets(
    connection: sqlite3.Connection,
    *,
    year: int,
) -> None:
    rows = connection.execute(
        """
        SELECT file_path, row_count
        FROM ft_infini_parquet_files
        WHERE source_year=?
        ORDER BY file_path
        """,
        (year,),
    ).fetchall()
    offset = 0
    updates: list[tuple[int, str, int, str]] = []
    now = _now_iso()
    for path, row_count in rows:
        if row_count is None:
            raise ValueError("cannot assign offsets with missing row counts")
        updates.append((offset, now, year, str(path)))
        offset += int(row_count)
    with connection:
        connection.executemany(
            """
            UPDATE ft_infini_parquet_files
            SET global_offset=?, updated_at=?
            WHERE source_year=? AND file_path=?
            """,
            updates,
        )


def _scan_pending_files(
    connection: sqlite3.Connection,
    *,
    year: int,
    target_articles: int,
    maximum_files: int,
    workers: int,
) -> dict[str, object]:
    rows = connection.execute(
        """
        SELECT file_path, global_offset
        FROM ft_infini_parquet_files
        WHERE source_year=?
          AND global_offset IS NOT NULL
          AND (
            status='pending'
            OR (status='error' AND attempts < 3)
          )
        ORDER BY scan_priority
        LIMIT ?
        """,
        (year, maximum_files),
    ).fetchall()
    attempted = 0
    accepted = 0
    errors: list[str] = []

    def scan(path: str, offset: int) -> list[dict[str, object]]:
        return _scan_parquet_file(
            path,
            global_offset=offset,
            year=year,
            # The direct catalog is itself a provenance-safe FT source.  Do
            # not restrict it to URLs already present in the Wayback
            # manifest: that would turn discovery into a mere candidate
            # augmenter and make the Infini corpus unable to fill sparse
            # historical years.
            capture_urls=None,
        )

    deterministic_rows = [
        (str(path), int(offset)) for path, offset in rows
    ]
    batch_size = workers * 4
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for batch_start in range(
            0,
            len(deterministic_rows),
            batch_size,
        ):
            if _article_count(connection, year) >= target_articles:
                break
            batch = deterministic_rows[
                batch_start : batch_start + batch_size
            ]
            futures = {
                executor.submit(scan, path, offset): path
                for path, offset in batch
            }
            for future in as_completed(futures):
                path = futures[future]
                attempted += 1
                try:
                    articles = future.result()
                    _store_scanned_articles(
                        connection,
                        year=year,
                        path=path,
                        articles=articles,
                    )
                    accepted += len(articles)
                except Exception as exc:
                    error = f"{type(exc).__name__}: {exc}"
                    errors.append(f"{path}: {error}")
                    with connection:
                        connection.execute(
                            """
                            UPDATE ft_infini_parquet_files
                            SET status='error',
                                attempts=attempts+1,
                                last_error=?,
                                updated_at=?
                            WHERE source_year=? AND file_path=?
                            """,
                            (error, _now_iso(), year, path),
                        )
    return {
        "attempted": attempted,
        "accepted": accepted,
        "errors": errors[:20],
    }


def _scan_parquet_file(
    path: str,
    *,
    global_offset: int,
    year: int,
    capture_urls: set[str] | None = None,
) -> list[dict[str, object]]:
    import fsspec

    columns = (
        "url",
        "url_hostname",
        "warc_filename",
        "publish_date",
        "title",
        "text_length",
        "language",
    )
    with fsspec.open(
        _resolve_url(path),
        "rb",
        block_size=5 * 1024 * 1024,
        cache_type="readahead",
    ).open() as handle:
        values = pq.read_table(handle, columns=list(columns)).to_pydict()
    accepted: list[dict[str, object]] = []
    spec = archive_source_spec("ft")
    for row_index, raw_url in enumerate(values["url"]):
        source_url = str(raw_url or "").strip()
        hostname = str(values["url_hostname"][row_index] or "").casefold()
        if not _is_ft_hostname(hostname):
            continue
        canonical_url = _normalize_ft_url(spec, source_url)
        if canonical_url is None:
            continue
        if capture_urls is not None and canonical_url not in capture_urls:
            continue
        published_at = _parse_publish_date(
            values["publish_date"][row_index]
        )
        if published_at is None or published_at.year != year:
            continue
        headline = " ".join(
            str(values["title"][row_index] or "").split()
        )
        if len(_SIGNIFICANT_TOKEN_RE.findall(headline.casefold())) < 4:
            continue
        # Infini-News contains FT subscription/paywall landing pages whose
        # extracted title is only a generic "Subscribe to FT.com" label.
        # They are deliberately rejected by the capture validator because
        # they do not identify the article headline; filter them here so the
        # direct catalog does not spend retries on a known non-article row.
        if is_ft_subscription_headline(headline):
            continue
        text_length = _optional_int(values["text_length"][row_index])
        if text_length is None or text_length < MINIMUM_TEXT_CHARACTERS:
            continue
        language = str(values["language"][row_index] or "").casefold()
        if language and not language.startswith("eng"):
            continue
        warc_filename = str(
            values["warc_filename"][row_index] or ""
        ).strip()
        if (
            not warc_filename.startswith("CC-NEWS-")
            or not warc_filename.endswith(".warc.gz")
        ):
            continue
        accepted.append(
            {
                "canonicalUrl": canonical_url,
                "sourceUrl": source_url,
                "publishedAt": published_at.isoformat(),
                "expectedHeadline": headline,
                "documentIndex": global_offset + row_index,
                "textLength": text_length,
                "warcFilename": warc_filename,
                "parquetRowIndex": row_index,
                "samplePriority": hashlib.sha256(
                    (
                        f"ft-infini-direct-article-v1\0{year}\0"
                        f"{canonical_url}"
                    ).encode()
                ).hexdigest(),
            }
        )
    return accepted


def _store_scanned_articles(
    connection: sqlite3.Connection,
    *,
    year: int,
    path: str,
    articles: Iterable[dict[str, object]],
) -> None:
    now = _now_iso()
    with connection:
        connection.executemany(
            """
            INSERT INTO ft_infini_direct_articles(
                canonical_url,
                source_url,
                published_at,
                expected_headline,
                source_year,
                document_index,
                text_length,
                warc_filename,
                parquet_path,
                parquet_row_index,
                sample_priority,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(canonical_url) DO UPDATE SET
                source_url=excluded.source_url,
                published_at=excluded.published_at,
                expected_headline=excluded.expected_headline,
                source_year=excluded.source_year,
                document_index=excluded.document_index,
                text_length=excluded.text_length,
                warc_filename=excluded.warc_filename,
                parquet_path=excluded.parquet_path,
                parquet_row_index=excluded.parquet_row_index,
                sample_priority=excluded.sample_priority,
                updated_at=excluded.updated_at
            """,
            (
                (
                    str(article["canonicalUrl"]),
                    str(article["sourceUrl"]),
                    str(article["publishedAt"]),
                    str(article["expectedHeadline"]),
                    year,
                    int(article["documentIndex"]),
                    int(article["textLength"]),
                    str(article["warcFilename"]),
                    path,
                    int(article["parquetRowIndex"]),
                    str(article["samplePriority"]),
                    now,
                )
                for article in articles
            ),
        )
        connection.execute(
            """
            UPDATE ft_infini_parquet_files
            SET status='complete',
                attempts=attempts+1,
                last_error=NULL,
                updated_at=?
            WHERE source_year=? AND file_path=?
            """,
            (now, year, path),
        )


def _resolve_url(path: str) -> str:
    return HUGGING_FACE_RESOLVE_ENDPOINT + "/" + quote(
        path,
        safe="/=",
    )


def _is_ft_hostname(hostname: str) -> bool:
    normalized = hostname.strip().casefold().rstrip(".")
    return normalized == "ft.com" or normalized.endswith(".ft.com")


def _normalize_ft_url(spec, source_url: str) -> str | None:
    parsed = urlsplit(source_url)
    hostname = (parsed.hostname or "").casefold()
    value = source_url
    if hostname == "amp.ft.com":
        value = urlunsplit(
            ("https", "www.ft.com", parsed.path, parsed.query, "")
        )
    return normalize_article_url(spec, value)


def _parse_publish_date(value: object) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(
            text.replace("Z", "+00:00")
        ).date()
    except ValueError:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None


def _optional_int(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _article_count(connection: sqlite3.Connection, year: int) -> int:
    return int(
        connection.execute(
            """
            SELECT COUNT(*)
            FROM ft_infini_direct_articles
            WHERE source_year=?
            """,
            (year,),
        ).fetchone()[0]
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
