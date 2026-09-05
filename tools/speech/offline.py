"""Bounded scheduling and provider throttling for the manual CLI only."""
from __future__ import annotations

import asyncio
import math
import time
from collections import deque
from contextlib import asynccontextmanager
from email.utils import parsedate_to_datetime

import httpx

from app.speech.providers import MimoProvider, PROVIDERS


class BatchStopped(Exception):
    """Do not send another request after a sibling's terminal failure."""


async def finish_cleanup(awaitable):
    """Finish already-started work even under repeated cancellation."""
    task = asyncio.ensure_future(awaitable)
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    result = task.result()
    if cancelled:
        raise asyncio.CancelledError()
    return result


class RequestLimiter:
    """One rolling 30-request/minute budget, including retries, per offline run.

    Reuse this instance across generate() calls in the same event loop. This is
    not an account-wide/distributed limit; leave headroom for online listeners.
    """

    def __init__(self, *, clock=time.monotonic, sleep=asyncio.sleep):
        self.clock = clock
        self.sleep = sleep
        self.requests = deque()
        self.cooldown_until = 0.0
        self.lock = asyncio.Lock()

    async def acquire(self, stopped: asyncio.Event) -> None:
        while True:
            async with self.lock:
                if stopped.is_set():
                    raise BatchStopped()
                now = self.clock()
                while self.requests and self.requests[0] <= now - 60:
                    self.requests.popleft()
                delay = max(0.0, self.cooldown_until - now)
                if len(self.requests) >= 30:
                    delay = max(delay, self.requests[0] + 60 - now)
                if delay <= 0:
                    self.requests.append(now)
                    return
            await self.sleep(delay)

    def defer(self, seconds: float) -> None:
        self.cooldown_until = max(self.cooldown_until, self.clock() + seconds)


def retry_delay(headers: httpx.Headers, attempt: int) -> float | None:
    """At most two retries, waiting 5/10s or a longer Retry-After (up to 60s).

    A server requesting more than our budget is not retried early. Malformed
    headers use the default backoff; HTTP-date and delta-seconds are supported.
    """
    delay = float(5 * 2**attempt)
    value = headers.get("Retry-After")
    if value:
        try:
            requested = float(value)
        except ValueError:
            try:
                requested = parsedate_to_datetime(value).timestamp() - time.time()
            except (TypeError, ValueError, OverflowError):
                requested = 0.0
        if math.isfinite(requested):
            if requested > 60:
                return None
            delay = max(delay, requested)
        elif requested > 0:
            return None
    return delay


class LimitedTransport(httpx.AsyncBaseTransport):
    """Retry only an explicit upstream HTTP 429, never synthesis/storage errors."""

    def __init__(self, transport, limiter: RequestLimiter, stopped: asyncio.Event):
        self.transport = transport
        self.limiter = limiter
        self.stopped = stopped

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        # MiMo sends a small JSON body. Materialize it once so every retry is
        # identical even if the original request stream was already consumed.
        body = await request.aread()
        for attempt in range(3):
            await self.limiter.acquire(self.stopped)
            replay = httpx.Request(request.method, request.url, headers=request.headers,
                                   content=body, extensions=request.extensions)
            response = await self.transport.handle_async_request(replay)
            if response.status_code != 429 or attempt == 2 or self.stopped.is_set():
                return response
            delay = retry_delay(response.headers, attempt)
            if delay is None:
                return response
            # Release the connection before waiting; share cooldown with workers.
            await response.aclose()
            self.limiter.defer(delay)
        raise AssertionError("Unreachable retry state")

    async def aclose(self) -> None:
        # MimoProvider closes its AsyncClient after each call. The offline scope,
        # not one client, owns the shared pool while another call may be active.
        pass

    async def close(self) -> None:
        await self.transport.aclose()


class LimitedProvider:
    """Apply the same request budget to Edge cache misses without HTTP retries."""

    def __init__(self, provider, limiter: RequestLimiter, stopped: asyncio.Event):
        self.provider, self.limiter, self.stopped = provider, limiter, stopped

    def __getattr__(self, name):
        return getattr(self.provider, name)

    async def synthesize(self, *args, **kwargs):
        await self.limiter.acquire(self.stopped)
        return await self.provider.synthesize(*args, **kwargs)


@asynccontextmanager
async def offline_provider(provider_id: str, limiter: RequestLimiter, stopped: asyncio.Event):
    # Only used by the standalone offline tool. Do not run overlapping generate()
    # scopes in one process, or use this context in the online API.
    original = PROVIDERS[provider_id]
    transport = None
    if provider_id == "mimo":
        transport = LimitedTransport(httpx.AsyncHTTPTransport(), limiter, stopped)
        replacement = MimoProvider(transport=transport)
    else:
        replacement = LimitedProvider(original, limiter, stopped)
    PROVIDERS[provider_id] = replacement
    try:
        yield
    finally:
        PROVIDERS[provider_id] = original
        if transport is not None:
            await finish_cleanup(transport.close())


@asynccontextmanager
async def ordered_results(texts, resolve, concurrency: int, stopped: asyncio.Event):
    """Prefetch at most two segments; report in order and drain on every exit."""
    pending = deque()
    remaining = iter(texts)

    async def run(text):
        try:
            if stopped.is_set():
                raise BatchStopped()
            return await resolve(text)
        except BaseException:
            stopped.set()
            raise

    def fill():
        while len(pending) < concurrency and not stopped.is_set():
            try:
                text = next(remaining)
            except StopIteration:
                break
            pending.append(asyncio.create_task(run(text)))

    async def iterate():
        fill()
        while pending:
            # Shield the outer resolver too: delivery shields its own synthesis,
            # so cancelling the resolver would otherwise leave an orphaned PUT.
            result = await asyncio.shield(pending[0])
            pending.popleft()
            yield result
            fill()

    try:
        yield iterate()
    finally:
        if pending:
            stopped.set()
            await finish_cleanup(asyncio.gather(*pending, return_exceptions=True))
