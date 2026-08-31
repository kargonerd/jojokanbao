from __future__ import annotations

import argparse
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import time
from typing import Any

import httpx


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_news_archive.discovery.client import ArchiveClient
from jojo_news_archive.sources.ft.discovery.infini import (
    discover_ft_infini_direct_candidates,
)
from jojo_news_archive.sources.ft.discovery.syndication import (
    load_ft_syndication_title_index,
)
from jojo_news_archive.sources.registry import publisher_spec
from jojo_news_archive.parsing.validation import (
    DEFAULT_SEED,
    ensure_parser_validation_plan,
    is_parser_validation_sample,
    parser_validation_summary,
    parser_validation_target_reached,
    pending_completed_parser_validation_files,
    record_parser_validation,
)
from jojo_news_archive.capture.raw import (
    ManifestItem,
    archive_fallback_policy,
    capture_item,
    capture_summary,
    completed_raw_capture,
    initialize_capture_schema,
    lease_pending_captures,
    load_capture_manifest,
    record_capture_result,
    release_capture_leases,
)


def _historical_attempts_from_leased_row(attempts: int) -> int:
    """Return attempts completed before the current capture lease.

    ``lease_pending_captures`` increments ``captures.attempts`` while it
    atomically reserves the batch. Fallback staging is based on earlier
    completed attempts, so the lease for the request about to be submitted
    must not make a fresh row look like a retry.
    """

    return max(0, attempts - 1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Capture raw archived HTML without parsing article content."
    )
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--skip-manifest-load",
        action="store_true",
        help=(
            "Resume from an existing capture.sqlite3 without rescanning and "
            "upserting the manifest."
        ),
    )
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--min-request-interval", type=float, default=0.5)
    parser.add_argument("--timeout", type=float, default=90.0)
    parser.add_argument("--attempts", type=int, default=6)
    parser.add_argument("--max-captures", type=int)
    parser.add_argument("--max-runtime-minutes", type=float)
    parser.add_argument("--max-record-attempts", type=int, default=3)
    parser.add_argument(
        "--stop-after-errors",
        type=int,
        default=0,
        help=(
            "Stop submitting new captures after this many errors in the "
            "current batch; in-flight work is still checkpointed."
        ),
    )
    parser.add_argument("--retry-errors", action="store_true")
    parser.add_argument(
        "--skip-wayback-timemap",
        action="store_true",
        help=(
            "Do not perform dynamic Wayback timemap discovery for this "
            "batch; use the manifest candidates and enabled secondary "
            "archives only."
        ),
    )
    parser.add_argument(
        "--concurrent-worker",
        action="store_true",
        help=(
            "Join an already initialized capture state without recovering "
            "active leases held by another local process. Batch rows are "
            "still reserved atomically."
        ),
    )
    parser.add_argument(
        "--enable-common-crawl-fallback",
        action="store_true",
        help=(
            "Try the substantially slower per-article Common Crawl index and "
            "WARC fallback after Wayback candidates are exhausted."
        ),
    )
    parser.add_argument(
        "--enable-arquivo-pt-fallback",
        action="store_true",
        help=(
            "Try exact Arquivo.pt CDX and replay candidates after Wayback "
            "captures are exhausted."
        ),
    )
    parser.add_argument("--max-html-mb", type=int, default=25)
    parser.add_argument("--progress-every", type=int, default=25)
    parser.add_argument("--minimum-free-gb", type=float, default=2.0)
    parser.add_argument(
        "--validation-sample-per-year",
        type=int,
        default=0,
        help="Prioritize a reproducible random parser QA sample for every year.",
    )
    parser.add_argument("--validation-seed", default=DEFAULT_SEED)
    parser.add_argument(
        "--validation-reserve-per-year",
        type=int,
        help=(
            "Additional deterministic random candidates kept available per "
            "year when the primary validation sample is not retrievable."
        ),
    )
    parser.add_argument(
        "--bloomberg-manifest-candidates-only",
        action="store_true",
        help=(
            "For Bloomberg validation, try only candidates already stored "
            "on each manifest row; skip dynamic Wayback timemap and "
            "syndication discovery."
        ),
    )
    parser.add_argument(
        "--ft-syndication-catalog",
        type=Path,
        help=(
            "Read the FT discovery SQLite catalog as a local title-to-"
            "Infini provenance index after raw archive candidates fail."
        ),
    )
    parser.add_argument(
        "--enable-ft-infini-direct-discovery",
        action="store_true",
        help=(
            "Scan provenance-bearing Infini-News Parquet rows for complete "
            "direct FT captures before building the parser QA plan."
        ),
    )
    parser.add_argument("--validation-from-year", type=int)
    parser.add_argument("--validation-to-year", type=int)
    parser.add_argument(
        "--stop-when-validation-ready",
        action="store_true",
        help=(
            "Stop submitting new captures as soon as every configured parser "
            "validation year passes its target and QA gates."
        ),
    )
    parser.add_argument(
        "--stop-when-validation-target-reached",
        action="store_true",
        help=(
            "Stop evaluating new parser samples at the configured sample "
            "count even when QA gates fail."
        ),
    )
    parser.add_argument(
        "--authorization-reference",
        default="user-provided-authorization",
    )
    return parser.parse_args()


def _record_validation_if_selected(
    connection: sqlite3.Connection,
    *,
    validation_plan: dict[str, object] | None,
    capture: Any | None,
    canonical_url: str,
    validation_target_reached: bool,
    archive_root: Path,
) -> dict[str, object] | None:
    if (
        validation_plan is None
        or capture is None
        or validation_target_reached
    ):
        return None
    if not is_parser_validation_sample(connection, canonical_url):
        return None
    return record_parser_validation(
        connection,
        capture=capture,
        archive_root=archive_root,
    )


def _cancel_not_started_validation_futures(
    in_flight: dict[Future, ManifestItem],
) -> int:
    """Remove queued capture work after a validation stop gate is met.

    ``ThreadPoolExecutor`` futures that are already running cannot be
    cancelled and remain in ``in_flight`` so their results are checkpointed.
    Futures that have not started are safe to cancel: their leased rows are
    returned to the queue by ``release_capture_leases`` at batch shutdown.
    """

    cancelled = 0
    for future in tuple(in_flight):
        if future.cancel():
            in_flight.pop(future)
            cancelled += 1
    return cancelled


def _initial_capture_window(
    *,
    workers: int,
    validation_summary: dict[str, object] | None,
) -> int:
    """Size validation prefetch to the number of QA-passing rows still due."""

    if validation_summary is None:
        return workers * 2
    years = validation_summary.get("years")
    if not isinstance(years, dict) or not years:
        return workers
    remaining = 0
    for value in years.values():
        if not isinstance(value, dict):
            continue
        remaining += max(
            0,
            int(value.get("target") or 0)
            - int(value.get("qaPassed") or 0),
        )
    if remaining <= 0:
        return 0
    # Four candidates per missing QA pass retains useful parallelism when
    # archive replay success is low. Capping at the worker count prevents a
    # two-batch queue from forming just as a continuation reaches its target.
    return min(workers, max(4, remaining * 4))


def main() -> int:
    args = parse_args()
    publisher_spec(args.publisher)
    if args.workers < 1:
        raise SystemExit("--workers must be positive")
    if args.stop_after_errors < 0:
        raise SystemExit("--stop-after-errors must not be negative")
    if args.max_record_attempts < 1:
        raise SystemExit("--max-record-attempts must be positive")
    if not args.manifest.exists():
        raise SystemExit(f"manifest not found: {args.manifest}")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    free_gb = shutil.disk_usage(args.output_dir).free / 1024**3
    if free_gb < args.minimum_free_gb:
        raise SystemExit(
            f"only {free_gb:.2f} GB free; need {args.minimum_free_gb:.2f} GB"
        )

    state_path = args.output_dir / "capture.sqlite3"
    connection = sqlite3.connect(state_path, timeout=60)
    initialize_capture_schema(
        connection,
        publisher=args.publisher,
        authorization_reference=args.authorization_reference,
        recover_interrupted=not args.concurrent_worker,
    )
    if args.skip_manifest_load:
        capture_rows = connection.execute(
            "SELECT COUNT(*) FROM captures WHERE publisher = ?",
            (args.publisher,),
        ).fetchone()[0]
        if capture_rows == 0:
            raise SystemExit(
                "--skip-manifest-load requires an existing populated "
                "capture.sqlite3"
            )
        manifest_result = {
            "manifestRows": 0,
            "inserted": 0,
            "manifestLoadSkipped": True,
        }
    else:
        manifest_result = load_capture_manifest(
            connection,
            manifest_path=args.manifest,
            publisher=args.publisher,
        )
    ft_title_index = None
    if args.ft_syndication_catalog is not None:
        if args.publisher != "ft":
            raise SystemExit(
                "--ft-syndication-catalog is only valid for FT"
            )
        ft_title_index = load_ft_syndication_title_index(
            args.ft_syndication_catalog
        )
    infini_direct_result = None
    if args.enable_ft_infini_direct_discovery:
        if args.publisher != "ft":
            raise SystemExit(
                "--enable-ft-infini-direct-discovery is only valid for FT"
            )
        if (
            args.validation_from_year is None
            or args.validation_to_year is None
            or args.validation_from_year != args.validation_to_year
        ):
            raise SystemExit(
                "FT Infini-News direct discovery requires one validation year"
            )
        target_articles = max(
            850,
            args.validation_sample_per_year
            + min(args.validation_reserve_per_year or 0, 500),
        )
        with httpx.Client(
            timeout=60.0,
            follow_redirects=True,
            headers={
                "User-Agent": (
                    "jojokanbao-news-archive/1.0 "
                    "(personal academic parser validation)"
                )
            },
        ) as discovery_client:
            infini_direct_result = discover_ft_infini_direct_candidates(
                connection,
                year=args.validation_from_year,
                http_client=discovery_client,
                target_articles=target_articles,
            )
    validation_plan = None
    if args.validation_sample_per_year:
        if args.validation_from_year is None or args.validation_to_year is None:
            raise SystemExit(
                "--validation-from-year and --validation-to-year are required "
                "when parser validation sampling is enabled"
            )
        validation_plan = ensure_parser_validation_plan(
            connection,
            publisher=args.publisher,
            from_year=args.validation_from_year,
            to_year=args.validation_to_year,
            target_per_year=args.validation_sample_per_year,
            reserve_per_year=args.validation_reserve_per_year,
            maximum_record_attempts=args.max_record_attempts,
            seed=args.validation_seed,
        )
    elif (
        args.stop_when_validation_ready
        or args.stop_when_validation_target_reached
    ):
        raise SystemExit(
            "validation stop options require "
            "--validation-sample-per-year"
        )
    replayed_validation_samples = 0
    if validation_plan is not None:
        completed_samples = pending_completed_parser_validation_files(
            connection,
            maximum=None,
        )
        for canonical_url, _raw_path in completed_samples:
            capture = completed_raw_capture(
                connection,
                canonical_url=canonical_url,
            )
            record_parser_validation(
                connection,
                capture=capture,
                archive_root=args.output_dir,
            )
            replayed_validation_samples += 1
    validation_target_reached = bool(
        args.stop_when_validation_target_reached
        and parser_validation_target_reached(connection)
    )
    validation_ready = bool(
        args.stop_when_validation_ready
        and parser_validation_summary(connection)["ready"]
    )
    infini_metadata_pending = bool(
        isinstance(infini_direct_result, dict)
        and not infini_direct_result.get("metadataReady", True)
    )
    items = (
        []
        if (
            validation_ready
            or validation_target_reached
            or infini_metadata_pending
        )
        else lease_pending_captures(
            connection,
            retry_errors=args.retry_errors,
            maximum=args.max_captures,
            maximum_record_attempts=args.max_record_attempts,
            prioritize_parser_validation=bool(
                args.validation_sample_per_year
            ),
            parser_validation_only=bool(
                args.stop_when_validation_ready
                or args.stop_when_validation_target_reached
            ),
            validation_from_year=args.validation_from_year,
            validation_to_year=args.validation_to_year,
        )
    )
    print(
        json.dumps(
            {
                "event": "start",
                "publisher": args.publisher,
                "manifest": str(args.manifest.resolve()),
                "state": str(state_path.resolve()),
                "freeGB": round(free_gb, 2),
                "queued": len(items),
                **manifest_result,
                "ftSyndicationTitleIndexEntries": (
                    ft_title_index.size if ft_title_index is not None else 0
                ),
                "ftInfiniDirectDiscovery": infini_direct_result,
                "parserValidationPlan": validation_plan,
                "replayedValidationSamples": replayed_validation_samples,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    if not items:
        summary = capture_summary(connection, output_dir=args.output_dir)
        _write_summary(args.output_dir, summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        connection.close()
        return 0

    archive_client = ArchiveClient(
        timeout=args.timeout,
        minimum_interval=args.min_request_interval,
        attempts=args.attempts,
    )
    started_at = time.monotonic()
    deadline = (
        started_at + args.max_runtime_minutes * 60
        if args.max_runtime_minutes is not None
        else None
    )
    completed = 0
    failures = 0
    stopped_for_error_limit = False
    runtime_limit_reached = False
    cancelled_for_validation = 0
    maximum_html_bytes = args.max_html_mb * 1024 * 1024
    iterator = iter(items)
    in_flight: dict[Future, ManifestItem] = {}

    def submit_one(executor: ThreadPoolExecutor) -> bool:
        nonlocal runtime_limit_reached
        if (
            validation_ready
            or validation_target_reached
            or stopped_for_error_limit
        ):
            return False
        if deadline is not None and time.monotonic() >= deadline:
            runtime_limit_reached = True
            return False
        try:
            item = next(iterator)
        except StopIteration:
            return False
        row = connection.execute(
            "SELECT attempts FROM captures WHERE canonical_url=?",
            (item.canonical_url,),
        ).fetchone()
        prior_attempts = _historical_attempts_from_leased_row(
            int(row[0]) if row is not None else 0
        )
        fallback_policy = archive_fallback_policy(
            publisher=item.publisher,
            parser_validation_enabled=bool(
                args.validation_sample_per_year
            ),
            prior_attempts=prior_attempts,
        )
        future = executor.submit(
            capture_item,
            item,
            archive_client=archive_client,
            output_dir=args.output_dir,
            maximum_html_bytes=maximum_html_bytes,
            enable_wayback_timemap_fallback=(
                fallback_policy.wayback_timemap
                and not args.skip_wayback_timemap
            ),
            enable_common_crawl_fallback=(
                args.enable_common_crawl_fallback
                and fallback_policy.common_crawl
            ),
            enable_arquivo_pt_fallback=(
                args.enable_arquivo_pt_fallback and fallback_policy.arquivo_pt
            ),
            bloomberg_manifest_candidates_only=(
                args.bloomberg_manifest_candidates_only
            ),
            ft_syndication_lookup=(
                None
                if ft_title_index is None
                else lambda indexed_item, indexed_headline: (
                    ft_title_index.candidates_for(
                        published_at=indexed_item.published_at,
                        headline=indexed_headline,
                    )
                )
            ),
        )
        in_flight[future] = item
        return True

    return_code = 0
    try:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            initial_window = _initial_capture_window(
                workers=args.workers,
                validation_summary=(
                    parser_validation_summary(connection)
                    if validation_plan is not None
                    else None
                ),
            )
            for _ in range(min(len(items), initial_window)):
                submit_one(executor)
            while in_flight:
                finished, _ = wait(in_flight, return_when=FIRST_COMPLETED)
                for future in finished:
                    item = in_flight.pop(future)
                    try:
                        result = future.result()
                    except Exception as exc:
                        result = {
                            "canonicalUrl": item.canonical_url,
                            "status": "error",
                            "capture": None,
                            "recordPath": None,
                            "error": f"{type(exc).__name__}: {exc}",
                        }
                    record_capture_result(connection, result)
                    capture = result.get("capture")
                    validation_result = _record_validation_if_selected(
                        connection,
                        validation_plan=validation_plan,
                        capture=capture,
                        canonical_url=item.canonical_url,
                        validation_target_reached=(
                            validation_target_reached
                        ),
                        archive_root=args.output_dir,
                    )
                    completed += 1
                    failures += result["status"] == "error"
                    if (
                        args.stop_after_errors > 0
                        and failures >= args.stop_after_errors
                    ):
                        stopped_for_error_limit = True
                    if args.stop_when_validation_ready:
                        validation_ready = bool(
                            parser_validation_summary(connection)["ready"]
                        )
                    if args.stop_when_validation_target_reached:
                        validation_target_reached = (
                            parser_validation_target_reached(connection)
                        )
                    if validation_ready or validation_target_reached:
                        # The executor is deliberately kept warm with up to
                        # two batches of futures. Once 800 usable samples have
                        # been recorded, discard only the requests that have
                        # not begun instead of waiting for an unnecessary
                        # second batch of archive timeouts before auditing.
                        cancelled_for_validation += (
                            _cancel_not_started_validation_futures(in_flight)
                        )
                    else:
                        submit_one(executor)
                    if (
                        completed % args.progress_every == 0
                        or completed == len(items)
                    ):
                        elapsed = max(0.001, time.monotonic() - started_at)
                        print(
                            json.dumps(
                                {
                                    "event": "progress",
                                    "publisher": args.publisher,
                                    "completedThisRun": completed,
                                    "queuedThisRun": len(items),
                                    "errorsThisRun": failures,
                                    "capturesPerMinute": round(
                                        completed / elapsed * 60,
                                        2,
                                    ),
                                    "lastUrl": result["canonicalUrl"],
                                    "lastStatus": result["status"],
                                    "lastParserValidation": validation_result,
                                },
                                ensure_ascii=False,
                            ),
                            flush=True,
                        )
                        _write_summary(
                            args.output_dir,
                            capture_summary(
                                connection,
                                output_dir=args.output_dir,
                            ),
                        )
    except KeyboardInterrupt:
        print("Interrupted; completed captures are committed and resumable.")
        return_code = 130
    finally:
        archive_client.close()

    released_leases = release_capture_leases(connection, items)
    summary = capture_summary(connection, output_dir=args.output_dir)
    summary.update(
        {
            "publisher": args.publisher,
            "completedThisRun": completed,
            "errorsThisRun": failures,
            "stoppedForRuntimeLimit": runtime_limit_reached,
            "stoppedForErrorLimit": stopped_for_error_limit,
            "stoppedForValidationReady": validation_ready,
            "stoppedForValidationTarget": validation_target_reached,
            "cancelledQueuedForValidation": cancelled_for_validation,
            "releasedLeases": released_leases,
            "finishedAt": datetime.now(timezone.utc).isoformat(),
        }
    )
    _write_summary(args.output_dir, summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    connection.close()
    return return_code


def _write_summary(output_dir: Path, result: dict[str, object]) -> None:
    destination = output_dir / "summary.json"
    temporary = destination.with_name(
        f"{destination.name}.{os.getpid()}.tmp"
    )
    temporary.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(destination)


if __name__ == "__main__":
    raise SystemExit(main())
