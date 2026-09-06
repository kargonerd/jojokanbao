"""Bounded scheduling and provider throttling for the manual CLI only."""
from __future__ import annotations

import asyncio
import math
import time
from collections import deque
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import replace
from email.utils import parsedate_to_datetime

import httpx

from app.speech.providers import MimoProvider, PROVIDERS


offline_account = ContextVar("offline_account", default=0)


class AccountProvider:
    """Route offline workers without changing shared storage settings/cache identity."""

    def __init__(self, providers, keys, budgets=None):
        self.providers, self.keys = providers, keys
        self.budgets = budgets

    def __getattr__(self, name):
        return getattr(self.providers[0], name)

    async def synthesize(self, text, voice, settings):
        index = offline_account.get()
        started = time.monotonic()
        result = await self.providers[index].synthesize(
            text, voice, replace(settings, mimo_api_key=self.keys[index]))
        if self.budgets:
            self.budgets[index].synthesis_seconds.append(time.monotonic() - started)
        return result


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

    def __init__(self, *, rpm=30, tpm=8_000_000, clock=time.monotonic, sleep=asyncio.sleep, smooth=False):
        if not 1 <= rpm <= 80 or not 1 <= tpm <= 8_000_000:
            raise ValueError("Offline rate budget exceeds reserved account headroom")
        self.rpm, self.tpm = rpm, tpm
        self.clock = clock
        self.sleep = sleep
        self.requests = deque()
        self.cooldown_until = 0.0
        self.lock = asyncio.Lock()
        self.tokens = deque()
        self.sent = self.throttled = 0
        self.interval = 60 / rpm if smooth else 0
        self.next_request_at = 0.0
        self.synthesis_seconds = deque(maxlen=100)

    async def acquire(self, stopped: asyncio.Event, tokens: int = 0) -> None:
        if not 0 <= tokens <= self.tpm:
            raise ValueError("One request exceeds token reservation budget")
        while True:
            async with self.lock:
                if stopped.is_set():
                    raise BatchStopped()
                now = self.clock()
                while self.requests and self.requests[0] <= now - 60:
                    self.requests.popleft()
                while self.tokens and self.tokens[0][0] <= now - 60:
                    self.tokens.popleft()
                delay = max(0.0, self.cooldown_until - now, self.next_request_at - now)
                if len(self.requests) >= self.rpm:
                    delay = max(delay, self.requests[0] + 60 - now)
                used = sum(value for _, value in self.tokens)
                for stamp, value in self.tokens:
                    if used + tokens <= self.tpm:
                        break
                    delay = max(delay, stamp + 60 - now)
                    used -= value
                if delay <= 0:
                    self.requests.append(now)
                    self.tokens.append((now, tokens))
                    self.sent += 1
                    # Do not accumulate burst credit after idle time or cooldown.
                    self.next_request_at = now + self.interval
                    return
            await self.sleep(delay)

    def defer(self, seconds: float) -> None:
        self.throttled += 1
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
            # Conservative reservation, not measured billing: UTF-8 request bytes
            # plus the model's documented 8K maximum output. Includes each retry.
            await self.limiter.acquire(self.stopped, tokens=len(body) + 8192)
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
async def offline_provider(provider_id: str, limiter: RequestLimiter, stopped: asyncio.Event, *, concurrency: int = 2,
                           accounts=None):
    # Only used by the standalone offline tool. Do not run overlapping generate()
    # scopes in one process, or use this context in the online API.
    original = PROVIDERS[provider_id]
    transports = []
    if provider_id == "mimo":
        for budget in ([item[1] for item in accounts] if accounts else [limiter]):
            transports.append(LimitedTransport(httpx.AsyncHTTPTransport(
                limits=httpx.Limits(max_connections=100, max_keepalive_connections=64, keepalive_expiry=60)), budget, stopped))
        providers = [MimoProvider(transport=item, max_response_bytes=None) for item in transports]
        replacement = AccountProvider(providers, [item[0] for item in accounts], [item[1] for item in accounts]) if accounts else providers[0]
    else:
        replacement = LimitedProvider(original, limiter, stopped)
    PROVIDERS[provider_id] = replacement
    from app.speech.delivery import offline_synthesis_slots, offline_pending_limit
    slot_token = offline_synthesis_slots.set(asyncio.Semaphore(concurrency))
    pending_token = offline_pending_limit.set(max(32, concurrency))
    try:
        yield
    finally:
        PROVIDERS[provider_id] = original
        offline_synthesis_slots.reset(slot_token)
        offline_pending_limit.reset(pending_token)
        await finish_cleanup(asyncio.gather(*(item.close() for item in transports)))


@asynccontextmanager
async def ordered_results(texts, resolve, concurrency: int, stopped: asyncio.Event):
    """Bound prefetch to the chosen offline concurrency; drain on every exit."""
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
