"""Explicit, resumable two-voice library run. Never deploys or deletes audio."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
import time
from types import SimpleNamespace

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
import httpx

import generate as batch
from environment import load_environment
from app.core.config import Settings
from app.core.errors import ApiError

VOICES = ("白桦", "冰糖")


def error_info(error):
    info = {"type": type(error).__name__}
    if isinstance(error, ApiError):
        info.update(status=error.status_code, code=error.code)
        if error.message == "这个声音暂不可用，请稍后重试或切换其他声音":
            info["reason"] = "provider_auth_rejected"
    if isinstance(error, httpx.HTTPStatusError):
        info["status"] = error.response.status_code
    if isinstance(error, ClientError):
        info["status"] = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    # Never persist upstream message, request text, URLs or credentials.
    return info


def tune(workers, generated, seconds, throttled, clean, ceiling):
    if throttled:
        return max(2, workers // 2), 0
    clean += generated
    if clean >= 32 and workers < ceiling:
        return min(ceiling, workers * 2), 0
    return workers, clean


async def run(args, settings):
    if settings.speech_storage != "b2" or not settings.mimo_api_key:
        raise ValueError("B2/MiMo synthesis configuration is required")
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    if plan.get("formatVersion") != "jojo-speech-plan/1" or not plan.get("books"):
        raise ValueError("Invalid library plan")
    digest = hashlib.sha256(json.dumps([plan, batch.delivery_version("mimo"), VOICES],
                                     ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    jobs = []
    for book in plan["books"]:
        for chapter in book["chapters"]:
            if not chapter["segments"]:
                raise ValueError("Empty chapter")
            for text in chapter["segments"]:
                batch.identity("mimo", "白桦", text)
            # Alternate voices each chapter; one shared account budget.
            for voice in VOICES:
                key = hashlib.sha256(json.dumps([book["datasetId"], book["itemKey"], chapter["id"], voice]).encode()).hexdigest()
                jobs.append((key, book, chapter, voice))
    args.output.mkdir(parents=True, exist_ok=True)
    checkpoint_path = args.output / "checkpoint.json"
    checkpoint = {"planHash": digest, "complete": {}}
    if checkpoint_path.exists():
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if checkpoint.get("planHash") != digest:
            raise ValueError("Plan changed; use a different output directory")
    summary = {"status": "running", "pid": os.getpid(), "startedAt": time.time(),
               "voices": list(VOICES), "booksTotal": len(plan["books"]), "chapterVoiceJobsTotal": len(jobs),
               "segmentsTotal": sum(len(c["segments"]) for _, _, c, _ in jobs),
               "rpmBudget": args.rpm, "tokenReservationBudget": 8_000_000,
               "checkpoint": str(checkpoint_path), "failures": {}, "benchmarks": []}
    summary_path = args.output / "summary.json"
    limiter = batch.RequestLimiter(rpm=args.rpm)
    workers, clean, consecutive_failures = min(getattr(args, "start_concurrency", 4), args.max_concurrency), 0, 0
    # Offline storage gets longer timeouts and retries only the same S3 operation,
    # never a new synthesis as a consequence of an upload retry.
    store = batch.speech_store(settings)
    config = store.client.meta.config.merge(Config(connect_timeout=10, read_timeout=60,
                      max_pool_connections=16, retries={"total_max_attempts": 5, "mode": "standard"}))
    store.client.close()
    store.client = boto3.client("s3", endpoint_url=settings.speech_s3_endpoint,
                               region_name=settings.speech_s3_region,
                               aws_access_key_id=settings.speech_s3_key_id,
                               aws_secret_access_key=settings.speech_s3_application_key, config=config)
    original_save = batch.save_report
    current = None

    def persist():
        totals = {voice: {"chaptersComplete": 0, "segmentsComplete": 0, "referencedBytes": 0} for voice in VOICES}
        for entry in checkpoint["complete"].values():
            row = totals[entry["voice"]]
            row["chaptersComplete"] += 1
            row["segmentsComplete"] += entry["segments"]
            row["referencedBytes"] += entry["bytes"]
        summary.update(updatedAt=time.time(), concurrency=workers, totals=totals,
                       requestsSent=limiter.sent, rateLimitCooldowns=limiter.throttled)
        original_save(summary_path, summary)

    def save_progress(path, report):
        original_save(path, report)
        if current is not None and path == current:
            summary["currentSegmentsComplete"] = report["cacheHits"] + report["generated"]
            summary["currentGenerated"] = report["generated"]
            summary["currentCacheHits"] = report["cacheHits"]
            persist()

    batch.save_report = save_progress
    stop_file = args.output / "STOP"
    persist()
    try:
        # A bounded second pass retries failed chapters; successful objects are
        # looked up in B2 first, including out-of-order saves from a failed attempt.
        for pass_index in range(2):
            summary["pass"] = pass_index + 1
            for key, book, chapter, voice in jobs:
                if key in checkpoint["complete"]:
                    continue
                if stop_file.exists():
                    summary["status"] = "paused"
                    return
                current = args.output / "reports" / f"{key}.json"
                chapter_plan = args.output / "current-plan.json"
                original_save(chapter_plan, {"formatVersion": "jojo-speech-plan/1", "books": [{**book, "chapters": [chapter]}]})
                summary.update(currentVoice=voice, currentBook=book["title"], currentChapter=chapter["id"],
                               currentJob=key, currentReport=str(current), currentSegmentsTotal=len(chapter["segments"]),
                               currentSegmentsComplete=0, currentGenerated=0, currentCacheHits=0)
                persist()
                started, requests, throttled = time.monotonic(), limiter.sent, limiter.throttled
                options = SimpleNamespace(plan=chapter_plan, report=current, provider="mimo", voice=voice,
                                          chapter=None, all=True, limit_chapters=1, dry_run=False, concurrency=workers)
                try:
                    report = await batch.generate(options, settings, limiter=limiter)
                except Exception as error:
                    info = error_info(error)
                    consecutive_failures += 1
                    summary["failures"][key] = {**info, "voice": voice, "datasetId": book["datasetId"],
                                                "chapterId": chapter["id"], "pass": pass_index + 1}
                    workers, clean = max(2, workers // 2), 0
                    print(f"Chapter failed: {voice} {book['datasetId']} {chapter['id']} {info}", flush=True)
                    # Auth, storage permissions, full disks or unavailable config
                    # require intervention; do not hammer every chapter.
                    if (info.get("status") in (401, 403, 503) or info.get("reason") == "provider_auth_rejected"
                            or consecutive_failures >= 5
                            or isinstance(error, OSError) and not isinstance(error, httpx.HTTPError)):
                        raise
                    persist()
                    await asyncio.sleep(10)
                    continue
                seconds = time.monotonic() - started
                consecutive_failures = 0
                benchmark = {"voice": voice, "workers": workers, "seconds": round(seconds, 2),
                             "generated": report["generated"], "cacheHits": report["cacheHits"],
                             "requests": limiter.sent - requests, "cooldowns": limiter.throttled - throttled}
                if benchmark["requests"]:
                    summary["benchmarks"] = (summary["benchmarks"] + [benchmark])[-30:]
                checkpoint["complete"][key] = {"voice": voice, "segments": len(chapter["segments"]),
                                               "bytes": report["uniqueBytes"], "report": str(current)}
                original_save(checkpoint_path, checkpoint)
                summary["failures"].pop(key, None)
                workers, clean = tune(workers, report["generated"], seconds, limiter.throttled - throttled, clean, args.max_concurrency)
                persist()
                print(f"Completed jobs {len(checkpoint['complete'])}/{len(jobs)}; {voice}; {benchmark}; next workers={workers}", flush=True)
        summary["status"] = "complete" if len(checkpoint["complete"]) == len(jobs) else "partial"
        summary["finishedAt"] = time.time()
    except BaseException as error:
        summary.update(status="failed", error=error_info(error))
        raise
    finally:
        batch.save_report = original_save
        persist()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rpm", type=int, default=60, choices=range(1, 81))
    parser.add_argument("--accounts", type=int, default=1, choices=range(1, 11),
                        help="Independent accounts, not two keys sharing one quota; limits are per account")
    parser.add_argument("--max-concurrency", type=int, default=32, choices=(4, 8, 16, 24, 32, 48, 64))
    parser.add_argument("--start-concurrency", type=int, default=32, choices=(2, 4, 8, 16, 24, 32, 48, 64))
    parser.add_argument("--use-rclone", action="store_true")
    parser.add_argument("--upload-workers", type=int, default=32, choices=(16, 32, 48, 64, 96),
                        help="Independent B2 upload concurrency; adjustable via concurrency.json")
    parser.add_argument("--publish-workers", type=int, default=16, choices=(1, 8, 16, 32, 48, 64),
                        help="Independent chapter JSON publication concurrency; checkpoint commits stay serialized")
    parser.add_argument("--publish-only", action="store_true",
                        help="Publish from confirmed audio only; never call TTS or upload audio")
    parser.add_argument("--b2-routes", type=Path,
                        help="Offline B2 only: JSON of tested loopback Mihomo listeners; never changes MiMo routing")
    args = parser.parse_args()
    # OS releases this lock on crash; it never leaves a stale PID lock file.
    lock = socket.socket()
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        lock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        lock.bind(("127.0.0.1", 18963))
        load_environment(batch.ROOT, use_rclone=args.use_rclone)
        from library_pool import run_pool
        asyncio.run(run_pool(args, Settings.from_env()))
    finally:
        lock.close()


if __name__ == "__main__":
    main()
