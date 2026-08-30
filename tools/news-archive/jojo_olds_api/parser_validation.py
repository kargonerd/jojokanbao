from __future__ import annotations

from datetime import datetime, timezone
from collections import Counter
import gzip
import hashlib
import heapq
import json
from pathlib import Path
import re
import sqlite3
from typing import Iterable
from urllib.parse import urlsplit

from bs4 import BeautifulSoup, Tag

from .archive_sources import (
    archive_source_spec,
    article_deduplication_key,
    article_url_publication_year,
    ft_content_uuid_creation_year,
    is_parser_validation_candidate,
    normalize_article_url,
)
from .news_models import ArticleStatus, ContentType, RawCapture
from .news_parser import _terminal_tandem_repeat_length, parse_article
from .parser_qa_policy import qa_policy_revision
from .publisher_specs import publisher_spec
from .infini_news import is_ft_subscription_headline


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
    "bloomberg professional service subscriber",
)
_UI_NOISE_PHRASES = (
    "promoted by taboola",
    "promoted by revcontent",
    "sponsored content from around the web",
    "more from reuters sponsored content",
    "our standards: the thomson reuters trust principles",
    "get livefyre",
    "text size regular medium large",
    "if you are not redirected automatically",
    "save article log in to save subscribe to wsj",
    "market wire, all rights reserved",
    "copyright the financial times limited",
    "this content requires an adobe flash plugin",
    "your plugin is either missing or out of date",
    "follow @financialtimesfashion on instagram",
    "ft subscriber? sign up for the weekly working it newsletter",
    "see acast.com/privacy for privacy and opt-out information",
)
_EXACT_UI_NOISE_BLOCKS = (
    "trending stories",
)
_PLACEHOLDER_IMAGE_MARKERS = (
    "wsj-social-share",
    "wsj_logo_black_social",
    "wsj_profile_lg",
    "wsjsection.",
    "rcom-default.png",
    "r-generic-hdr.png",
    "og-ft-logo",
    "social-default",
    "/__assets/creatives/brand-ft/icons/v2/open-graph.png",
)


def _wsj_validation_article_identity(
    html_bytes: bytes,
    canonical_url: str,
) -> str | None:
    """Read WSJ's stable article id across slug and legacy URL aliases."""

    url_match = re.search(r"(?i)(?:^|[/=])(SB\d{20,})(?:$|[/?&#])", canonical_url)
    if url_match is not None:
        return "wsj:" + url_match.group(1).upper()
    for pattern in (
        rb'''(?i)data-articleid\s*=\s*["'](SB\d{20,})["']''',
        rb'''(?i)["']articleId["']\s*:\s*["'](SB\d{20,})["']''',
        rb"(?i)(?:[?&]|\b)articleid=(SB\d{20,})(?:&|[\"'])",
    ):
        match = re.search(pattern, html_bytes)
        if match is not None:
            return "wsj:" + match.group(1).decode("ascii").upper()
    return None


def _validation_article_identity(
    publisher: str,
    html_bytes: bytes,
    canonical_url: str,
    plain_text: str,
) -> str | None:
    """Identify one editorial article across distinct public URL aliases."""

    if publisher == "wsj":
        stable_identity = _wsj_validation_article_identity(
            html_bytes,
            canonical_url,
        )
        if stable_identity is not None:
            return stable_identity
    if publisher == "scmp":
        article_id = re.search(
            r"(?i)(?:^|/)article/(\d+)(?:$|[/?#])",
            urlsplit(canonical_url).path,
        )
        if article_id is not None:
            # SCMP can republish one numeric CMS article under multiple slugs
            # after a headline edit.  The numeric id is stable across those
            # public aliases and must occupy only one validation slot.
            return "scmp:article:" + article_id.group(1)
    normalized_body = _normalize_text(plain_text)
    if len(normalized_body) < 100:
        return None
    return "content-sha256:" + hashlib.sha256(
        normalized_body.encode("utf-8")
    ).hexdigest()


def is_axios_internal_test_entry(
    canonical_url: str,
    headline: str | None,
) -> bool:
    """Identify confirmed Axios CMS fixtures without matching real test news."""
    slug = urlsplit(canonical_url).path.rstrip("/").rsplit("/", 1)[-1].casefold()
    normalized_headline = _normalize_text(headline).casefold()
    known_fixtures = {
        "axios-generate-test": "axios generate test",
        "test-this-is-second-persons-post": (
            "test: this is second person's post"
        ),
    }
    return any(
        normalized_headline == expected
        and re.fullmatch(rf"{re.escape(prefix)}-\d+", slug) is not None
        for prefix, expected in known_fixtures.items()
    )


def _has_publisher_interface_noise(
    publisher: str,
    blocks: list[str],
) -> bool:
    """Catch repeated publisher chrome that generic quality metrics miss."""
    if publisher == "ap" and "." in blocks:
        return True
    if publisher == "axios":
        return any(
            text.rstrip(":") == "more from axios"
            or text.startswith("subscribe to axios ")
            for text in blocks
        )
    if publisher == "wsj":
        if any(
            text.startswith(
                "buy side from wsj expert recommendations "
                "on products and services"
            )
            for text in blocks
        ):
            return True
        for index, text in enumerate(blocks):
            nearby = " ".join(blocks[index : index + 3])
            if (
                text == "stay informed"
                and "get a coronavirus briefing" in nearby
                and "sign up here" in nearby
            ):
                return True
        theme_navigation = {
            "free resources",
            "live updates",
            "daily video briefing",
        }
        if theme_navigation.issubset(set(blocks)):
            return True
        if any(
            len(text) <= 300
            and text.startswith("sign up for our")
            and "sign up for our" in text
            and "newsletter" in text
            for text in blocks
        ):
            return True
    if publisher == "bloomberg":
        return any(
            text == "watch this next"
            or text.rstrip(":") == "related stories"
            or (
                text.startswith("sign up to receive the brexit bulletin")
                and "departure from the eu" in text
            )
            or (
                text.startswith("subscribe to bloomberg benchmark")
                and ("pocketcast" in text or "itunes" in text)
            )
            or (
                "sign up to receive" in text
                and "green daily" in text
                and "newsletter" in text
            )
            or text.startswith(
                "for even more: subscribe to bloomberg all access"
            )
            or (
                text.startswith("want to receive this post in your inbox")
                and "sign up for" in text
                and "newsletter" in text
            )
            for text in blocks
        )
    if publisher == "nyt":
        return any(
            text.startswith("sign up for weekly updates on ")
            and text.endswith(" from the times.")
            for text in blocks
        )
    if publisher == "reuters":
        return any(
            (
                # Reuters press releases can legitimately discuss copyright
                # and include an ``all rights reserved`` sentence in the
                # substantive body.  Interface footers are short standalone
                # blocks; require a bounded block length before classifying
                # this legal boilerplate as publisher chrome.
                len(text) <= 1000
                and "all rights reserved" in text
                and any(
                    marker in text
                    for marker in (
                        "copyright",
                        "(c) reuters",
                        "marketwire",
                        "market wire",
                        "business wire",
                    )
                )
            )
            or (
                len(text) <= 1000
                and "republication or redistribution ofreuters content" in text
            )
            for text in blocks
        )
    if publisher == "ft":
        return any(
            "stay briefed with our coronavirus newsletter" in text
            or text == "."
            or text.startswith(
                "subscribe to the rachman review wherever you get your "
                "podcasts"
            )
            or text == "sign up for the survey!"
            or (
                text.startswith("sign up for the britain")
                and "healthiest workplace survey" in text
            )
            or text.startswith(
                "sign up for the financial times markets news channel"
            )
            or re.match(
                r"^sign up for the ft(?:'|’)s due diligence newsletter\b",
                text,
            ) is not None
            or (
                text.startswith("sign up to scoreboard")
                and "must-read weekly briefing" in text
            )
            for text in blocks
        )
    return False


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
        # phrase anywhere inside a paragraph: legacy NYT essays legitimately
        # use prose such as “By the way, share this article. Please.”
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
            or (
                publisher in {"axios", "wsj"}
                and normalize_article_url(source_spec, str(row[0]))
                != str(row[0])
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
            or (
                publisher == "ft"
                and (
                    ft_created_year := ft_content_uuid_creation_year(
                        str(row[0])
                    )
                )
                is not None
                and (
                    ft_created_year > int(row[1])
                    or ft_created_year < int(row[1]) - 1
                )
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
        if publisher == "ft":
            existing_direct = int(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM parser_validation_samples AS sample
                    JOIN captures AS capture
                      ON capture.canonical_url=sample.canonical_url
                    WHERE sample.sample_year=?
                      AND capture.candidates_json
                          LIKE '%"provider":"infini-news"%'
                    """,
                    (year,),
                ).fetchone()[0]
            )
            direct_selected = _select_additional_samples(
                connection,
                publisher=publisher,
                year=year,
                limit=max(0, desired_actionable - existing_direct),
                seed=seed,
                completed_only=False,
                direct_provider="infini-news",
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
                    for priority, canonical_url in direct_selected
                ),
            )
            actionable += len(direct_selected)
        if publisher == "bloomberg":
            exact_wayback_selected = _select_additional_samples(
                connection,
                publisher=publisher,
                year=year,
                limit=max(0, desired_actionable - actionable),
                seed=seed,
                completed_only=False,
                direct_provider="wayback-exact",
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
                    for priority, canonical_url in exact_wayback_selected
                ),
            )
            actionable += len(exact_wayback_selected)
        add_count = max(0, desired_actionable - actionable)
        if publisher == "nyt" and add_count:
            direct_selected = _select_additional_samples(
                connection,
                publisher=publisher,
                year=year,
                limit=add_count,
                seed=seed,
                completed_only=False,
                direct_provider="other",
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
                    for priority, canonical_url in direct_selected
                ),
            )
            actionable += len(direct_selected)
            add_count -= len(direct_selected)
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
                        CASE capture.status
                            WHEN 'pending' THEN 1
                            ELSE CASE
                                -- A failed canonical WSJ article can use the
                                -- independently archived AMP representation
                                -- on its next attempt. Retry it before adding
                                -- more first-pass subscription previews; the
                                -- random validation cohort itself is unchanged.
                                WHEN capture.publisher = 'wsj'
                                  AND capture.canonical_url LIKE '%/articles/%'
                                    THEN 0
                                WHEN capture.last_error LIKE
                                     '%server-placeholder-shell%'
                                    THEN 0
                                ELSE 2
                            END
                        END,
                        CASE
                            WHEN capture.publisher = 'ft'
                              AND EXISTS (
                                SELECT 1
                                FROM json_each(capture.candidates_json)
                                WHERE json_extract(value, '$.provider')
                                    = 'infini-news'
                            ) THEN 0
                            WHEN capture.publisher != 'wsj' THEN 1
                            -- The validation cohort remains the same random
                            -- sample.  Only execute its already-indexed,
                            -- provenance-bearing full-text candidates before
                            -- low-yield replay guesses so each checkpoint
                            -- banks the strongest evidence first.
                            WHEN EXISTS (
                                SELECT 1
                                FROM json_each(capture.candidates_json)
                                WHERE json_extract(value, '$.provider')
                                    = 'infini-news'
                            ) THEN 0
                            WHEN EXISTS (
                                SELECT 1
                                FROM json_each(capture.candidates_json)
                                WHERE json_extract(value, '$.provider')
                                    = 'arquivo-pt'
                            ) THEN 1
                            WHEN EXISTS (
                                SELECT 1
                                FROM json_each(capture.candidates_json)
                                WHERE json_extract(value, '$.provider')
                                    = 'other'
                            ) THEN 2
                            ELSE 3
                        END,
                        CASE
                            WHEN capture.publisher != 'wsj' THEN 0
                            -- Calendar snapshots are date-pinned Wayback
                            -- replays added for the current WSJ cohort.  They
                            -- are usually much more useful than the older
                            -- CDX candidates, even when those candidates
                            -- advertise a larger byte count.  Keep the
                            -- random cohort unchanged, but spend each
                            -- validation batch on these stronger candidates
                            -- first.
                            WHEN capture.candidates_json LIKE '%000000id_%'
                                THEN 0
                            -- WSJ changed its archived page shape after the
                            -- legacy 2016 cohort.  In 2018+ cohorts, prefer
                            -- the larger CDX responses before the 30-50 KiB
                            -- shells that were high-yield only in 2016.
                            WHEN capture.candidates_json LIKE '%tpl=%'
                                THEN CASE
                                    WHEN sample.sample_year >= 2018 THEN 7
                                    ELSE 5
                                END
                            WHEN sample.sample_year >= 2018
                              AND COALESCE((
                                SELECT MAX(CAST(
                                    json_extract(value, '$.byteCount')
                                    AS INTEGER
                                ))
                                FROM json_each(capture.candidates_json)
                            ), 0) >= 200000 THEN 0
                            WHEN sample.sample_year >= 2018
                              AND COALESCE((
                                SELECT MAX(CAST(
                                    json_extract(value, '$.byteCount')
                                    AS INTEGER
                                ))
                                FROM json_each(capture.candidates_json)
                            ), 0) >= 100000 THEN 1
                            WHEN sample.sample_year >= 2018
                              AND capture.candidates_json LIKE '%tesla=y%'
                                THEN 2
                            WHEN sample.sample_year >= 2018
                              AND COALESCE((
                                SELECT MAX(CAST(
                                    json_extract(value, '$.byteCount')
                                    AS INTEGER
                                ))
                                FROM json_each(capture.candidates_json)
                            ), 0) >= 50000 THEN 3
                            WHEN sample.sample_year >= 2018
                              AND COALESCE((
                                SELECT MAX(CAST(
                                    json_extract(value, '$.byteCount')
                                    AS INTEGER
                                ))
                                FROM json_each(capture.candidates_json)
                            ), 0) >= 30000 THEN 4
                            WHEN sample.sample_year >= 2018
                              AND COALESCE((
                                SELECT MAX(CAST(
                                    json_extract(value, '$.byteCount')
                                    AS INTEGER
                                ))
                                FROM json_each(capture.candidates_json)
                            ), 0) >= 20000 THEN 5
                            WHEN sample.sample_year >= 2018 THEN 6
                            -- In the 2016 WSJ validation cohort, every
                            -- attempted capture whose largest CDX response
                            -- was 30-50 KiB produced usable full text.  The
                            -- smaller shells were overwhelmingly paywalls.
                            WHEN COALESCE((
                                SELECT MAX(CAST(
                                    json_extract(value, '$.byteCount')
                                    AS INTEGER
                                ))
                                FROM json_each(capture.candidates_json)
                            ), 0) >= 30000
                              AND COALESCE((
                                SELECT MAX(CAST(
                                    json_extract(value, '$.byteCount')
                                    AS INTEGER
                                ))
                                FROM json_each(capture.candidates_json)
                            ), 0) < 50000 THEN 0
                            WHEN capture.candidates_json LIKE '%tesla=y%'
                                THEN 1
                            WHEN COALESCE((
                                SELECT MAX(CAST(
                                    json_extract(value, '$.byteCount')
                                    AS INTEGER
                                ))
                                FROM json_each(capture.candidates_json)
                            ), 0) >= 50000 THEN 2
                            WHEN COALESCE((
                                SELECT MAX(CAST(
                                    json_extract(value, '$.byteCount')
                                    AS INTEGER
                                ))
                                FROM json_each(capture.candidates_json)
                            ), 0) >= 20000 THEN 3
                            ELSE 4
                        END,
                        CASE
                            -- NPR's legacy Wayback captures are frequently
                            -- 503-limited or parser-unusable.  Keep the
                            -- random cohort unchanged, but replay its
                            -- provenance-bearing Common Crawl rows before
                            -- those low-yield Wayback rows.
                            WHEN capture.publisher = 'npr'
                              AND EXISTS (
                                SELECT 1
                                FROM json_each(capture.candidates_json)
                                WHERE json_extract(value, '$.provider')
                                    = 'commoncrawl'
                            ) THEN 0
                            WHEN capture.publisher = 'npr' THEN 1
                            -- Nikkei's indexed Wayback captures in the
                            -- 2012-2015 cohort overwhelmingly contain only
                            -- membership excerpts.  Keep the randomly chosen
                            -- article cohort unchanged, but replay its
                            -- provenance-bearing Common Crawl rows before
                            -- low-yield Wayback rows.
                            WHEN capture.publisher = 'nikkei'
                              AND EXISTS (
                                SELECT 1
                                FROM json_each(capture.candidates_json)
                                WHERE json_extract(value, '$.provider')
                                    = 'commoncrawl'
                            ) THEN 0
                            WHEN capture.publisher = 'nikkei' THEN 1
                            WHEN EXISTS (
                                SELECT 1
                                FROM json_each(capture.candidates_json)
                                WHERE
                                    json_extract(value, '$.provider')
                                        = 'wayback'
                                    AND json_extract(value, '$.digest')
                                        IS NOT NULL
                                    AND json_extract(value, '$.capturedAt')
                                        IS NOT NULL
                            )
                            THEN 0
                            WHEN capture.candidates_json
                                 LIKE '%"provider":"infini-news"%'
                            THEN 0
                            WHEN capture.candidates_json
                                 LIKE '%"provider":"other"%'
                            THEN 1
                            ELSE 2
                        END,
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
        values["article_identity"] = _validation_article_identity(
            capture.publisher,
            html_bytes,
            capture.canonical_url,
            article.plain_text,
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
        # Axios video landing pages can carry valid article metadata and a
        # poster image while containing neither a transcript nor any other
        # recoverable editorial body.  They are useful catalog records, but
        # must not fill one of the 800 article-validation slots.
        if (
            capture.publisher == "axios"
            and nontext_content
            and article.quality.body_characters == 0
        ):
            issues.append("empty-nontext-content")
        if capture.publisher == "axios" and is_axios_internal_test_entry(
            capture.canonical_url,
            article.headline,
        ):
            issues.append("nonarticle-desk")
        # Axios video packages and subscription-confirmation routes can carry
        # valid metadata while exposing no recoverable article prose. Keep
        # those raw captures, but exclude them from the text-article cohort.
        if (
            capture.publisher == "axios"
            and article.content_type == ContentType.VIDEO
            and article.quality.body_characters < 200
        ):
            issues.append("nonarticle-desk")
        if (
            capture.publisher == "axios"
            and re.search(
                r"(?i)(?:^|/)thank-you-for-subscribing(?:/|$)",
                urlsplit(capture.canonical_url).path,
            )
        ):
            issues.append("nonarticle-desk")
        # Axios special-report landing pages expose a headline and a poster
        # image but only a short ``Read the story`` hand-off to the actual
        # package. Preserve the landing page while excluding it from the
        # text-article denominator.
        if (
            capture.publisher == "axios"
            and article.quality.body_characters < 100
        ):
            axios_text = _normalize_text(
                BeautifulSoup(html_bytes, "html.parser").get_text(
                    " ",
                    strip=True,
                )
            ).casefold()
            if "special report" in axios_text and "read the story" in axios_text:
                # A structured Axios landing page can be marked COMPLETE
                # because its only body block is the short ``Read the story``
                # handoff. It is still not a text article for QA purposes.
                issues.append("nonarticle-desk")
        # A few legacy Axios CMS test/placeholder pages are neither videos
        # nor special-report landing pages.  They can still produce a short
        # partial extraction (for example, ``Day 91`` or ``Latest story``),
        # which would otherwise be counted as a parser failure and consume a
        # validation slot.  Keep the raw capture, but screen only short,
        # non-complete Axios shells from the text-article cohort.  Complete
        # short-form articles are intentionally left untouched.
        if (
            capture.publisher == "axios"
            and article.quality.status != ArticleStatus.COMPLETE
            and article.quality.body_characters < 100
            and "nonarticle-desk" not in issues
        ):
            issues.append("nonarticle-desk")
        if capture.publisher == "axios" and normalize_article_url(
            archive_source_spec("axios"),
            capture.canonical_url,
        ) != capture.canonical_url:
            issues.append("nonarticle-desk")
        # Preserve Caixin's photo/video desks in the raw archive and parser
        # coverage, but do not let their one-image landing pages dominate the
        # independently sampled article-validation cohort.
        if capture.publisher == "caixin" and capture.canonical_url.startswith(
            ("https://photos.caixin.com/", "https://video.caixin.com/")
        ):
            issues.append("nonarticle-desk")
        # FT Wayback snapshots sometimes contain only the subscription shell.
        # Its title is stable and the apparent body is entirely navigation and
        # upsell chrome, so preserve the capture but keep it out of article QA.
        if capture.publisher == "ft":
            ft_soup = BeautifulSoup(html_bytes, "html.parser")
            title = (
                _normalize_text(ft_soup.title.get_text(" ", strip=True))
                if ft_soup.title
                else ""
            ).casefold()
            if title == "subscribe to read | financial times" and (
                not article.headline
                or is_ft_subscription_headline(article.headline)
            ):
                issues.append("nonarticle-desk")
            # FT's sitemap can expose a generic ``/content/<uuid>`` URL that
            # Wayback redirects to the first-party ``/video/<uuid>`` page.
            # The archived player page retains a headline, poster and short
            # description but no article transcript.  The canonical URL alone
            # therefore looks like an article and cannot screen the package;
            # use the provenance-preserved final URL to keep this video record
            # in the raw archive without consuming a text-article QA slot.
            if re.search(
                r"(?i)https?://(?:www\.)?ft\.com/video/",
                capture.final_url or "",
            ):
                issues.append("nonarticle-desk")
            # Legacy FT Photo Diary records use ordinary ``/content/<uuid>``
            # URLs and NewsArticle markup, but the source package is only a
            # one-sentence image caption (the archived image may be absent).
            # The stable Photo Diary navigation link distinguishes these
            # records from genuinely short text articles. Weekend Quiz answer
            # keys are likewise editorial game material rather than news.
            has_photo_diary_link = ft_soup.select_one(
                "a[href='/photo-diary'], a[href='https://www.ft.com/photo-diary']"
            ) is not None
            if (
                has_photo_diary_link
                and article.quality.body_characters <= 250
            ) or re.fullmatch(
                r"(?i)ft weekend quiz solutions",
                _normalize_text(article.headline or ""),
            ):
                issues.append("nonarticle-desk")
        # NYT's sitemap includes utility entries from the printed-paper
        # package. Empty corrections notices and the one-line quotation card
        # are editorial metadata, not news articles to count toward the
        # article-parser cohort. Older quotation cards lived below
        # ``/pageoneplus/`` before moving to ``/todayspaper/``; screen both
        # URL families so a short utility card cannot fail an otherwise clean
        # independent cohort. Keep them visible in screening statistics.
        if capture.publisher == "nyt" and re.search(
            r"(?i)^https://(?:www\.)?nytimes\.com/20\d{2}/\d{2}/\d{2}/(?:"
            r"pageoneplus/(?:(?:no-)?corrections|quotation-of-the-day)"
            r"(?:-|\.)|"
            r"todayspaper/quotation-of-the-day(?:-|\.))",
            capture.canonical_url,
        ):
            issues.append("nonarticle-desk")
        # Al Jazeera's archived LiveBlog pages can be valid editorial
        # packages but still expose only a short closing shell when the
        # client-rendered update stream was not captured. Do not let such an
        # unrecoverable dynamic package consume an article-validation slot;
        # keep the capture and liveblog classification for later replay.
        if (
            capture.publisher == "aljazeera"
            and article.content_type == ContentType.LIVEBLOG
            and article.quality.status != ArticleStatus.COMPLETE
        ):
            issues.append("nonarticle-desk")
        if (
            capture.publisher in {"aljazeera", "nyt"}
            and not is_parser_validation_candidate(
                archive_source_spec(capture.publisher),
                capture.canonical_url,
            )
        ):
            # Re-screen already selected samples when a publisher's URL
            # policy changes. This rotates templated/non-independent routes
            # out of the denominator without deleting their raw captures.
            issues.append("nonarticle-desk")
        # SCMP Wayback/Common Crawl captures sometimes preserve only article
        # metadata plus an explicit access shell (for example ``READ FULL
        # ARTICLE``). There is no body for the parser to recover; keep the
        # raw capture but do not count it as a parser failure.
        if (
            capture.publisher == "scmp"
            and article.quality.status
            in {ArticleStatus.UNSUPPORTED, ArticleStatus.PARTIAL}
            and (
                "/infographics/" in capture.canonical_url.casefold()
                or re.search(
                    r"(?:^|[-/])gallery(?:$|[-/?])",
                    capture.canonical_url.casefold(),
                )
                or article.quality.body_characters < 100
            )
        ):
            # Newsletter/image packages can be archived as valid Apollo
            # metadata with a slideshow cover and no prose body. They use
            # normal ``/news/article/`` URLs, so URL-only screening misses
            # them; the Apollo marker is the reliable media-only signal.
            apollo_media_only = bool(
                re.search(
                    rb"\"displaySlideShow\"\s*:\s*true",
                    html_bytes,
                    re.IGNORECASE,
                )
            )
            carousel_media_only = bool(
                re.search(
                    rb"\"carousel_slideshow_items\"\s*:\s*\"[1-9]",
                    html_bytes,
                    re.IGNORECASE,
                )
            )
            # Young Post also publishes image-led explainers below ordinary
            # ``/yp/.../article/`` routes.  They do not carry the legacy
            # slideshow flags: the Apollo body is intentionally one
            # infographic followed by a short source credit, while the
            # article summary explicitly calls the package an infographic.
            # Keep the raw HTML and selected editorial image, but do not
            # treat the absent prose body as a parser extraction failure.
            scmp_infographic_media_only = bool(
                article.quality.images_selected > 0
                and re.search(
                    rb"\bthis\s+infographic\b",
                    html_bytes,
                    re.IGNORECASE,
                )
                and _normalize_text(article.plain_text)
                .casefold()
                .startswith("all information from ")
            )
            short_infographic_handoff = bool(
                article.quality.images_selected > 0
                and re.fullmatch(
                    r"(?i)click to view the full-size infographic(?: in high resolution)?\.?",
                    _normalize_text(article.plain_text),
                )
            )
            if (
                "/infographics/" in capture.canonical_url.casefold()
                or re.search(
                    r"(?:^|[-/])gallery(?:$|[-/?])",
                    capture.canonical_url.casefold(),
                )
                or apollo_media_only
                or carousel_media_only
                or scmp_infographic_media_only
                or short_infographic_handoff
            ):
                issues.append("nonarticle-desk")
            else:
                raw_text = _normalize_text(
                    BeautifulSoup(html_bytes, "html.parser").get_text(
                        " ",
                        strip=True,
                    )
                ).casefold()
                if any(
                    marker in raw_text
                    for marker in (
                        "read full article",
                        "sign in/up",
                        "subscribe to read",
                        "subscribe to continue",
                    )
                ):
                    issues.append("nonarticle-desk")
        scmp_path = (
            urlsplit(capture.canonical_url).path.casefold()
            if capture.publisher == "scmp"
            else ""
        )
        # SCMP's About Us and announcement sections are publisher corporate
        # pages, not newsroom articles. Some long recruitment pages parse as
        # COMPLETE, so screen these paths independently of extraction status.
        if (
            capture.publisher == "scmp"
            and scmp_path.startswith(("/about-us/", "/announcements/"))
            and "nonarticle-desk" not in issues
        ):
            issues.append("nonarticle-desk")
        # SCMP's corporate announcements are a separate information desk,
        # not newsroom text articles. Archived Young Post releases can also
        # preserve an explicit article-body component that is completely
        # empty while the rest of the document contains only recommendation
        # cards. In both cases the raw snapshot has no body for a parser to
        # recover, so retain it without consuming an article-validation row.
        if (
            capture.publisher == "scmp"
            and article.quality.status
            in {ArticleStatus.UNSUPPORTED, ArticleStatus.PARTIAL}
            and "nonarticle-desk" not in issues
        ):
            scmp_document = BeautifulSoup(html_bytes, "html.parser")
            empty_structured_body = scmp_document.select_one(
                "[class*='ArticleContent__StyledBody-']"
            )
            unrecoverable_empty_body = bool(
                isinstance(empty_structured_body, Tag)
                and not _normalize_text(
                    empty_structured_body.get_text(" ", strip=True)
                )
                and empty_structured_body.select_one(
                    "img, picture, iframe, video, audio"
                )
                is None
            )
            series_label = scmp_document.select_one(
                ".subheadline, [class*='subheadline']"
            )
            scmp_series_package = bool(
                isinstance(series_label, Tag)
                and _normalize_text(series_label.get_text(" ", strip=True)).casefold()
                == "scmp series"
            )
            temporary_outage = bool(
                _normalize_text(article.headline or "").casefold() == "sorry..."
                and "site will be unavailable for a short period"
                in _normalize_text(
                    scmp_document.get_text(" ", strip=True)
                ).casefold()
            )
            subscription_campaign_redirect = bool(
                "subscribe.scmp.com/"
                in (capture.final_url or "").casefold()
            )
            # Wayback can resolve an old ``/article/<id>/...`` URL to the
            # later SCMP topic bearing the same slug. The replay is a real,
            # substantial document, but it is a topic index with no article
            # body. Preserve it without treating the redirect as a parser
            # extraction failure.
            scmp_og_type = scmp_document.select_one(
                "meta[property='og:type']"
            )
            redirected_topic_index = bool(
                "/article/" in scmp_path
                and "/topics/"
                in urlsplit(capture.final_url or "").path.casefold()
                and (
                    scmp_document.select_one(
                        ".topic-view, .panel-content-topic, .section-topics"
                    )
                    is not None
                    or (
                        isinstance(scmp_og_type, Tag)
                        and str(scmp_og_type.get("content", "")).casefold()
                        == "website"
                    )
                )
            )
            young_post_answer_key = bool(
                scmp_path.startswith("/yp/")
                and re.match(
                    r"(?i)^(?:turbo english|listening|(?:news )?quiz) answers\b",
                    article.headline or "",
                )
            )
            if (
                "/announcements/" in scmp_path
                or unrecoverable_empty_body
                or scmp_series_package
                or temporary_outage
                or subscription_campaign_redirect
                or redirected_topic_index
                or young_post_answer_key
            ):
                issues.append("nonarticle-desk")
        # Image-only SCMP graphics are valid archived media records and the
        # parser preserves their body image as a gallery. They are not text
        # articles for the independent 800-row article denominator. Native
        # campaigns that redirect to multimedia.scmp.com can likewise retain
        # only a title/social-image shell after the interactive payload is
        # lost; preserve the raw capture and select a replacement article.
        if (
            capture.publisher == "scmp"
            and article.quality.body_characters < 100
            and "nonarticle-desk" not in issues
        ):
            scmp_marker_text = " ".join(
                value
                for value in (
                    capture.canonical_url,
                    article.headline,
                    article.description,
                )
                if value
            )
            image_led_graphic = bool(
                article.content_type == ContentType.GALLERY
                and article.quality.images_selected > 0
                and re.search(
                    r"(?i)\b(?:info)?graphic\b",
                    scmp_marker_text,
                )
            )
            branded_multimedia_shell = bool(
                article.quality.status != ArticleStatus.COMPLETE
                and scmp_path.startswith(("/native/", "/presented/"))
                and "multimedia.scmp.com"
                in (capture.final_url or "").casefold()
            )
            if image_led_graphic or branded_multimedia_shell:
                issues.append("nonarticle-desk")
        # SCMP live-sport packages often archive only the introduction while
        # the update stream is client-rendered and absent from the snapshot.
        # Keep those raw packages and their LIVEBLOG type, but do not count a
        # short unrecoverable shell as a text-parser extraction failure.
        if (
            capture.publisher == "scmp"
            and article.content_type == ContentType.LIVEBLOG
            and article.quality.status != ArticleStatus.COMPLETE
            and article.quality.body_characters < 200
        ):
            issues.append("nonarticle-desk")
        # Zaobao's article sitemap also contains interactive packages and
        # horse-racing result pages.  The former can arrive through a
        # canonical news URL but redirect to ``interactive.zaobao.com.sg``;
        # the latter expose a short structured-results shell rather than a
        # text article.  Keep both captures for provenance without counting
        # them as parser extraction failures.
        if capture.publisher == "zaobao":
            final_url = (capture.final_url or "").casefold()
            canonical_url = capture.canonical_url.casefold()
            if (
                "interactive.zaobao.com.sg" in final_url
                or "/horse-racing/race-results/" in canonical_url
            ):
                issues.append("nonarticle-desk")
            elif (
                "/forum/" in canonical_url
                and article.quality.status
                in {ArticleStatus.UNSUPPORTED, ArticleStatus.PARTIAL}
                and article.quality.body_characters < 100
            ):
                # Legacy Zaobao forum URLs can expose a misleading OG/title
                # headline while replaying only a short navigation/teaser
                # shell. Retain the capture but keep it out of the
                # recoverable text-article denominator.
                issues.append("nonarticle-desk")
            elif (
                article.quality.status != ArticleStatus.COMPLETE
                and article.quality.body_characters < 100
                and (
                    article.quality.body_characters == 0
                    or "点击视频" in article.plain_text
                    or "视频观看" in article.plain_text
                )
            ):
                # Legacy Zaobao video teasers and empty special-report shells
                # retain a headline/images but no recoverable article prose.
                issues.append("nonarticle-desk")
            elif (
                "/shorts/" in canonical_url
                and article.content_type == ContentType.VIDEO
                and article.quality.body_characters < 100
            ):
                # The modern ``shorts`` desk can be a video-first package.
                # Its archived HTML retains the headline, poster and related
                # stories but no text body; do not count that media shell as
                # a parser extraction failure.
                issues.append("nonarticle-desk")
        # NPR's legacy audio-only pages can retain a headline and player while
        # exposing no recoverable text body. Preserve the raw/audio record,
        # but do not let an unrecoverable short audio shell fill an article
        # validation slot. Audio stories with a complete transcript remain in
        # the article cohort.
        if (
            capture.publisher == "npr"
            and article.content_type == ContentType.AUDIO
            and article.quality.status != ArticleStatus.COMPLETE
            and article.quality.body_characters < 200
        ):
            issues.append("nonarticle-desk")
        # Some WSJ Infini-News snapshots are media-only pages. They preserve
        # the headline and a synthetic body containing the explicit
        # ``Article Not Supported`` notice plus subscription chrome, but no
        # recoverable prose. Keep the raw capture while excluding it from the
        # text-article denominator.
        if capture.publisher == "wsj":
            wsj_document = BeautifulSoup(html_bytes, "html.parser")
            raw_text = _normalize_text(
                wsj_document.get_text(
                    " ",
                    strip=True,
                )
            ).casefold()
            if (
                article.quality.body_characters < 200
                and "article not supported" in raw_text
                and "to read the full story" in raw_text
            ):
                issues.append("nonarticle-desk")
            # Legacy WSJ Video Center pages can retain a headline, a player,
            # and a one-line description while the transcript is absent from
            # the archive.  The parser correctly classifies these captures as
            # VIDEO, but the short description must not count as an article
            # sample.  Keep the raw capture for provenance and replace it in
            # the independent article cohort.
            if (
                nontext_content
                and article.quality.body_characters < 200
            ):
                issues.append("nonarticle-desk")
            # Older WSJ Wayback snapshots often preserve a real headline and
            # a few preview paragraphs, followed by the explicit
            # ``Get The Full Story / Subscribe or Log In`` roadblock. The
            # parser correctly marks these bodies as truncated; they are
            # useful raw provenance but cannot satisfy a complete text
            # article holdout slot. Exclude them from the QA denominator so
            # the scheduler can select a replacement from the same year.
            if (
                article.quality.status != ArticleStatus.COMPLETE
                and "truncated-body" in article.quality.warnings
                and (
                    "get the full story" in raw_text
                    or "available to wsj.com subscribers" in raw_text
                )
                and (
                    "subscribe or log in" in raw_text
                    or "subscribe or sign in" in raw_text
                )
            ):
                issues.append("nonarticle-desk")
            legacy_article_panel = wsj_document.select_one(
                "#articleTabs_panel_article"
            )
            if (
                article.quality.status != ArticleStatus.COMPLETE
                and "truncated-body" in article.quality.warnings
                and isinstance(legacy_article_panel, Tag)
                and legacy_article_panel.select_one(".article.story") is None
                and "available to wsj.com subscribers" in raw_text
            ):
                # The legacy partner shell contains no recoverable story
                # node. Preserve its raw HTML, but replace it with another
                # independent article in the validation denominator.
                issues.append("nonarticle-desk")
            # Some metered WSJ previews contain only the dek and a hero image.
            # The generic media classifier can therefore label the capture as
            # a gallery even though WSJ declares a much larger article word
            # count. The parser marks this explicit snippet template as
            # truncated; retain it as provenance but replace it in the text-
            # article cohort.
            wsj_template = wsj_document.select_one(
                "meta[name='article.template']"
            )
            if (
                article.quality.status != ArticleStatus.COMPLETE
                and "truncated-body" in article.quality.warnings
                and isinstance(wsj_template, Tag)
                and str(wsj_template.get("content", "")).casefold()
                in {"snippet", "preview"}
            ):
                issues.append("nonarticle-desk")
        # Some legacy NYT ``admin`` package pages survive in Wayback with
        # only a short teaser; their client-rendered listicle body is absent
        # from the archived HTML. Keep the raw capture, but do not count an
        # unrecoverable teaser as a complete article sample.
        if (
            capture.publisher == "nyt"
            and re.search(
                r"(?i)^https://(?:www\.)?nytimes\.com/"
                r"(?:interactive/)?20\d{2}/\d{2}/\d{2}/admin/",
                capture.canonical_url,
            )
            and article.quality.body_characters < 200
        ):
            issues.append("nonarticle-desk")
        if (
            capture.publisher == "nyt"
            and article.quality.body_characters < 200
            and (
                article.content_type == ContentType.LIVEBLOG
                or re.search(
                    r"(?i)/opinion/editorial-cartoon(?:\.html)?$",
                    capture.canonical_url,
                )
                or (
                    article.headline
                    and article.headline.casefold().strip()
                    in {"editors' note", "editors’ note"}
                )
            )
        ):
            # Wayback can replay a NYT live-blog alias, an image-only
            # editorial cartoon, or a correction placeholder under a normal
            # article URL. Preserve the raw capture and metadata, but keep
            # these non-recoverable packages out of the text-article cohort.
            issues.append("nonarticle-desk")
        if (
            capture.publisher == "nyt"
            and "/interactive/" in capture.canonical_url.casefold()
            and article.content_type in {ContentType.ARTICLE, ContentType.OPINION}
            and article.quality.body_characters < 100
        ):
            # Some Wayback captures retain only the interactive shell and a
            # short visual-series description. Without the embedded graphic
            # payload there is no recoverable article body to validate.
            issues.append("nonarticle-desk")
        if (
            capture.publisher == "nyt"
            and article.content_type == ContentType.INTERACTIVE
            and article.quality.status == ArticleStatus.PARTIAL
            and article.quality.body_characters < 100
        ):
            # Some interactive URLs retain only an empty client shell. An
            # unsupported package is retained as a non-text record, but a
            # short partial interactive is not recoverable article content
            # and must be replaced in the 800-row article cohort.
            issues.append("nonarticle-desk")
        if (
            capture.publisher == "nyt"
            and article.quality.status != ArticleStatus.COMPLETE
            and article.quality.body_characters < 200
        ):
            # A few NYT URLs are briefly exposed as an Editors' Note before
            # the promised story is published. Wayback preserves that
            # placeholder faithfully, but it is not an article body and
            # should not consume an independent parser sample.
            placeholder_text = article.plain_text.casefold()
            if (
                "published prematurely" in placeholder_text
                and "will be available" in placeholder_text
            ):
                issues.append("nonarticle-desk")
        if (
            capture.publisher == "nyt"
            and article.quality.status != ArticleStatus.COMPLETE
            and article.quality.body_characters < 200
        ):
            # Some Wayback snapshots preserve the NYT shell and metadata but
            # leave the canonical story container empty.  The remaining text
            # is often an author bio or navigation fragment, not recoverable
            # article prose.  Keep the raw capture, but exclude this
            # source-limited shell from the article denominator.
            nyt_soup = BeautifulSoup(html_bytes, "html.parser")
            story = nyt_soup.find("article", id="story")
            story_is_empty = story is not None and not _normalize_text(
                story.get_text(" ", strip=True)
            )
            nyt_raw_text = _normalize_text(
                nyt_soup.get_text(" ", strip=True)
            ).casefold()
            opinion_footer_shell = (
                article.quality.body_characters < 100
                and "the times is committed to publishing a diversity of letters"
                in nyt_raw_text
                and "follow the new york times opinion section"
                in nyt_raw_text
            )
            # Metered NYT snapshots can preserve only the one-sentence dek
            # inside the article body while the story paragraphs remain
            # behind the paywall. This is a source-limited shell, not a
            # parser failure; keep it out of the 800-article denominator.
            metered_body_shell = (
                article.quality.body_characters < 200
                and nyt_soup.select_one(
                    "section[name='articleBody'].meteredContent"
                )
                is not None
            )
            if story_is_empty or opinion_footer_shell or metered_body_shell:
                issues.append("nonarticle-desk")
        if (
            capture.publisher == "aljazeera"
            and article.quality.body_characters < 300
            and article.plain_text.casefold().startswith(
                "al jazeera has removed this story"
            )
        ):
            # Wayback preserves a small number of publisher takedown notices
            # in place of the original story. They are valid archive captures
            # but not article bodies, so keep them out of the parser-error
            # gate while retaining the raw object for provenance.
            issues.append("nonarticle-desk")
        if (
            capture.publisher == "aljazeera"
            and article.content_type == ContentType.ARTICLE
            and article.quality.body_characters == 0
        ):
            # A handful of legacy Al Jazeera URLs are article shells whose
            # archived page has no recoverable prose at all. Keep the raw
            # capture, but do not let an empty shell consume an article slot.
            issues.append("nonarticle-desk")
        if (
            capture.publisher == "aljazeera"
            and article.quality.body_characters < 100
        ):
            # Legacy Al Jazeera infographics are sometimes classified as
            # ordinary articles because the archived HTML retains the title
            # and a single "Download a gif" link but not the interactive
            # payload. Keep the shell for provenance without treating it as
            # a parser extraction failure.
            aljazeera_text = article.plain_text.casefold()
            if (
                "download a gif" in aljazeera_text
                and (
                    "interactive" in aljazeera_text
                    or "infographic" in aljazeera_text
                )
            ):
                issues.append("nonarticle-desk")
            # Older Al Jazeera interactive packages can be archived as a
            # normal News article even though the only body text is a handoff
            # to a client-rendered timeline or Storify story. Keep the raw
            # capture for provenance, but do not count the short handoff as a
            # parser extraction failure.
            if (
                "view the historical context" in aljazeera_text
                or (
                    "view the story" in aljazeera_text
                    and "storify" in aljazeera_text
                )
                or "viewing this from your mobile" in aljazeera_text
                or (
                    "al jazeera round table" in aljazeera_text
                    and "expert commentary" in aljazeera_text
                )
            ):
                issues.append("nonarticle-desk")
            if (
                article.quality.status != ArticleStatus.COMPLETE
                and "nonarticle-desk" not in issues
            ):
                # A legacy Wayback replay can retain only a one-sentence
                # teaser or the editorial-policy disclaimer.  These short
                # partial documents have no recoverable article body; keep
                # their raw captures, but exclude them from parser QA.
                issues.append("nonarticle-desk")
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
        if (
            capture.publisher == "zaobao"
            and any(
                _terminal_tandem_repeat_length(block)
                for block in text_blocks
            )
        ):
            issues.append("repeated-text-within-block")
        normalized_blocks = [
            _normalize_text(block.text).casefold()
            for block in article.blocks
            if block.text and _normalize_text(block.text)
        ]
        if (
            "nonarticle-desk" not in issues
            and (
                _has_generic_interface_noise(
                    normalized_blocks,
                    allow_editorial_read_more=capture.publisher == "aljazeera",
                )
                or _has_publisher_interface_noise(
                    capture.publisher,
                    [
                        *normalized_blocks,
                        *(
                            [_normalize_text(article.description).casefold()]
                            if article.description
                            else []
                        ),
                    ],
                )
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
            # Publishers can expose one story under multiple canonical URLs;
            # WSJ also exposes stable article ids across bodies that changed
            # slightly. Only one public URL may fill an independent 800-item
            # validation slot. Preserve the later raw capture but rotate it
            # out of the article denominator.
            issues.append("nonarticle-desk")
        if (
            capture.publisher in {"ap", "bloomberg", "nyt", "wsj"}
            and article.content_type == ContentType.ARTICLE
            and "<button" in article.body_html.casefold()
        ):
            issues.append("interactive-control-in-body")
        if any(
            image.should_archive
            and any(
                marker in image.original_url.casefold()
                for marker in _PLACEHOLDER_IMAGE_MARKERS
            )
            for image in article.images
        ):
            issues.append("selected-placeholder-image")
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
        if publisher == "ft" and direct_provider == "infini-news":
            try:
                candidates = json.loads(str(candidates_json))
            except (TypeError, ValueError):
                candidates = []
            if any(
                isinstance(candidate, dict)
                and str(candidate.get("provider") or "") == "infini-news"
                and is_ft_subscription_headline(
                    candidate.get("expectedHeadline")
                )
                for candidate in candidates
            ):
                # Infini-News access-shell rows are retained in the capture
                # state for provenance, but must not consume a direct-source
                # validation slot. They have no article headline to validate.
                continue
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
        if publisher == "ft":
            ft_created_year = ft_content_uuid_creation_year(str(canonical_url))
            if ft_created_year is not None and (
                ft_created_year > year or ft_created_year < year - 1
            ):
                # UUIDv1 is generated when the FT content record is created.
                # Keep the immediately following year for drafts that cross a
                # calendar boundary, but avoid downloading captures whose id
                # proves they predate the target by several years.
                continue
        # Do not seed a holdout with a capture whose stored URL is only a
        # source alias. The content audit treats these as hard anomalies, and
        # older source-state databases may predate manifest-time normalization.
        if publisher in {"axios", "npr", "wsj"} and normalize_article_url(
            source_spec, str(canonical_url)
        ) != str(canonical_url):
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
