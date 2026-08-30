from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys
import time

import httpx


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.archive_sources import archive_source_spec
from jojo_olds_api.wayback_manifest import (
    ARCHIVED_DATE_HYDRATION_PUBLISHERS,
    WaybackCDXClient,
    discovery_summary,
    export_capture_manifest,
    initialize_archived_date_schema,
    initialize_discovery_schema,
    initialize_wsj_bluesky_schema,
    initialize_wsj_google_news_schema,
    initialize_wsj_legacy_date_schema,
    initialize_wsj_rss_schema,
    next_discovery_query,
    process_archived_dates,
    process_wsj_bluesky_page,
    process_wsj_google_news_feed,
    process_wsj_legacy_dates,
    process_wsj_rss_feeds,
    record_discovery_failure,
    record_discovery_page,
    wsj_bluesky_should_continue,
    wsj_catalog_ready_for_capture,
    wsj_google_news_is_only_catalog_gap,
    wsj_google_news_should_continue,
)
from jojo_olds_api.wsj_syndication_catalog import (
    DEFAULT_RESOLUTIONS_PER_RUN,
    initialize_wsj_syndication_schema,
    process_wsj_syndication_catalog,
    process_wsj_syndication_resolutions,
)
from jojo_olds_api.wsj_infini_catalog import (
    initialize_wsj_infini_schema,
    process_wsj_infini_documents,
    process_wsj_infini_queries,
)
from jojo_olds_api.wsj_infini_direct_catalog import (
    initialize_wsj_infini_direct_schema,
    process_wsj_infini_direct_catalog,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a resumable raw-capture manifest from Wayback CDX."
    )
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--from-year", type=int, default=2016)
    parser.add_argument("--to-year", type=int, default=2026)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--state", type=Path)
    parser.add_argument("--page-limit", type=int, default=10_000)
    parser.add_argument("--max-pages", type=int)
    parser.add_argument("--min-request-interval", type=float, default=1.0)
    parser.add_argument("--timeout", type=float, default=90.0)
    parser.add_argument("--attempts", type=int, default=6)
    parser.add_argument(
        "--collapse",
        choices=("digest", "urlkey"),
        default="digest",
        help="CDX deduplication key; urlkey is the fast unique-URL mode.",
    )
    parser.add_argument(
        "--reset-incompatible-state",
        action="store_true",
        help=(
            "Rebuild only the derived discovery catalog when its source "
            "fingerprint no longer matches the requested publisher window."
        ),
    )
    parser.add_argument(
        "--continue-after-capture-ready",
        action="store_true",
        help=(
            "Keep advancing CDX after the current catalog reaches the "
            "minimum capture-ready threshold. Use this for catalog-only "
            "capacity expansion; capture runs still pause discovery so they "
            "can drain already actionable URLs first."
        ),
    )
    parser.add_argument(
        "--priority-year",
        type=int,
        help=(
            "Prefer unfinished URL patterns for this publication year while "
            "preserving the normal round-robin order within that year."
        ),
    )
    parser.add_argument("--github-output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.from_year > args.to_year:
        raise SystemExit("--from-year must not be after --to-year")
    if args.page_limit < 1:
        raise SystemExit("--page-limit must be positive")
    spec = archive_source_spec(args.publisher)
    state = args.state or args.output.with_suffix(".sqlite3")
    state.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(state, timeout=60)
    try:
        initialize_discovery_schema(
            connection,
            spec=spec,
            from_year=args.from_year,
            to_year=args.to_year,
            collapse=args.collapse,
        )
    except ValueError as exc:
        if not args.reset_incompatible_state or "different publisher" not in str(exc):
            raise
        connection.close()
        state.unlink(missing_ok=True)
        connection = sqlite3.connect(state, timeout=60)
        initialize_discovery_schema(
            connection,
            spec=spec,
            from_year=args.from_year,
            to_year=args.to_year,
            collapse=args.collapse,
        )
        print(
            json.dumps(
                {
                    "event": "discovery-state-reset",
                    "publisher": args.publisher,
                    "reason": "source-fingerprint-changed",
                }
            ),
            flush=True,
        )
    bluesky_pages_this_run = 0
    google_news_items_this_run = 0
    wsj_syndication_pages_this_run = 0
    wsj_syndication_resolutions_this_run = 0
    wsj_infini_queries_this_run = 0
    wsj_infini_documents_this_run = 0
    wsj_infini_direct_files_this_run = 0
    archived_dates_this_run = 0
    cdx_paused_for_google_news = False
    deferred_errors: list[str] = []
    if args.publisher == "wsj" and args.collapse == "urlkey":
        initialize_wsj_bluesky_schema(connection)
        initialize_wsj_google_news_schema(connection)
        initialize_wsj_legacy_date_schema(connection)
        initialize_wsj_rss_schema(connection)
        initialize_wsj_syndication_schema(connection)
        initialize_wsj_infini_schema(
            connection,
            from_year=args.from_year,
            to_year=args.to_year,
        )
        initialize_wsj_infini_direct_schema(
            connection,
            from_year=args.from_year,
            to_year=args.to_year,
        )
        with httpx.Client(
            headers={
                "User-Agent": (
                    "JOJO-News-Archive-Research/0.1 "
                    "(nonprofit academic archive; contact via repository)"
                )
            },
            follow_redirects=True,
            timeout=args.timeout,
        ) as http_client:
            try:
                infini_query_result = process_wsj_infini_queries(
                    connection,
                    http_client=http_client,
                    maximum_queries=max(1, args.max_pages or 5),
                )
                wsj_infini_queries_this_run = int(
                    infini_query_result["processed"]
                )
                infini_query_errors = infini_query_result.pop("errors")
                deferred_errors.extend(
                    f"WSJ Infini-News query: {error}"
                    for error in infini_query_errors
                )
                print(
                    json.dumps(
                        {
                            "event": "wsj-infini-queries",
                            **infini_query_result,
                            "errors": len(infini_query_errors),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            except Exception as exc:
                deferred_errors.append(
                    "WSJ Infini-News query: "
                    f"{type(exc).__name__}: {exc}"
                )
            try:
                infini_direct_result = process_wsj_infini_direct_catalog(
                    connection,
                    from_year=args.from_year,
                    to_year=args.to_year,
                    http_client=http_client,
                    maximum_files=max(1, args.max_pages or 5) * 10,
                    workers=8,
                )
                wsj_infini_direct_files_this_run = int(
                    infini_direct_result["attemptedFiles"]
                )
                infini_direct_errors = infini_direct_result.pop("errors")
                deferred_errors.extend(
                    f"WSJ Infini-News direct: {error}"
                    for error in infini_direct_errors
                )
                print(
                    json.dumps(
                        {
                            "event": "wsj-infini-direct",
                            **infini_direct_result,
                            "errors": len(infini_direct_errors),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            except Exception as exc:
                deferred_errors.append(
                    "WSJ Infini-News direct: "
                    f"{type(exc).__name__}: {exc}"
                )
            if wsj_google_news_should_continue(
                connection,
                from_year=args.from_year,
                to_year=args.to_year,
            ):
                try:
                    google_news_result = process_wsj_google_news_feed(
                        connection,
                        spec=spec,
                        http_client=http_client,
                        from_year=args.from_year,
                        to_year=args.to_year,
                    )
                    google_news_items_this_run = int(
                        google_news_result["decodesAttempted"]
                    )
                    google_news_errors = google_news_result.pop("errors")
                    cdx_paused_for_google_news = (
                        int(google_news_result["accepted"]) > 0
                        and wsj_google_news_is_only_catalog_gap(
                            connection,
                            from_year=args.from_year,
                            to_year=args.to_year,
                        )
                    )
                    deferred_errors.extend(
                        f"WSJ Google News: {error}"
                        for error in google_news_errors
                    )
                    print(
                        json.dumps(
                            {
                                "event": "wsj-google-news-poll",
                                **google_news_result,
                                "errors": len(google_news_errors),
                            },
                            ensure_ascii=False,
                        ),
                        flush=True,
                    )
                except Exception as exc:
                    deferred_errors.append(
                        "WSJ Google News: "
                        f"{type(exc).__name__}: {exc}"
                    )
            rss_result = process_wsj_rss_feeds(
                connection,
                spec=spec,
                http_client=http_client,
                from_year=args.from_year,
                to_year=args.to_year,
            )
            rss_errors = rss_result.pop("errors")
            deferred_errors.extend(
                f"WSJ RSS: {error}" for error in rss_errors
            )
            print(
                json.dumps(
                    {
                        "event": "wsj-rss-poll",
                        **rss_result,
                        "errors": len(rss_errors),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            try:
                syndication_catalog = process_wsj_syndication_catalog(
                    connection,
                    http_client=http_client,
                    from_year=args.from_year,
                    to_year=args.to_year,
                    maximum_pages=max(1, args.max_pages or 5),
                    minimum_request_interval=args.min_request_interval,
                )
                wsj_syndication_pages_this_run = int(
                    syndication_catalog["pages"]
                )
                print(
                    json.dumps(
                        {
                            "event": "wsj-syndication-catalog",
                            **syndication_catalog,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            except Exception as exc:
                deferred_errors.append(
                    "WSJ syndication catalog: "
                    f"{type(exc).__name__}: {exc}"
                )
            try:
                syndication_resolutions = (
                    process_wsj_syndication_resolutions(
                        connection,
                        spec=spec,
                        http_client=http_client,
                        maximum=DEFAULT_RESOLUTIONS_PER_RUN,
                        minimum_request_interval=args.min_request_interval,
                    )
                )
                wsj_syndication_resolutions_this_run = int(
                    syndication_resolutions["attempted"]
                )
                syndication_errors = syndication_resolutions.pop("errors")
                deferred_errors.extend(
                    f"WSJ syndication resolution: {error}"
                    for error in syndication_errors
                )
                print(
                    json.dumps(
                        {
                            "event": "wsj-syndication-resolution",
                            **syndication_resolutions,
                            "errors": len(syndication_errors),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            except Exception as exc:
                deferred_errors.append(
                    "WSJ syndication resolution: "
                    f"{type(exc).__name__}: {exc}"
                )
            try:
                infini_document_result = process_wsj_infini_documents(
                    connection,
                    spec=spec,
                    http_client=http_client,
                    maximum=max(1, args.max_pages or 5) * 100,
                    workers=4,
                    minimum_request_interval=args.min_request_interval,
                )
                wsj_infini_documents_this_run = int(
                    infini_document_result["attempted"]
                )
                infini_document_errors = infini_document_result.pop("errors")
                deferred_errors.extend(
                    f"WSJ Infini-News document: {error}"
                    for error in infini_document_errors
                )
                print(
                    json.dumps(
                        {
                            "event": "wsj-infini-documents",
                            **infini_document_result,
                            "errors": len(infini_document_errors),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            except Exception as exc:
                deferred_errors.append(
                    "WSJ Infini-News document: "
                    f"{type(exc).__name__}: {exc}"
                )
            while (
                args.max_pages is None
                or bluesky_pages_this_run < args.max_pages
            ) and wsj_bluesky_should_continue(
                connection,
                from_year=args.from_year,
                to_year=args.to_year,
            ):
                try:
                    result = process_wsj_bluesky_page(
                        connection,
                        spec=spec,
                        http_client=http_client,
                        from_year=args.from_year,
                        to_year=args.to_year,
                    )
                except Exception as exc:
                    deferred_errors.append(
                        f"WSJ Bluesky: {type(exc).__name__}: {exc}"
                    )
                    break
                bluesky_pages_this_run += 1
                print(
                    json.dumps(
                        {
                            "event": "wsj-bluesky-page",
                            "page": bluesky_pages_this_run,
                            **result,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                if args.min_request_interval:
                    time.sleep(args.min_request_interval)
            try:
                legacy_dates = process_wsj_legacy_dates(
                    connection,
                    http_client=http_client,
                    maximum=max(1, args.max_pages or 5) * 20,
                    minimum_request_interval=args.min_request_interval,
                )
                legacy_date_errors = legacy_dates.pop("errors")
                deferred_errors.extend(
                    f"WSJ legacy date: {error}"
                    for error in legacy_date_errors
                )
                print(
                    json.dumps(
                        {
                            "event": "wsj-legacy-date-hydration",
                            **legacy_dates,
                            "errors": len(legacy_date_errors),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            except Exception as exc:
                deferred_errors.append(
                    "WSJ legacy date hydration: "
                    f"{type(exc).__name__}: {exc}"
                )
        if (
            not args.continue_after_capture_ready
            and wsj_catalog_ready_for_capture(
                connection,
                from_year=args.from_year,
                to_year=args.to_year,
            )
        ):
            cdx_paused_for_google_news = True
    if (
        args.publisher in ARCHIVED_DATE_HYDRATION_PUBLISHERS
        and args.collapse == "urlkey"
    ):
        initialize_archived_date_schema(
            connection,
            publisher=args.publisher,
        )
        with httpx.Client(
            headers={
                "User-Agent": (
                    "JOJO-News-Archive-Research/0.1 "
                    "(nonprofit academic archive; contact via repository)"
                )
            },
            follow_redirects=True,
            timeout=args.timeout,
        ) as http_client:
            try:
                archived_dates = process_archived_dates(
                    connection,
                    publisher=args.publisher,
                    http_client=http_client,
                    maximum=max(1, args.max_pages or 5) * 20,
                    minimum_request_interval=args.min_request_interval,
                )
                archived_dates_this_run = int(archived_dates["attempted"])
                archived_date_errors = archived_dates.pop("errors")
                deferred_errors.extend(
                    f"{args.publisher} archived date: {error}"
                    for error in archived_date_errors
                )
                print(
                    json.dumps(
                        {
                            "event": "archived-date-hydration",
                            "publisher": args.publisher,
                            **archived_dates,
                            "errors": len(archived_date_errors),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            except Exception as exc:
                deferred_errors.append(
                    f"{args.publisher} archived date hydration: "
                    f"{type(exc).__name__}: {exc}"
                )
    client = WaybackCDXClient(
        minimum_interval=args.min_request_interval,
        timeout=args.timeout,
        attempts=args.attempts,
        page_limit=args.page_limit,
        collapse=args.collapse,
    )
    pages_this_run = 0
    deferred_error = None
    try:
        while (
            not cdx_paused_for_google_news
            and (
                args.max_pages is None
                or bluesky_pages_this_run + pages_this_run < args.max_pages
            )
        ):
            query = next_discovery_query(
                connection,
                preferred_year=args.priority_year,
            )
            if query is None:
                break
            pattern, resume_key = query
            try:
                page = client.fetch_page(
                    pattern=pattern,
                    from_year=args.from_year,
                    to_year=args.to_year,
                    resume_key=resume_key,
                )
            except RuntimeError as exc:
                deferred_error = str(exc)
                deferred_errors.append(deferred_error)
                record_discovery_failure(
                    connection,
                    pattern=pattern,
                    error=deferred_error,
                )
                print(
                    json.dumps(
                        {
                            "event": "discovery-deferred",
                            "publisher": args.publisher,
                            "pattern": pattern,
                            "error": deferred_error,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                break
            result = record_discovery_page(
                connection,
                spec=spec,
                pattern=pattern,
                page=page,
            )
            pages_this_run += 1
            print(
                json.dumps(
                    {
                        "event": "discovery-page",
                        "publisher": args.publisher,
                        "pattern": pattern,
                        "page": pages_this_run,
                        **result,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
    finally:
        client.close()

    if (
        args.publisher in ARCHIVED_DATE_HYDRATION_PUBLISHERS
        and args.collapse == "urlkey"
    ):
        # New CDX rows still contain capture-time placeholders. Register them
        # before export so they stay out of yearly manifests until a later
        # bounded run proves their actual publication timestamp.
        initialize_archived_date_schema(
            connection,
            publisher=args.publisher,
        )

    manifest = export_capture_manifest(
        connection,
        spec=spec,
        destination=args.output,
        from_year=args.from_year,
        to_year=args.to_year,
    )
    summary = {
        **discovery_summary(connection),
        **manifest,
        "state": str(state),
        "pagesThisRun": pages_this_run,
        "blueskyPagesThisRun": bluesky_pages_this_run,
        "googleNewsItemsThisRun": google_news_items_this_run,
        "wsjSyndicationPagesThisRun": wsj_syndication_pages_this_run,
        "wsjSyndicationResolutionsThisRun": (
            wsj_syndication_resolutions_this_run
        ),
        "wsjInfiniQueriesThisRun": wsj_infini_queries_this_run,
        "wsjInfiniDocumentsThisRun": wsj_infini_documents_this_run,
        "wsjInfiniDirectFilesThisRun": wsj_infini_direct_files_this_run,
        "archivedDatesThisRun": archived_dates_this_run,
        "cdxPausedForGoogleNews": cdx_paused_for_google_news,
        "deferredError": (
            "; ".join(deferred_errors) if deferred_errors else None
        ),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as handle:
            handle.write(
                f"should_continue={str(bool(summary['shouldContinue'])).lower()}\n"
            )
            handle.write(
                f"complete={str(bool(summary['complete'])).lower()}\n"
            )
            handle.write(
                "capture_ready="
                f"{str(bool(summary['captureReady'])).lower()}\n"
            )
            handle.write(f"articles={summary['articles']}\n")
    connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
