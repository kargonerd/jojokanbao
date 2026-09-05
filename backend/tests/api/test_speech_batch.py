import asyncio
import base64
import copy
import importlib.util
import json
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from botocore.exceptions import ClientError

from app.core.config import Settings
from app.core.errors import ApiError
from app.speech.providers import MimoProvider, PROVIDERS


TOOLS = Path(__file__).resolve().parents[3] / "tools" / "speech"
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("speech_batch_tool", TOOLS / "generate.py")
batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch)
from offline import LimitedTransport, RequestLimiter, offline_provider, retry_delay


def configured():
    return Settings(environment="test", allowed_origins=(), supabase_url=None,
                    supabase_publishable_key=None, auth_timeout_seconds=1,
                    speech_storage="b2", mimo_api_key="not-a-real-key")


def options(tmp_path, texts, concurrency=2):
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"formatVersion": "jojo-speech-plan/1", "books": [
        {"datasetId": "book", "itemKey": "full-book", "chapters": [
            {"id": "chapter:1", "segments": texts},
        ]},
    ]}), encoding="utf-8")
    return SimpleNamespace(plan=plan, report=tmp_path / "report.json", provider="mimo", voice="白桦",
                           chapter=None, all=True, limit_chapters=1, dry_run=False, concurrency=concurrency)


def audio(text, duration=1):
    return {"key": text, "object": f"audio/{text}.mp3", "duration": duration,
            "bytes": 100, "sha256": "digest"}


@pytest.fixture
def isolated_batch(monkeypatch):
    writes = []

    class Store:
        def put_json(self, key, value, **kwargs):
            writes.append((key, copy.deepcopy(value)))

    @asynccontextmanager
    async def no_provider(*args):
        yield

    monkeypatch.setattr(batch, "speech_store", lambda _: Store())
    monkeypatch.setattr(batch, "offline_provider", no_provider)
    return writes


@pytest.mark.parametrize("concurrency", [1, 2])
def test_bounded_workers_and_ordered_offsets(tmp_path, monkeypatch, isolated_batch, concurrency):
    async def scenario():
        active = peak = 0
        finished = []

        async def resolve(provider, voice, text, settings):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(.02 if text == "a" else 0)
            active -= 1
            finished.append(text)
            return audio(text, {"a": 2, "b": 3, "c": 4}[text]), "miss"

        monkeypatch.setattr(batch, "resolve_speech", resolve)
        report = await batch.generate(options(tmp_path, ["a", "b", "c"], concurrency), configured())
        assert peak == concurrency
        if concurrency == 2:
            assert finished[0] == "b"
        segments = report["chapters"][0]["segments"]
        assert [entry["key"] for entry in segments] == ["a", "b", "c"]
        assert [entry["offset"] for entry in segments] == [0, 2, 5]
        assert report["durationSeconds"] == 9
        assert report["uniqueBytes"] == report["newBytes"] == 300
        assert isolated_batch[0][1]["segments"] == segments
        assert len(isolated_batch) == 2 and isolated_batch[-1][0].endswith("/index.json")

    asyncio.run(scenario())


def test_old_namespace_defaults_to_serial(tmp_path, monkeypatch, isolated_batch):
    async def resolve(*args):
        return audio(args[2]), "hit"

    args = options(tmp_path, ["a"])
    del args.concurrency
    monkeypatch.setattr(batch, "resolve_speech", resolve)
    report = asyncio.run(batch.generate(args, configured()))
    assert report["cacheHits"] == 1 and report["newBytes"] == 0


def test_shared_before_miss_keeps_unique_and_new_bytes_independent(tmp_path, monkeypatch, isolated_batch):
    statuses = iter(["shared", "miss", "hit"])

    async def resolve(*args):
        return audio("same"), next(statuses)

    monkeypatch.setattr(batch, "resolve_speech", resolve)
    report = asyncio.run(batch.generate(options(tmp_path, ["same"] * 3), configured()))
    assert report["cacheHits"] == 2 and report["generated"] == 1
    assert report["uniqueBytes"] == report["newBytes"] == 100
    assert [entry["offset"] for entry in report["chapters"][0]["segments"]] == [0, 1, 2]


def test_later_error_stops_dispatch_and_drains_shielded_work(tmp_path, monkeypatch, isolated_batch):
    async def scenario():
        release = asyncio.Event()
        failed = asyncio.Event()
        started, persisted = [], []

        async def resolve(provider, voice, text, settings):
            started.append(text)
            if text == "b":
                failed.set()
                raise httpx.ReadTimeout("ambiguous synthesis response")

            async def upload():
                await release.wait()
                persisted.append(text)
                return audio(text), "miss"

            return await asyncio.shield(asyncio.create_task(upload()))

        monkeypatch.setattr(batch, "resolve_speech", resolve)
        args = options(tmp_path, ["a", "b", "c", "d"])
        task = asyncio.create_task(batch.generate(args, configured()))
        await asyncio.wait_for(failed.wait(), 1)
        await asyncio.sleep(0)
        assert started == ["a", "b"] and not task.done()
        release.set()
        with pytest.raises(httpx.ReadTimeout):
            await task
        assert started == ["a", "b"] and persisted == ["a"]
        assert not isolated_batch
        report = json.loads(args.report.read_text())
        assert report["chapters"][0]["status"] == "failed"
        assert report["chapters"][0]["errorType"] == "ReadTimeout"

    asyncio.run(scenario())


def test_cancellation_drains_before_returning(tmp_path, monkeypatch, isolated_batch):
    async def scenario():
        started = asyncio.Event()
        release = asyncio.Event()
        persisted = []

        async def resolve(*args):
            async def upload():
                started.set()
                await release.wait()
                persisted.append(args[2])
                return audio(args[2]), "miss"
            return await asyncio.shield(asyncio.create_task(upload()))

        monkeypatch.setattr(batch, "resolve_speech", resolve)
        task = asyncio.create_task(batch.generate(options(tmp_path, ["a", "b", "c"]), configured()))
        await started.wait()
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert persisted == ["a", "b"]
        assert not isolated_batch

    asyncio.run(scenario())


@pytest.mark.parametrize("concurrency", [0, 3, -1, True, "2", 2.0, None])
def test_invalid_concurrency_fails_before_any_external_work(tmp_path, monkeypatch, concurrency):
    def forbidden(*args):
        pytest.fail("No storage or provider access is allowed")

    monkeypatch.setattr(batch, "speech_store", forbidden)
    monkeypatch.setattr(batch, "offline_provider", forbidden)
    monkeypatch.setattr(batch, "resolve_speech", forbidden)
    with pytest.raises(ValueError, match="concurrency"):
        asyncio.run(batch.generate(options(tmp_path, ["a"], concurrency), configured()))


class FakeClock:
    def __init__(self):
        self.now = 0.0
        self.delays = []

    def time(self):
        return self.now

    async def sleep(self, seconds):
        self.delays.append(seconds)
        self.now += seconds
        await asyncio.sleep(0)


def test_limiter_uses_one_rolling_budget_across_calls_and_retries():
    async def scenario():
        clock = FakeClock()
        limiter = RequestLimiter(clock=clock.time, sleep=clock.sleep)
        stopped = asyncio.Event()
        for _ in range(30):
            await limiter.acquire(stopped)
        await limiter.acquire(stopped)
        assert clock.delays == [60]
        limiter.defer(7)
        await limiter.acquire(stopped)
        assert clock.delays == [60, 7]

    asyncio.run(scenario())


def test_mimo_retries_429_with_identical_json_and_keeps_shared_pool_open():
    async def scenario():
        clock = FakeClock()
        limiter = RequestLimiter(clock=clock.time, sleep=clock.sleep)
        bodies, responses = [], []

        class Pool(httpx.MockTransport):
            closed = False

            async def aclose(self):
                self.closed = True

        async def handler(request):
            bodies.append(await request.aread())
            if len(bodies) <= 2:
                response = httpx.Response(429, headers={"Retry-After": "7"}, content=b"busy")
            else:
                wav = base64.b64encode(b"RIFF\0\0\0\0WAVEdata").decode()
                response = httpx.Response(200, json={"choices": [{"message": {"audio": {"data": wav}}}]})
            responses.append(response)
            return response

        pool = Pool(handler)
        transport = LimitedTransport(pool, limiter, asyncio.Event())
        provider = MimoProvider(transport=transport)
        first = await provider.synthesize("原文", "白桦", configured())
        assert clock.delays == [7, 10]
        assert len(limiter.requests) == 3
        assert all(response.is_closed for response in responses[:2])
        assert bodies[0] == bodies[1] == bodies[2]
        payload = json.loads(bodies[0])
        assert payload["model"] == "mimo-v2.5-tts"
        assert payload["audio"] == {"format": "wav", "voice": "白桦"}
        assert payload["messages"][-1] == {"role": "assistant", "content": "原文"}
        assert not pool.closed
        second = await provider.synthesize("原文", "白桦", configured())
        assert second == first and not pool.closed
        await transport.close()
        assert pool.closed

    asyncio.run(scenario())


@pytest.mark.parametrize("retry_after,expected_calls,expected_delays", [
    (None, 3, [5, 10]), ("61", 1, []), ("invalid", 3, [5, 10]),
])
def test_429_is_bounded_and_never_retried_earlier_than_long_retry_after(retry_after, expected_calls, expected_delays):
    async def scenario():
        clock = FakeClock()
        calls = 0

        def handler(request):
            nonlocal calls
            calls += 1
            return httpx.Response(429, headers={"Retry-After": retry_after} if retry_after else {}, json={"error": "busy"})

        transport = LimitedTransport(httpx.MockTransport(handler), RequestLimiter(clock=clock.time, sleep=clock.sleep), asyncio.Event())
        with pytest.raises(ApiError) as error:
            await MimoProvider(transport=transport).synthesize("原文", "白桦", configured())
        assert error.value.status_code == 429
        assert calls == expected_calls and clock.delays == expected_delays
        await transport.close()

    asyncio.run(scenario())


def test_retry_after_http_date(monkeypatch):
    import offline
    monkeypatch.setattr(offline.time, "time", lambda: 0)
    assert retry_delay(httpx.Headers({"Retry-After": "Thu, 01 Jan 1970 00:00:40 GMT"}), 0) == 40
    assert retry_delay(httpx.Headers({"Retry-After": "Thu, 01 Jan 1970 00:02:00 GMT"}), 0) is None


@pytest.mark.parametrize("status", [401, 500, 502])
def test_other_http_failures_are_never_retried(status):
    async def scenario():
        calls = []
        def handler(request):
            calls.append(request)
            return httpx.Response(status, content=b"failure")
        transport = LimitedTransport(httpx.MockTransport(handler), RequestLimiter(), asyncio.Event())
        response = await transport.handle_async_request(httpx.Request("POST", "https://example.invalid", json={"text": "a"}))
        assert response.status_code == status and len(calls) == 1
        await response.aclose()
        await transport.close()
    asyncio.run(scenario())


def test_read_timeout_is_never_retried():
    async def scenario():
        calls = []
        def handler(request):
            calls.append(request)
            raise httpx.ReadTimeout("unknown upstream outcome")
        transport = LimitedTransport(httpx.MockTransport(handler), RequestLimiter(), asyncio.Event())
        with pytest.raises(httpx.ReadTimeout):
            await transport.handle_async_request(httpx.Request("POST", "https://example.invalid", json={"text": "a"}))
        assert len(calls) == 1
        await transport.close()
    asyncio.run(scenario())


def test_b2_error_is_not_retried(tmp_path, monkeypatch, isolated_batch):
    calls = []
    async def resolve(*args):
        calls.append(args[2])
        raise ClientError({"Error": {"Code": "SlowDown"}, "ResponseMetadata": {"HTTPStatusCode": 429}}, "PutObject")
    monkeypatch.setattr(batch, "resolve_speech", resolve)
    with pytest.raises(ClientError):
        asyncio.run(batch.generate(options(tmp_path, ["a", "b"], 1), configured()))
    assert calls == ["a"] and not isolated_batch


def test_provider_scope_restores_original_on_failure(monkeypatch):
    async def scenario():
        original = PROVIDERS["mimo"]
        pool = httpx.MockTransport(lambda _: pytest.fail("No HTTP request expected"))
        monkeypatch.setattr(httpx, "AsyncHTTPTransport", lambda: pool)
        with pytest.raises(RuntimeError):
            async with offline_provider("mimo", RequestLimiter(), asyncio.Event()):
                assert PROVIDERS["mimo"] is not original
                assert PROVIDERS["mimo"].cache_version == original.cache_version
                raise RuntimeError("stop")
        assert PROVIDERS["mimo"] is original
    asyncio.run(scenario())


def test_one_client_closing_does_not_close_another_inflight_synthesis(monkeypatch):
    async def scenario():
        original = PROVIDERS["mimo"]
        second_started = asyncio.Event()
        release_second = asyncio.Event()

        class Pool(httpx.MockTransport):
            close_count = 0

            async def aclose(self):
                self.close_count += 1

        async def handler(request):
            text = json.loads(await request.aread())["messages"][-1]["content"]
            if text == "b":
                second_started.set()
                await release_second.wait()
            else:
                await second_started.wait()
            assert pool.close_count == 0
            wav = base64.b64encode(b"RIFF\0\0\0\0WAVEdata").decode()
            return httpx.Response(200, json={"choices": [{"message": {"audio": {"data": wav}}}]})

        pool = Pool(handler)
        monkeypatch.setattr(httpx, "AsyncHTTPTransport", lambda: pool)
        async with offline_provider("mimo", RequestLimiter(), asyncio.Event()):
            provider = PROVIDERS["mimo"]
            first = asyncio.create_task(provider.synthesize("a", "白桦", configured()))
            second = asyncio.create_task(provider.synthesize("b", "白桦", configured()))
            await first
            assert not second.done() and pool.close_count == 0
            release_second.set()
            await second
        assert pool.close_count == 1 and PROVIDERS["mimo"] is original

    asyncio.run(scenario())


def test_cancelled_generate_drains_pool_restores_provider_and_leaves_no_tasks(tmp_path, monkeypatch):
    async def scenario():
        original = PROVIDERS["mimo"]
        both_started = asyncio.Event()
        release = asyncio.Event()
        requests, persisted = [], []

        class Pool(httpx.MockTransport):
            close_count = 0

            async def aclose(self):
                self.close_count += 1

        async def handler(request):
            requests.append(json.loads(await request.aread())["messages"][-1]["content"])
            if len(requests) == 2:
                both_started.set()
            await release.wait()
            assert pool.close_count == 0
            wav = base64.b64encode(b"RIFF\0\0\0\0WAVEdata").decode()
            return httpx.Response(200, json={"choices": [{"message": {"audio": {"data": wav}}}]})

        async def resolve(provider, voice, text, settings):
            await PROVIDERS[provider].synthesize(text, voice, settings)
            persisted.append(text)
            return audio(text), "miss"

        class Store:
            def put_json(self, *args, **kwargs):
                pytest.fail("Cancelled chapter must not be published")

        pool = Pool(handler)
        monkeypatch.setattr(httpx, "AsyncHTTPTransport", lambda: pool)
        monkeypatch.setattr(batch, "speech_store", lambda _: Store())
        monkeypatch.setattr(batch, "resolve_speech", resolve)
        baseline = asyncio.all_tasks()
        task = asyncio.create_task(batch.generate(options(tmp_path, ["a", "b", "c"]), configured()))
        await asyncio.wait_for(both_started.wait(), 1)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done() and pool.close_count == 0
        assert PROVIDERS["mimo"] is not original
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert requests == persisted == ["a", "b"]
        assert pool.close_count == 1 and PROVIDERS["mimo"] is original
        assert not (asyncio.all_tasks() - baseline)

    asyncio.run(scenario())


def test_429_retry_wait_does_not_send_after_sibling_failure():
    async def scenario():
        stopped = asyncio.Event()
        calls = []

        async def wait_then_fail(seconds):
            stopped.set()

        def handler(request):
            calls.append(request)
            return httpx.Response(429, headers={"Retry-After": "10"})

        from offline import BatchStopped
        transport = LimitedTransport(httpx.MockTransport(handler), RequestLimiter(sleep=wait_then_fail), stopped)
        with pytest.raises(BatchStopped):
            await transport.handle_async_request(httpx.Request("POST", "https://example.invalid", json={"text": "a"}))
        assert len(calls) == 1
        await transport.close()

    asyncio.run(scenario())


def test_report_write_error_drains_without_starting_more(tmp_path, monkeypatch, isolated_batch):
    async def scenario():
        second_started = asyncio.Event()
        release = asyncio.Event()
        write_failed = asyncio.Event()
        started, persisted = [], []

        async def resolve(provider, voice, text, settings):
            started.append(text)
            if text == "b":
                second_started.set()
                await release.wait()
            else:
                await second_started.wait()
            persisted.append(text)
            return audio(text), "miss"

        def fail_save(*args):
            write_failed.set()
            raise OSError("report disk full")

        monkeypatch.setattr(batch, "resolve_speech", resolve)
        monkeypatch.setattr(batch, "save_report", fail_save)
        task = asyncio.create_task(batch.generate(options(tmp_path, ["a", "b", "c"]), configured()))
        await asyncio.wait_for(write_failed.wait(), 1)
        assert not task.done() and started == ["a", "b"]
        release.set()
        with pytest.raises(OSError):
            await task
        assert persisted == ["a", "b"] and started == ["a", "b"]
        assert not isolated_batch

    asyncio.run(scenario())


@pytest.mark.parametrize("cancel_body", [False, True])
def test_pool_close_finishes_under_repeated_cancellation(monkeypatch, cancel_body):
    async def scenario():
        original = PROVIDERS["mimo"]
        body_started = asyncio.Event()
        close_started = asyncio.Event()
        release_close = asyncio.Event()
        body_wait = asyncio.Event()

        class Pool(httpx.MockTransport):
            closed = False

            async def aclose(self):
                close_started.set()
                await release_close.wait()
                self.closed = True

        pool = Pool(lambda _: pytest.fail("No HTTP request expected"))
        monkeypatch.setattr(httpx, "AsyncHTTPTransport", lambda: pool)

        async def scoped():
            async with offline_provider("mimo", RequestLimiter(), asyncio.Event()):
                body_started.set()
                if cancel_body:
                    await body_wait.wait()

        baseline = asyncio.all_tasks()
        task = asyncio.create_task(scoped())
        await body_started.wait()
        if cancel_body:
            task.cancel()
        await close_started.wait()
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done() and not pool.closed
        release_close.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert pool.closed and PROVIDERS["mimo"] is original
        assert not (asyncio.all_tasks() - baseline)

    asyncio.run(scenario())
