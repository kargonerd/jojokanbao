from __future__ import annotations

import argparse
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import time


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from jojo_olds_api.bloomberg_archive_download import (  # noqa: E402
    ArchiveClient,
    ManifestArticle,
    download_article,
    download_summary,
    initialize_download_schema,
    load_manifest,
    mark_downloading,
    pending_articles,
    record_article_result,
)


DEFAULT_AUTHORIZATION_REFERENCE = (
    "user-attested:personal-academic-ai-news-research:2026-07-24"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Download an authorized Bloomberg calendar-year archive from indexed "
            "Wayback captures. Stores raw HTML, extracted body text, and the best "
            "available version of each editorial image with resumable state."
        )
    )
    parser.add_argument("--year", type=int, default=2020)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument(
        "--authorization-reference",
        default=DEFAULT_AUTHORIZATION_REFERENCE,
        help=(
            "Audit reference authorizing bulk storage and AI research. The default "
            "records the authorization attested by the user on 2026-07-24."
        ),
    )
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--min-request-interval", type=float, default=0.5)
    parser.add_argument("--timeout", type=float, default=90.0)
    parser.add_argument("--attempts", type=int, default=6)
    parser.add_argument("--max-articles", type=int)
    parser.add_argument(
        "--max-runtime-minutes",
        type=float,
        help=(
            "Stop submitting new articles after this many minutes, then finish "
            "in-flight downloads and write a resumable checkpoint."
        ),
    )
    parser.add_argument(
        "--max-record-attempts",
        type=int,
        default=3,
        help=(
            "Maximum article-level attempts for error/partial recovery rows. "
            "Pending rows remain eligible so interrupted jobs can always resume."
        ),
    )
    parser.add_argument("--retry-errors", action="store_true")
    parser.add_argument("--no-images", action="store_true")
    parser.add_argument("--max-html-mb", type=int, default=20)
    parser.add_argument("--max-image-mb", type=int, default=50)
    parser.add_argument("--progress-every", type=int, default=10)
    parser.add_argument("--minimum-free-gb", type=float, default=10.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.workers < 1 or args.workers > 16:
        raise SystemExit("--workers must be between 1 and 16")
    if args.min_request_interval < 0:
        raise SystemExit("--min-request-interval cannot be negative")
    if args.max_articles is not None and args.max_articles < 1:
        raise SystemExit("--max-articles must be positive")
    if args.max_runtime_minutes is not None and args.max_runtime_minutes <= 0:
        raise SystemExit("--max-runtime-minutes must be positive")
    if args.max_record_attempts < 1:
        raise SystemExit("--max-record-attempts must be positive")
    if not args.authorization_reference.strip():
        raise SystemExit("--authorization-reference cannot be empty")

    manifest = args.manifest or (
        SERVICE_DIR / "data" / f"bloomberg-{args.year}-archive-manifest.jsonl.gz"
    )
    output_dir = args.output_dir or (
        SERVICE_DIR / "data" / f"bloomberg-{args.year}-full"
    )
    if not manifest.exists():
        raise SystemExit(f"Manifest does not exist: {manifest}")
    output_dir.mkdir(parents=True, exist_ok=True)
    free_gb = shutil.disk_usage(output_dir).free / (1024**3)
    if free_gb < args.minimum_free_gb:
        raise SystemExit(
            f"Only {free_gb:.2f} GB is free; minimum is {args.minimum_free_gb:.2f} GB"
        )

    state_path = output_dir / "archive.sqlite3"
    connection = sqlite3.connect(state_path)
    initialize_download_schema(
        connection,
        authorization_reference=args.authorization_reference,
    )
    manifest_result = load_manifest(
        connection,
        manifest_path=manifest,
        authorization_reference=args.authorization_reference,
    )
    articles = pending_articles(
        connection,
        retry_errors=args.retry_errors,
        maximum=args.max_articles,
        maximum_record_attempts=args.max_record_attempts,
    )
    print(
        json.dumps(
            {
                "event": "start",
                "manifest": str(manifest.resolve()),
                "state": str(state_path.resolve()),
                "freeGB": round(free_gb, 2),
                "queued": len(articles),
                **manifest_result,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    if not articles:
        result = download_summary(connection, output_dir=output_dir)
        _write_summary(output_dir, result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        connection.close()
        return 0

    archive_client = ArchiveClient(
        timeout=args.timeout,
        minimum_interval=args.min_request_interval,
        attempts=args.attempts,
    )
    maximum_html_bytes = args.max_html_mb * 1024 * 1024
    maximum_image_bytes = args.max_image_mb * 1024 * 1024
    started_at = time.monotonic()
    deadline = (
        started_at + args.max_runtime_minutes * 60
        if args.max_runtime_minutes is not None
        else None
    )
    completed = 0
    failures = 0
    runtime_limit_reached = False
    iterator = iter(articles)
    in_flight: dict[Future, ManifestArticle] = {}

    def submit_one(executor: ThreadPoolExecutor) -> bool:
        nonlocal runtime_limit_reached
        if deadline is not None and time.monotonic() >= deadline:
            if not runtime_limit_reached:
                runtime_limit_reached = True
                print(
                    json.dumps(
                        {
                            "event": "runtime_limit_reached",
                            "completedThisRun": completed,
                            "queuedThisRun": len(articles),
                        }
                    ),
                    flush=True,
                )
            return False
        try:
            article = next(iterator)
        except StopIteration:
            return False
        mark_downloading(connection, article)
        future = executor.submit(
            download_article,
            article,
            archive_client=archive_client,
            output_dir=output_dir,
            maximum_html_bytes=maximum_html_bytes,
            maximum_image_bytes=maximum_image_bytes,
            download_images=not args.no_images,
        )
        in_flight[future] = article
        return True

    try:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            for _ in range(min(len(articles), args.workers * 2)):
                submit_one(executor)
            while in_flight:
                finished, _ = wait(in_flight, return_when=FIRST_COMPLETED)
                for future in finished:
                    article = in_flight.pop(future)
                    try:
                        result = future.result()
                    except Exception as exc:
                        result = {
                            "url": article.url,
                            "status": "error",
                            "httpStatus": None,
                            "bodyText": "",
                            "bodyChars": 0,
                            "bodyHtml": None,
                            "assets": [],
                            "imageStatus": "not_attempted",
                            "error": f"{type(exc).__name__}: {exc}",
                        }
                    record_article_result(connection, result)
                    completed += 1
                    failures += result["status"] == "error"
                    submit_one(executor)
                    if (
                        completed % args.progress_every == 0
                        or completed == len(articles)
                    ):
                        elapsed = max(0.001, time.monotonic() - started_at)
                        rate = completed / elapsed
                        remaining = len(articles) - completed
                        event = {
                            "event": "progress",
                            "completedThisRun": completed,
                            "queuedThisRun": len(articles),
                            "errorsThisRun": failures,
                            "articlesPerMinute": round(rate * 60, 2),
                            "estimatedMinutesRemaining": (
                                round(remaining / rate / 60, 1) if rate else None
                            ),
                            "lastUrl": result["url"],
                            "lastStatus": result["status"],
                        }
                        print(json.dumps(event, ensure_ascii=False), flush=True)
                        _write_summary(
                            output_dir,
                            download_summary(connection, output_dir=output_dir),
                        )
    except KeyboardInterrupt:
        print("Interrupted; completed rows are committed and the run is resumable.")
        return_code = 130
    else:
        return_code = 0
    finally:
        archive_client.close()

    result = download_summary(connection, output_dir=output_dir)
    result["completedThisRun"] = completed
    result["errorsThisRun"] = failures
    result["stoppedForRuntimeLimit"] = runtime_limit_reached
    _write_summary(output_dir, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    connection.close()
    return return_code


def _write_summary(output_dir: Path, result: dict) -> None:
    path = output_dir / "summary.json"
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


if __name__ == "__main__":
    raise SystemExit(main())
