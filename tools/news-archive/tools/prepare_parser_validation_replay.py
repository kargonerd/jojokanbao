from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.parser_validation import (
    DEFAULT_SEED,
    ensure_parser_validation_plan,
    failed_completed_parser_validation_files,
    pending_completed_parser_validation_files,
)
from jojo_olds_api.raw_archive_capture import initialize_capture_schema


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Plan parser validation and list previously captured raw objects "
            "that must be restored for the current parser version."
        )
    )
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--from-year", type=int, required=True)
    parser.add_argument("--to-year", type=int, required=True)
    parser.add_argument("--target-per-year", type=int, default=500)
    parser.add_argument("--seed", default=DEFAULT_SEED)
    parser.add_argument("--reserve-per-year", type=int)
    parser.add_argument("--max-record-attempts", type=int, default=3)
    parser.add_argument("--max-replays", type=int, default=500)
    parser.add_argument("--files-from", type=Path, required=True)
    parser.add_argument(
        "--all-result-files-from",
        type=Path,
        help=(
            "Also list every raw object backing an existing validation "
            "result. Restoring these files enables a complete forced replay."
        ),
    )
    parser.add_argument("--github-output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.max_replays < 1:
        raise SystemExit("--max-replays must be positive")
    args.state.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(args.state, timeout=60)
    initialize_capture_schema(
        connection,
        publisher=args.publisher,
        authorization_reference="user-provided-authorization",
    )
    plan = ensure_parser_validation_plan(
        connection,
        publisher=args.publisher,
        from_year=args.from_year,
        to_year=args.to_year,
        target_per_year=args.target_per_year,
        reserve_per_year=args.reserve_per_year,
        maximum_record_attempts=args.max_record_attempts,
        seed=args.seed,
    )
    pending = pending_completed_parser_validation_files(
        connection,
        maximum=args.max_replays,
    )
    failed = failed_completed_parser_validation_files(
        connection,
        maximum=max(0, args.max_replays - len(pending)),
    )
    pending.extend(
        row for row in failed if row[0] not in {item[0] for item in pending}
    )
    pending_resource_files = _dependent_resource_paths(
        connection,
        [canonical_url for canonical_url, _ in pending],
    )
    existing_result_files = [
        str(raw_path)
        for (raw_path,) in connection.execute(
            """
            SELECT DISTINCT capture.raw_path
            FROM parser_validation_results AS result
            JOIN parser_validation_samples AS sample
              ON sample.canonical_url=result.canonical_url
            JOIN captures AS capture
              ON capture.canonical_url=result.canonical_url
             AND capture.status='complete'
            WHERE capture.raw_path IS NOT NULL
            ORDER BY sample.sample_priority, result.canonical_url
            """
        )
    ]
    existing_result_urls = [
        str(canonical_url)
        for (canonical_url,) in connection.execute(
            """
            SELECT DISTINCT result.canonical_url
            FROM parser_validation_results AS result
            JOIN captures AS capture
              ON capture.canonical_url=result.canonical_url
             AND capture.status='complete'
            WHERE capture.raw_path IS NOT NULL
            """
        )
    ]
    existing_result_files.extend(
        _dependent_resource_paths(connection, existing_result_urls)
    )
    connection.close()

    args.files_from.parent.mkdir(parents=True, exist_ok=True)
    args.files_from.write_text(
        "".join(
            f"{raw_path}\n"
            for raw_path in (
                [raw_path for _, raw_path in pending]
                + pending_resource_files
            )
        ),
        encoding="utf-8",
    )
    if args.all_result_files_from:
        args.all_result_files_from.parent.mkdir(
            parents=True,
            exist_ok=True,
        )
        args.all_result_files_from.write_text(
            "".join(f"{raw_path}\n" for raw_path in existing_result_files),
            encoding="utf-8",
        )
    result = {
        "publisher": args.publisher,
        "parserVersion": plan["parserVersion"],
        "replays": len(pending),
        "existingResultFiles": len(existing_result_files),
        "filesFrom": str(args.files_from),
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as handle:
            handle.write(f"replays={len(pending)}\n")
    return 0


def _dependent_resource_paths(
    connection: sqlite3.Connection,
    canonical_urls: list[str],
) -> list[str]:
    if not canonical_urls:
        return []
    paths: set[str] = set()
    for offset in range(0, len(canonical_urls), 500):
        batch = canonical_urls[offset : offset + 500]
        placeholders = ",".join("?" for _ in batch)
        rows = connection.execute(
            f"""
            SELECT dependent_resources_json
            FROM captures
            WHERE canonical_url IN ({placeholders})
              AND dependent_resources_json IS NOT NULL
            """,
            batch,
        )
        for (serialized,) in rows:
            try:
                resources = json.loads(str(serialized))
            except (TypeError, ValueError):
                continue
            for resource in resources:
                blob = resource.get("blob") if isinstance(resource, dict) else None
                path = blob.get("path") if isinstance(blob, dict) else None
                if isinstance(path, str):
                    paths.add(path)
    return sorted(paths)


if __name__ == "__main__":
    raise SystemExit(main())
