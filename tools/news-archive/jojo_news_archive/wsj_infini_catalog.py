from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import random
import re
import sqlite3

from .archive_sources import ArchiveSourceSpec, normalize_article_url
from .bloomberg_archive_download import GlobalRateLimiter
from .infini_news import infini_news_row_url
from .news_models import CaptureCandidate, CaptureProvider


INFINI_FIND_ENDPOINT = "https://infini-news.uni-graz.at/api/v1/find"
INFINI_DOCUMENT_ENDPOINT = "https://infini-news.uni-graz.at/api/v1/get_doc"
WSJ_INFINI_FIRST_YEAR = 2016
WSJ_INFINI_LAST_YEAR = 2023
WSJ_INFINI_TARGET_PER_YEAR = 4_000
WSJ_INFINI_MINIMUM_BODY_CHARACTERS = 1_000
MAXIMUM_OCCURRENCES_PER_QUERY = 4_000
WSJ_ORIGIN_QUERY_SPECS = (
    (
        "articles-url-token",
        "wsj.com/articles",
        2016,
        2018,
    ),
    (
        "origin-host-token",
        "wsj.com",
        2016,
        2018,
    ),
    ("subscription", "WSJ subscription", 2016, 2017),
    (
        "continue-reading",
        "Continue reading your article",
        2018,
        2022,
    ),
    (
        "dow-jones-copyright",
        "Copyright ©{year} Dow Jones & Company, Inc. All Rights Reserved.",
        2017,
        2023,
    ),
    (
        "modern-paywall",
        (
            "Continue reading your article with\n"
            "a WSJ subscription\n"
            "Already a subscriber? Sign In"
        ),
        2023,
        2023,
    ),
    (
        "www-origin-host-token",
        "www.wsj.com",
        2016,
        2018,
    ),
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


def initialize_wsj_infini_schema(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS wsj_infini_queries (
            year INTEGER NOT NULL,
            query_id TEXT NOT NULL,
            query TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            occurrence_count INTEGER,
            shard_count INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(year, query_id)
        );

        CREATE TABLE IF NOT EXISTS wsj_infini_occurrences (
            year INTEGER NOT NULL,
            query_id TEXT NOT NULL,
            shard_index INTEGER NOT NULL,
            rank INTEGER NOT NULL,
            sample_priority INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            canonical_url TEXT,
            published_at TEXT,
            expected_headline TEXT,
            hostname TEXT,
            language TEXT,
            document_index INTEGER,
            document_length INTEGER,
            warc_source TEXT,
            last_error TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(year, query_id, shard_index, rank)
        );

        CREATE TABLE IF NOT EXISTS wsj_infini_articles (
            canonical_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            expected_headline TEXT NOT NULL,
            source_year INTEGER NOT NULL,
            query_id TEXT NOT NULL,
            document_index INTEGER,
            warc_source TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_wsj_infini_occurrence_status
            ON wsj_infini_occurrences(
                status,
                year,
                sample_priority
            );
        CREATE INDEX IF NOT EXISTS idx_wsj_infini_occurrence_article
            ON wsj_infini_occurrences(
                canonical_url,
                document_index,
                status,
                document_length
            );
        CREATE INDEX IF NOT EXISTS idx_wsj_infini_article_year
            ON wsj_infini_articles(published_at);
        """
    )
    first_year = max(from_year, WSJ_INFINI_FIRST_YEAR)
    last_year = min(to_year, WSJ_INFINI_LAST_YEAR)
    now = _now_iso()
    if first_year <= last_year:
        connection.executemany(
            """
            INSERT OR IGNORE INTO wsj_infini_queries(
                year,
                query_id,
                query,
                updated_at
            ) VALUES (?, ?, ?, ?)
            """,
            (
                (
                    year,
                    query_id,
                    query_template.format(year=year),
                    now,
                )
                for year in range(first_year, last_year + 1)
                for (
                    query_id,
                    query_template,
                    query_first_year,
                    query_last_year,
                ) in WSJ_ORIGIN_QUERY_SPECS
                if query_first_year <= year <= query_last_year
            ),
        )
    connection.commit()


def process_wsj_infini_queries(
    connection: sqlite3.Connection,
    *,
    http_client,
    maximum_queries: int,
) -> dict[str, object]:
    if maximum_queries < 1:
        raise ValueError("maximum_queries must be positive")
    rows = connection.execute(
        """
        SELECT item.year, item.query_id, item.query
        FROM wsj_infini_queries AS item
        WHERE (
                item.status='pending'
                OR (item.status='error' AND item.attempts < 3)
              )
          AND (
                SELECT COUNT(*)
                FROM wsj_infini_articles AS article
                WHERE substr(article.published_at, 1, 4)
                      = CAST(item.year AS TEXT)
              ) < ?
        ORDER BY item.year, item.query_id
        LIMIT ?
        """,
        (WSJ_INFINI_TARGET_PER_YEAR, maximum_queries),
    ).fetchall()
    processed = 0
    occurrences = 0
    errors: list[str] = []
    for year_value, query_id_value, query_value in rows:
        year = int(year_value)
        query_id = str(query_id_value)
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
                maximum=MAXIMUM_OCCURRENCES_PER_QUERY,
                seed=f"wsj:{year}:{query_id}:{query}",
            )
            now = _now_iso()
            with connection:
                connection.executemany(
                    """
                    INSERT OR IGNORE INTO wsj_infini_occurrences(
                        year,
                        query_id,
                        shard_index,
                        rank,
                        sample_priority,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        (
                            year,
                            query_id,
                            shard_index,
                            rank,
                            _sample_priority(
                                year,
                                query_id,
                                shard_index,
                                rank,
                            ),
                            now,
                        )
                        for shard_index, rank in sampled
                    ),
                )
                connection.execute(
                    """
                    UPDATE wsj_infini_queries
                    SET status='complete',
                        occurrence_count=?,
                        shard_count=?,
                        attempts=attempts+1,
                        last_error=NULL,
                        updated_at=?
                    WHERE year=? AND query_id=?
                    """,
                    (
                        int(payload.get("count") or len(sampled)),
                        len(segments),
                        now,
                        year,
                        query_id,
                    ),
                )
            processed += 1
            occurrences += len(sampled)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            errors.append(f"{year}/{query_id}: {error}")
            with connection:
                connection.execute(
                    """
                    UPDATE wsj_infini_queries
                    SET status='error',
                        attempts=attempts+1,
                        last_error=?,
                        updated_at=?
                    WHERE year=? AND query_id=?
                    """,
                    (error, _now_iso(), year, query_id),
                )
    return {
        "processed": processed,
        "occurrences": occurrences,
        "errors": errors,
    }


def process_wsj_infini_documents(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    http_client,
    maximum: int,
    workers: int = 4,
    minimum_request_interval: float = 0.5,
) -> dict[str, object]:
    if spec.publisher != "wsj":
        raise ValueError("WSJ Infini-News discovery requires the WSJ spec")
    if maximum < 1:
        raise ValueError("maximum must be positive")
    rows = _next_document_rows(connection, maximum=maximum)
    limiter = GlobalRateLimiter(minimum_request_interval)

    def fetch(
        row: tuple[int, str, str, int, int],
    ) -> tuple[
        tuple[int, str, str, int, int],
        dict[str, object] | None,
        str | None,
    ]:
        year, query_id, query, shard_index, rank = row
        try:
            limiter.wait()
            response = http_client.post(
                INFINI_DOCUMENT_ENDPOINT,
                json={
                    "query": query,
                    "index": "ccnews",
                    "year_min": year,
                    "year_max": year,
                    "s": shard_index,
                    "rank": rank,
                    "max_ctx_len": 1,
                },
            )
            response.raise_for_status()
            return row, _parse_document(response.json()), None
        except Exception as exc:
            return row, None, f"{type(exc).__name__}: {exc}"

    accepted = 0
    rejected = 0
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = {executor.submit(fetch, row): row for row in rows}
        for future in as_completed(futures):
            row, parsed, error = future.result()
            year, query_id, _, shard_index, rank = row
            if error is not None:
                errors.append(
                    f"{year}/{query_id}/{shard_index}/{rank}: {error}"
                )
                _record_error(
                    connection,
                    year=year,
                    query_id=query_id,
                    shard_index=shard_index,
                    rank=rank,
                    error=error,
                )
                continue
            assert parsed is not None
            reason = _rejection_reason(
                parsed,
                spec=spec,
                source_year=year,
            )
            if reason is not None:
                rejected += 1
                _record_rejection(
                    connection,
                    year=year,
                    query_id=query_id,
                    shard_index=shard_index,
                    rank=rank,
                    parsed=parsed,
                    reason=reason,
                )
                continue
            accepted += 1
            _record_acceptance(
                connection,
                year=year,
                query_id=query_id,
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


def wsj_infini_articles(
    connection: sqlite3.Connection,
) -> dict[str, str]:
    if not _table_exists(connection, "wsj_infini_articles"):
        return {}
    return {
        str(canonical_url): str(published_at)
        for canonical_url, published_at in connection.execute(
            """
            SELECT canonical_url, published_at
            FROM wsj_infini_articles
            ORDER BY canonical_url
            """
        )
    }


def wsj_infini_capture_candidates(
    connection: sqlite3.Connection,
) -> dict[str, dict[str, object]]:
    """Export validated dataset rows as derived WSJ capture candidates."""
    if not _table_exists(connection, "wsj_infini_articles") or not (
        _table_exists(connection, "wsj_infini_occurrences")
    ):
        return {}
    result: dict[str, dict[str, object]] = {}
    for (
        canonical_url,
        expected_headline,
        source_year,
        document_index,
        warc_source,
    ) in connection.execute(
        """
        SELECT
            article.canonical_url,
            article.expected_headline,
            article.source_year,
            article.document_index,
            article.warc_source
        FROM wsj_infini_articles AS article
        WHERE article.document_index IS NOT NULL
          AND EXISTS (
              SELECT 1
              FROM wsj_infini_occurrences AS occurrence
              WHERE occurrence.status='accepted'
                AND occurrence.canonical_url=article.canonical_url
                AND occurrence.document_index=article.document_index
                AND occurrence.document_length>=?
          )
        ORDER BY article.canonical_url
        """,
        (WSJ_INFINI_MINIMUM_BODY_CHARACTERS,),
    ):
        candidate = CaptureCandidate(
            provider=CaptureProvider.INFINI_NEWS,
            snapshot_url=infini_news_row_url(
                int(source_year),
                int(document_index),
            ),
            source_url=str(canonical_url),
            expected_headline=str(expected_headline),
            warc_filename=str(warc_source),
        )
        result[str(canonical_url)] = candidate.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        )
    return result


def wsj_infini_count_for_year(
    connection: sqlite3.Connection,
    year: int,
) -> int:
    if not _table_exists(connection, "wsj_infini_articles"):
        return 0
    return int(
        connection.execute(
            """
            SELECT COUNT(*)
            FROM wsj_infini_articles
            WHERE substr(published_at, 1, 4)=?
            """,
            (str(year),),
        ).fetchone()[0]
    )


def wsj_infini_should_continue(
    connection: sqlite3.Connection,
) -> bool:
    if not _table_exists(connection, "wsj_infini_queries"):
        return False
    for table, year_expression in (
        ("wsj_infini_queries", "CAST(item.year AS TEXT)"),
        ("wsj_infini_occurrences", "CAST(item.year AS TEXT)"),
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
                    FROM wsj_infini_articles AS article
                    WHERE substr(article.published_at, 1, 4)
                          = {year_expression}
                  ) < ?
            LIMIT 1
            """,
            (WSJ_INFINI_TARGET_PER_YEAR,),
        ).fetchone():
            return True
    return False


def wsj_infini_summary(
    connection: sqlite3.Connection,
) -> dict[str, object] | None:
    if not _table_exists(connection, "wsj_infini_queries"):
        return None
    return {
        "queriesByStatus": _status_counts(
            connection,
            "wsj_infini_queries",
        ),
        "occurrencesByStatus": _status_counts(
            connection,
            "wsj_infini_occurrences",
        ),
        "articlesByYear": {
            str(year): int(count)
            for year, count in connection.execute(
                """
                SELECT substr(published_at, 1, 4), COUNT(*)
                FROM wsj_infini_articles
                GROUP BY 1
                ORDER BY 1
                """
            )
        },
        "shouldContinue": wsj_infini_should_continue(connection),
    }


def _next_document_rows(
    connection: sqlite3.Connection,
    *,
    maximum: int,
) -> list[tuple[int, str, str, int, int]]:
    return [
        (
            int(year),
            str(query_id),
            str(query),
            int(shard_index),
            int(rank),
        )
        for (
            year,
            query_id,
            query,
            shard_index,
            rank,
        ) in connection.execute(
            """
            WITH eligible AS (
                SELECT
                    item.year,
                    item.query_id,
                    query.query,
                    item.shard_index,
                    item.rank,
                    ROW_NUMBER() OVER (
                        PARTITION BY item.year
                        ORDER BY item.sample_priority
                    ) AS year_position
                FROM wsj_infini_occurrences AS item
                JOIN wsj_infini_queries AS query
                  ON query.year=item.year
                 AND query.query_id=item.query_id
                WHERE (
                        item.status='pending'
                        OR (item.status='error' AND item.attempts < 3)
                      )
                  AND (
                        SELECT COUNT(*)
                        FROM wsj_infini_articles AS article
                        WHERE substr(article.published_at, 1, 4)
                              = CAST(item.year AS TEXT)
                      ) < ?
            )
            SELECT year, query_id, query, shard_index, rank
            FROM eligible
            ORDER BY year_position, year, query_id
            LIMIT ?
            """,
            (WSJ_INFINI_TARGET_PER_YEAR, maximum),
        )
    ]


def _parse_document(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise ValueError("Infini-News document response is invalid")
    metadata = payload.get("metadata")
    if not isinstance(metadata, dict):
        raise ValueError("Infini-News document metadata is missing")
    return {
        "url": metadata.get("url"),
        "publishedAt": _parse_metadata_date(metadata.get("date")),
        "expectedHeadline": _clean_title(metadata.get("title")),
        "hostname": str(metadata.get("hostname") or "").casefold(),
        "language": str(metadata.get("language") or "").casefold(),
        "documentIndex": _optional_int(payload.get("doc_ix")),
        "documentLength": _optional_int(payload.get("doc_len")),
        "warcSource": str(metadata.get("warc_source") or ""),
    }


def _rejection_reason(
    parsed: dict[str, object],
    *,
    spec: ArchiveSourceSpec,
    source_year: int,
) -> str | None:
    raw_url = parsed.get("url")
    canonical_url = (
        normalize_article_url(spec, raw_url)
        if isinstance(raw_url, str)
        else None
    )
    if canonical_url is None:
        return "not-wsj-origin"
    published_at = parsed.get("publishedAt")
    published = (
        _parse_datetime(published_at)
        if isinstance(published_at, str)
        else None
    )
    if published is None:
        return "missing-publication-date"
    if published.year != source_year:
        return "publication-year-mismatch"
    headline = parsed.get("expectedHeadline")
    if (
        not isinstance(headline, str)
        or len(_significant_tokens(headline)) < 4
    ):
        return "missing-headline"
    if parsed.get("language") not in {"", "eng"}:
        return "non-english"
    document_length = parsed.get("documentLength")
    if not isinstance(document_length, int) or document_length < 300:
        return "document-too-short"
    warc_source = parsed.get("warcSource")
    if (
        not isinstance(warc_source, str)
        or not warc_source.startswith("CC-NEWS-")
        or not warc_source.endswith(".warc.gz")
    ):
        return "missing-warc-provenance"
    parsed["canonicalUrl"] = canonical_url
    return None


def _record_acceptance(
    connection: sqlite3.Connection,
    *,
    year: int,
    query_id: str,
    shard_index: int,
    rank: int,
    parsed: dict[str, object],
) -> None:
    now = _now_iso()
    with connection:
        _update_occurrence(
            connection,
            year=year,
            query_id=query_id,
            shard_index=shard_index,
            rank=rank,
            status="accepted",
            parsed=parsed,
            error=None,
            now=now,
        )
        connection.execute(
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(canonical_url) DO UPDATE SET
                published_at=MIN(
                    wsj_infini_articles.published_at,
                    excluded.published_at
                ),
                expected_headline=excluded.expected_headline,
                document_index=excluded.document_index,
                warc_source=excluded.warc_source,
                updated_at=excluded.updated_at
            """,
            (
                parsed["canonicalUrl"],
                parsed["publishedAt"],
                parsed["expectedHeadline"],
                year,
                query_id,
                parsed["documentIndex"],
                parsed["warcSource"],
                now,
            ),
        )


def _record_rejection(
    connection: sqlite3.Connection,
    *,
    year: int,
    query_id: str,
    shard_index: int,
    rank: int,
    parsed: dict[str, object],
    reason: str,
) -> None:
    with connection:
        _update_occurrence(
            connection,
            year=year,
            query_id=query_id,
            shard_index=shard_index,
            rank=rank,
            status="rejected",
            parsed=parsed,
            error=reason,
            now=_now_iso(),
        )


def _update_occurrence(
    connection: sqlite3.Connection,
    *,
    year: int,
    query_id: str,
    shard_index: int,
    rank: int,
    status: str,
    parsed: dict[str, object],
    error: str | None,
    now: str,
) -> None:
    connection.execute(
        """
        UPDATE wsj_infini_occurrences
        SET status=?,
            attempts=attempts+1,
            canonical_url=?,
            published_at=?,
            expected_headline=?,
            hostname=?,
            language=?,
            document_index=?,
            document_length=?,
            warc_source=?,
            last_error=?,
            updated_at=?
        WHERE year=? AND query_id=? AND shard_index=? AND rank=?
        """,
        (
            status,
            parsed.get("canonicalUrl"),
            parsed.get("publishedAt"),
            parsed.get("expectedHeadline"),
            parsed.get("hostname"),
            parsed.get("language"),
            parsed.get("documentIndex"),
            parsed.get("documentLength"),
            parsed.get("warcSource"),
            error,
            now,
            year,
            query_id,
            shard_index,
            rank,
        ),
    )


def _record_error(
    connection: sqlite3.Connection,
    *,
    year: int,
    query_id: str,
    shard_index: int,
    rank: int,
    error: str,
) -> None:
    with connection:
        connection.execute(
            """
            UPDATE wsj_infini_occurrences
            SET status='error',
                attempts=attempts+1,
                last_error=?,
                updated_at=?
            WHERE year=? AND query_id=? AND shard_index=? AND rank=?
            """,
            (
                error,
                _now_iso(),
                year,
                query_id,
                shard_index,
                rank,
            ),
        )


def _sample_occurrence_ranks(
    segments: list[object],
    *,
    maximum: int,
    seed: str,
) -> list[tuple[int, int]]:
    normalized: list[tuple[int, int, int, int]] = []
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
        if end > start:
            normalized.append((total, total + end - start, shard_index, start))
            total += end - start
    if total == 0:
        return []
    randomizer = random.Random(
        int.from_bytes(
            hashlib.sha256(seed.encode()).digest()[:8],
            byteorder="big",
        )
    )
    positions = randomizer.sample(range(total), min(total, maximum))
    result: list[tuple[int, int]] = []
    for position in positions:
        for lower, upper, shard_index, start in normalized:
            if lower <= position < upper:
                result.append(
                    (shard_index, start + position - lower)
                )
                break
    return result


def _sample_priority(
    year: int,
    query_id: str,
    shard_index: int,
    rank: int,
) -> int:
    digest = hashlib.sha256(
        f"wsj-infini:{year}:{query_id}:{shard_index}:{rank}".encode()
    ).digest()
    return int.from_bytes(digest[:8], byteorder="big") & ((1 << 63) - 1)


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


def _parse_datetime(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _clean_title(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    title = re.sub(r"\s+", " ", value).strip()
    title = re.sub(
        r"\s+(?:[-|]\s*)?(?:The\s+)?Wall\s+Street\s+Journal\s*$",
        "",
        title,
        flags=re.IGNORECASE,
    )
    return title or None


def _significant_tokens(value: str) -> set[str]:
    return {
        token
        for token in _SIGNIFICANT_TOKEN_RE.findall(value.casefold())
        if token not in _STOP_WORDS
    }


def _optional_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError, OverflowError):
        return None


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
