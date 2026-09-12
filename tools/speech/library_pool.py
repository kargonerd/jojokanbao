"""Deduplicated cross-chapter offline pool; manifests retain original ordering."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import time
from collections import deque
from functools import partial
from contextlib import nullcontext

import boto3
from botocore.config import Config
import httpx

import generate as batch
from library import VOICES, error_info
from offline import offline_provider, offline_account, RequestLimiter, BatchStopped
from app.speech.storage import PREFIX
from app.speech.delivery import offline_blocking_pool, run_blocking
from metrics import BlockingPool
from outbox import AudioOutbox
from app.speech.providers import PROVIDERS
from app.speech.encoding import encode_delivery
from b2_routes import B2Routes

MAX_UPLOAD_WORKERS = 96
MAX_PUBLICATION_WORKERS = 64


async def prepare_audio(task, settings):
    audio = await PROVIDERS["mimo"].synthesize(task["text"], task["voice"], settings)
    return await run_blocking(encode_delivery, audio, max_bytes=None)


class WorkerGate:
    def __init__(self, start, maximum):
        self.limit, self.maximum, self.active = start, maximum, 0
        self.clean = self.cooldowns = 0
        self.condition = asyncio.Condition()

    async def acquire(self):
        async with self.condition:
            await self.condition.wait_for(lambda: self.active < self.limit)
            self.active += 1

    async def release(self, *, generated=False, cooldowns=0, throttled=False):
        async with self.condition:
            self.active -= 1
            # Invalid audio/content is a failed item, not evidence of saturation.
            # Only explicit rate-limit feedback reduces the account's capacity.
            if throttled or cooldowns > self.cooldowns:
                self.limit, self.clean = max(2, self.limit // 2), 0
            elif generated:
                self.clean += 1
                if self.clean >= 32 and self.limit < self.maximum:
                    self.limit, self.clean = min(self.maximum, self.limit + 8), 0
            self.cooldowns = cooldowns
            self.condition.notify_all()


async def apply_worker_limit(gates, value, ceiling):
    if type(value) is not int or not 2 <= value <= ceiling:
        raise ValueError("perAccount must be an integer between 2 and the CLI maximum")
    for gate in gates:
        async with gate.condition:
            gate.maximum = gate.limit = value
            gate.clean = 0
            gate.condition.notify_all()


def read_worker_limits(control, synthesis_ceiling, default_upload):
    synthesis, upload = control["perAccount"], control.get("uploadWorkers", default_upload)
    for value, ceiling in ((synthesis, synthesis_ceiling), (upload, MAX_UPLOAD_WORKERS)):
        if type(value) is not int or not 2 <= value <= ceiling:
            raise ValueError("Invalid worker limit")
    return synthesis, upload


def jobs_for_plan(plan, checkpoint):
    jobs, tasks = {}, {}
    for book in plan["books"]:
        for chapter in book["chapters"]:
            if not chapter["segments"]:
                raise ValueError("Empty chapter")
            for voice in VOICES:
                job_key = hashlib.sha256(json.dumps([book["datasetId"], book["itemKey"], chapter["id"], voice]).encode()).hexdigest()
                if job_key in checkpoint["complete"]:
                    continue
                jobs[job_key] = {"book": book, "chapter": chapter, "voice": voice,
                                 "records": [None] * len(chapter["segments"]), "remaining": len(chapter["segments"]),
                                 "generated": 0, "cacheHits": 0}
                for index, text in enumerate(chapter["segments"]):
                    _, normalized, key = batch.identity("mimo", voice, text)
                    task = tasks.setdefault(key, {"key": key, "voice": voice, "text": normalized, "consumers": []})
                    task["consumers"].append((job_key, index))
    return jobs, list(tasks.values())


async def run_pool(args, settings):
    publish_workers = getattr(args, "publish_workers", 16)
    publish_only = getattr(args, "publish_only", False)
    if type(publish_workers) is not int or not 1 <= publish_workers <= MAX_PUBLICATION_WORKERS:
        raise ValueError("publish_workers must be between 1 and 64")
    if settings.speech_storage != "b2" or not settings.mimo_api_key:
        raise ValueError("B2/MiMo synthesis configuration is required")
    keys = [settings.mimo_api_key]
    account_count = getattr(args, "accounts", 1)
    if not 1 <= account_count <= 10:
        raise ValueError("Supported independent account count is 1 to 10")
    for number in range(2, account_count + 1):
        key = os.environ.get(f"MIMO_API_KEY_{number}", "").strip()
        if not key or key in keys:
            raise ValueError(f"MIMO_API_KEY_{number} must be configured and distinct")
        keys.append(key)
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    if plan.get("formatVersion") != "jojo-speech-plan/1" or not plan.get("books"):
        raise ValueError("Invalid library plan")
    digest = hashlib.sha256(json.dumps([plan, batch.delivery_version("mimo"), VOICES], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    args.output.mkdir(parents=True, exist_ok=True)
    checkpoint_path = args.output / "checkpoint.json"
    checkpoint = {"planHash": digest, "complete": {}}
    if checkpoint_path.exists():
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if checkpoint.get("planHash") != digest:
            raise ValueError("Plan changed; use another output directory")
    jobs, tasks = jobs_for_plan(plan, checkpoint)
    limiters = [RequestLimiter(rpm=args.rpm, smooth=True) for _ in keys]
    gates = [WorkerGate(min(args.start_concurrency, args.max_concurrency), args.max_concurrency) for _ in keys]
    account_generated = [0 for _ in keys]
    account_failures = [0 for _ in keys]
    segment_seconds = [deque(maxlen=100) for _ in keys]
    stopped, writer_stopped = asyncio.Event(), asyncio.Event()
    stop_file = args.output / "STOP"
    control_file = args.output / "concurrency.json"
    last_control = None
    ready = asyncio.Queue()
    checkpoint_lock = asyncio.Lock()
    active_publications = 0
    published_recent = deque()
    uploads = asyncio.Queue()
    producers_done = asyncio.Event()
    reservations = 0
    failures, recent = {}, deque()
    counters = {"generated": 0, "staged": 0, "cacheHits": 0, "tasksFinished": 0, "newBytes": 0, "consecutiveFailures": 0}
    summary = {"status": "running", "pid": os.getpid(), "startedAt": time.time(), "scheduler": "cross-chapter-v1",
               "voices": list(VOICES), "booksTotal": len(plan["books"]),
               "segmentsTotal": sum(len(c["segments"]) for b in plan["books"] for c in b["chapters"]) * 2,
               "chapterVoiceJobsTotal": sum(len(b["chapters"]) for b in plan["books"]) * 2,
               "uniqueTasksAtStart": len(tasks), "rpmBudget": args.rpm * len(keys),
               "tokenReservationBudget": sum(item.tpm for item in limiters),
               "checkpoint": str(checkpoint_path)}
    summary_path = args.output / "summary.json"
    totals = {voice: {"chaptersComplete": 0, "segmentsComplete": 0, "referencedBytes": 0} for voice in VOICES}
    for item in checkpoint["complete"].values():
        row = totals[item["voice"]]
        row["chaptersComplete"] += 1
        row["segmentsComplete"] += item["segments"]
        row["referencedBytes"] += item["bytes"]
    store = batch.speech_store(settings)
    config = store.client.meta.config.merge(Config(connect_timeout=5, read_timeout=30, max_pool_connections=64,
                   retries={"total_max_attempts": 2, "mode": "standard"}))
    store.client.close()
    store.client = boto3.client("s3", endpoint_url=settings.speech_s3_endpoint, region_name=settings.speech_s3_region,
                               aws_access_key_id=settings.speech_s3_key_id,
                               aws_secret_access_key=settings.speech_s3_application_key, config=config)
    routes = None
    if getattr(args, "b2_routes", None):
        routes = B2Routes.load(args.b2_routes, settings)
        store.client.close()
        store = routes
    blocking_pool = BlockingPool(min(128, max(16, len(keys) * args.max_concurrency // 8)))
    blocking_token = offline_blocking_pool.set(blocking_pool)
    upload_workers = getattr(args, "upload_workers", 32)
    read_worker_limits({"perAccount": min(args.start_concurrency, args.max_concurrency)},
                       args.max_concurrency, upload_workers)
    upload_gate = WorkerGate(upload_workers, MAX_UPLOAD_WORKERS)
    # JSON publication has independent capacity; audio uploads cannot starve it.
    upload_pool, lookup_pool = BlockingPool(MAX_UPLOAD_WORKERS), BlockingPool(16)
    publication_pool = BlockingPool(publish_workers)
    outbox = AudioOutbox(args.output / "outbox.sqlite3")
    staged_recent = deque()

    async def storage_retry(func, *values, lane="upload", **kwargs):
        attempt = 0
        while True:
            if stopped.is_set():
                raise BatchStopped()
            try:
                pool = {"lookup": lookup_pool, "publication": publication_pool}.get(lane, upload_pool)
                result = await asyncio.get_running_loop().run_in_executor(pool, partial(func, *values, **kwargs))
                summary.setdefault("storage", {}).setdefault(lane, {})["lastSuccessAt"] = time.time()
                return result
            except Exception as error:
                attempt += 1
                info = error_info(error)
                delay = 300 if info.get("status") in (401, 403) else min(60, 2 ** min(attempt, 6))
                summary.setdefault("storage", {})[lane] = {"lastError": info, "lastErrorAt": time.time(), "retrySeconds": delay}
                # Storage failures never affect the TTS account gates. Retries
                # operate on committed local audio, not another synthesis.
                try:
                    await asyncio.wait_for(stopped.wait(), delay)
                except asyncio.TimeoutError:
                    continue
                raise BatchStopped()

    async def persist():
        now = time.monotonic()
        while recent and recent[0] < now - 300:
            recent.popleft()
        while staged_recent and staged_recent[0] < now - 300:
            staged_recent.popleft()
        while published_recent and published_recent[0] < now - 300:
            published_recent.popleft()
        seconds = min(300, time.time() - summary["startedAt"])
        summary.update(updatedAt=time.time(), concurrency=sum(g.limit for g in gates), activeWorkers=sum(g.active for g in gates),
                       maxConcurrency=sum(g.maximum for g in gates), totals=totals, requestsSent=sum(l.sent for l in limiters),
                       rateLimitCooldowns=sum(l.throttled for l in limiters), failures=failures, **counters,
                       blockingPool={"workers": blocking_pool.workers, "stages": blocking_pool.snapshot()},
                       outbox=outbox.snapshot(), uploadWorkers=upload_gate.limit, uploadQueue=uploads.qsize(),
                       uploadPool=upload_pool.snapshot(),
                       publishOnly=publish_only, publishWorkers=publish_workers,
                       activePublications=active_publications, publicationQueue=ready.qsize(),
                       publicationPool=publication_pool.snapshot(),
                       chaptersPerMinute5m=round(len(published_recent) * 60 / max(1, seconds), 2),
                       b2Routes=routes.snapshot() if routes else [],
                       synthesisFinished=producers_done.is_set(),
                       stagedPerMinute5m=round(len(staged_recent) * 60 / max(1, seconds), 2),
                       accounts=[{"account": i + 1, "rpmBudget": l.rpm, "tokenReservationBudget": l.tpm,
                                  "requestsSent": l.sent, "rateLimitCooldowns": l.throttled,
                                  "requestsLastMinute": sum(stamp > now - 60 for stamp in l.requests),
                                  "meanSynthesisSeconds": round(sum(l.synthesis_seconds) / len(l.synthesis_seconds), 2) if l.synthesis_seconds else None,
                                  "meanSegmentSeconds": round(sum(segment_seconds[i]) / len(segment_seconds[i]), 2) if segment_seconds[i] else None,
                                  "concurrency": g.limit, "activeWorkers": g.active, "generated": account_generated[i]}
                                 for i, (l, g) in enumerate(zip(limiters, gates))],
                       generatedPerMinute5m=round(len(recent) * 60 / max(1, seconds), 2))
        # Only this coroutine writes summary; snapshot before going to the thread.
        snapshot = json.loads(json.dumps(summary))
        await asyncio.to_thread(batch.save_report, summary_path, snapshot)

    async def heartbeat():
        nonlocal last_control
        try:
            while not writer_stopped.is_set():
                if stop_file.exists():
                    stopped.set()
                if control_file.exists() and not stopped.is_set():
                    try:
                        values = read_worker_limits(json.loads(control_file.read_text(encoding="utf-8")),
                                                    args.max_concurrency, upload_workers)
                        if values != last_control:
                            # Changing upload slots must not reset synthesis 429 backoff.
                            if last_control is None or values[0] != last_control[0]:
                                await apply_worker_limit(gates, values[0], args.max_concurrency)
                            if last_control is None or values[1] != last_control[1]:
                                await apply_worker_limit([upload_gate], values[1], MAX_UPLOAD_WORKERS)
                            last_control = values
                            summary["workerControl"] = {"perAccount": values[0], "uploadWorkers": values[1],
                                                        "changedAt": time.time()}
                        summary.pop("controlError", None)
                    except (OSError, ValueError, KeyError, TypeError):
                        summary["controlError"] = "Invalid concurrency.json; keeping current limit"
                await persist()
                try:
                    await asyncio.wait_for(writer_stopped.wait(), 5)
                except asyncio.TimeoutError:
                    pass
        except BaseException:
            stopped.set()
            raise

    async def publish(job_key):
        job = jobs[job_key]
        book, chapter, voice = job["book"], job["chapter"], job["voice"]
        entries, offset = [], 0
        for record in job["records"]:
            entry = {k: record[k] for k in ("key", "object", "duration", "bytes", "sha256")}
            entry["offset"] = offset
            entries.append(entry)
            offset += record["duration"]
        revision = hashlib.sha256(json.dumps([e["object"] for e in entries]).encode()).hexdigest()
        voice_key = hashlib.sha256(f"mimo:{voice}".encode()).hexdigest()[:16]
        prefix = f"{PREFIX}/books/{batch.component(book['datasetId'])}/{batch.component(book['itemKey'])}/{voice_key}/{batch.component(chapter['id'])}"
        manifest_key = f"{prefix}/{revision}.json"
        manifest = {"formatVersion": "jojo-speech-chapter/1", "provider": "mimo", "voice": voice,
                    "version": batch.delivery_version("mimo"), "chapterId": chapter["id"], "duration": offset, "segments": entries}
        await storage_retry(store.put_json, manifest_key, manifest, immutable=True, lane="publication")
        await storage_retry(store.put_json, f"{prefix}/index.json", {"manifest": manifest_key}, lane="publication")
        report_path = args.output / "reports" / f"{job_key}.json"
        unique_bytes = sum({e["object"]: e["bytes"] for e in entries}.values())
        report = {"formatVersion": "jojo-speech-report/1", "provider": "mimo", "voice": voice,
                  "version": batch.delivery_version("mimo"), "finishedAt": time.time(),
                  "generated": job["generated"], "cacheHits": job["cacheHits"], "uniqueBytes": unique_bytes,
                  "chapters": [{"datasetId": book["datasetId"], "itemKey": book["itemKey"], "chapterId": chapter["id"],
                                "status": "complete", "duration": offset, "segments": entries, "manifest": manifest_key}]}
        await asyncio.to_thread(batch.save_report, report_path, report)
        # Only the local checkpoint commit is serialized. Both remote writes
        # and this chapter's report must succeed before it is marked complete.
        async with checkpoint_lock:
            checkpoint["complete"][job_key] = {"voice": voice, "segments": len(entries), "bytes": unique_bytes, "report": str(report_path)}
            try:
                await asyncio.to_thread(batch.save_report, checkpoint_path, checkpoint)
            except BaseException:
                del checkpoint["complete"][job_key]
                raise
            row = totals[voice]
            row["chaptersComplete"] += 1
            row["segmentsComplete"] += len(entries)
            row["referencedBytes"] += unique_bytes
            del jobs[job_key]
            published_recent.append(time.monotonic())
            print(f"Published {len(checkpoint['complete'])}/{summary['chapterVoiceJobsTotal']}: {voice} {book['datasetId']} {chapter['id']}", flush=True)

    async def publisher():
        nonlocal active_publications
        while not stopped.is_set():
            job_key = await ready.get()
            if job_key is None:
                ready.task_done()
                return
            active_publications += 1
            try:
                await publish(job_key)
            except BatchStopped:
                return
            except BaseException:
                stopped.set()
                raise
            finally:
                active_publications -= 1
                ready.task_done()

    def delivered(task, record, generated):
        counters["generated" if generated else "cacheHits"] += 1
        counters["tasksFinished"] += 1
        if generated:
            counters["newBytes"] += record["bytes"]
            recent.append(time.monotonic())
        for job_key, index in task["consumers"]:
            job = jobs[job_key]
            job["records"][index] = record
            job["remaining"] -= 1
            job["generated" if generated else "cacheHits"] += 1
            if job["remaining"] == 0:
                ready.put_nowait(job_key)

    def upload_and_verify(key, audio):
        if routes:
            return routes.upload_and_verify(key, audio)
        record = store.get("mimo", key)
        if record is None:
            store.put("mimo", key, audio)
            record = store.get("mimo", key)
            if (not record or record.get("sha256") != hashlib.sha256(audio.data).hexdigest()
                    or record.get("bytes") != len(audio.data)):
                raise ValueError("B2 commit verification failed; staged audio retained")
        return record

    async def uploader():
        while not stopped.is_set():
            await upload_gate.acquire()
            task = None
            try:
                if stopped.is_set():
                    return
                try:
                    task = await asyncio.wait_for(uploads.get(), .2)
                except asyncio.TimeoutError:
                    if producers_done.is_set():
                        return
                    continue
                audio = await run_blocking(outbox.load, task["key"])
                # A prior process may have uploaded successfully and crashed
                # before committing the local receipt. Reuse that valid object.
                record = await storage_retry(upload_and_verify, task["key"], audio)
                await run_blocking(outbox.confirm, task["key"], record)
                delivered(task, record, True)
            except BatchStopped:
                return
            except Exception as error:
                # Local corruption/disk commit failures require intervention;
                # never silently discard or resynthesize staged audio.
                summary["outboxError"] = error_info(error)
                stopped.set()
                return
            finally:
                if task is not None:
                    uploads.task_done()
                await upload_gate.release()

    async def process(task, account):
        nonlocal reservations
        # Cache lookup and resumed uploads do not hold a synthesis permit.
        existing = await run_blocking(outbox.lookup, task["key"])
        if existing:
            if existing[0] == "uploaded":
                delivered(task, existing[1], False)
            else:
                uploads.put_nowait(task)
            return
        try:
            cached = await storage_retry(store.get, "mimo", task["key"], lane="lookup")
        except BatchStopped:
            return
        if cached:
            delivered(task, cached, False)
            return
        if publish_only:
            raise ValueError("Cached audio is missing in publish-only mode; synthesis is disabled")
        gate, limiter = gates[account], limiters[account]
        # 48 kbps / <=600 sec validated output fits within this reservation.
        reservation = 8 * 1024**2
        while not stopped.is_set():
            if outbox.has_room(reservations + reservation):
                reservations += reservation
                break
            summary["diskBackpressure"] = True
            try:
                await asyncio.wait_for(stopped.wait(), 2)
            except asyncio.TimeoutError:
                pass
        else:
            return
        summary["diskBackpressure"] = False
        await gate.acquire()
        started = time.monotonic()
        account_token = offline_account.set(account)
        generated, throttled = False, False
        try:
            if stopped.is_set():
                return
            audio = await prepare_audio(task, settings)
            try:
                await run_blocking(outbox.stage, task["key"], task["voice"], audio)
            except Exception as error:
                summary["outboxError"] = error_info(error)
                stopped.set()
                return
            counters["consecutiveFailures"] = 0
            account_failures[account] = 0
            generated = True
            counters["staged"] += 1
            segment_seconds[account].append(time.monotonic() - started)
            account_generated[account] += 1
            staged_recent.append(time.monotonic())
            uploads.put_nowait(task)
            failures.pop(task["key"], None)
        except BatchStopped:
            pass
        except Exception as error:
            info = error_info(error)
            throttled = info.get("status") == 429
            failures[task["key"]] = {**info, "voice": task["voice"], "chapters": len(task["consumers"])}
            counters["consecutiveFailures"] += 1
            account_failures[account] += 1
            print(f"Segment failed {task['key']} {info}", flush=True)
            if (info.get("status") in (401, 403, 503) or info.get("reason") == "provider_auth_rejected"
                    or account_failures[account] >= 5):
                summary["error"] = info
                stopped.set()
        finally:
            reservations -= reservation
            offline_account.reset(account_token)
            await gate.release(generated=generated, cooldowns=limiter.throttled, throttled=throttled)

    async def workers_for(pending):
        queue = deque(pending)
        async def worker(account):
            try:
                while queue and not stopped.is_set():
                    await process(queue.popleft(), account)
            except BaseException:
                stopped.set()
                raise
        results = await asyncio.gather(*(worker(account) for account in range(len(keys)) for _ in range(args.max_concurrency)), return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result

    status_task = asyncio.create_task(heartbeat())
    publish_tasks = [asyncio.create_task(publisher()) for _ in range(publish_workers)]
    upload_tasks = [asyncio.create_task(uploader()) for _ in range(MAX_UPLOAD_WORKERS)]
    try:
        # Drain durable audio immediately, instead of waiting for the plan's
        # earlier B2 cache lookups to reach these entries after a restart.
        pending_keys = await run_blocking(outbox.pending_keys)
        if publish_only and pending_keys:
            raise ValueError("Publish-only mode requires all audio uploads to be confirmed first")
        for task in tasks:
            if task["key"] in pending_keys:
                uploads.put_nowait(task)
        provider_context = (nullcontext() if publish_only else
                            offline_provider("mimo", limiters[0], stopped, concurrency=args.max_concurrency * len(keys),
                                             accounts=list(zip(keys, limiters))))
        async with provider_context:
            await workers_for([t for t in tasks if t["key"] not in pending_keys])
            if failures and not stopped.is_set():
                summary["pass"] = 2
                await asyncio.sleep(10)
                await workers_for([t for t in tasks if t["key"] in failures])
        producers_done.set()
        await asyncio.gather(*upload_tasks)
        for _ in publish_tasks:
            ready.put_nowait(None)
        await asyncio.gather(*publish_tasks)
        summary["status"] = ("paused" if stop_file.exists() else "failed" if stopped.is_set() else
                             "partial" if jobs else "complete")
        if not jobs:
            summary["finishedAt"] = time.time()
    except BaseException as error:
        stopped.set()
        producers_done.set()
        await asyncio.gather(*upload_tasks, return_exceptions=True)
        summary.update(status="failed", error=error_info(error))
        for _ in publish_tasks:
            ready.put_nowait(None)
        await asyncio.gather(*publish_tasks, return_exceptions=True)
        raise
    finally:
        writer_stopped.set()
        try:
            await status_task
            await persist()
        finally:
            offline_blocking_pool.reset(blocking_token)
            await asyncio.to_thread(blocking_pool.shutdown, wait=True)
            await asyncio.to_thread(upload_pool.shutdown, wait=True)
            await asyncio.to_thread(lookup_pool.shutdown, wait=True)
            await asyncio.to_thread(publication_pool.shutdown, wait=True)
            outbox.close()
            if routes:
                routes.close()
            else:
                store.client.close()
