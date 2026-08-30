from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.archive_sources import archive_source_spec
from jojo_olds_api.npr_archive_manifest import (
    NprArchiveClient,
    export_npr_archive_manifest,
    initialize_npr_archive_schema,
    next_npr_archive_query,
    npr_archive_summary,
    record_npr_archive_error,
    record_npr_archive_page,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a resumable manifest from NPR's official archive."
    )
    parser.add_argument("--from-year", type=int, required=True)
    parser.add_argument("--to-year", type=int, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary", type=Path)
    parser.add_argument("--max-pages", type=int, default=200)
    parser.add_argument("--min-request-interval", type=float, default=0.5)
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--attempts", type=int, default=4)
    parser.add_argument("--github-output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.from_year > args.to_year:
        raise SystemExit("--from-year must not be after --to-year")
    if args.max_pages < 1:
        raise SystemExit("--max-pages must be positive")
    args.state.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(args.state, timeout=60)
    client = NprArchiveClient(
        minimum_interval=args.min_request_interval,
        timeout=args.timeout,
        attempts=args.attempts,
    )
    pages = 0
    errors = 0
    try:
        initialize_npr_archive_schema(
            connection,
            from_year=args.from_year,
            to_year=args.to_year,
        )
        spec = archive_source_spec("npr")
        while pages < args.max_pages:
            query = next_npr_archive_query(connection)
            if query is None:
                break
            year, cursor_date, offset = query
            try:
                result = record_npr_archive_page(
                    connection,
                    spec=spec,
                    year=year,
                    cursor_date=cursor_date,
                    offset=offset,
                    content=client.page(
                        cursor_date=cursor_date,
                        offset=offset,
                    ),
                )
                pages += 1
                print(
                    json.dumps(
                        {
                            "event": "npr-official-archive-page",
                            "year": year,
                            "cursorDate": cursor_date,
                            "offset": offset,
                            **result,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            except Exception as exc:
                errors += 1
                record_npr_archive_error(
                    connection,
                    year=year,
                    error=f"{type(exc).__name__}: {exc}",
                )
                print(
                    json.dumps(
                        {
                            "event": "npr-official-archive-error",
                            "year": year,
                            "cursorDate": cursor_date,
                            "offset": offset,
                            "error": type(exc).__name__,
                            "message": str(exc),
                        }
                    ),
                    flush=True,
                )
                # Let the next bounded run provide a real cooldown before
                # retrying the same page. The checkpoint keeps the cursor and
                # a finite cross-run attempt count.
                break
        manifest = export_npr_archive_manifest(
            connection,
            destination=args.output,
        )
        summary = {
            **npr_archive_summary(connection),
            "pagesThisRun": pages,
            "errorsThisRun": errors,
            "manifest": manifest,
        }
        if args.summary is not None:
            args.summary.parent.mkdir(parents=True, exist_ok=True)
            args.summary.write_text(
                json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
        if args.github_output is not None:
            with args.github_output.open("a", encoding="utf-8") as handle:
                handle.write(
                    "should_continue="
                    f"{str(summary['shouldContinue']).lower()}\n"
                )
                handle.write(f"pages={pages}\n")
                handle.write(f"errors={errors}\n")
        return 0
    finally:
        client.close()
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
