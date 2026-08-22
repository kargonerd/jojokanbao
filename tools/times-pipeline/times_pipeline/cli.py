from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from time import perf_counter

from .build import build_times_release
from .feeds import collect_sources, load_sources
from .publish import download_previous_state, publish_release
from .runner_bridge import enrich_articles
from .webarchive import capture_articles, load_archive_state, select_articles_for_capture


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SOURCES = REPOSITORY_ROOT / "tools" / "times-pipeline" / "sources.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect Times feeds, build JOJO newspaper objects, and optionally publish them to B2.")
    parser.add_argument("--sources", type=Path, default=DEFAULT_SOURCES)
    parser.add_argument("--source", action="append", dest="source_ids", help="Only collect the selected source id; repeat as needed.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--previous-dir", type=Path)
    parser.add_argument("--rsshub-url", default=os.getenv("JOJO_TIMES_RSSHUB_URL", "https://jojokanbao-rsshub.onrender.com"))
    parser.add_argument("--rsshub-access-key-env", default="JOJOKANBAO_RSSHUB_ACCESS_KEY")
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--article-timeout", type=float, default=25.0)
    parser.add_argument("--archive-engine", choices=("browser", "http"), default=os.getenv("JOJO_TIMES_ARCHIVE_ENGINE", "browser"))
    parser.add_argument("--archive-proxy", default=os.getenv("JOJO_TIMES_ARCHIVE_PROXY"))
    parser.add_argument("--archive-browser-executable", default=os.getenv("JOJO_TIMES_BROWSER_EXECUTABLE"))
    parser.add_argument("--archive-browser-retries", type=int, default=1)
    parser.add_argument("--archive-workers", type=int, default=4)
    parser.add_argument("--archive-max-pages", type=int, default=50)
    parser.add_argument("--archive-refresh-hours", type=float, default=24.0)
    parser.add_argument("--archive-retry-hours", type=float, default=2.0)
    parser.add_argument("--archive-max-response-bytes", type=int, default=5_000_000)
    parser.add_argument("--archive-max-page-bytes", type=int, default=25_000_000)
    parser.add_argument("--news-runner-root", type=Path)
    parser.add_argument("--require-news-runner", action="store_true")
    parser.add_argument("--retention-days", type=int, default=7)
    parser.add_argument("--collection-window-hours", type=float, default=24.0)
    parser.add_argument("--max-latest-articles", type=int, default=1_000)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--delivery-remote", default=os.getenv("JOJO_DELIVERY_REMOTE", "jojo-b2:jojo-newspaper"))
    parser.add_argument("--raw-remote", default=os.getenv("JOJO_RAW_REMOTE", "jojo-b2:jojo-news-raw"))
    return parser.parse_args()


async def run(args: argparse.Namespace) -> dict:
    if args.timeout <= 0 or args.article_timeout <= 0 or args.collection_window_hours <= 0:
        raise ValueError("Network timeouts must be positive")
    pipeline_started = perf_counter()
    now = datetime.now(timezone.utc)
    previous_directory = args.previous_dir
    if args.publish:
        previous_directory = args.output.parent / f"{args.output.name}-previous"
        download_previous_state(
            args.delivery_remote,
            previous_directory,
            raw_remote=args.raw_remote,
            retention_days=args.retention_days,
            now=now,
        )
    sources = load_sources(args.sources)
    if args.source_ids:
        requested = set(args.source_ids)
        known = {source.id for source in sources}
        unknown = sorted(requested - known)
        if unknown:
            raise ValueError(f"Unknown Times source ids: {', '.join(unknown)}")
        sources = tuple(source for source in sources if source.id in requested)
    collection_started = perf_counter()
    window_start = now - timedelta(hours=args.collection_window_hours)
    articles, raw_feeds, statuses = await collect_sources(
        sources,
        rsshub_url=args.rsshub_url,
        rsshub_access_key=os.getenv(args.rsshub_access_key_env),
        timeout_seconds=args.timeout,
        now=now,
        since=window_start,
    )
    collection_elapsed_ms = round((perf_counter() - collection_started) * 1_000)
    archive_state = load_archive_state(previous_directory)
    selected_articles = select_articles_for_capture(
        articles,
        archive_state,
        now=now,
        retention_days=args.retention_days,
        max_pages=args.archive_max_pages,
        refresh_hours=args.archive_refresh_hours,
        retry_hours=args.archive_retry_hours,
    )
    archive_started = perf_counter()
    captures = await capture_articles(
        selected_articles,
        timeout_seconds=args.article_timeout,
        workers=args.archive_workers,
        maximum_response_bytes=args.archive_max_response_bytes,
        engine=args.archive_engine,
        proxy_server=args.archive_proxy,
        browser_executable=args.archive_browser_executable,
        browser_retries=args.archive_browser_retries,
        maximum_page_bytes=args.archive_max_page_bytes,
    )
    archive_elapsed_ms = round((perf_counter() - archive_started) * 1_000)
    parser_started = perf_counter()
    articles, parser_report = enrich_articles(
        articles,
        captures,
        runner_root=args.news_runner_root,
        require_runner=args.require_news_runner,
        parsed_at=now,
    )
    parser_elapsed_ms = round((perf_counter() - parser_started) * 1_000)
    build_started = perf_counter()
    report = build_times_release(
        articles=articles,
        raw_feeds=raw_feeds,
        article_captures=captures,
        source_statuses=statuses,
        output_directory=args.output,
        previous_directory=previous_directory,
        previous_archive_state=archive_state,
        parser_report=parser_report,
        now=now,
        retention_days=args.retention_days,
        max_latest_articles=args.max_latest_articles,
    )
    build_elapsed_ms = round((perf_counter() - build_started) * 1_000)
    if args.publish:
        publish_started = perf_counter()
        report["publish"] = publish_release(
            args.output,
            delivery_remote=args.delivery_remote,
            raw_remote=args.raw_remote,
        )
        publish_elapsed_ms = round((perf_counter() - publish_started) * 1_000)
    else:
        publish_elapsed_ms = 0
    report.update({
        "collectionWindowHours": args.collection_window_hours,
        "windowStart": window_start.isoformat(),
        "selectedForArchive": len(selected_articles),
        "sources": statuses,
        "timingsMs": {
            "collect": collection_elapsed_ms,
            "archive": archive_elapsed_ms,
            "parse": parser_elapsed_ms,
            "build": build_elapsed_ms,
            "publish": publish_elapsed_ms,
            "total": round((perf_counter() - pipeline_started) * 1_000),
        },
    })
    (args.output / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return report


def main() -> int:
    args = parse_args()
    report = asyncio.run(run(args))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
