#!/usr/bin/env python3
"""Recover sampled FT articles using headlines preserved by Choo Choo Train."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.parser_validation import record_parser_validation
from jojo_olds_api.raw_archive_capture import (
    ArchiveClient,
    ManifestItem,
    capture_item,
    discover_ft_syndication_candidates,
    record_capture_result,
)


@dataclass(frozen=True)
class Target:
    canonical_url: str
    published_at: str | None
    section: str | None
    headline: str


def _clean_headline(value: str) -> str:
    return re.sub(r"\s+ft\.com\s*$", "", value, flags=re.I).strip()


def _recover(
    target: Target,
    *,
    output_dir: Path,
) -> dict[str, object] | None:
    client = ArchiveClient(minimum_interval=0.0, timeout=15.0, attempts=2)
    empty_item = ManifestItem(
        publisher="ft",
        canonical_url=target.canonical_url,
        published_at=target.published_at,
        section=target.section,
        candidates=(),
    )
    try:
        candidates = discover_ft_syndication_candidates(
            empty_item,
            archive_client=client,
            expected_headline=target.headline,
            exhaustive=True,
        )
        if not candidates:
            return None
        return capture_item(
            ManifestItem(
                publisher="ft",
                canonical_url=target.canonical_url,
                published_at=target.published_at,
                section=target.section,
                candidates=candidates,
            ),
            archive_client=client,
            output_dir=output_dir,
            maximum_html_bytes=2_000_000,
        )
    except Exception:
        return None


def capture(
    state_path: Path,
    *,
    output_dir: Path,
    headlines_path: Path,
    workers: int,
    target_results: int,
) -> dict[str, int]:
    headlines = {
        str(item["canonical_url"]): _clean_headline(str(item["headline"]))
        for item in json.loads(headlines_path.read_text(encoding="utf-8"))
        if item.get("canonical_url") and item.get("headline")
    }
    connection = sqlite3.connect(state_path)
    try:
        targets = [
            Target(
                canonical_url=str(row[0]),
                published_at=str(row[1]) if row[1] else None,
                section=str(row[2]) if row[2] else None,
                headline=headlines[str(row[0])],
            )
            for row in connection.execute(
                """
                SELECT c.canonical_url, c.published_at, c.section
                FROM parser_validation_samples AS s
                JOIN captures AS c USING (canonical_url)
                LEFT JOIN parser_validation_results AS r USING (canonical_url)
                WHERE r.canonical_url IS NULL
                  AND c.canonical_url IN (
                    SELECT value FROM json_each(?)
                  )
                ORDER BY s.sample_priority
                """,
                (json.dumps(list(headlines)),),
            )
        ]
        needed = max(
            0,
            target_results
            - connection.execute(
                """
                SELECT COUNT(*) FROM parser_validation_results
                WHERE parser_version = 'ft-parser/0.8.7'
                """
            ).fetchone()[0],
        )
        completed = 0
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=max(1, workers)
        ) as executor:
            futures = [
                executor.submit(_recover, target, output_dir=output_dir)
                for target in targets[: max(needed * 4, needed)]
            ]
            for future in concurrent.futures.as_completed(futures):
                result = future.result()
                if result is None or completed >= needed:
                    continue
                record_capture_result(connection, result)
                raw_capture = result.get("capture")
                if raw_capture is None:
                    continue
                record_parser_validation(
                    connection,
                    capture=raw_capture,
                    archive_root=output_dir,
                )
                connection.commit()
                completed += 1
        evaluated, qa_pass, complete, errors = connection.execute(
            """
            SELECT COUNT(*), SUM(qa_pass),
                   SUM(extraction_status = 'complete'),
                   SUM(error IS NOT NULL)
            FROM parser_validation_results
            WHERE parser_version = 'ft-parser/0.8.7'
            """
        ).fetchone()
        return {
            "matched": len(targets),
            "attempted": min(len(targets), max(needed * 4, needed)),
            "completed": completed,
            "evaluated": evaluated,
            "qa_pass": qa_pass or 0,
            "complete": complete or 0,
            "errors": errors or 0,
        }
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--headlines", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--target-results", type=int, default=500)
    args = parser.parse_args()
    print(
        json.dumps(
            capture(
                args.state,
                output_dir=args.output_dir,
                headlines_path=args.headlines,
                workers=max(1, args.workers),
                target_results=max(1, args.target_results),
            ),
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
