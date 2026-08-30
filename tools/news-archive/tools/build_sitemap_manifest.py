from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys

import httpx


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.archive_sources import archive_source_spec
from jojo_olds_api.bloomberg_archive_download import ArchiveClient
from jojo_olds_api.bloomberg_bnn_catalog import (
    bloomberg_bnn_summary,
    initialize_bloomberg_bnn_schema,
    process_bloomberg_infini_documents,
    process_bloomberg_infini_pages,
    process_bloomberg_infini_queries,
    process_bloomberg_bnn_pages,
    process_bloomberg_bnn_sitemaps,
)
from jojo_olds_api.ft_syndication_catalog import (
    initialize_ft_syndication_schema,
    ft_syndication_summary,
    process_ft_infini_documents,
    process_ft_infini_queries,
    process_ft_syndication_resolutions,
)
from jojo_olds_api.nyt_syndication_catalog import (
    MAXIMUM_RESPONSE_BYTES,
    initialize_nyt_syndication_schema,
    next_nyt_syndication_query,
    next_nyt_syndication_resolution,
    nyt_syndication_resolution_url,
    nyt_syndication_summary,
    record_nyt_syndication_page,
    record_nyt_syndication_resolution,
    resolve_nyt_syndication_search,
)
from jojo_olds_api.sitemap_manifest import (
    SitemapClient,
    export_sitemap_manifest,
    initialize_sitemap_schema,
    next_sitemap_query,
    record_sitemap,
    sitemap_source,
    sitemap_summary,
)
from jojo_olds_api.wayback_manifest import (
    WaybackCDXClient,
    discovery_summary,
    initialize_discovery_schema,
    next_discovery_query,
    record_discovery_page,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a resumable capture manifest from publisher sitemaps."
    )
    parser.add_argument("--publisher", required=True)
    parser.add_argument(
        "--source-variant",
        choices=("canonical", "axios-local"),
        default="canonical",
    )
    parser.add_argument("--from-year", type=int, default=2016)
    parser.add_argument("--to-year", type=int, default=2026)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--state", type=Path)
    parser.add_argument("--max-sitemaps", type=int, default=10)
    parser.add_argument("--min-request-interval", type=float, default=1.0)
    parser.add_argument("--timeout", type=float, default=90.0)
    parser.add_argument("--attempts", type=int, default=5)
    parser.add_argument("--github-output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.from_year > args.to_year:
        raise SystemExit("--from-year must not be after --to-year")
    if args.max_sitemaps < 1:
        raise SystemExit("--max-sitemaps must be positive")
    if args.source_variant == "axios-local" and args.publisher != "axios":
        raise SystemExit("axios-local source requires --publisher axios")
    source = sitemap_source(
        "axios-local" if args.source_variant == "axios-local" else args.publisher
    )
    publisher_spec = archive_source_spec(args.publisher)
    state = args.state or args.output.with_suffix(".sqlite3")
    state.parent.mkdir(parents=True, exist_ok=True)
    client = SitemapClient(
        minimum_interval=args.min_request_interval,
        timeout=args.timeout,
        attempts=args.attempts,
    )
    connection = sqlite3.connect(state, timeout=60)
    processed = 0
    try:
        index = client.fetch_xml(source.index_url)
        initialize_sitemap_schema(
            connection,
            source=source,
            from_year=args.from_year,
            to_year=args.to_year,
            sitemap_index=index,
            supplemental_sitemap_indexes=tuple(
                client.fetch_xml(index_url)
                for index_url in source.supplemental_index_urls
            ),
        )
        while processed < args.max_sitemaps:
            query = next_sitemap_query(connection)
            if query is None:
                break
            sitemap_url, year, month = query
            result = record_sitemap(
                connection,
                publisher_spec=publisher_spec,
                sitemap_url=sitemap_url,
                year=year,
                month=month,
                content=client.fetch_xml(sitemap_url),
            )
            processed += 1
            print(
                json.dumps(
                    {
                        "event": "sitemap",
                        "publisher": args.publisher,
                        "year": year,
                        "month": month,
                        "processedThisRun": processed,
                        **result,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
    finally:
        client.close()
    wayback_pages = 0
    wayback_error: str | None = None
    wayback: dict[str, object] | None = None
    if args.publisher in {"bloomberg", "ft"}:
        initialize_discovery_schema(
            connection,
            spec=publisher_spec,
            from_year=args.from_year,
            to_year=args.to_year,
            collapse="urlkey",
        )
        wayback_client = WaybackCDXClient(
            minimum_interval=args.min_request_interval,
            timeout=args.timeout,
            attempts=args.attempts,
            page_limit=2_000,
            collapse="urlkey",
        )
        try:
            while wayback_pages < args.max_sitemaps:
                query = next_discovery_query(connection)
                if query is None:
                    break
                pattern, resume_key = query
                try:
                    page = wayback_client.fetch_page(
                        pattern=pattern,
                        from_year=args.from_year,
                        to_year=args.to_year,
                        resume_key=resume_key,
                    )
                except RuntimeError as exc:
                    wayback_error = str(exc)
                    print(
                        json.dumps(
                            {
                                "event": "wayback-discovery-deferred",
                                "publisher": args.publisher,
                                "pattern": pattern,
                                "error": wayback_error,
                            },
                            ensure_ascii=False,
                        ),
                        flush=True,
                    )
                    break
                result = record_discovery_page(
                    connection,
                    spec=publisher_spec,
                    pattern=pattern,
                    page=page,
                )
                wayback_pages += 1
                print(
                    json.dumps(
                        {
                            "event": "wayback-discovery-page",
                            "publisher": args.publisher,
                            "pattern": pattern,
                            "page": wayback_pages,
                            **result,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
        finally:
            wayback_client.close()
        wayback = discovery_summary(connection)
    syndication_processed = 0
    syndication_resolutions = 0
    syndication_resolution_matches = 0
    syndication_error: str | None = None
    ft_syndication: dict[str, object] | None = None
    ft_infini_queries = 0
    ft_infini_documents = 0
    ft_resolution_attempts = 0
    bloomberg_bnn: dict[str, object] | None = None
    bloomberg_bnn_days = 0
    bloomberg_bnn_pages = 0
    bloomberg_infini_queries = 0
    bloomberg_infini_documents = 0
    bloomberg_infini_pages = 0
    bloomberg_bnn_error: str | None = None
    if args.publisher == "nyt":
        initialize_nyt_syndication_schema(
            connection,
            from_year=args.from_year,
            to_year=args.to_year,
        )
        syndication_client = ArchiveClient(
            minimum_interval=args.min_request_interval,
            timeout=args.timeout,
            attempts=args.attempts,
        )
        try:
            while syndication_processed < args.max_sitemaps:
                query = next_nyt_syndication_query(connection)
                if query is None:
                    break
                year, page, request_url = query
                try:
                    status, headers, content, _ = syndication_client.fetch(
                        request_url,
                        maximum_bytes=MAXIMUM_RESPONSE_BYTES,
                    )
                    if status != 200:
                        raise ValueError(
                            f"partner catalog returned HTTP {status}"
                        )
                    total_pages = int(
                        headers.get("x-wp-totalpages") or "0"
                    )
                    result = record_nyt_syndication_page(
                        connection,
                        year=year,
                        page=page,
                        request_url=request_url,
                        content=content,
                        total_pages=total_pages,
                    )
                except Exception as exc:
                    syndication_error = (
                        f"{type(exc).__name__}: {exc}"
                    )
                    print(
                        json.dumps(
                            {
                                "event": "nyt-syndication-error",
                                "year": year,
                                "page": page,
                                "error": syndication_error,
                            },
                            ensure_ascii=False,
                        ),
                        flush=True,
                    )
                    break
                syndication_processed += 1
                print(
                    json.dumps(
                        {
                            "event": "nyt-syndication-page",
                            "year": year,
                            "page": page,
                            "processedThisRun": syndication_processed,
                            **result,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            maximum_resolutions = args.max_sitemaps * 10
            while syndication_resolutions < maximum_resolutions:
                resolution = next_nyt_syndication_resolution(connection)
                if resolution is None:
                    break
                (
                    syndicated_url,
                    partner_published_at,
                    headline,
                    source_endpoint,
                ) = resolution
                search_url = nyt_syndication_resolution_url(headline)
                try:
                    status, headers, content, _ = syndication_client.fetch(
                        search_url,
                        maximum_bytes=2_000_000,
                    )
                    content_type = headers.get(
                        "content-type",
                        "",
                    ).casefold()
                    if status != 200:
                        raise ValueError(
                            f"headline search returned HTTP {status}"
                        )
                    if (
                        "html" not in content_type
                        and b"<html" not in content[:1_000].lower()
                    ):
                        raise ValueError(
                            "headline search did not return HTML"
                        )
                    resolved = resolve_nyt_syndication_search(
                        content,
                        headline=headline,
                        partner_published_at=partner_published_at,
                    )
                    record_nyt_syndication_resolution(
                        connection,
                        syndicated_url=syndicated_url,
                        partner_published_at=partner_published_at,
                        headline=headline,
                        source_endpoint=source_endpoint,
                        resolved=resolved,
                    )
                except Exception as exc:
                    syndication_error = (
                        f"{type(exc).__name__}: {exc}"
                    )
                    print(
                        json.dumps(
                            {
                                "event": "nyt-resolution-error",
                                "error": syndication_error,
                            },
                            ensure_ascii=False,
                        ),
                        flush=True,
                    )
                    break
                syndication_resolutions += 1
                syndication_resolution_matches += int(
                    resolved is not None
                )
                if (
                    syndication_resolutions % 25 == 0
                    or syndication_resolutions == maximum_resolutions
                ):
                    print(
                        json.dumps(
                            {
                                "event": "nyt-resolution-progress",
                                "processedThisRun": (
                                    syndication_resolutions
                                ),
                                "matchedThisRun": (
                                    syndication_resolution_matches
                                ),
                            },
                            ensure_ascii=False,
                        ),
                        flush=True,
                    )
        finally:
            syndication_client.close()
    if args.publisher == "ft":
        initialize_ft_syndication_schema(
            connection,
            from_year=args.from_year,
            to_year=args.to_year,
        )
        try:
            with httpx.Client(
                headers={
                    "User-Agent": (
                        "JOJO-News-Archive-Research/0.1 "
                        "(authorized nonprofit academic archive)"
                    )
                },
                follow_redirects=True,
                timeout=args.timeout,
            ) as ft_client:
                query_result = process_ft_infini_queries(
                    connection,
                    http_client=ft_client,
                    maximum_years=args.max_sitemaps,
                )
                ft_infini_queries = int(query_result["processed"])
                print(
                    json.dumps(
                        {
                            "event": "ft-infini-queries",
                            **query_result,
                            "errors": len(query_result["errors"]),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                document_result = process_ft_infini_documents(
                    connection,
                    http_client=ft_client,
                    maximum=args.max_sitemaps * 25,
                    workers=4,
                    minimum_request_interval=(
                        args.min_request_interval
                    ),
                )
                ft_infini_documents = int(
                    document_result["attempted"]
                )
                print(
                    json.dumps(
                        {
                            "event": "ft-infini-documents",
                            **document_result,
                            "errors": len(document_result["errors"]),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                resolution_result = (
                    process_ft_syndication_resolutions(
                        connection,
                        http_client=ft_client,
                        maximum=args.max_sitemaps * 25,
                        minimum_request_interval=(
                            args.min_request_interval
                        ),
                    )
                )
                ft_resolution_attempts = int(
                    resolution_result["attempted"]
                )
                print(
                    json.dumps(
                        {
                            "event": "ft-syndication-resolutions",
                            **resolution_result,
                            "errors": len(resolution_result["errors"]),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
        except Exception as exc:
            syndication_error = f"{type(exc).__name__}: {exc}"
            print(
                json.dumps(
                    {
                        "event": "ft-syndication-error",
                        "error": syndication_error,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        ft_syndication = ft_syndication_summary(connection)
    if args.publisher == "bloomberg":
        initialize_bloomberg_bnn_schema(
            connection,
            from_year=args.from_year,
            to_year=args.to_year,
        )
        bnn_client = ArchiveClient(
            minimum_interval=args.min_request_interval,
            timeout=args.timeout,
            attempts=args.attempts,
        )
        try:
            with httpx.Client(
                headers={
                    "User-Agent": (
                        "JOJO-News-Archive-Research/0.1 "
                        "(authorized nonprofit academic archive)"
                    )
                },
                follow_redirects=True,
                timeout=args.timeout,
            ) as bloomberg_source_client:
                infini_query_result = process_bloomberg_infini_queries(
                    connection,
                    http_client=bloomberg_source_client,
                    maximum_years=args.max_sitemaps,
                )
                bloomberg_infini_queries = int(
                    infini_query_result["processed"]
                )
                print(
                    json.dumps(
                        {
                            "event": "bloomberg-infini-queries",
                            **infini_query_result,
                            "errors": len(
                                infini_query_result["errors"]
                            ),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                infini_document_result = (
                    process_bloomberg_infini_documents(
                        connection,
                        http_client=bloomberg_source_client,
                        maximum=args.max_sitemaps * 25,
                        workers=4,
                        minimum_request_interval=(
                            args.min_request_interval
                        ),
                    )
                )
                bloomberg_infini_documents = int(
                    infini_document_result["attempted"]
                )
                print(
                    json.dumps(
                        {
                            "event": "bloomberg-infini-documents",
                            **infini_document_result,
                            "errors": len(
                                infini_document_result["errors"]
                            ),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                infini_page_result = process_bloomberg_infini_pages(
                    connection,
                    search_client=bloomberg_source_client,
                    archive_client=bnn_client,
                    maximum=args.max_sitemaps * 10,
                    minimum_request_interval=(
                        args.min_request_interval
                    ),
                )
                bloomberg_infini_pages = int(
                    infini_page_result["attempted"]
                )
                print(
                    json.dumps(
                        {
                            "event": "bloomberg-infini-pages",
                            **infini_page_result,
                            "errors": len(
                                infini_page_result["errors"]
                            ),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            day_result = process_bloomberg_bnn_sitemaps(
                connection,
                http_client=bnn_client,
                maximum_days=args.max_sitemaps * 2,
            )
            bloomberg_bnn_days = int(day_result["processed"])
            print(
                json.dumps(
                    {
                        "event": "bloomberg-bnn-sitemaps",
                        **day_result,
                        "errors": len(day_result["errors"]),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            page_result = process_bloomberg_bnn_pages(
                connection,
                http_client=bnn_client,
                maximum=args.max_sitemaps * 25,
            )
            bloomberg_bnn_pages = int(page_result["attempted"])
            print(
                json.dumps(
                    {
                        "event": "bloomberg-bnn-pages",
                        **page_result,
                        "errors": len(page_result["errors"]),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as exc:
            bloomberg_bnn_error = f"{type(exc).__name__}: {exc}"
            print(
                json.dumps(
                    {
                        "event": "bloomberg-bnn-error",
                        "error": bloomberg_bnn_error,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        finally:
            bnn_client.close()
        bloomberg_bnn = bloomberg_bnn_summary(connection)
    manifest = export_sitemap_manifest(
        connection,
        publisher=args.publisher,
        destination=args.output,
        from_year=args.from_year,
        to_year=args.to_year,
    )
    sitemap_is_complete = bool(manifest["complete"])
    syndication = (
        nyt_syndication_summary(connection)
        if args.publisher == "nyt"
        else None
    )
    should_continue = bool(manifest["shouldContinue"]) or bool(
        syndication and syndication["shouldContinue"]
    ) or bool(
        ft_syndication and ft_syndication["shouldContinue"]
    ) or bool(
        bloomberg_bnn and bloomberg_bnn["shouldContinue"]
    ) or bool(
        wayback and wayback["shouldContinue"]
    )
    summary = {
        **sitemap_summary(connection),
        **manifest,
        "sitemapComplete": sitemap_is_complete,
        "complete": not should_continue,
        "shouldContinue": should_continue,
        "captureReady": sitemap_is_complete,
        "state": str(state),
        "sitemapsThisRun": processed,
        "waybackPagesThisRun": wayback_pages,
        "nytSyndicationPagesThisRun": syndication_processed,
        "nytSyndicationResolutionsThisRun": syndication_resolutions,
        "nytSyndicationResolutionMatchesThisRun": (
            syndication_resolution_matches
        ),
        "ftInfiniQueriesThisRun": ft_infini_queries,
        "ftInfiniDocumentsThisRun": ft_infini_documents,
        "ftSyndicationResolutionsThisRun": ft_resolution_attempts,
        "bloombergBnnDaysThisRun": bloomberg_bnn_days,
        "bloombergBnnPagesThisRun": bloomberg_bnn_pages,
        "bloombergInfiniQueriesThisRun": bloomberg_infini_queries,
        "bloombergInfiniDocumentsThisRun": (
            bloomberg_infini_documents
        ),
        "bloombergInfiniPagesThisRun": bloomberg_infini_pages,
        **(
            {"nytSyndication": syndication}
            if syndication is not None
            else {}
        ),
        **(
            {"nytSyndicationError": syndication_error}
            if syndication_error and args.publisher == "nyt"
            else {}
        ),
        **(
            {"ftSyndication": ft_syndication}
            if ft_syndication is not None
            else {}
        ),
        **(
            {"ftSyndicationError": syndication_error}
            if syndication_error and args.publisher == "ft"
            else {}
        ),
        **(
            {"bloombergBnn": bloomberg_bnn}
            if bloomberg_bnn is not None
            else {}
        ),
        **(
            {"bloombergBnnError": bloomberg_bnn_error}
            if bloomberg_bnn_error
            else {}
        ),
        **({"wayback": wayback} if wayback is not None else {}),
        **({"waybackError": wayback_error} if wayback_error else {}),
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
                f"capture_ready="
                f"{str(bool(summary['captureReady'])).lower()}\n"
            )
            handle.write(f"articles={summary['articles']}\n")
    connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
