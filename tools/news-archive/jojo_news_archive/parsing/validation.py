from __future__ import annotations

from datetime import datetime, timezone
from collections import Counter
import gzip
import hashlib
import heapq
import json
from pathlib import Path
import sqlite3
from typing import Iterable

from bs4 import BeautifulSoup

from jojo_news_archive.sources.registry import (
    archive_source_spec,
    article_deduplication_key,
    article_url_publication_year,
    is_parser_validation_candidate,
    normalize_article_url,
)
from jojo_news_archive.models import ArticleStatus, ContentType, RawCapture
from jojo_news_archive.parsing.parser import parse_article
from jojo_news_archive.parsing.policy import qa_policy_revision
from jojo_news_archive.parsing.validation_contracts import (
    CapturePriorityContext,
    ExistingSampleContext,
    SampleCandidateContext,
    ValidationContext,
    has_terminal_tandem_repeat,
)
from jojo_news_archive.parsing.validation_registry import source_validation_hooks
from jojo_news_archive.sources.registry import publisher_spec


SCHEMA_VERSION = "jojo-parser-validation/2"
DEFAULT_SEED = "jojo-parser-validation-v1"
HOLDOUT_SEED = "jojo-parser-holdout-v1"
MINIMUM_COMPLETE_RATE = 0.95
# Parser convergence is strict: one structural/content QA failure in a
# 300-sample cell must keep the cohort open for investigation.  The separate
# complete-rate gate remains below 1.0 because valid non-text interactives can
# intentionally be classified as unsupported while still passing QA.
MINIMUM_QA_PASS_RATE = 1.0
# Keep capacity reporting aligned with the capture scheduler.  Capture jobs
# use three attempts by default; terminal errors at that limit are no longer
# actionable candidates and must not keep the watchdog dispatching work for
# an exhausted URL.
DEFAULT_MAXIMUM_RECORD_ATTEMPTS = 3
_PAYWALL_PHRASES = (
    "subscribe to read",
    "subscribe to continue",
    "sign in to continue",
    "already a subscriber",
    "unlock this article",
)
_UI_NOISE_PHRASES = (
    "promoted by taboola",
    "promoted by revcontent",
    "sponsored content from around the web",
    "get livefyre",
    "text size regular medium large",
    "if you are not redirected automatically",
)
_EXACT_UI_NOISE_BLOCKS = (
    "trending stories",
)
def _has_generic_interface_noise(
    blocks: list[str],
    *,
    allow_editorial_read_more: bool = False,
) -> bool:
    """Detect standalone interface chrome without matching normal prose."""
    return any(
        text == "0 min read"
        or (text == "read more:" and not allow_editorial_read_more)
        or text == "promoted content"
        or text in _EXACT_UI_NOISE_BLOCKS
        or (len(text) >= 2 and set(text) == {"_"})
        or text.startswith("recommended *")
        or text.startswith("share on twitter (opens new window)")
        or text.startswith("follow the topics in this ")
        # A standalone share control is interface chrome.  Do not match the
        # phrase anywhere inside a paragraph: essays can legitimately use it
        # as ordinary editorial prose.
        or text == "share this article"
        or (
            text.startswith("get alerts on ")
            and text.endswith(" when a new story is published")
        )
        or any(phrase in text for phrase in _UI_NOISE_PHRASES)
        for text in blocks
    )


def initialize_parser_validation_schema(
    connection: sqlite3.Connection,
    *,
    invalidate_stale_results: bool = True,
) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS parser_validation_config (
            sample_year INTEGER PRIMARY KEY,
            target_size INTEGER NOT NULL,
            seed TEXT NOT NULL,
            parser_version TEXT NOT NULL DEFAULT '',
            qa_revision INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS parser_validation_samples (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL,
            sample_priority TEXT NOT NULL,
            selected_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_parser_validation_samples_year
            ON parser_validation_samples(sample_year, sample_priority);

        CREATE TABLE IF NOT EXISTS parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            publisher TEXT NOT NULL,
            sample_year INTEGER NOT NULL,
            parser_version TEXT,
            qa_revision INTEGER NOT NULL DEFAULT 0,
            extraction_status TEXT NOT NULL,
            content_type TEXT NOT NULL DEFAULT 'article',
            qa_pass INTEGER NOT NULL,
            body_characters INTEGER NOT NULL DEFAULT 0,
            block_count INTEGER NOT NULL DEFAULT 0,
            images_referenced INTEGER NOT NULL DEFAULT 0,
            images_selected INTEGER NOT NULL DEFAULT 0,
            duplicate_text_blocks INTEGER NOT NULL DEFAULT 0,
            headline_present INTEGER NOT NULL DEFAULT 0,
            published_at_present INTEGER NOT NULL DEFAULT 0,
            source_link_preserved INTEGER NOT NULL DEFAULT 0,
            warnings_json TEXT NOT NULL,
            issues_json TEXT NOT NULL,
            error TEXT,
            parsed_at TEXT NOT NULL,
            article_identity TEXT,
            source_raw_sha256 TEXT,
            source_capture_sha256 TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_parser_validation_results_year
            ON parser_validation_results(sample_year, qa_pass);

        CREATE TABLE IF NOT EXISTS parser_validation_exclusions (
            canonical_url TEXT PRIMARY KEY,
            source_cohort TEXT NOT NULL,
            excluded_at TEXT NOT NULL
        );
        """
    )
    config_columns = {
        str(row[1])
        for row in connection.execute(
            "PRAGMA table_info(parser_validation_config)"
        ).fetchall()
    }
    if "parser_version" not in config_columns:
        connection.execute(
            """
            ALTER TABLE parser_validation_config
            ADD COLUMN parser_version TEXT NOT NULL DEFAULT ''
            """
        )
    if "qa_revision" not in config_columns:
        connection.execute(
            """
            ALTER TABLE parser_validation_config
            ADD COLUMN qa_revision INTEGER NOT NULL DEFAULT 0
            """
        )
    result_columns = {
        str(row[1])
        for row in connection.execute(
            "PRAGMA table_info(parser_validation_results)"
        ).fetchall()
    }
    if "content_type" not in result_columns:
        connection.execute(
            """
            ALTER TABLE parser_validation_results
            ADD COLUMN content_type TEXT NOT NULL DEFAULT 'article'
            """
        )
    if "qa_revision" not in result_columns:
        connection.execute(
            """
            ALTER TABLE parser_validation_results
            ADD COLUMN qa_revision INTEGER NOT NULL DEFAULT 0
            """
        )
    if "source_raw_sha256" not in result_columns:
        connection.execute(
            """
            ALTER TABLE parser_validation_results
            ADD COLUMN source_raw_sha256 TEXT
            """
        )
    if "article_identity" not in result_columns:
        connection.execute(
            """
            ALTER TABLE parser_validation_results
            ADD COLUMN article_identity TEXT
            """
        )
    if "source_capture_sha256" not in result_columns:
        connection.execute(
            """
            ALTER TABLE parser_validation_results
            ADD COLUMN source_capture_sha256 TEXT
            """
        )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_parser_validation_results_identity
        ON parser_validation_results(
            publisher,
            sample_year,
            parser_version,
            qa_revision,
            article_identity,
            qa_pass
        )
        """
    )
    captures_exist = connection.execute(
        """
        SELECT 1 FROM sqlite_master
        WHERE type='table' AND name='captures'
        """
    ).fetchone()
    if captures_exist is not None and invalidate_stale_results:
        connection.execute(
            """
            DELETE FROM parser_validation_results
            WHERE canonical_url IN (
                SELECT result.canonical_url
                FROM parser_validation_results AS result
                CROSS JOIN captures AS capture
                  ON capture.canonical_url=result.canonical_url
                WHERE result.source_raw_sha256 IS NOT NULL
                  AND capture.status='complete'
                  AND capture.raw_sha256 IS NOT NULL
                  AND capture.raw_sha256 != result.source_raw_sha256
              )
            """
        )
    connection.commit()


def ensure_parser_validation_plan(
    connection: sqlite3.Connection,
    *,
    publisher: str,
    from_year: int,
    to_year: int,
    target_per_year: int,
    maximum_record_attempts: int,
    reserve_per_year: int | None = None,
    seed: str = DEFAULT_SEED,
) -> dict[str, object]:
    if from_year > to_year:
        raise ValueError("from_year must not exceed to_year")
    if target_per_year < 1:
        raise ValueError("target_per_year must be positive")
    if maximum_record_attempts < 1:
        raise ValueError("maximum_record_attempts must be positive")
    reserve = (
        reserve_per_year
        if reserve_per_year is not None
        else max(100, target_per_year // 2)
    )
    if reserve < 0:
        raise ValueError("reserve_per_year must not be negative")

    initialize_parser_validation_schema(connection)
    source_spec = archive_source_spec(publisher)
    hooks = source_validation_hooks(publisher)
    invalid_urls = [
        str(row[0])
        for row in connection.execute(
            """
            SELECT canonical_url, sample_year
            FROM parser_validation_samples
            WHERE sample_year >= ? AND sample_year <= ?
            """,
            (from_year, to_year),
        )
        if (
            article_deduplication_key(source_spec, str(row[0])) is None
            or not hooks.existing_sample_valid(
                ExistingSampleContext(
                    canonical_url=str(row[0]),
                    sample_year=int(row[1]),
                )
            )
            or (
                (
                    embedded_year := article_url_publication_year(
                        source_spec,
                        str(row[0]),
                    )
                )
                is not None
                and embedded_year != int(row[1])
            )
        )
    ]
    if invalid_urls:
        connection.executemany(
            """
            DELETE FROM parser_validation_results
            WHERE canonical_url=?
            """,
            ((url,) for url in invalid_urls),
        )
        connection.executemany(
            """
            DELETE FROM parser_validation_samples
            WHERE canonical_url=?
            """,
            ((url,) for url in invalid_urls),
        )
    now = _now_iso()
    current_parser_version = publisher_spec(publisher).parser_version
    current_qa_revision = qa_policy_revision(publisher)
    # Versions before this migration recorded every planned reserve URL as a
    # holdout exclusion, even when no parser-validation result was produced.
    # Keep the zero-overlap guarantee scoped to articles that were actually
    # evaluated and recover untouched reserve candidates for future cohorts.
    for year in range(from_year, to_year + 1):
        source_prefix = f"{publisher}:{year}:"
        connection.execute(
            """
            DELETE FROM parser_validation_exclusions
            WHERE substr(source_cohort, 1, ?) = ?
              AND NOT EXISTS (
                SELECT 1
                FROM parser_validation_results AS result
                WHERE result.canonical_url =
                      parser_validation_exclusions.canonical_url
              )
            """,
            (len(source_prefix), source_prefix),
        )
    previous_versions = {
        int(year): str(parser_version)
        for year, parser_version in connection.execute(
            """
            SELECT sample_year, parser_version
            FROM parser_validation_config
            WHERE sample_year >= ? AND sample_year <= ?
            """,
            (from_year, to_year),
        )
    }
    refreshed_years = {
        year
        for year in range(from_year, to_year + 1)
        if (
            year in previous_versions
            and previous_versions[year] != current_parser_version
        )
    }
    if refreshed_years:
        # A parser change requires an independent holdout cohort.  Preserve
        # every URL actually evaluated under the previous version before
        # dropping the old plan. Unevaluated reserve candidates remain
        # eligible because they were never part of the measured cohort.
        for year in sorted(refreshed_years):
            connection.execute(
                """
                INSERT OR IGNORE INTO parser_validation_exclusions(
                    canonical_url, source_cohort, excluded_at
                )
                SELECT sample.canonical_url, ?, ?
                FROM parser_validation_samples AS sample
                WHERE sample.sample_year=?
                  AND EXISTS (
                    SELECT 1
                    FROM parser_validation_results AS result
                    WHERE result.canonical_url=sample.canonical_url
                      AND result.sample_year=sample.sample_year
                  )
                """,
                (
                    f"{publisher}:{year}:{previous_versions[year]}",
                    now,
                    year,
                ),
            )
        placeholders = ",".join("?" for _ in refreshed_years)
        connection.execute(
            f"""
            DELETE FROM parser_validation_samples
            WHERE sample_year IN ({placeholders})
            """,
            sorted(refreshed_years),
        )
    connection.executemany(
        """
        INSERT INTO parser_validation_config(
            sample_year,
            target_size,
            seed,
            parser_version,
            qa_revision,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(sample_year) DO UPDATE SET
            target_size=excluded.target_size,
            seed=excluded.seed,
            parser_version=excluded.parser_version,
            qa_revision=excluded.qa_revision,
            updated_at=excluded.updated_at
        """,
        (
            (
                year,
                target_per_year,
                seed,
                current_parser_version,
                current_qa_revision,
                now,
            )
            for year in range(from_year, to_year + 1)
        ),
    )

    years: dict[str, dict[str, int]] = {}
    for year in range(from_year, to_year + 1):
        start = f"{year:04d}-01-01"
        end = f"{year + 1:04d}-01-01"
        available = int(
            connection.execute(
                """
                SELECT COUNT(*)
                FROM captures
                WHERE published_at >= ? AND published_at < ?
                """,
                (start, end),
            ).fetchone()[0]
        )
        evaluated = int(
            connection.execute(
                """
                SELECT COUNT(*)
                FROM parser_validation_results
                WHERE sample_year=?
                  AND parser_version=?
                  AND qa_revision=?
                """,
                (year, current_parser_version, current_qa_revision),
            ).fetchone()[0]
        )
        qa_passed = int(
            connection.execute(
                """
                SELECT COALESCE(SUM(qa_pass), 0)
                FROM parser_validation_results
                WHERE sample_year=?
                  AND parser_version=?
                  AND qa_revision=?
                """,
                (year, current_parser_version, current_qa_revision),
            ).fetchone()[0]
        )
        actionable = int(
            connection.execute(
                """
                SELECT COUNT(*)
                FROM parser_validation_samples AS sample
                JOIN captures AS capture
                  ON capture.canonical_url=sample.canonical_url
                LEFT JOIN parser_validation_results AS result
                  ON result.canonical_url=sample.canonical_url
                 AND result.parser_version=?
                 AND result.qa_revision=?
                WHERE sample.sample_year=?
                  AND result.canonical_url IS NULL
                  AND (
                    (
                      capture.status='complete'
                      AND capture.raw_path IS NOT NULL
                    )
                    OR
                    capture.status IN ('pending', 'downloading')
                    OR (
                      capture.status='error'
                      AND capture.attempts < ?
                    )
                  )
                """,
                (
                    current_parser_version,
                    current_qa_revision,
                    year,
                    maximum_record_attempts,
                ),
            ).fetchone()[0]
        )
        actionable_before_planning = actionable
        completed_actionable = int(
            connection.execute(
                """
                SELECT COUNT(*)
                FROM parser_validation_samples AS sample
                JOIN captures AS capture
                  ON capture.canonical_url=sample.canonical_url
                LEFT JOIN parser_validation_results AS result
                  ON result.canonical_url=sample.canonical_url
                 AND result.parser_version=?
                 AND result.qa_revision=?
                WHERE sample.sample_year=?
                  AND result.canonical_url IS NULL
                  AND capture.status='complete'
                  AND capture.raw_path IS NOT NULL
                """,
                (current_parser_version, current_qa_revision, year),
            ).fetchone()[0]
        )
        completed_needed = max(
            0,
            target_per_year - qa_passed - completed_actionable,
        )
        completed_selected = _select_additional_samples(
            connection,
            publisher=publisher,
            year=year,
            limit=completed_needed,
            seed=seed,
            completed_only=True,
        )
        connection.executemany(
            """
            INSERT OR IGNORE INTO parser_validation_samples(
                canonical_url, sample_year, sample_priority, selected_at
            )
            VALUES (?, ?, ?, ?)
            """,
            (
                (canonical_url, year, priority, now)
                for priority, canonical_url in completed_selected
            ),
        )
        actionable += len(completed_selected)
        desired_actionable = max(0, target_per_year - qa_passed) + reserve
        direct_selected: list[tuple[str, str]] = []
        exact_wayback_selected: list[tuple[str, str]] = []
        for preferred_pass in hooks.preferred_sampling_passes:
            if preferred_pass.mode == "provider-target":
                existing_preferred = int(
                    connection.execute(
                        """
                        SELECT COUNT(*)
                        FROM parser_validation_samples AS sample
                        JOIN captures AS capture
                          ON capture.canonical_url=sample.canonical_url
                        WHERE sample.sample_year=?
                          AND capture.candidates_json LIKE ?
                        """,
                        (
                            year,
                            f'%"provider":"{preferred_pass.provider}"%',
                        ),
                    ).fetchone()[0]
                )
                preferred_limit = max(
                    0,
                    desired_actionable - existing_preferred,
                )
            else:
                preferred_limit = max(0, desired_actionable - actionable)
            preferred_selected = _select_additional_samples(
                connection,
                publisher=publisher,
                year=year,
                limit=preferred_limit,
                seed=seed,
                completed_only=False,
                direct_provider=preferred_pass.provider,
            )
            connection.executemany(
                """
                INSERT OR IGNORE INTO parser_validation_samples(
                    canonical_url,
                    sample_year,
                    sample_priority,
                    selected_at
                )
                VALUES (?, ?, ?, ?)
                """,
                (
                    (canonical_url, year, priority, now)
                    for priority, canonical_url in preferred_selected
                ),
            )
            actionable += len(preferred_selected)
            if preferred_pass.summary == "exact-wayback":
                exact_wayback_selected.extend(preferred_selected)
            else:
                direct_selected.extend(preferred_selected)
        add_count = max(0, desired_actionable - actionable)
        selected = _select_additional_samples(
            connection,
            publisher=publisher,
            year=year,
            limit=add_count,
            seed=seed,
            completed_only=False,
        )
        connection.executemany(
            """
            INSERT OR IGNORE INTO parser_validation_samples(
                canonical_url, sample_year, sample_priority, selected_at
            )
            VALUES (?, ?, ?, ?)
            """,
            (
                (canonical_url, year, priority, now)
                for priority, canonical_url in selected
            ),
        )
        years[str(year)] = {
            "available": available,
            "evaluated": evaluated,
            "qaPassed": qa_passed,
            "actionableBeforePlanning": actionable_before_planning,
            "refreshedForParserVersion": int(year in refreshed_years),
            "addedCompletedToPlan": len(completed_selected),
            "addedDirectToPlan": len(direct_selected),
            "addedExactWaybackToPlan": len(exact_wayback_selected),
            "addedToPlan": (
                len(completed_selected)
                + len(direct_selected)
                + len(exact_wayback_selected)
                + len(selected)
            ),
        }
    connection.commit()
    return {
        "formatVersion": SCHEMA_VERSION,
        "publisher": publisher,
        "parserVersion": current_parser_version,
        "qaRevision": current_qa_revision,
        "targetPerYear": target_per_year,
        "reservePerYear": reserve,
        "years": years,
    }


def pending_parser_validation_urls(
    connection: sqlite3.Connection,
    *,
    maximum: int | None,
    maximum_record_attempts: int,
    from_year: int | None = None,
    to_year: int | None = None,
    initialize_schema: bool = True,
) -> list[str]:
    if initialize_schema:
        initialize_parser_validation_schema(
            connection,
            invalidate_stale_results=False,
        )
    def validation_priority(
        publisher: str,
        canonical_url: str,
        sample_year: int,
        status: str,
        last_error: str | None,
        candidates_json: str | None,
    ) -> int:
        try:
            decoded = json.loads(candidates_json or "[]")
        except (TypeError, ValueError):
            decoded = []
        candidates = tuple(
            candidate for candidate in decoded if isinstance(candidate, dict)
        )
        priority = source_validation_hooks(publisher).capture_priority(
            CapturePriorityContext(
                canonical_url=canonical_url,
                sample_year=int(sample_year),
                status=status,
                last_error=last_error or "",
                candidates_json=candidates_json or "[]",
                candidates=candidates,
            )
        )
        if len(priority) != 4 or any(value < 0 or value > 99 for value in priority):
            raise ValueError(f"invalid source validation priority: {priority!r}")
        return sum(
            value * scale
            for value, scale in zip(priority, (1_000_000, 10_000, 100, 1))
        )

    connection.create_function(
        "source_validation_priority",
        6,
        validation_priority,
        deterministic=True,
    )
    query = """
        WITH active_years AS (
            SELECT
                config.sample_year,
                config.target_size,
                config.parser_version,
                config.qa_revision,
                COALESCE(SUM(result.qa_pass), 0) AS qa_passed
            FROM parser_validation_config AS config
            LEFT JOIN parser_validation_results AS result
             ON result.sample_year=config.sample_year
             AND result.parser_version=config.parser_version
             AND result.qa_revision=config.qa_revision
            WHERE (? IS NULL OR config.sample_year >= ?)
              AND (? IS NULL OR config.sample_year <= ?)
            GROUP BY
                config.sample_year,
                config.target_size,
                config.parser_version,
                config.qa_revision
            HAVING COALESCE(SUM(result.qa_pass), 0) < config.target_size
        ),
        ranked AS (
            SELECT
                sample.canonical_url,
                sample.sample_year,
                ROW_NUMBER() OVER (
                    PARTITION BY sample.sample_year
                    ORDER BY
                        source_validation_priority(
                            capture.publisher,
                            capture.canonical_url,
                            sample.sample_year,
                            capture.status,
                            capture.last_error,
                            capture.candidates_json
                        ),
                        sample.sample_priority
                ) AS sample_rank
            FROM active_years
            CROSS JOIN parser_validation_samples AS sample
              ON sample.sample_year=active_years.sample_year
            CROSS JOIN captures AS capture
              ON capture.canonical_url=sample.canonical_url
            LEFT JOIN parser_validation_results AS result
              ON result.canonical_url=sample.canonical_url
             AND result.parser_version=active_years.parser_version
             AND result.qa_revision=active_years.qa_revision
            WHERE result.canonical_url IS NULL
              AND (
                capture.status='pending'
                OR (
                    capture.status='error'
                    AND capture.attempts < ?
                )
              )
        )
        SELECT canonical_url
        FROM ranked
        ORDER BY sample_rank, sample_year
    """
    parameters: list[object] = [
        from_year,
        from_year,
        to_year,
        to_year,
        maximum_record_attempts,
    ]
    if maximum is not None:
        query += " LIMIT ?"
        parameters.append(maximum)
    return [
        str(row[0])
        for row in connection.execute(query, parameters).fetchall()
    ]


def pending_completed_parser_validation_files(
    connection: sqlite3.Connection,
    *,
    maximum: int | None,
) -> list[tuple[str, str]]:
    initialize_parser_validation_schema(
        connection,
        invalidate_stale_results=False,
    )
    query = """
        WITH active_years AS (
            SELECT
                config.sample_year,
                config.target_size,
                config.parser_version,
                config.qa_revision,
                COALESCE(SUM(result.qa_pass), 0) AS qa_passed
            FROM parser_validation_config AS config
            LEFT JOIN parser_validation_results AS result
             ON result.sample_year=config.sample_year
             AND result.parser_version=config.parser_version
             AND result.qa_revision=config.qa_revision
            GROUP BY
                config.sample_year,
                config.target_size,
                config.parser_version,
                config.qa_revision
            HAVING COALESCE(SUM(result.qa_pass), 0) < config.target_size
        ),
        ranked AS (
            SELECT
                sample.canonical_url,
                capture.raw_path,
                sample.sample_year,
                active_years.target_size,
                active_years.qa_passed,
                ROW_NUMBER() OVER (
                    PARTITION BY sample.sample_year
                    ORDER BY sample.sample_priority
                ) AS sample_rank
            FROM parser_validation_samples AS sample
            JOIN active_years
              ON active_years.sample_year=sample.sample_year
            JOIN captures AS capture
              ON capture.canonical_url=sample.canonical_url
            LEFT JOIN parser_validation_results AS result
              ON result.canonical_url=sample.canonical_url
             AND result.parser_version=active_years.parser_version
             AND result.qa_revision=active_years.qa_revision
            WHERE result.canonical_url IS NULL
              AND capture.status='complete'
              AND capture.raw_path IS NOT NULL
        )
        SELECT canonical_url, raw_path
        FROM ranked
        WHERE sample_rank <= target_size - qa_passed
        ORDER BY sample_rank, sample_year
    """
    parameters: list[object] = []
    if maximum is not None:
        query += " LIMIT ?"
        parameters.append(maximum)
    return [
        (str(row[0]), str(row[1]))
        for row in connection.execute(query, parameters).fetchall()
    ]


def failed_completed_parser_validation_files(
    connection: sqlite3.Connection,
    *,
    maximum: int | None,
) -> list[tuple[str, str]]:
    initialize_parser_validation_schema(
        connection,
        invalidate_stale_results=False,
    )
    query = """
        SELECT
            result.canonical_url,
            capture.raw_path
        FROM parser_validation_results AS result
        JOIN parser_validation_config AS config
          ON config.sample_year=result.sample_year
         AND config.parser_version=result.parser_version
         AND config.qa_revision=result.qa_revision
        JOIN captures AS capture
          ON capture.canonical_url=result.canonical_url
        WHERE result.qa_pass=0
          AND capture.status='complete'
          AND capture.raw_path IS NOT NULL
        ORDER BY result.sample_year, result.canonical_url
    """
    parameters: list[object] = []
    if maximum is not None:
        query += " LIMIT ?"
        parameters.append(maximum)
    return [
        (str(row[0]), str(row[1]))
        for row in connection.execute(query, parameters).fetchall()
    ]


def is_parser_validation_sample(
    connection: sqlite3.Connection,
    canonical_url: str,
) -> bool:
    return (
        connection.execute(
            """
            SELECT 1
            FROM parser_validation_samples
            WHERE canonical_url=?
            """,
            (canonical_url,),
        ).fetchone()
        is not None
    )


def record_parser_validation(
    connection: sqlite3.Connection,
    *,
    capture: RawCapture,
    archive_root: Path,
) -> dict[str, object]:
    initialize_parser_validation_schema(
        connection,
        invalidate_stale_results=False,
    )
    sample_row = connection.execute(
        """
        SELECT sample_year
        FROM parser_validation_samples
        WHERE canonical_url=?
        """,
        (capture.canonical_url,),
    ).fetchone()
    if sample_row is None:
        return {"sample": False}

    sample_year = int(sample_row[0])
    planned_year = sample_year
    parsed_at = datetime.now(timezone.utc)
    capture_fingerprint = hashlib.sha256(
        json.dumps(
            capture.model_dump(mode="json"),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    values: dict[str, object] = {
        "canonical_url": capture.canonical_url,
        "publisher": capture.publisher,
        "sample_year": sample_year,
        "parser_version": None,
        "qa_revision": qa_policy_revision(capture.publisher),
        "extraction_status": ArticleStatus.ERROR.value,
        "content_type": ContentType.ARTICLE.value,
        "qa_pass": 0,
        "body_characters": 0,
        "block_count": 0,
        "images_referenced": 0,
        "images_selected": 0,
        "duplicate_text_blocks": 0,
        "headline_present": 0,
        "published_at_present": 0,
        "source_link_preserved": 0,
        "warnings_json": "[]",
        "issues_json": '["parser-exception"]',
        "error": None,
        "parsed_at": parsed_at.isoformat(),
        "article_identity": None,
        "source_raw_sha256": capture.raw_html.sha256,
        "source_capture_sha256": capture_fingerprint,
    }
    try:
        html_bytes = _read_capture_html(capture, archive_root)
        article = parse_article(
            html_bytes,
            publisher=capture.publisher,
            canonical_url=capture.canonical_url,
            raw_capture=capture,
            dependent_resources=_read_dependent_resources(
                capture,
                archive_root,
            ),
            parsed_at=parsed_at,
        )
        embedded_year = article_url_publication_year(
            archive_source_spec(capture.publisher),
            capture.canonical_url,
        )
        if embedded_year is not None:
            # The validation cohort is assigned from the source catalog's
            # publication year.  A parser-visible ``datePublished`` can be
            # stale (or reflect a later/earlier update) and must not move a
            # sample into another year's target.  Only a stable year encoded
            # in the canonical URL is authoritative enough to repair a
            # misplaced catalog row.
            sample_year = embedded_year
            values["sample_year"] = sample_year
            if sample_year != planned_year:
                connection.execute(
                    """
                    UPDATE parser_validation_samples
                    SET sample_year=?
                    WHERE canonical_url=?
                    """,
                    (sample_year, capture.canonical_url),
                )
        text_blocks = [
            _normalize_text(block.text)
            for block in article.blocks
            if block.text and _normalize_text(block.text)
        ]
        duplicate_blocks = len(text_blocks) - len(set(text_blocks))
        issues: list[str] = []
        nontext_content = article.content_type in {
            ContentType.INTERACTIVE,
            ContentType.VIDEO,
            ContentType.AUDIO,
            ContentType.GALLERY,
        }
        document = BeautifulSoup(html_bytes, "html.parser")
        raw_text = _normalize_text(document.get_text(" ", strip=True))
        normalized_blocks = tuple(text_blocks)
        publisher_blocks = (
            *normalized_blocks,
            *(
                (_normalize_text(article.description),)
                if article.description
                else ()
            ),
        )
        source_spec = archive_source_spec(capture.publisher)
        hooks = source_validation_hooks(capture.publisher)
        validation_context = ValidationContext(
            capture=capture,
            article=article,
            html_bytes=html_bytes,
            document=document,
            raw_text=raw_text,
            sample_year=sample_year,
            text_blocks=tuple(text_blocks),
            normalized_blocks=normalized_blocks,
            publisher_blocks=publisher_blocks,
            nontext_content=nontext_content,
            repeated_text_within_block=any(
                has_terminal_tandem_repeat(block) for block in text_blocks
            ),
            canonical_url_is_normalized=(
                normalize_article_url(source_spec, capture.canonical_url)
                == capture.canonical_url
            ),
            validation_candidate=is_parser_validation_candidate(
                source_spec,
                capture.canonical_url,
            ),
        )
        source_identity = hooks.article_identity(validation_context)
        if source_identity is None:
            normalized_body = _normalize_text(article.plain_text)
            source_identity = (
                "content-sha256:"
                + hashlib.sha256(normalized_body.encode("utf-8")).hexdigest()
                if len(normalized_body) >= 100
                else None
            )
        values["article_identity"] = source_identity
        issues: list[str] = list(hooks.issues(validation_context))
        if (
            article.quality.status != ArticleStatus.COMPLETE
            and not nontext_content
            and "nonarticle-desk" not in issues
        ):
            issues.append(f"extraction-{article.quality.status.value}")
        if not article.headline:
            issues.append("missing-headline")
        if not article.published_at:
            issues.append("missing-published-at")
        elif (
            publication_year_for_sample(
                article.published_at,
                capture.published_at,
            )
            != sample_year
            and "nonarticle-desk" not in issues
        ):
            # Archive catalogs for date-less canonical URLs can accidentally
            # assign the WARC capture year as the publication year. The body
            # parser is authoritative once it recovers a real article date:
            # reject this row so a same-year replacement can be sampled.
            issues.append("publication-year-mismatch")
        if article.canonical_url != capture.canonical_url:
            issues.append("source-link-mismatch")
        if duplicate_blocks:
            issues.append("duplicate-text-blocks")
        issues.extend(hooks.post_issues(validation_context))
        if (
            "nonarticle-desk" not in issues
            and (
                _has_generic_interface_noise(
                    list(normalized_blocks),
                    allow_editorial_read_more=hooks.allow_editorial_read_more,
                )
                or hooks.interface_noise(validation_context)
            )
        ):
            issues.append("interface-noise-in-body")
        if (
            values["article_identity"] is not None
            and "nonarticle-desk" not in issues
            and connection.execute(
                """
                SELECT 1
                FROM parser_validation_results
                WHERE publisher=?
                  AND sample_year=?
                  AND parser_version=?
                  AND qa_revision=?
                  AND article_identity=?
                  AND qa_pass=1
                  AND canonical_url != ?
                LIMIT 1
                """,
                (
                    capture.publisher,
                    sample_year,
                    article.extraction.parser_version,
                    values["qa_revision"],
                    values["article_identity"],
                    capture.canonical_url,
                ),
            ).fetchone()
            is not None
        ):
            # Publishers can expose one story under multiple canonical URLs.
            # Only one public URL may fill an independent validation slot.
            issues.append("nonarticle-desk")
        if (
            hooks.reject_article_buttons
            and article.content_type == ContentType.ARTICLE
            and "<button" in article.body_html.casefold()
        ):
            issues.append("interactive-control-in-body")
        prefix = article.plain_text[:1_500].casefold()
        if (
            article.quality.body_characters < 1_000
            and any(phrase in prefix for phrase in _PAYWALL_PHRASES)
        ):
            issues.append("suspected-paywall-shell")
        values.update(
            {
                "parser_version": article.extraction.parser_version,
                "extraction_status": article.quality.status.value,
                "content_type": article.content_type.value,
                "qa_pass": int(not issues),
                "body_characters": article.quality.body_characters,
                "block_count": article.quality.block_count,
                "images_referenced": article.quality.images_referenced,
                "images_selected": article.quality.images_selected,
                "duplicate_text_blocks": duplicate_blocks,
                "headline_present": int(bool(article.headline)),
                "published_at_present": int(article.published_at is not None),
                "source_link_preserved": int(
                    article.canonical_url == capture.canonical_url
                ),
                "warnings_json": json.dumps(
                    article.quality.warnings,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                "issues_json": json.dumps(
                    issues,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            }
        )
    except Exception as exc:
        values["error"] = f"{type(exc).__name__}: {exc}"

    with connection:
        connection.execute(
            """
            INSERT INTO parser_validation_results(
                canonical_url,
                publisher,
                sample_year,
                parser_version,
                qa_revision,
                extraction_status,
                content_type,
                qa_pass,
                body_characters,
                block_count,
                images_referenced,
                images_selected,
                duplicate_text_blocks,
                headline_present,
                published_at_present,
                source_link_preserved,
                warnings_json,
                issues_json,
                error,
                parsed_at,
                article_identity,
                source_raw_sha256,
                source_capture_sha256
            )
            VALUES (
                :canonical_url,
                :publisher,
                :sample_year,
                :parser_version,
                :qa_revision,
                :extraction_status,
                :content_type,
                :qa_pass,
                :body_characters,
                :block_count,
                :images_referenced,
                :images_selected,
                :duplicate_text_blocks,
                :headline_present,
                :published_at_present,
                :source_link_preserved,
                :warnings_json,
                :issues_json,
                :error,
                :parsed_at,
                :article_identity,
                :source_raw_sha256,
                :source_capture_sha256
            )
            ON CONFLICT(canonical_url) DO UPDATE SET
                parser_version=excluded.parser_version,
                qa_revision=excluded.qa_revision,
                extraction_status=excluded.extraction_status,
                content_type=excluded.content_type,
                qa_pass=excluded.qa_pass,
                body_characters=excluded.body_characters,
                block_count=excluded.block_count,
                images_referenced=excluded.images_referenced,
                images_selected=excluded.images_selected,
                duplicate_text_blocks=excluded.duplicate_text_blocks,
                headline_present=excluded.headline_present,
                published_at_present=excluded.published_at_present,
                source_link_preserved=excluded.source_link_preserved,
                warnings_json=excluded.warnings_json,
                issues_json=excluded.issues_json,
                error=excluded.error,
                parsed_at=excluded.parsed_at,
                article_identity=excluded.article_identity,
                source_raw_sha256=excluded.source_raw_sha256,
                source_capture_sha256=excluded.source_capture_sha256
            """,
            values,
        )
    return {
        "sample": True,
        "year": sample_year,
        "plannedYear": planned_year,
        "status": values["extraction_status"],
        "qaPass": bool(values["qa_pass"]),
        "issues": json.loads(str(values["issues_json"])),
        "error": values["error"],
    }


def parser_validation_summary(
    connection: sqlite3.Connection,
    *,
    maximum_record_attempts: int = DEFAULT_MAXIMUM_RECORD_ATTEMPTS,
) -> dict[str, object]:
    if maximum_record_attempts < 1:
        raise ValueError("maximum_record_attempts must be positive")
    initialize_parser_validation_schema(
        connection,
        invalidate_stale_results=False,
    )
    result: dict[str, object] = {
        "formatVersion": SCHEMA_VERSION,
        "ready": True,
        "gates": {
            "minimumSamplesPerYear": "configured per year",
            "minimumCompleteRate": MINIMUM_COMPLETE_RATE,
            "minimumQaPassRate": MINIMUM_QA_PASS_RATE,
            "maximumParserErrors": 0,
            "maximumUnboundCaptureInputs": 0,
        },
        "years": {},
    }
    years: dict[str, object] = {}
    configs = connection.execute(
        """
        SELECT sample_year, target_size, parser_version, qa_revision
        FROM parser_validation_config
        ORDER BY sample_year
        """
    ).fetchall()
    has_captures = bool(
        connection.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type='table' AND name='captures'
            """
        ).fetchone()
    )
    for sample_year, target_size, parser_version, qa_revision in configs:
        row = connection.execute(
            """
            SELECT
                COALESCE(SUM(
                    NOT EXISTS (
                        SELECT 1
                        FROM json_each(parser_validation_results.issues_json)
                        WHERE value IN (
                            'empty-nontext-content',
                            'nonarticle-desk',
                            'publication-year-mismatch'
                        )
                    )
                ), 0),
                COALESCE(SUM(
                    qa_pass
                    AND NOT EXISTS (
                        SELECT 1
                        FROM json_each(parser_validation_results.issues_json)
                        WHERE value IN (
                            'empty-nontext-content',
                            'nonarticle-desk',
                            'publication-year-mismatch'
                        )
                    )
                ), 0),
                COALESCE(SUM(
                    extraction_status='complete'
                    AND NOT EXISTS (
                        SELECT 1
                        FROM json_each(parser_validation_results.issues_json)
                        WHERE value IN (
                            'empty-nontext-content',
                            'nonarticle-desk',
                            'publication-year-mismatch'
                        )
                    )
                ), 0),
                COALESCE(SUM(
                    extraction_status='partial'
                    AND NOT EXISTS (
                        SELECT 1
                        FROM json_each(parser_validation_results.issues_json)
                        WHERE value IN (
                            'empty-nontext-content',
                            'nonarticle-desk',
                            'publication-year-mismatch'
                        )
                    )
                ), 0),
                COALESCE(SUM(
                    extraction_status='unsupported'
                    AND NOT EXISTS (
                        SELECT 1
                        FROM json_each(parser_validation_results.issues_json)
                        WHERE value IN (
                            'empty-nontext-content',
                            'nonarticle-desk',
                            'publication-year-mismatch'
                        )
                    )
                ), 0),
                COALESCE(SUM(
                    extraction_status='error'
                    AND NOT EXISTS (
                        SELECT 1
                        FROM json_each(parser_validation_results.issues_json)
                        WHERE value IN (
                            'empty-nontext-content',
                            'nonarticle-desk',
                            'publication-year-mismatch'
                        )
                    )
                ), 0),
                COALESCE(AVG(body_characters), 0),
                COALESCE(SUM(headline_present=0), 0),
                COALESCE(SUM(published_at_present=0), 0),
                COALESCE(SUM(duplicate_text_blocks > 0), 0),
                COALESCE(SUM(images_referenced), 0),
                COALESCE(SUM(images_selected), 0),
                COALESCE(SUM(images_referenced > 0), 0),
                COALESCE(SUM(images_selected > 0), 0)
                ,
                COALESCE(
                    SUM(
                        content_type IN (
                            'interactive',
                            'video',
                            'audio',
                            'gallery'
                        )
                    ),
                    0
                )
                ,
                COALESCE(SUM(source_capture_sha256 IS NULL), 0)
                ,
                COALESCE(SUM(
                    EXISTS (
                        SELECT 1
                        FROM json_each(parser_validation_results.issues_json)
                        WHERE value IN (
                            'empty-nontext-content',
                            'nonarticle-desk',
                            'publication-year-mismatch'
                        )
                    )
                ), 0)
            FROM parser_validation_results
            WHERE sample_year=?
              AND parser_version=?
              AND qa_revision=?
            """,
            (sample_year, parser_version, qa_revision),
        ).fetchone()
        evaluated = int(row[0])
        planned = int(
            connection.execute(
                """
                SELECT COUNT(*)
                FROM parser_validation_samples
                WHERE sample_year=?
                """,
                (sample_year,),
            ).fetchone()[0]
        )
        capacity: dict[str, int] = {}
        if has_captures:
            # Capacity must use the same normalized URL identity as holdout
            # selection.  Counting raw canonical rows here can overstate the
            # fresh sample pool when HTTP/HTTPS, www, query, or trailing-slash
            # aliases exist: the planner correctly treats those aliases as
            # overlap, while the old summary reported them as eligible.
            start = f"{int(sample_year):04d}-01-01"
            end = f"{int(sample_year) + 1:04d}-01-01"
            # Keep the raw row count alongside the normalized capacity.  The
            # watchdog uses this to tell whether the current validation
            # checkpoint already loaded the complete source manifest.  A
            # source sidecar's ``articles`` count includes aliases that
            # collapse to one story identity, so treating the sidecar count
            # as unseen growth after the manifest has been loaded can
            # repeatedly dispatch an empty replacement cohort.
            capacity["captureRows"] = int(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM captures
                    WHERE published_at >= ? AND published_at < ?
                    """,
                    (start, end),
                ).fetchone()[0]
            )
            publisher_row = connection.execute(
                "SELECT publisher FROM captures LIMIT 1"
            ).fetchone()
            if publisher_row is None:
                capacity["eligibleCandidates"] = 0
                capacity["excludedCandidates"] = 0
            else:
                source_spec = archive_source_spec(str(publisher_row[0]))
                excluded_normalized = {
                    normalized
                    for (canonical_url,) in connection.execute(
                        "SELECT canonical_url FROM parser_validation_exclusions"
                    )
                    if (
                        normalized := article_deduplication_key(
                            source_spec,
                            str(canonical_url),
                        )
                    )
                    is not None
                }
                eligible_normalized: set[str] = set()
                excluded_year_normalized: set[str] = set()
                nonarticle_candidates = 0
                for (canonical_url,) in connection.execute(
                    """
                    SELECT capture.canonical_url
                    FROM captures AS capture
                    WHERE capture.published_at >= ?
                      AND capture.published_at < ?
                      AND (
                        capture.status IN ('pending', 'downloading')
                        OR (
                          capture.status='error'
                          AND capture.attempts < ?
                        )
                        OR (
                          capture.status='complete'
                          AND capture.raw_path IS NOT NULL
                        )
                      )
                    """,
                    (start, end, maximum_record_attempts),
                ):
                    normalized = article_deduplication_key(
                        source_spec,
                        str(canonical_url),
                    )
                    if normalized is None:
                        continue
                    # Capacity must describe the same recoverable article
                    # pool that the holdout planner samples.  Publisher
                    # manifests intentionally retain photo/video/utility
                    # desks for provenance, but those rows are screened out
                    # by ``is_parser_validation_candidate`` and cannot fill
                    # an 800-article text cohort.  Counting them here makes
                    # source-limited years look healthy and causes the
                    # watchdog to dispatch futile replacement batches.
                    if not is_parser_validation_candidate(
                        source_spec,
                        str(canonical_url),
                    ):
                        nonarticle_candidates += 1
                        continue
                    if normalized in excluded_normalized:
                        excluded_year_normalized.add(normalized)
                    else:
                        eligible_normalized.add(normalized)
                capacity["eligibleCandidates"] = len(eligible_normalized)
                capacity["excludedCandidates"] = len(excluded_year_normalized)
                capacity["nonArticleCandidates"] = nonarticle_candidates
        issue_counts: Counter[str] = Counter()
        failure_examples: list[dict[str, object]] = []
        failure_rows = connection.execute(
            """
            SELECT
                canonical_url,
                extraction_status,
                body_characters,
                issues_json,
                error
            FROM parser_validation_results
            WHERE sample_year=?
              AND parser_version=?
              AND qa_revision=?
              AND qa_pass=0
            ORDER BY
                extraction_status='error' DESC,
                extraction_status='unsupported' DESC,
                body_characters,
                canonical_url
            """,
            (sample_year, parser_version, qa_revision),
        ).fetchall()
        for (
            canonical_url,
            extraction_status,
            body_characters,
            issues_json,
            error,
        ) in failure_rows:
            issues = json.loads(issues_json)
            issue_counts.update(str(issue) for issue in issues)
            if len(failure_examples) < 20:
                failure_examples.append(
                    {
                        "canonicalUrl": str(canonical_url),
                        "status": str(extraction_status),
                        "bodyCharacters": int(body_characters),
                        "issues": issues,
                        **({"error": str(error)} if error else {}),
                    }
                )
        target_reached = evaluated >= int(target_size)
        complete_rate = int(row[2]) / evaluated if evaluated else 0.0
        qa_pass_rate = int(row[1]) / evaluated if evaluated else 0.0
        year_ready = (
            target_reached
            and complete_rate >= MINIMUM_COMPLETE_RATE
            and qa_pass_rate >= MINIMUM_QA_PASS_RATE
            and int(row[5]) == 0
            and int(row[15]) == 0
        )
        result["ready"] = bool(result["ready"]) and year_ready
        years[str(sample_year)] = {
            "target": int(target_size),
            "parserVersion": str(parser_version),
            "qaRevision": int(qa_revision),
            "planned": planned,
            **capacity,
            "evaluated": evaluated,
            "targetReached": target_reached,
            "qaPassed": int(row[1]),
            "qaPassRate": round(qa_pass_rate, 4),
            "complete": int(row[2]),
            "completeRate": round(complete_rate, 4),
            "partial": int(row[3]),
            "unsupported": int(row[4]),
            "errors": int(row[5]),
            "averageBodyCharacters": round(float(row[6]), 2),
            "missingHeadline": int(row[7]),
            "missingPublishedAt": int(row[8]),
            "articlesWithDuplicateBlocks": int(row[9]),
            "imagesReferenced": int(row[10]),
            "imagesSelected": int(row[11]),
            "articlesWithImagesReferenced": int(row[12]),
            "articlesWithImagesSelected": int(row[13]),
            "imageSelectionRate": round(
                int(row[11]) / int(row[10]) if int(row[10]) else 0.0,
                4,
            ),
            "nonTextContent": int(row[14]),
            "unboundCaptureInputs": int(row[15]),
            "screenedNonArticles": int(row[16]),
            "issueCounts": dict(sorted(issue_counts.items())),
            "failureExamples": failure_examples,
        }
    result["years"] = years
    if not configs:
        result["ready"] = False
    return result


def parser_validation_target_reached(
    connection: sqlite3.Connection,
) -> bool:
    initialize_parser_validation_schema(
        connection,
        invalidate_stale_results=False,
    )
    rows = connection.execute(
        """
        SELECT
            config.target_size,
            COALESCE(SUM(result.qa_pass), 0)
        FROM parser_validation_config AS config
        LEFT JOIN parser_validation_results AS result
         ON result.sample_year=config.sample_year
         AND result.parser_version=config.parser_version
         AND result.qa_revision=config.qa_revision
         AND result.source_capture_sha256 IS NOT NULL
        GROUP BY
            config.sample_year,
            config.target_size,
            config.parser_version,
            config.qa_revision
        """
    ).fetchall()
    return bool(rows) and all(
        int(qa_passed) >= int(target_size)
        for target_size, qa_passed in rows
    )


def _select_additional_samples(
    connection: sqlite3.Connection,
    *,
    publisher: str,
    year: int,
    limit: int,
    seed: str,
    completed_only: bool,
    direct_provider: str | None = None,
) -> list[tuple[str, str]]:
    if limit <= 0:
        return []
    start = f"{year:04d}-01-01"
    end = f"{year + 1:04d}-01-01"
    selected: list[tuple[int, str, str]] = []
    completed_filter = (
        """
          AND capture.status='complete'
          AND capture.raw_path IS NOT NULL
        """
        if completed_only
        else ""
    )
    if direct_provider not in {
        None,
        "other",
        "infini-news",
        "wayback-exact",
    }:
        raise ValueError("unsupported direct capture provider")
    if direct_provider == "wayback-exact":
        direct_filter = """
          AND EXISTS (
            SELECT 1
            FROM json_each(capture.candidates_json)
            WHERE
              json_extract(value, '$.provider')='wayback'
              AND json_extract(value, '$.digest') IS NOT NULL
              AND json_extract(value, '$.capturedAt') IS NOT NULL
          )
        """
    elif direct_provider is not None:
        direct_filter = "AND capture.candidates_json LIKE ?"
    else:
        direct_filter = ""
    parameters: list[object] = [start, end]
    if direct_provider not in {None, "wayback-exact"}:
        parameters.append(f'%"provider":"{direct_provider}"%')
    source_spec = archive_source_spec(publisher)
    hooks = source_validation_hooks(publisher)
    excluded_normalized = {
        normalized
        for (canonical_url,) in connection.execute(
            "SELECT canonical_url FROM parser_validation_exclusions"
        )
        if (
            normalized := article_deduplication_key(
                source_spec,
                str(canonical_url),
            )
        )
        is not None
    }
    selected_normalized = {
        normalized
        for (canonical_url,) in connection.execute(
            "SELECT canonical_url FROM parser_validation_samples "
            "WHERE sample_year=?",
            (year,),
        )
        if (
            normalized := article_deduplication_key(
                source_spec,
                str(canonical_url),
            )
        )
        is not None
    }
    rows: Iterable[tuple[str, str]] = connection.execute(
        f"""
        SELECT capture.canonical_url, capture.candidates_json
        FROM captures AS capture
        LEFT JOIN parser_validation_samples AS sample
          ON sample.canonical_url=capture.canonical_url
        WHERE capture.published_at >= ?
          AND capture.published_at < ?
          AND (
            capture.status != 'complete'
            OR capture.raw_path IS NOT NULL
          )
          {completed_filter}
          {direct_filter}
          AND sample.canonical_url IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM parser_validation_exclusions AS exclusion
            WHERE exclusion.canonical_url=capture.canonical_url
          )
        ORDER BY
          (capture.status='complete') DESC,
          capture.canonical_url
        """,
        parameters,
    )
    seen_normalized = excluded_normalized | selected_normalized
    for canonical_url, candidates_json in rows:
        try:
            decoded_candidates = json.loads(str(candidates_json))
        except (TypeError, ValueError):
            decoded_candidates = []
        candidates = tuple(
            candidate
            for candidate in decoded_candidates
            if isinstance(candidate, dict)
        )
        normalized_url = article_deduplication_key(
            source_spec,
            str(canonical_url),
        )
        if normalized_url is None or normalized_url in seen_normalized:
            continue
        if not is_parser_validation_candidate(
            source_spec,
            str(canonical_url),
        ):
            continue
        if not hooks.sample_candidate_valid(
            SampleCandidateContext(
                canonical_url=str(canonical_url),
                sample_year=year,
                direct_provider=direct_provider,
                candidates=candidates,
            )
        ):
            continue
        # Legacy checkpoints can contain HTTP/HTTPS, bare/www, query-string,
        # or trailing-slash variants of the same article. SQL equality cannot
        # enforce a zero-overlap holdout across those representations.
        seen_normalized.add(normalized_url)
        embedded_year = article_url_publication_year(
            source_spec,
            str(canonical_url),
        )
        if embedded_year is not None and embedded_year != year:
            continue
        priority = hashlib.sha256(
            f"{seed}\0{publisher}\0{year}\0{normalized_url}".encode("utf-8")
        ).hexdigest()
        numeric = int(priority, 16)
        candidate = (-numeric, str(canonical_url), priority)
        if len(selected) < limit:
            heapq.heappush(selected, candidate)
        elif numeric < -selected[0][0]:
            heapq.heapreplace(selected, candidate)
    return sorted(
        ((priority, canonical_url) for _, canonical_url, priority in selected),
        key=lambda item: item[0],
    )


def _read_capture_html(capture: RawCapture, archive_root: Path) -> bytes:
    raw_path = archive_root / capture.raw_html.path
    if capture.raw_html.content_encoding == "gzip":
        with gzip.open(raw_path, "rb") as handle:
            content = handle.read()
    else:
        content = raw_path.read_bytes()
    actual = hashlib.sha256(content).hexdigest()
    if actual != capture.raw_html.sha256:
        raise ValueError(
            "raw HTML checksum mismatch: "
            f"expected {capture.raw_html.sha256}, got {actual}"
        )
    return content


def _read_dependent_resources(
    capture: RawCapture,
    archive_root: Path,
) -> dict[str, bytes]:
    resources: dict[str, bytes] = {}
    for resource in capture.dependent_resources:
        path = archive_root / resource.blob.path
        if resource.blob.content_encoding == "gzip":
            with gzip.open(path, "rb") as handle:
                content = handle.read()
        else:
            content = path.read_bytes()
        actual = hashlib.sha256(content).hexdigest()
        if actual != resource.blob.sha256:
            raise ValueError(
                "dependent resource checksum mismatch: "
                f"expected {resource.blob.sha256}, got {actual}"
            )
        resources[resource.source_url] = content
    return resources


def _normalize_text(value: str | None) -> str:
    return " ".join((value or "").split()).casefold()


def publication_year_for_sample(
    published_at: datetime | None,
    capture_published_at: datetime | None = None,
) -> int | None:
    """Return the publication year in the catalog record's local timezone.

    Archive catalogs retain the publisher-facing offset when one was
    available. A UTC timestamp just after midnight can therefore still be a
    story published on December 31 in the outlet's locale. Comparing the raw
    UTC ``year`` would falsely eject those boundary articles. Converting the
    parsed instant to the capture hint's timezone preserves the catalog's
    year convention while still rejecting genuine multi-year mismatches.
    """

    if published_at is None:
        return None
    comparison = published_at
    if comparison.tzinfo is None:
        comparison = comparison.replace(tzinfo=timezone.utc)
    if (
        capture_published_at is not None
        and capture_published_at.tzinfo is not None
        and capture_published_at.utcoffset() is not None
    ):
        comparison = comparison.astimezone(capture_published_at.tzinfo)
    return comparison.year


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
