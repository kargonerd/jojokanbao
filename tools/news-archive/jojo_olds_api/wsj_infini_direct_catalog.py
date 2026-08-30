from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
import hashlib
import re
import sqlite3
import struct
from typing import Iterable
from urllib.parse import quote, urlsplit

import pyarrow as pa
import pyarrow.parquet as pq

from .archive_sources import (
    archive_source_spec,
    normalize_article_url,
    wsj_article_publication_datetime,
)
from .infini_news import INFINI_DATASET, infini_news_row_url
from .news_models import CaptureCandidate, CaptureProvider

HUGGING_FACE_TREE_ENDPOINT = (
    "https://huggingface.co/api/datasets/"
    f"{INFINI_DATASET}/tree/main"
)
HUGGING_FACE_RESOLVE_ENDPOINT = (
    "https://huggingface.co/datasets/"
    f"{INFINI_DATASET}/resolve/main"
)
WSJ_INFINI_DIRECT_FIRST_YEAR = 2016
WSJ_INFINI_DIRECT_LAST_YEAR = 2018
WSJ_INFINI_DIRECT_TARGET_PER_YEAR = 1_600
DEFAULT_MAXIMUM_FILES_PER_RUN = 50
DEFAULT_SCAN_WORKERS = 8
DEFAULT_METADATA_FILES_PER_RUN = 1_200
DEFAULT_METADATA_WORKERS = 24
# Keep discovery eligibility aligned with the final derived-HTML acceptance
# gate.  Infini-News contains many WSJ subscription previews in the 300-900
# character range; exporting those rows only spends an API request before the
# capture worker rejects them as incomplete.
MINIMUM_TEXT_CHARACTERS = 1_000
PARQUET_FOOTER_PROBE_BYTES = 32 * 1024
_WSJ_HOSTS = {"wsj.com", "www.wsj.com", "online.wsj.com"}
_SIGNIFICANT_TOKEN_RE = re.compile(r"[a-z0-9]+")


def initialize_wsj_infini_direct_schema(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS wsj_infini_direct_years (
            source_year INTEGER PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'pending',
            file_count INTEGER,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wsj_infini_direct_files (
            source_year INTEGER NOT NULL,
            file_path TEXT NOT NULL,
            byte_count INTEGER NOT NULL,
            row_count INTEGER,
            global_offset INTEGER,
            scan_priority TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            metadata_attempts INTEGER NOT NULL DEFAULT 0,
            accepted_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            metadata_error TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(source_year, file_path)
        );

        CREATE INDEX IF NOT EXISTS idx_wsj_infini_direct_file_scan
            ON wsj_infini_direct_files(
                source_year,
                status,
                scan_priority
            );

        CREATE TABLE IF NOT EXISTS wsj_infini_direct_articles (
            canonical_url TEXT PRIMARY KEY,
            source_url TEXT NOT NULL,
            published_at TEXT NOT NULL,
            expected_headline TEXT NOT NULL,
            source_year INTEGER NOT NULL,
            document_index INTEGER,
            text_length INTEGER NOT NULL,
            warc_filename TEXT NOT NULL,
            parquet_path TEXT NOT NULL,
            parquet_row_index INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_wsj_infini_direct_article_year
            ON wsj_infini_direct_articles(source_year, canonical_url);
        """
    )
    _ensure_column(
        connection,
        "wsj_infini_direct_files",
        "row_count",
        "INTEGER",
    )
    _ensure_column(
        connection,
        "wsj_infini_direct_files",
        "global_offset",
        "INTEGER",
    )
    _ensure_column(
        connection,
        "wsj_infini_direct_files",
        "metadata_attempts",
        "INTEGER NOT NULL DEFAULT 0",
    )
    _ensure_column(
        connection,
        "wsj_infini_direct_files",
        "metadata_error",
        "TEXT",
    )
    _ensure_column(
        connection,
        "wsj_infini_direct_articles",
        "document_index",
        "INTEGER",
    )
    first_year = max(from_year, WSJ_INFINI_DIRECT_FIRST_YEAR)
    last_year = min(to_year, WSJ_INFINI_DIRECT_LAST_YEAR)
    if first_year <= last_year:
        now = _now_iso()
        connection.executemany(
            """
            INSERT OR IGNORE INTO wsj_infini_direct_years(
                source_year,
                updated_at
            ) VALUES (?, ?)
            """,
            ((year, now) for year in range(first_year, last_year + 1)),
        )
    connection.commit()


def process_wsj_infini_direct_catalog(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
    http_client,
    maximum_files: int = DEFAULT_MAXIMUM_FILES_PER_RUN,
    workers: int = DEFAULT_SCAN_WORKERS,
    target_articles: int = WSJ_INFINI_DIRECT_TARGET_PER_YEAR,
) -> dict[str, object]:
    if maximum_files < 1:
        raise ValueError("maximum_files must be positive")
    if workers < 1:
        raise ValueError("workers must be positive")
    if target_articles < 1:
        raise ValueError("target_articles must be positive")
    initialize_wsj_infini_direct_schema(
        connection,
        from_year=from_year,
        to_year=to_year,
    )
    row = connection.execute(
        """
        SELECT source_year
        FROM wsj_infini_direct_years
        WHERE status != 'complete'
        ORDER BY source_year
        LIMIT 1
        """
    ).fetchone()
    if row is None:
        metadata = _process_metadata_backfill(
            connection,
            http_client=http_client,
            maximum_files=DEFAULT_METADATA_FILES_PER_RUN,
            workers=DEFAULT_METADATA_WORKERS,
        )
        return {
            "year": None,
            "listedFiles": 0,
            "attemptedFiles": 0,
            "acceptedRows": 0,
            "newArticles": 0,
            "metadata": metadata,
            "errors": list(metadata["errors"]),
            "shouldContinue": wsj_infini_direct_should_continue(connection),
        }
    year = int(row[0])
    listed_files = 0
    if not connection.execute(
        """
        SELECT 1
        FROM wsj_infini_direct_files
        WHERE source_year=?
        LIMIT 1
        """,
        (year,),
    ).fetchone():
        try:
            files = _list_year_parquet_files(http_client, year=year)
            if not files:
                raise ValueError("Infini-News year has no Parquet files")
            _store_file_catalog(connection, year=year, files=files)
            listed_files = len(files)
            with connection:
                connection.execute(
                    """
                    UPDATE wsj_infini_direct_years
                    SET status='scanning',
                        file_count=?,
                        last_error=NULL,
                        updated_at=?
                    WHERE source_year=?
                    """,
                    (len(files), _now_iso(), year),
                )
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            with connection:
                connection.execute(
                    """
                    UPDATE wsj_infini_direct_years
                    SET last_error=?, updated_at=?
                    WHERE source_year=?
                    """,
                    (error, _now_iso(), year),
                )
            return {
                "year": year,
                "listedFiles": 0,
                "attemptedFiles": 0,
                "acceptedRows": 0,
                "newArticles": 0,
                "errors": [error],
                "shouldContinue": True,
            }

    before = _article_count(connection, year)
    scan = _scan_pending_files(
        connection,
        year=year,
        maximum_files=maximum_files,
        workers=workers,
        target_articles=target_articles,
    )
    after = _article_count(connection, year)
    retryable = _retryable_file_count(connection, year)
    if after >= target_articles or retryable == 0:
        with connection:
            connection.execute(
                """
                UPDATE wsj_infini_direct_years
                SET status='complete', last_error=NULL, updated_at=?
                WHERE source_year=?
                """,
                (_now_iso(), year),
            )
    return {
        "year": year,
        "listedFiles": listed_files,
        "attemptedFiles": int(scan["attempted"]),
        "acceptedRows": int(scan["accepted"]),
        "newArticles": after - before,
        "articles": after,
        "targetArticles": target_articles,
        "retryableFiles": retryable,
        "errors": list(scan["errors"]),
        "shouldContinue": wsj_infini_direct_should_continue(connection),
    }


def wsj_infini_direct_should_continue(
    connection: sqlite3.Connection,
) -> bool:
    if not _table_exists(connection, "wsj_infini_direct_years"):
        return False
    scan_pending = connection.execute(
        """
        SELECT 1
        FROM wsj_infini_direct_years
        WHERE status != 'complete'
        LIMIT 1
        """
    ).fetchone() is not None
    return scan_pending or _metadata_should_continue(connection)


def wsj_infini_direct_summary(
    connection: sqlite3.Connection,
) -> dict[str, object] | None:
    if not _table_exists(connection, "wsj_infini_direct_years"):
        return None
    years: dict[str, object] = {}
    for year, status, file_count, last_error in connection.execute(
        """
        SELECT source_year, status, file_count, last_error
        FROM wsj_infini_direct_years
        ORDER BY source_year
        """
    ):
        file_status = {
            str(item_status): int(count)
            for item_status, count in connection.execute(
                """
                SELECT status, COUNT(*)
                FROM wsj_infini_direct_files
                WHERE source_year=?
                GROUP BY status
                """,
                (year,),
            )
        }
        years[str(year)] = {
            "status": str(status),
            "files": int(file_count or 0),
            "filesByStatus": file_status,
            "articles": _article_count(connection, int(year)),
            "eligibleArticles": int(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM wsj_infini_direct_articles
                    WHERE source_year=? AND text_length>=?
                    """,
                    (year, MINIMUM_TEXT_CHARACTERS),
                ).fetchone()[0]
            ),
            "articlesWithDocumentIndex": int(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM wsj_infini_direct_articles
                    WHERE source_year=? AND document_index IS NOT NULL
                    """,
                    (year,),
                ).fetchone()[0]
            ),
            "eligibleArticlesWithDocumentIndex": int(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM wsj_infini_direct_articles
                    WHERE source_year=?
                      AND document_index IS NOT NULL
                      AND text_length>=?
                    """,
                    (year, MINIMUM_TEXT_CHARACTERS),
                ).fetchone()[0]
            ),
            "metadataFilesReady": int(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM wsj_infini_direct_files
                    WHERE source_year=? AND row_count IS NOT NULL
                    """,
                    (year,),
                ).fetchone()[0]
            ),
            "targetArticles": WSJ_INFINI_DIRECT_TARGET_PER_YEAR,
            "lastError": last_error,
        }
    return {
        "years": years,
        "shouldContinue": wsj_infini_direct_should_continue(connection),
    }


def wsj_infini_direct_capture_candidates(
    connection: sqlite3.Connection,
) -> dict[str, dict[str, object]]:
    if not _table_exists(connection, "wsj_infini_direct_articles"):
        return {}
    result: dict[str, dict[str, object]] = {}
    for (
        canonical_url,
        source_url,
        expected_headline,
        source_year,
        document_index,
        warc_filename,
    ) in connection.execute(
        """
        SELECT canonical_url, source_url, expected_headline, source_year,
               document_index, warc_filename
        FROM wsj_infini_direct_articles
        WHERE document_index IS NOT NULL
          AND text_length>=?
        ORDER BY canonical_url
        """,
        (MINIMUM_TEXT_CHARACTERS,),
    ):
        candidate = CaptureCandidate(
            provider=CaptureProvider.INFINI_NEWS,
            snapshot_url=infini_news_row_url(
                int(source_year),
                int(document_index),
            ),
            source_url=str(source_url),
            expected_headline=str(expected_headline),
            warc_filename=str(warc_filename),
        )
        result[str(canonical_url)] = candidate.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        )
    return result


def _process_metadata_backfill(
    connection: sqlite3.Connection,
    *,
    http_client,
    maximum_files: int,
    workers: int,
) -> dict[str, object]:
    row = connection.execute(
        """
        SELECT source_year
        FROM wsj_infini_direct_articles
        WHERE document_index IS NULL
        GROUP BY source_year
        ORDER BY source_year
        LIMIT 1
        """
    ).fetchone()
    if row is None:
        return {
            "year": None,
            "attemptedFiles": 0,
            "completedFiles": 0,
            "indexedArticles": 0,
            "errors": [],
        }
    year = int(row[0])
    files = connection.execute(
        """
        SELECT file_path, byte_count
        FROM wsj_infini_direct_files
        WHERE source_year=?
          AND row_count IS NULL
          AND metadata_attempts < 3
        ORDER BY file_path
        LIMIT ?
        """,
        (year, maximum_files),
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
            ): str(path)
            for path, byte_count in files
        }
        for future in as_completed(futures):
            path = futures[future]
            try:
                row_count = future.result()
                with connection:
                    connection.execute(
                        """
                        UPDATE wsj_infini_direct_files
                        SET row_count=?, metadata_attempts=metadata_attempts+1,
                            metadata_error=NULL, updated_at=?
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
                        UPDATE wsj_infini_direct_files
                        SET metadata_attempts=metadata_attempts+1,
                            metadata_error=?, updated_at=?
                        WHERE source_year=? AND file_path=?
                        """,
                        (error, _now_iso(), year, path),
                    )
    unresolved = int(
        connection.execute(
            """
            SELECT COUNT(*)
            FROM wsj_infini_direct_files
            WHERE source_year=? AND row_count IS NULL
            """,
            (year,),
        ).fetchone()[0]
    )
    indexed = 0
    if unresolved == 0:
        indexed = _assign_global_offsets(connection, year=year)
    return {
        "year": year,
        "attemptedFiles": len(files),
        "completedFiles": completed,
        "unresolvedFiles": unresolved,
        "indexedArticles": indexed,
        "errors": errors[:20],
    }


def _metadata_should_continue(connection: sqlite3.Connection) -> bool:
    if not _table_exists(connection, "wsj_infini_direct_articles"):
        return False
    years = [
        int(row[0])
        for row in connection.execute(
            """
            SELECT DISTINCT source_year
            FROM wsj_infini_direct_articles
            WHERE document_index IS NULL
            ORDER BY source_year
            """
        )
    ]
    for year in years:
        unresolved, retryable = connection.execute(
            """
            SELECT
                SUM(CASE WHEN row_count IS NULL THEN 1 ELSE 0 END),
                SUM(CASE WHEN row_count IS NULL AND metadata_attempts < 3
                         THEN 1 ELSE 0 END)
            FROM wsj_infini_direct_files
            WHERE source_year=?
            """,
            (year,),
        ).fetchone()
        unresolved_count = int(unresolved or 0)
        retryable_count = int(retryable or 0)
        if unresolved_count == 0 or retryable_count > 0:
            return True
    return False


def _read_parquet_row_count(
    http_client,
    path: str,
    byte_count: int,
) -> int:
    if byte_count < 12:
        raise ValueError("Parquet file is too small")
    url = _resolve_url(path)
    probe_start = max(0, byte_count - PARQUET_FOOTER_PROBE_BYTES)
    probe = http_client.get(
        url,
        headers={"Range": f"bytes={probe_start}-{byte_count - 1}"},
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
        footer = http_client.get(
            url,
            headers={"Range": f"bytes={footer_start}-{byte_count - 1}"},
        )
        footer.raise_for_status()
        footer_content = footer.content
    if len(footer_content) != expected_size:
        raise ValueError("Parquet footer range is incomplete")
    metadata = pq.read_metadata(pa.BufferReader(b"PAR1" + footer_content))
    return int(metadata.num_rows)


def _assign_global_offsets(
    connection: sqlite3.Connection,
    *,
    year: int,
) -> int:
    rows = connection.execute(
        """
        SELECT file_path, row_count
        FROM wsj_infini_direct_files
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
            UPDATE wsj_infini_direct_files
            SET global_offset=?, updated_at=?
            WHERE source_year=? AND file_path=?
            """,
            updates,
        )
        connection.execute(
            """
            UPDATE wsj_infini_direct_articles AS article
            SET document_index=(
                    SELECT file.global_offset + article.parquet_row_index
                    FROM wsj_infini_direct_files AS file
                    WHERE file.source_year=article.source_year
                      AND file.file_path=article.parquet_path
                ),
                updated_at=?
            WHERE article.source_year=?
            """,
            (now, year),
        )
    return int(
        connection.execute(
            """
            SELECT COUNT(*)
            FROM wsj_infini_direct_articles
            WHERE source_year=? AND document_index IS NOT NULL
            """,
            (year,),
        ).fetchone()[0]
    )


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
            INSERT INTO wsj_infini_direct_files(
                source_year,
                file_path,
                byte_count,
                scan_priority,
                updated_at
            ) VALUES (?, ?, ?, ?, ?)
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
                        f"wsj-infini-direct-v1\0{year}\0{path}".encode()
                    ).hexdigest(),
                    now,
                )
                for path, byte_count in files
            ),
        )


def _list_year_parquet_files(
    http_client,
    *,
    year: int,
) -> list[tuple[str, int]]:
    files: dict[str, int] = {}
    for month in range(1, 13):
        tree_path = f"data/year={year}/month={month:02d}"
        url = HUGGING_FACE_TREE_ENDPOINT + "/" + quote(
            tree_path,
            safe="",
        )
        while url:
            response = http_client.get(
                url,
                params={
                    "recursive": "false",
                    "expand": "false",
                    "limit": 1000,
                }
                if "cursor=" not in url
                else None,
            )
            if response.status_code == 404:
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


def _scan_pending_files(
    connection: sqlite3.Connection,
    *,
    year: int,
    maximum_files: int,
    workers: int,
    target_articles: int,
) -> dict[str, object]:
    rows = connection.execute(
        """
        SELECT file_path
        FROM wsj_infini_direct_files
        WHERE source_year=?
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
    batch_size = workers * 2
    for batch_start in range(0, len(rows), batch_size):
        if _article_count(connection, year) >= target_articles:
            break
        batch = [
            str(row[0])
            for row in rows[batch_start : batch_start + batch_size]
        ]
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(_scan_parquet_file, path, year=year): path
                for path in batch
            }
            for future in as_completed(futures):
                path = futures[future]
                attempted += 1
                try:
                    articles = future.result()
                    accepted += len(articles)
                    _store_scanned_articles(
                        connection,
                        year=year,
                        path=path,
                        articles=articles,
                    )
                except Exception as exc:
                    error = f"{type(exc).__name__}: {exc}"
                    errors.append(f"{path}: {error}")
                    with connection:
                        connection.execute(
                            """
                            UPDATE wsj_infini_direct_files
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
    year: int,
) -> list[dict[str, object]]:
    import fsspec
    import pyarrow.parquet as pq

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
    spec = archive_source_spec("wsj")
    for row_index, raw_url in enumerate(values["url"]):
        source_url = str(raw_url or "").strip()
        hostname = str(
            values["url_hostname"][row_index] or ""
        ).casefold().rstrip(".")
        if hostname not in _WSJ_HOSTS:
            continue
        parsed_hostname = (
            urlsplit(source_url).hostname or ""
        ).casefold().rstrip(".")
        if parsed_hostname != hostname:
            continue
        canonical_url = normalize_article_url(spec, source_url)
        if canonical_url is None:
            continue
        published = _parse_publish_date(values["publish_date"][row_index])
        if published is None or published.year != year:
            continue
        url_published = wsj_article_publication_datetime(canonical_url)
        if url_published is not None and url_published.year != year:
            continue
        headline = " ".join(str(values["title"][row_index] or "").split())
        if len(_SIGNIFICANT_TOKEN_RE.findall(headline.casefold())) < 4:
            continue
        text_length = _optional_int(values["text_length"][row_index])
        if text_length is None or text_length < MINIMUM_TEXT_CHARACTERS:
            continue
        language = str(values["language"][row_index] or "").casefold()
        if language and not language.startswith("eng"):
            continue
        warc_filename = str(values["warc_filename"][row_index] or "").strip()
        if (
            not warc_filename.startswith("CC-NEWS-")
            or not warc_filename.endswith(".warc.gz")
        ):
            continue
        accepted.append(
            {
                "canonicalUrl": canonical_url,
                "sourceUrl": source_url,
                "publishedAt": published.isoformat(),
                "expectedHeadline": headline,
                "textLength": text_length,
                "warcFilename": warc_filename,
                "parquetRowIndex": row_index,
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
    rows = list(articles)
    now = _now_iso()
    with connection:
        connection.executemany(
            """
            INSERT INTO wsj_infini_direct_articles(
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
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(canonical_url) DO UPDATE SET
                source_url=excluded.source_url,
                published_at=excluded.published_at,
                expected_headline=excluded.expected_headline,
                document_index=COALESCE(
                    excluded.document_index,
                    wsj_infini_direct_articles.document_index
                ),
                text_length=excluded.text_length,
                warc_filename=excluded.warc_filename,
                parquet_path=excluded.parquet_path,
                parquet_row_index=excluded.parquet_row_index,
                updated_at=excluded.updated_at
            """,
            (
                (
                    row["canonicalUrl"],
                    row["sourceUrl"],
                    row["publishedAt"],
                    row["expectedHeadline"],
                    year,
                    row.get("documentIndex"),
                    row["textLength"],
                    row["warcFilename"],
                    path,
                    row["parquetRowIndex"],
                    now,
                )
                for row in rows
            ),
        )
        connection.executemany(
            """
            INSERT INTO wsj_infini_articles(
                canonical_url,
                published_at,
                expected_headline,
                source_year,
                query_id,
                document_index,
                warc_source,
                updated_at
            ) VALUES (?, ?, ?, ?, 'direct-hostname', NULL, ?, ?)
            ON CONFLICT(canonical_url) DO UPDATE SET
                published_at=MIN(
                    wsj_infini_articles.published_at,
                    excluded.published_at
                ),
                expected_headline=excluded.expected_headline,
                warc_source=excluded.warc_source,
                updated_at=excluded.updated_at
            """,
            (
                (
                    row["canonicalUrl"],
                    row["publishedAt"],
                    row["expectedHeadline"],
                    year,
                    row["warcFilename"],
                    now,
                )
                for row in rows
            ),
        )
        connection.execute(
            """
            UPDATE wsj_infini_direct_files
            SET status='complete',
                attempts=attempts+1,
                accepted_count=?,
                last_error=NULL,
                updated_at=?
            WHERE source_year=? AND file_path=?
            """,
            (len(rows), now, year, path),
        )


def _retryable_file_count(connection: sqlite3.Connection, year: int) -> int:
    return int(
        connection.execute(
            """
            SELECT COUNT(*)
            FROM wsj_infini_direct_files
            WHERE source_year=?
              AND (
                status='pending'
                OR (status='error' AND attempts < 3)
              )
            """,
            (year,),
        ).fetchone()[0]
    )


def _resolve_url(path: str) -> str:
    return HUGGING_FACE_RESOLVE_ENDPOINT + "/" + quote(path, safe="/=")


def _parse_publish_date(value: object) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
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
            FROM wsj_infini_direct_articles
            WHERE source_year=?
            """,
            (year,),
        ).fetchone()[0]
    )


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone() is not None


def _ensure_column(
    connection: sqlite3.Connection,
    table: str,
    column: str,
    definition: str,
) -> None:
    columns = {
        str(row[1])
        for row in connection.execute(f"PRAGMA table_info({table})")
    }
    if column not in columns:
        connection.execute(
            f"ALTER TABLE {table} ADD COLUMN {column} {definition}"
        )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
