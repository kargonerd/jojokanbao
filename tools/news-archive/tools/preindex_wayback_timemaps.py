from __future__ import annotations

import argparse
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import sqlite3
import sys
import time


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_news_archive.discovery.client import ArchiveClient
from jojo_news_archive.models import CaptureCandidate
from jojo_news_archive.capture.raw import (
    ManifestItem,
    discover_wayback_timemap_candidates,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Preindex exact Wayback Timemap rows for unevaluated parser "
            "validation samples so capture workers can download HTML "
            "without repeating per-article index discovery."
        )
    )
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--maximum", type=int, default=1_000)
    parser.add_argument("--workers", type=int, default=128)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--attempts", type=int, default=1)
    parser.add_argument("--minimum-interval", type=float, default=0.0)
    parser.add_argument("--maximum-candidates", type=int, default=8)
    parser.add_argument("--from-year", type=int)
    parser.add_argument("--to-year", type=int)
    parser.add_argument("--progress-every", type=int, default=100)
    return parser.parse_args()


def pending_wayback_preindex_rows(
    connection: sqlite3.Connection,
    *,
    publisher: str,
    maximum: int,
    from_year: int | None = None,
    to_year: int | None = None,
) -> list[tuple[ManifestItem, list[dict[str, object]]]]:
    rows = connection.execute(
        """
        SELECT
            capture.canonical_url,
            capture.published_at,
            capture.section,
            capture.candidates_json
        FROM parser_validation_samples AS sample
        JOIN parser_validation_config AS config
          ON config.sample_year=sample.sample_year
        JOIN captures AS capture
          ON capture.canonical_url=sample.canonical_url
        LEFT JOIN parser_validation_results AS result
          ON result.canonical_url=sample.canonical_url
         AND result.parser_version=config.parser_version
         AND result.qa_revision=config.qa_revision
        WHERE capture.publisher=?
          AND result.canonical_url IS NULL
          AND capture.status IN ('pending', 'error')
          AND (? IS NULL OR sample.sample_year >= ?)
          AND (? IS NULL OR sample.sample_year <= ?)
          AND NOT EXISTS (
              SELECT 1
              FROM json_each(capture.candidates_json)
              WHERE json_extract(value, '$.provider')='wayback'
                AND json_extract(value, '$.digest') IS NOT NULL
                AND json_extract(value, '$.capturedAt') IS NOT NULL
          )
        ORDER BY
            CASE capture.status WHEN 'pending' THEN 0 ELSE 1 END,
            sample.sample_priority,
            capture.canonical_url
        LIMIT ?
        """,
        (
            publisher,
            from_year,
            from_year,
            to_year,
            to_year,
            maximum,
        ),
    ).fetchall()
    selected: list[tuple[ManifestItem, list[dict[str, object]]]] = []
    for canonical_url, published_at, section, candidates_json in rows:
        serialized_candidates = json.loads(str(candidates_json))
        selected.append(
            (
                ManifestItem(
                    publisher=publisher,
                    canonical_url=str(canonical_url),
                    published_at=(
                        str(published_at)
                        if published_at is not None
                        else None
                    ),
                    section=str(section) if section is not None else None,
                    candidates=tuple(
                        CaptureCandidate.model_validate(candidate)
                        for candidate in serialized_candidates
                    ),
                ),
                serialized_candidates,
            )
        )
    return selected


def merged_candidate_json(
    existing: list[dict[str, object]],
    exact: tuple[CaptureCandidate, ...],
) -> str:
    serialized_exact = [
        candidate.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        )
        for candidate in exact
    ]
    seen = {
        str(candidate.get("snapshotUrl"))
        for candidate in serialized_exact
    }
    merged = serialized_exact + [
        candidate
        for candidate in existing
        if str(candidate.get("snapshotUrl")) not in seen
    ]
    return json.dumps(
        merged,
        ensure_ascii=False,
        separators=(",", ":"),
    )


def apply_candidate_updates(
    connection: sqlite3.Connection,
    updates: list[tuple[str, str]],
) -> int:
    """Write one ready batch without holding a lock during network work."""

    if not updates:
        return 0
    before = connection.total_changes
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.executemany(
            """
            UPDATE captures
            SET candidates_json=?, updated_at=datetime('now')
            WHERE canonical_url=?
              AND status IN ('pending', 'error')
            """,
            updates,
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    return max(0, connection.total_changes - before)


def main() -> int:
    args = parse_args()
    positive = {
        "--maximum": args.maximum,
        "--workers": args.workers,
        "--timeout": args.timeout,
        "--attempts": args.attempts,
        "--maximum-candidates": args.maximum_candidates,
        "--progress-every": args.progress_every,
    }
    invalid = [name for name, value in positive.items() if value <= 0]
    if invalid:
        raise SystemExit(f"positive values required: {', '.join(invalid)}")
    connection = sqlite3.connect(args.state, timeout=60)
    rows = pending_wayback_preindex_rows(
        connection,
        publisher=args.publisher,
        maximum=args.maximum,
        from_year=args.from_year,
        to_year=args.to_year,
    )
    existing_by_url = {
        item.canonical_url: existing for item, existing in rows
    }
    client = ArchiveClient(
        timeout=args.timeout,
        minimum_interval=args.minimum_interval,
        attempts=args.attempts,
    )
    started_at = time.monotonic()
    finished = 0
    found = 0
    exact_candidates = 0
    updated = 0
    pending_updates: list[tuple[str, str]] = []
    errors: dict[str, int] = {}

    def discover(item: ManifestItem) -> tuple[str, tuple[CaptureCandidate, ...]]:
        return (
            item.canonical_url,
            discover_wayback_timemap_candidates(
                item,
                archive_client=client,
                maximum_candidates=args.maximum_candidates,
            ),
        )

    try:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures: dict[Future, ManifestItem] = {
                executor.submit(discover, item): item for item, _ in rows
            }
            for future in as_completed(futures):
                item = futures[future]
                finished += 1
                try:
                    canonical_url, candidates = future.result()
                except Exception as exc:
                    error_name = type(exc).__name__
                    errors[error_name] = errors.get(error_name, 0) + 1
                    canonical_url = item.canonical_url
                    candidates = ()
                if candidates:
                    found += 1
                    exact_candidates += len(candidates)
                    pending_updates.append(
                        (
                            merged_candidate_json(
                                existing_by_url[canonical_url],
                                candidates,
                            ),
                            canonical_url,
                        )
                    )
                if finished % args.progress_every == 0:
                    updated += apply_candidate_updates(
                        connection,
                        pending_updates,
                    )
                    pending_updates.clear()
                    elapsed = max(0.001, time.monotonic() - started_at)
                    print(
                        json.dumps(
                            {
                                "event": "wayback-timemap-preindex",
                                "finished": finished,
                                "selected": len(rows),
                                "found": found,
                                "updated": updated,
                                "itemsPerMinute": round(
                                    finished / elapsed * 60,
                                    1,
                                ),
                            },
                            ensure_ascii=False,
                        ),
                        flush=True,
                    )
        updated += apply_candidate_updates(connection, pending_updates)
    finally:
        client.close()
        connection.close()
    print(
        json.dumps(
            {
                "event": "wayback-timemap-preindex-complete",
                "publisher": args.publisher,
                "selected": len(rows),
                "finished": finished,
                "found": found,
                "exactCandidates": exact_candidates,
                "updated": updated,
                "errors": dict(sorted(errors.items())),
                "seconds": round(time.monotonic() - started_at, 1),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
