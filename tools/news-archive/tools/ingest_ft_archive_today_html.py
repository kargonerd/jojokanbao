#!/usr/bin/env python3
"""Validate and ingest FT HTML exported from an archive.today browser session."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.news_models import CaptureCandidate, CaptureProvider
from jojo_olds_api.news_parser import parse_article
from jojo_olds_api.parser_validation import record_parser_validation
from jojo_olds_api.raw_archive_capture import (
    ManifestItem,
    capture_item,
    record_capture_result,
)
from tools.enrich_ft_validation_candidates import CachedResponseClient


def ingest(
    state_path: Path,
    *,
    output_dir: Path,
    input_path: Path,
    target_results: int,
) -> dict[str, int]:
    exported = json.loads(input_path.read_text(encoding="utf-8"))
    if not isinstance(exported, list):
        raise ValueError("input must be a JSON array")
    connection = sqlite3.connect(state_path)
    completed = 0
    rejected = 0
    try:
        for entry in exported:
            current = connection.execute(
                """
                SELECT COUNT(*)
                FROM parser_validation_results
                WHERE parser_version = 'ft-parser/0.8.7'
                """
            ).fetchone()[0]
            if current >= target_results:
                break
            canonical_url = str(entry["canonical_url"])
            if connection.execute(
                """
                SELECT 1 FROM parser_validation_results
                WHERE canonical_url = ?
                """,
                (canonical_url,),
            ).fetchone():
                continue
            row = connection.execute(
                """
                SELECT published_at, section
                FROM captures
                WHERE canonical_url = ?
                """,
                (canonical_url,),
            ).fetchone()
            if row is None:
                rejected += 1
                continue
            content = str(entry["html"]).encode("utf-8")
            try:
                parsed = parse_article(
                    content,
                    publisher="ft",
                    canonical_url=canonical_url,
                )
                headline = parsed.headline
                if not headline:
                    rejected += 1
                    continue
                snapshot_url = str(entry["snapshot_url"])
                result = capture_item(
                    ManifestItem(
                        publisher="ft",
                        canonical_url=canonical_url,
                        published_at=str(row[0]) if row[0] else None,
                        section=str(row[1]) if row[1] else None,
                        candidates=(
                            CaptureCandidate(
                                provider=CaptureProvider.OTHER,
                                snapshot_url=snapshot_url,
                                source_url=canonical_url,
                                expected_headline=headline,
                            ),
                        ),
                    ),
                    archive_client=CachedResponseClient(
                        url=snapshot_url,
                        status=200,
                        content=content,
                        final_url=canonical_url,
                        content_type="text/html; charset=utf-8",
                    ),
                    output_dir=output_dir,
                    maximum_html_bytes=2_000_000,
                )
            except Exception:
                rejected += 1
                continue
            record_capture_result(connection, result)
            raw_capture = result.get("capture")
            if raw_capture is None:
                rejected += 1
                continue
            record_parser_validation(
                connection,
                capture=raw_capture,
                archive_root=output_dir,
            )
            connection.commit()
            completed += 1
        connection.commit()
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
            "completed": completed,
            "rejected": rejected,
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
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--target-results", type=int, default=500)
    args = parser.parse_args()
    print(
        json.dumps(
            ingest(
                args.state,
                output_dir=args.output_dir,
                input_path=args.input,
                target_results=max(1, args.target_results),
            ),
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
