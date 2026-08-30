from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3

from jojo_news_archive.parsing.validation import DEFAULT_SEED, ensure_parser_validation_plan
from jojo_news_archive.capture.raw import (
    initialize_capture_schema,
    load_capture_manifest,
)


SOURCE_CAPTURE_COLUMNS = (
    "canonical_url",
    "selected_candidate_json",
    "final_url",
    "http_status",
    "content_type",
    "quality_score",
    "quality_signals_json",
    "dependent_resources_json",
    "raw_path",
    "raw_sha256",
    "raw_bytes",
    "stored_bytes",
    "retrieved_at",
)


_COMMON_CRAWL_LEGACY_TRUNCATION_BYTES = 1 << 20


def _is_known_legacy_common_crawl_truncation(values: dict[str, object]) -> bool:
    """Reject captures made before WARC-Truncated headers were enforced.

    Common Crawl's historical payload cap is exactly one MiB.  Older JOJO
    capture rows did not retain the ``WARC-Truncated`` response header, but
    they do retain both the Common Crawl provider and the capped decoded byte
    count.  Reusing those rows can feed an HTML document ending halfway
    through Apollo JSON into every new parser holdout.
    """
    if values.get("raw_bytes") != _COMMON_CRAWL_LEGACY_TRUNCATION_BYTES:
        return False
    selected = values.get("selected_candidate_json")
    if not isinstance(selected, str):
        return False
    try:
        candidate = json.loads(selected)
    except (TypeError, ValueError):
        return False
    return (
        isinstance(candidate, dict)
        and str(candidate.get("provider", "")).casefold() == "commoncrawl"
        and candidate.get("byteCount")
        == _COMMON_CRAWL_LEGACY_TRUNCATION_BYTES
    )


def _source_capture_select_columns(
    connection: sqlite3.Connection,
) -> str:
    available = {
        str(column[1])
        for column in connection.execute("PRAGMA table_info(captures)")
    }
    return ", ".join(
        (
            column
            if column in available
            else f"NULL AS {column}"
        )
        for column in SOURCE_CAPTURE_COLUMNS
    )


def export_completed_capture_index(
    *,
    source_connection: sqlite3.Connection,
    destination_connection: sqlite3.Connection,
) -> dict[str, int | str]:
    destination_connection.executescript(
        """
        PRAGMA journal_mode=DELETE;
        DROP TABLE IF EXISTS captures;
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            selected_candidate_json TEXT,
            final_url TEXT,
            http_status INTEGER,
            content_type TEXT,
            quality_score INTEGER,
            quality_signals_json TEXT,
            dependent_resources_json TEXT,
            raw_path TEXT NOT NULL,
            raw_sha256 TEXT NOT NULL,
            raw_bytes INTEGER,
            stored_bytes INTEGER,
            retrieved_at TEXT
        );
        """
    )
    total_complete = int(
        source_connection.execute(
            "SELECT COUNT(*) FROM captures WHERE status='complete'"
        ).fetchone()[0]
    )
    exported = 0
    skipped = 0
    skipped_known_truncated = 0
    cursor = source_connection.execute(
        f"""
        SELECT {_source_capture_select_columns(source_connection)}
        FROM captures
        WHERE status='complete'
        ORDER BY canonical_url
        """
    )
    with destination_connection:
        while rows := cursor.fetchmany(1000):
            accepted: list[tuple] = []
            for row in rows:
                values = dict(
                    zip(SOURCE_CAPTURE_COLUMNS, row, strict=True)
                )
                if _is_known_legacy_common_crawl_truncation(values):
                    skipped += 1
                    skipped_known_truncated += 1
                    continue
                raw_path = values["raw_path"]
                raw_sha256 = values["raw_sha256"]
                if (
                    not isinstance(raw_path, str)
                    or not raw_path.startswith("objects/")
                    or ".." in Path(raw_path).parts
                    or not isinstance(raw_sha256, str)
                    or len(raw_sha256) != 64
                ):
                    skipped += 1
                    continue
                accepted.append(
                    (
                        values["canonical_url"],
                        "complete",
                        *(values[column] for column in SOURCE_CAPTURE_COLUMNS[1:]),
                    )
                )
            destination_connection.executemany(
                f"""
                INSERT INTO captures (
                    canonical_url,
                    status,
                    {", ".join(SOURCE_CAPTURE_COLUMNS[1:])}
                )
                VALUES ({", ".join("?" for _ in range(len(SOURCE_CAPTURE_COLUMNS) + 1))})
                """,
                accepted,
            )
            exported += len(accepted)
    destination_connection.execute("PRAGMA optimize")
    return {
        "formatVersion": "jojo-completed-capture-index/1",
        "totalComplete": total_complete,
        "exported": exported,
        "skipped": skipped,
        "skippedKnownTruncated": skipped_known_truncated,
    }


def import_selected_source_captures(
    *,
    source_connection: sqlite3.Connection,
    target_connection: sqlite3.Connection,
    manifest_path: Path,
    publisher: str,
    sample_year: int,
    target_per_year: int = 500,
    reserve_per_year: int | None = None,
    maximum_record_attempts: int = 3,
    seed: str = DEFAULT_SEED,
    reuse_target_plan: bool = False,
) -> dict[str, object]:
    initialize_capture_schema(
        target_connection,
        publisher=publisher,
        authorization_reference="user-provided-authorization",
    )
    if reuse_target_plan:
        config = target_connection.execute(
            """
            SELECT target_size, seed
            FROM parser_validation_config
            WHERE sample_year=?
            """,
            (sample_year,),
        ).fetchone()
        if config != (target_per_year, seed):
            raise ValueError(
                "existing parser-validation plan does not match the requested "
                "year, target, and seed"
            )
        manifest_result = {"reusedTargetManifest": True}
        plan = {"reusedTargetPlan": True}
    else:
        manifest_result = load_capture_manifest(
            target_connection,
            manifest_path=manifest_path,
            publisher=publisher,
        )
        plan = ensure_parser_validation_plan(
            target_connection,
            publisher=publisher,
            from_year=sample_year,
            to_year=sample_year,
            target_per_year=target_per_year,
            reserve_per_year=reserve_per_year,
            maximum_record_attempts=maximum_record_attempts,
            seed=seed,
        )
    source_has_captures = source_connection.execute(
        """
        SELECT 1
        FROM sqlite_master
        WHERE type='table' AND name='captures'
        """
    ).fetchone()
    if source_has_captures is None:
        return {
            "publisher": publisher,
            "sampleYear": sample_year,
            "selectedIncomplete": 0,
            "sourceMatches": 0,
            "imported": 0,
            "rawPaths": [],
            "skippedSourcePlaceholder": True,
            "manifest": manifest_result,
            "plan": plan,
        }
    selected_urls = [
        str(row[0])
        for row in target_connection.execute(
            """
            SELECT sample.canonical_url
            FROM parser_validation_samples AS sample
            JOIN captures AS capture
              ON capture.canonical_url=sample.canonical_url
            WHERE sample.sample_year=?
              AND capture.status!='complete'
              -- A completed source capture can be requeued by the parser
              -- quality gate when its raw representation is unusable.  Do
              -- not import that same source row on every continuation: doing
              -- so resets the row to complete, the replay gate requeues it,
              -- and the bounded capture-attempt counter can never drain.
              -- Keep ordinary network/capture errors eligible for source
              -- seeding; only the explicit quality-rejection markers are
              -- excluded here.
              AND COALESCE(capture.last_error, '') NOT LIKE
                    'raw quality policy rejected stored capture:%'
              AND COALESCE(capture.last_error, '') NOT LIKE '%reject-%'
            ORDER BY sample.sample_priority, sample.canonical_url
            """,
            (sample_year,),
        )
    ]
    source_rows: dict[str, tuple] = {}
    for offset in range(0, len(selected_urls), 500):
        batch = selected_urls[offset : offset + 500]
        placeholders = ",".join("?" for _ in batch)
        for row in source_connection.execute(
            f"""
            SELECT {_source_capture_select_columns(source_connection)}
            FROM captures
            WHERE status='complete'
              AND canonical_url IN ({placeholders})
            """,
            batch,
        ):
            source_rows[str(row[0])] = row

    imported_paths: list[str] = []
    imported = 0
    skipped_known_truncated = 0
    now = datetime.now(timezone.utc).isoformat()
    with target_connection:
        for canonical_url in selected_urls:
            row = source_rows.get(canonical_url)
            if row is None:
                continue
            values = dict(zip(SOURCE_CAPTURE_COLUMNS, row, strict=True))
            if _is_known_legacy_common_crawl_truncation(values):
                skipped_known_truncated += 1
                continue
            raw_path = values["raw_path"]
            raw_sha256 = values["raw_sha256"]
            if (
                not isinstance(raw_path, str)
                or not raw_path.startswith("objects/")
                or ".." in Path(raw_path).parts
                or not isinstance(raw_sha256, str)
                or len(raw_sha256) != 64
            ):
                continue
            target_connection.execute(
                """
                UPDATE captures
                SET status='complete',
                    selected_candidate_json=?,
                    final_url=?,
                    http_status=?,
                    content_type=?,
                    quality_score=?,
                    quality_signals_json=?,
                    dependent_resources_json=?,
                    raw_path=?,
                    raw_sha256=?,
                    raw_bytes=?,
                    stored_bytes=?,
                    record_path=NULL,
                    last_error=NULL,
                    retrieved_at=?,
                    updated_at=?
                WHERE canonical_url=?
                  AND status!='complete'
                """,
                (
                    values["selected_candidate_json"],
                    values["final_url"],
                    values["http_status"],
                    values["content_type"],
                    values["quality_score"],
                    values["quality_signals_json"],
                    values["dependent_resources_json"],
                    raw_path,
                    raw_sha256,
                    values["raw_bytes"],
                    values["stored_bytes"],
                    values["retrieved_at"],
                    now,
                    canonical_url,
                ),
            )
            if target_connection.execute(
                "SELECT changes()"
            ).fetchone()[0]:
                imported += 1
                imported_paths.append(raw_path)
                dependent_resources = values["dependent_resources_json"]
                if isinstance(dependent_resources, str):
                    try:
                        resources = json.loads(dependent_resources)
                    except (ValueError, TypeError):
                        resources = []
                    for resource in resources:
                        blob = (
                            resource.get("blob")
                            if isinstance(resource, dict)
                            else None
                        )
                        path = (
                            blob.get("path")
                            if isinstance(blob, dict)
                            else None
                        )
                        if (
                            isinstance(path, str)
                            and path.startswith("objects/")
                            and ".." not in Path(path).parts
                        ):
                            imported_paths.append(path)
    return {
        "publisher": publisher,
        "sampleYear": sample_year,
        "selectedIncomplete": len(selected_urls),
        "sourceMatches": len(source_rows),
        "imported": imported,
        "skippedKnownTruncated": skipped_known_truncated,
        "rawPaths": sorted(set(imported_paths)),
        "manifest": manifest_result,
        "plan": plan,
    }
