from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.archive_sources import (
    ArchiveSourceSpec,
    archive_source_variant,
)
from jojo_olds_api.bloomberg_archive_download import ArchiveClient
from jojo_olds_api.common_crawl_prefix_manifest import (
    CommonCrawlPrefixClient,
    export_prefix_manifest,
    initialize_prefix_schema,
    next_prefix_query,
    prefix_summary,
    process_prefix_date_hydration,
    record_prefix_error,
    record_prefix_page,
    record_prefix_page_count,
    reconcile_prefix_year_targets,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build a resumable Common Crawl prefix manifest for archive "
            "URLs missing from the primary catalog."
        )
    )
    parser.add_argument("--publisher", required=True)
    parser.add_argument(
        "--source-variant",
        choices=("canonical", "nikkei-asia-probe", "wsj-legacy-probe"),
        default="canonical",
        help=(
            "Explicit isolated source variant. Probe variants must use a "
            "separate remote checkpoint and are not parser inputs."
        ),
    )
    parser.add_argument("--from-year", type=int, required=True)
    parser.add_argument("--to-year", type=int, required=True)
    parser.add_argument("--collection-from-year", type=int, default=2012)
    parser.add_argument("--collection-to-year", type=int)
    parser.add_argument(
        "--collection-order",
        choices=("newest", "oldest"),
        default="newest",
    )
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-pages", type=int, default=10)
    parser.add_argument(
        "--max-queries",
        type=int,
        default=100,
        help=(
            "Maximum prefix-query state advances in this run, including "
            "empty page-count queries."
        ),
    )
    parser.add_argument("--max-errors", type=int, default=3)
    parser.add_argument(
        "--target-articles-per-year",
        type=int,
        help=(
            "Stop pending index queries for a publication year after this "
            "many distinct canonical URLs have been cataloged."
        ),
    )
    parser.add_argument("--min-request-interval", type=float, default=2.0)
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--attempts", type=int, default=4)
    parser.add_argument(
        "--max-date-hydrations",
        type=int,
        default=0,
        help=(
            "Maximum WARC pages used to recover publication dates for URL "
            "families whose canonical keys do not contain a date."
        ),
    )
    parser.add_argument("--data-min-request-interval", type=float, default=0.5)
    parser.add_argument("--maximum-html-bytes", type=int, default=15_000_000)
    parser.add_argument(
        "--page-size",
        type=int,
        help=(
            "Optional number of compressed index blocks per page. Use 1 "
            "for broad prefixes that time out with the server default."
        ),
    )
    parser.add_argument("--summary", type=Path)
    parser.add_argument("--github-output", type=Path)
    return parser.parse_args()


def initialize_with_collection_refresh(
    connection: sqlite3.Connection,
    *,
    client: CommonCrawlPrefixClient,
    spec: ArchiveSourceSpec,
    from_year: int,
    to_year: int,
    collection_from_year: int,
    collection_to_year: int | None = None,
) -> dict[str, object]:
    """Refresh Common Crawl indexes without stranding a saved checkpoint."""
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=from_year,
        to_year=to_year,
        collections=(),
    )
    try:
        collections = tuple(
            collection
            for collection in client.collections()
            if collection.to_at.year >= collection_from_year
            and (
                collection_to_year is None
                or collection.from_at.year <= collection_to_year
            )
            and collection.from_at <= datetime.now(timezone.utc)
        )
    except (RuntimeError, ValueError) as exc:
        existing_queries = int(
            connection.execute(
                "SELECT COUNT(*) FROM prefix_queries"
            ).fetchone()[0]
        )
        if existing_queries == 0:
            raise
        result = {
            "source": "checkpoint",
            "queryCount": existing_queries,
            "refreshError": type(exc).__name__,
        }
        print(
            json.dumps(
                {"event": "common-crawl-collection-refresh-fallback", **result}
            ),
            flush=True,
        )
        return result
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=from_year,
        to_year=to_year,
        collections=collections,
    )
    return {
        "source": "remote",
        "collectionCount": len(collections),
    }


def main() -> int:
    args = parse_args()
    if args.from_year > args.to_year:
        raise SystemExit("--from-year must not be after --to-year")
    if args.max_pages < 1 or args.max_queries < 1 or args.max_errors < 1:
        raise SystemExit(
            "--max-pages, --max-queries, and --max-errors must be positive"
        )
    if args.max_date_hydrations < 0:
        raise SystemExit("--max-date-hydrations must not be negative")
    if args.data_min_request_interval < 0:
        raise SystemExit("--data-min-request-interval must not be negative")
    if args.maximum_html_bytes < 1:
        raise SystemExit("--maximum-html-bytes must be positive")
    if (
        args.collection_to_year is not None
        and args.collection_from_year > args.collection_to_year
    ):
        raise SystemExit(
            "--collection-from-year must not exceed --collection-to-year"
        )
    if args.page_size is not None and args.page_size < 1:
        raise SystemExit("--page-size must be positive")
    if (
        args.target_articles_per_year is not None
        and args.target_articles_per_year < 1
    ):
        raise SystemExit("--target-articles-per-year must be positive")
    try:
        spec = archive_source_variant(args.publisher, args.source_variant)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    client = CommonCrawlPrefixClient(
        minimum_interval=args.min_request_interval,
        timeout=args.timeout,
        attempts=args.attempts,
        page_size=args.page_size,
    )
    args.state.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(args.state, timeout=60)
    pages = 0
    queries = 0
    advances = 0
    errors = 0
    archive_client: ArchiveClient | None = None
    try:
        collection_refresh = initialize_with_collection_refresh(
            connection,
            client=client,
            spec=spec,
            from_year=args.from_year,
            to_year=args.to_year,
            collection_from_year=args.collection_from_year,
            collection_to_year=args.collection_to_year,
        )
        queries_completed_by_target = reconcile_prefix_year_targets(
            connection,
            target_articles_per_year=args.target_articles_per_year,
        )
        while (
            pages < args.max_pages
            and queries < args.max_queries
            and errors < args.max_errors
        ):
            query = next_prefix_query(
                connection,
                collection_order=args.collection_order,
            )
            if query is None:
                break
            queries += 1
            collection_id, index_url, pattern, total_pages, next_page = query
            try:
                if total_pages is None:
                    total_pages = client.page_count(
                        index_url=index_url,
                        pattern=pattern,
                    )
                    record_prefix_page_count(
                        connection,
                        collection_id=collection_id,
                        pattern=pattern,
                        total_pages=total_pages,
                    )
                    advances += 1
                    if total_pages == 0:
                        continue
                page = client.page(
                    index_url=index_url,
                    pattern=pattern,
                    page=next_page,
                )
                result = record_prefix_page(
                    connection,
                    spec=spec,
                    collection_id=collection_id,
                    pattern=pattern,
                    page_number=next_page,
                    total_pages=total_pages,
                    page=page,
                )
                advances += 1
                pages += 1
                queries_completed_by_target += reconcile_prefix_year_targets(
                    connection,
                    target_articles_per_year=(
                        args.target_articles_per_year
                    ),
                )
                print(
                    json.dumps(
                        {
                            "event": "common-crawl-prefix-page",
                            "collection": collection_id,
                            "pattern": pattern,
                            "page": next_page,
                            **result,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            except Exception as exc:
                errors += 1
                record_prefix_error(
                    connection,
                    collection_id=collection_id,
                    pattern=pattern,
                    error=f"{type(exc).__name__}: {exc}",
                )
                print(
                    json.dumps(
                        {
                            "event": "common-crawl-prefix-error",
                            "collection": collection_id,
                            "pattern": pattern,
                            "error": type(exc).__name__,
                        }
                    ),
                    flush=True,
                )
        hydration = None
        if args.max_date_hydrations:
            archive_client = ArchiveClient(
                timeout=args.timeout,
                minimum_interval=args.data_min_request_interval,
                attempts=args.attempts,
            )
            hydration = process_prefix_date_hydration(
                connection,
                spec=spec,
                archive_client=archive_client,
                maximum=args.max_date_hydrations,
                target_articles_per_year=args.target_articles_per_year,
                maximum_html_bytes=args.maximum_html_bytes,
            )
            queries_completed_by_target += reconcile_prefix_year_targets(
                connection,
                target_articles_per_year=args.target_articles_per_year,
            )
        manifest = export_prefix_manifest(
            connection,
            spec=spec,
            destination=args.output,
        )
        summary = {
            **prefix_summary(connection),
            "sourceVariant": args.source_variant,
            "pagesThisRun": pages,
            "queriesThisRun": queries,
            "stateAdvancesThisRun": advances,
            "queriesCompletedByTargetThisRun": (
                queries_completed_by_target
            ),
            "targetArticlesPerYear": args.target_articles_per_year,
            "errorsThisRun": errors,
            "collectionRefresh": collection_refresh,
            **({"dateHydrationThisRun": hydration} if hydration else {}),
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
                    f"should_continue={str(summary['shouldContinue']).lower()}\n"
                )
                handle.write(f"pages={pages}\n")
                handle.write(f"queries={queries}\n")
                handle.write(f"advances={advances}\n")
                handle.write(f"errors={errors}\n")
                handle.write(
                    "hydration_attempted="
                    f"{hydration['attempted'] if hydration else 0}\n"
                )
        return 0
    finally:
        connection.close()
        client.close()
        if archive_client is not None:
            archive_client.close()


if __name__ == "__main__":
    raise SystemExit(main())
