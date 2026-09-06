import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from contextlib import asynccontextmanager
import pytest

from botocore.config import Config
from app.core.config import Settings


def load_tool(monkeypatch):
    folder = Path(__file__).resolve().parents[3] / "tools" / "speech"
    monkeypatch.syspath_prepend(str(folder))
    spec = importlib.util.spec_from_file_location("speech_library_test", folder / "library.py")
    tool = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tool)
    return tool


def test_library_two_voices_retries_failed_jobs_and_resumes_without_repeating(monkeypatch, tmp_path):
    tool = load_tool(monkeypatch)
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"formatVersion": "jojo-speech-plan/1", "books": [{
        "datasetId": "book", "itemKey": "full-book", "title": "Book", "chapters": [
            {"id": "chapter:1", "segments": ["正文"]},
        ]}]}), encoding="utf-8")
    args = SimpleNamespace(plan=plan, output=tmp_path / "run", rpm=60, max_concurrency=8)
    settings = Settings(environment="test", allowed_origins=(), supabase_url=None,
                        supabase_publishable_key=None, auth_timeout_seconds=1,
                        speech_storage="b2", mimo_api_key="test", tts_enabled=True)
    client = Mock()
    client.meta.config = Config()
    store = SimpleNamespace(client=client)
    monkeypatch.setattr(tool.batch, "speech_store", lambda _: store)
    monkeypatch.setattr(tool.boto3, "client", lambda *a, **kw: client)
    calls, budgets = [], []

    async def generate(options, settings, *, limiter):
        calls.append(options.voice)
        budgets.append(limiter)
        if calls == ["白桦"]:
            raise ValueError("invalid audio")
        return {"generated": 1, "cacheHits": 0, "uniqueBytes": 100}

    async def sleep(_):
        pass

    monkeypatch.setattr(tool.batch, "generate", generate)
    monkeypatch.setattr(tool.asyncio, "sleep", sleep)
    asyncio.run(tool.run(args, settings))
    assert calls == ["白桦", "冰糖", "白桦"]
    assert len({id(item) for item in budgets}) == 1
    summary = json.loads((args.output / "summary.json").read_text(encoding="utf-8"))
    assert summary["status"] == "complete" and not summary["failures"]
    assert all(value["segmentsComplete"] == 1 for value in summary["totals"].values())
    asyncio.run(tool.run(args, settings))
    assert calls == ["白桦", "冰糖", "白桦"]


def test_tuning_increases_only_after_clean_samples_and_backs_off(monkeypatch):
    tool = load_tool(monkeypatch)
    assert tool.tune(4, 31, 50, 0, 0, 8) == (4, 31)
    assert tool.tune(4, 1, 50, 0, 31, 8) == (8, 0)
    assert tool.tune(8, 40, 50, 0, 0, 8) == (8, 40)
    assert tool.tune(8, 1, 50, 1, 31, 8) == (4, 0)


def test_report_replace_retries_without_resynthesizing(monkeypatch, tmp_path):
    tool = load_tool(monkeypatch)
    original = Path.replace
    attempts = []
    def replace(path, target):
        attempts.append(target)
        if len(attempts) < 3:
            raise PermissionError("reader temporarily holds file")
        return original(path, target)
    monkeypatch.setattr(Path, "replace", replace)
    monkeypatch.setattr(tool.batch.time, "sleep", lambda _: None)
    tool.batch.save_report(tmp_path / "report.json", {"complete": True})
    assert len(attempts) == 3
    assert json.loads((tmp_path / "report.json").read_text())["complete"]


def test_blocking_pool_does_not_starve_dns_and_preserves_context(monkeypatch):
    load_tool(monkeypatch)
    import socket
    import threading
    from contextvars import ContextVar
    from concurrent.futures import ThreadPoolExecutor
    from metrics import BlockingPool
    from app.speech.delivery import offline_blocking_pool, run_blocking
    marker = ContextVar("test_marker", default="missing")
    release = threading.Event()
    entered = threading.Event()
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args: [])
    async def scenario():
        loop = asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
        pool = BlockingPool(1)
        token = offline_blocking_pool.set(pool)
        marker.set("preserved")
        def occupied():
            entered.set()
            release.wait(5)
            return marker.get()
        task = asyncio.create_task(run_blocking(occupied))
        try:
            while not entered.is_set():
                await asyncio.sleep(.001)
            assert await asyncio.wait_for(loop.getaddrinfo("example.test", 443), 1) == []
        finally:
            release.set()
            assert await task == "preserved"
            offline_blocking_pool.reset(token)
            pool.shutdown()
        stats = pool.snapshot()["occupied"]
        assert stats["completed"] == 1 and stats["active"] == stats["queued"] == 0
        assert offline_blocking_pool.get() is None
    asyncio.run(scenario())


def test_live_worker_limit_does_not_cancel_active_work(monkeypatch):
    load_tool(monkeypatch)
    from library_pool import WorkerGate, apply_worker_limit
    async def scenario():
        gate = WorkerGate(4, 8)
        for _ in range(4):
            await gate.acquire()
        await apply_worker_limit([gate], 2, 8)
        assert gate.active == 4 and gate.limit == gate.maximum == 2
        for invalid in (0, 9, True, "4"):
            with pytest.raises(ValueError):
                await apply_worker_limit([gate], invalid, 8)
        for _ in range(4):
            await gate.release()
        await apply_worker_limit([gate], 8, 8)
        assert gate.limit == gate.maximum == 8 and gate.active == 0
    asyncio.run(scenario())


@pytest.mark.parametrize("accounts", [1, 2, 3, 7, 10])
def test_cross_chapter_pool_deduplicates_and_publishes_in_original_order(monkeypatch, tmp_path, accounts):
    load_tool(monkeypatch)
    import library_pool as pool
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"formatVersion": "jojo-speech-plan/1", "books": [{
        "datasetId": "book", "itemKey": "full-book", "title": "Book", "chapters": [
            {"id": "chapter:1", "segments": ["slow", "fast"]},
            {"id": "chapter:2", "segments": ["shared", "slow"]},
        ]}]}), encoding="utf-8")
    args = SimpleNamespace(plan=plan, output=tmp_path / "pool", rpm=80, start_concurrency=4, max_concurrency=4, accounts=accounts)
    if accounts == 10:
        args.upload_workers = 64
    monkeypatch.setenv("MIMO_API_KEY_2", "second-test")
    monkeypatch.setenv("MIMO_API_KEY_3", "third-test")
    for number in range(4, accounts + 1):
        monkeypatch.setenv(f"MIMO_API_KEY_{number}", f"account-{number}-test")
    if accounts >= 3:
        args.start_concurrency = args.max_concurrency = 2
    if accounts >= 7:
        content = json.loads(plan.read_text(encoding="utf-8"))
        content["books"][0]["chapters"].append({"id": "chapter:3", "segments": [f"extra-{i}" for i in range(8)]})
        plan.write_text(json.dumps(content), encoding="utf-8")
    expected_tasks = 22 if accounts >= 7 else 6
    settings = Settings(environment="test", allowed_origins=(), supabase_url=None,
                        supabase_publishable_key=None, auth_timeout_seconds=1,
                        speech_storage="b2", mimo_api_key="test", tts_enabled=True)
    client = Mock()
    client.meta.config = Config()
    manifests = []
    def put_json(key, value, **kwargs):
        if "segments" in value:
            manifests.append(value)
    objects = {}
    def put(provider, key, audio):
        import hashlib
        record = {"key": key, "object": f"audio/{key}", "bytes": len(audio.data),
                  "duration": audio.duration, "sha256": hashlib.sha256(audio.data).hexdigest()}
        objects[key] = record
        return record
    store = SimpleNamespace(client=client, put_json=put_json, get=lambda provider, key: objects.get(key), put=put)
    monkeypatch.setattr(pool.batch, "speech_store", lambda _: store)
    monkeypatch.setattr(pool.boto3, "client", lambda *a, **kw: client)
    @asynccontextmanager
    async def provider(*args, **kwargs):
        yield
    monkeypatch.setattr(pool, "offline_provider", provider)
    finished = []
    routed = []
    async def prepare(task, settings):
        from app.speech.encoding import EncodedAudio
        voice, text = task["voice"], task["text"]
        routed.append(pool.offline_account.get())
        await asyncio.sleep(.08 if text == "slow" else .001)
        finished.append((voice, text))
        return EncodedAudio(f"{voice}/{text}".encode(), 2 if text == "slow" else 1)
    monkeypatch.setattr(pool, "prepare_audio", prepare)
    asyncio.run(pool.run_pool(args, settings))
    assert len(finished) == expected_tasks
    assert set(routed) == set(range(accounts))
    assert finished.index(("白桦", "shared")) < finished.index(("白桦", "slow"))
    assert len(manifests) == (6 if accounts >= 7 else 4)
    for manifest in manifests:
        expected = {"chapter:1": [0, 2], "chapter:2": [0, 1], "chapter:3": list(range(8))}
        assert [e["offset"] for e in manifest["segments"]] == expected[manifest["chapterId"]]
    summary = json.loads((args.output / "summary.json").read_text(encoding="utf-8"))
    assert summary["status"] == "complete"
    assert summary["rpmBudget"] == 80 * accounts
    assert summary["uploadWorkers"] == (64 if accounts == 10 else 32)
    assert sum(a["generated"] for a in summary["accounts"]) == expected_tasks
    assert all(row["segmentsComplete"] == (12 if accounts >= 7 else 4) for row in summary["totals"].values())
    asyncio.run(pool.run_pool(args, settings))
    assert len(finished) == expected_tasks


@pytest.mark.parametrize("accounts", [2, 3, 7, 10])
@pytest.mark.parametrize("workers_per_account", [32, 64])
def test_offline_accounts_route_keys_and_restore_online_limits(monkeypatch, accounts, workers_per_account):
    load_tool(monkeypatch)
    import offline
    from app.speech import delivery
    settings = Settings(environment="test", allowed_origins=(), supabase_url=None,
                        supabase_publishable_key=None, auth_timeout_seconds=1, mimo_api_key="first-test")
    original = offline.PROVIDERS["mimo"]
    received = []
    keys = (["first-test", "second-test", "third-test"] + [f"account-{i}-test" for i in range(4, 11)])[:accounts]
    async def synthesize(self, text, voice, config):
        await asyncio.sleep(0)
        received.append((text, config.mimo_api_key))
        return b"test"
    monkeypatch.setattr(offline.MimoProvider, "synthesize", synthesize)
    async def run():
        budgets = [offline.RequestLimiter(rpm=80) for _ in range(accounts)]
        async with offline.offline_provider("mimo", budgets[0], asyncio.Event(), concurrency=workers_per_account * accounts,
                                            accounts=list(zip(keys, budgets))):
            assert delivery.offline_pending_limit.get() == workers_per_account * accounts
            async def request(index):
                token = offline.offline_account.set(index)
                try:
                    await offline.PROVIDERS["mimo"].synthesize(str(index), "白桦", settings)
                finally:
                    offline.offline_account.reset(token)
            await asyncio.gather(*(request(i) for i in range(accounts)))
            budgets[0].defer(10)
            assert budgets[1].cooldown_until == 0
        assert delivery.offline_pending_limit.get() == 32
        assert delivery.offline_synthesis_slots.get() is None
        assert offline.PROVIDERS["mimo"] is original
    asyncio.run(run())
    assert sorted(received) == [(str(i), key) for i, key in enumerate(keys)]
    assert settings.mimo_api_key == "first-test"


@pytest.mark.parametrize("third_key", ["", "primary-test", "second-test"])
def test_third_account_rejects_missing_or_duplicate_key(monkeypatch, third_key):
    load_tool(monkeypatch)
    import library_pool
    monkeypatch.setenv("MIMO_API_KEY_2", "second-test")
    monkeypatch.setenv("MIMO_API_KEY_3", third_key)
    settings = SimpleNamespace(speech_storage="b2", mimo_api_key="primary-test", tts_enabled=True)
    with pytest.raises(ValueError, match="MIMO_API_KEY_3 must be configured and distinct"):
        asyncio.run(library_pool.run_pool(SimpleNamespace(accounts=3), settings))


def test_pool_only_rate_limits_reduce_concurrency(monkeypatch):
    load_tool(monkeypatch)
    from library_pool import WorkerGate
    async def run():
        gate = WorkerGate(32, 32)
        for _ in range(100):
            await gate.acquire()
            # A failed item has neither a successful generation nor rate limiting.
            await gate.release(generated=False)
        assert gate.limit == 32
        await gate.acquire()
        await gate.release(cooldowns=1)
        assert gate.limit == 16
        for _ in range(32):
            await gate.acquire()
            await gate.release(generated=True, cooldowns=1)
        assert gate.limit == 24
        for _ in range(32):
            await gate.acquire()
            await gate.release(generated=True, cooldowns=1)
        assert gate.limit == 32
        await gate.acquire()
        # A final 429 without an internal retry also counts as rate-limit feedback.
        await gate.release(throttled=True, cooldowns=1)
        assert gate.limit == 16 and gate.active == 0
    asyncio.run(run())


def test_worker_control_validates_both_limits_before_changing_either(monkeypatch):
    load_tool(monkeypatch)
    from library_pool import read_worker_limits
    assert read_worker_limits({"perAccount": 48, "uploadWorkers": 64}, 64, 32) == (48, 64)
    assert read_worker_limits({"perAccount": 64}, 64, 96) == (64, 96)
    for value in (0, True, 97, "64"):
        with pytest.raises(ValueError):
            read_worker_limits({"perAccount": 48, "uploadWorkers": value}, 64, 32)
