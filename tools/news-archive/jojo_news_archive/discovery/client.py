from __future__ import annotations

import os
import threading
import time
from urllib.parse import urlsplit

import httpx


DEFAULT_USER_AGENT = (
    "JOJO-Olds/0.1 (+https://jojokanbao.cn; authorized personal academic archive)"
)
RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}


class GlobalRateLimiter:
    def __init__(self, minimum_interval: float) -> None:
        self.minimum_interval = max(0.0, minimum_interval)
        self._lock = threading.Lock()
        self._next_request_at = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            delay = max(0.0, self._next_request_at - now)
            self._next_request_at = max(now, self._next_request_at) + self.minimum_interval
        if delay:
            time.sleep(delay)


class ArchiveClient:
    def __init__(
        self,
        *,
        timeout: float = 90.0,
        minimum_interval: float = 0.5,
        attempts: int = 6,
        client: httpx.Client | None = None,
        proxy: str | None = None,
    ) -> None:
        self.attempts = attempts
        self.timeout = timeout
        self.minimum_interval = max(0.0, minimum_interval)
        self.rate_limiter = GlobalRateLimiter(self.minimum_interval)
        self._provided_client = client
        # The workflow starts an optional local Mihomo load-balancer and
        # exposes it through this non-secret variable.  Keep the proxy
        # opt-in: local tests and ordinary archive runs retain httpx's normal
        # environment behavior when no proxy was requested.
        configured_proxy = (
            proxy if proxy is not None else os.environ.get("ARCHIVE_HTTP_PROXY")
        )
        self.proxy = configured_proxy.strip() if configured_proxy else None
        self._local = threading.local()
        self._direct_local = threading.local()
        self._clients: list[httpx.Client] = []
        self._clients_lock = threading.Lock()
        self._circuit_lock = threading.Lock()
        self._consecutive_failures: dict[str, int] = {}
        self._blocked_until: dict[str, float] = {}
        self._prefer_wayback_http = False

    def close(self) -> None:
        if self._provided_client is not None:
            return
        with self._clients_lock:
            clients = list(self._clients)
            self._clients.clear()
        for client in clients:
            client.close()

    @staticmethod
    def _uses_direct_common_crawl(url: str | None) -> bool:
        """Keep Common Crawl transport independent from the archive proxy.

        Mihomo is useful for Wayback and other archive hosts, but its rotating
        egress nodes frequently terminate the large ranged responses served by
        ``data.commoncrawl.org``. Common Crawl is a public object store with
        its own request limits, so a direct runner connection is both more
        reliable and easier to resume. A caller-supplied mock/client remains
        authoritative for tests and embedded users.
        """

        if not url:
            return False
        host = (urlsplit(url).hostname or "").casefold()
        return host in {"data.commoncrawl.org", "index.commoncrawl.org"}

    def _get_client(self, url: str | None = None) -> httpx.Client:
        if self._provided_client is not None:
            return self._provided_client
        direct = self._uses_direct_common_crawl(url)
        local = self._direct_local if direct else self._local
        client = getattr(local, "client", None)
        if client is None:
            transport = httpx.HTTPTransport(
                # Retry policy belongs to ArchiveClient._fetch, which records
                # archive failures, applies the circuit breaker, and can
                # switch Wayback HTTPS to HTTP.  Transport-level retries
                # silently multiply that policy and leave validation workers
                # occupied for minutes on dead archive captures.
                retries=0,
                limits=httpx.Limits(
                    max_connections=2,
                    max_keepalive_connections=1,
                    keepalive_expiry=10.0,
                ),
            )
            client_kwargs = {
                "headers": {"User-Agent": DEFAULT_USER_AGENT},
                "follow_redirects": True,
                "timeout": self.timeout,
                "transport": transport,
            }
            if self.proxy and not direct:
                # Do not let an ambient CI proxy override the explicitly
                # selected local pool.  The proxy URL itself is never logged.
                client_kwargs["proxy"] = self.proxy
                client_kwargs["trust_env"] = False
            elif direct:
                # Common Crawl must bypass both the explicit Mihomo pool and
                # any runner-wide HTTP(S)_PROXY inherited from the job.
                client_kwargs["trust_env"] = False
            client = httpx.Client(**client_kwargs)
            local.client = client
            with self._clients_lock:
                self._clients.append(client)
        return client

    def _wait_for_circuit(self, url: str) -> None:
        if self.proxy and not self._uses_direct_common_crawl(url):
            # An explicit archive proxy can be a load-balancing pool with a
            # different egress node per connection. A host-wide breaker in
            # this process would let failures from a few nodes pause every
            # healthy worker, defeating the pool. Per-request timeouts,
            # bounded attempts, and the global cadence still apply.
            return
        host = (urlsplit(url).hostname or "").casefold()
        with self._circuit_lock:
            delay = max(
                0.0,
                self._blocked_until.get(host, 0.0) - time.monotonic(),
            )
        if delay:
            time.sleep(delay)

    def circuit_is_open(self, url: str) -> bool:
        """Return whether a direct archive host is currently cooling down.

        Common Crawl discovery is an optional fallback performed for many
        articles in parallel.  Callers can use this non-blocking probe to skip
        an index lookup while the shared direct-host circuit is already open,
        instead of occupying every capture worker in ``_wait_for_circuit``.
        """

        if self.proxy and not self._uses_direct_common_crawl(url):
            return False
        host = (urlsplit(url).hostname or "").casefold()
        with self._circuit_lock:
            return self._blocked_until.get(host, 0.0) > time.monotonic()

    def _wait_for_rate_slot(self, url: str | None = None) -> None:
        """Throttle one worker without serializing an explicit proxy pool.

        Without a proxy, the archive host sees all requests from this
        process, so the historical global cadence remains appropriate. An
        explicit Mihomo pool load-balances independent worker connections
        across egress nodes; using one process-wide lock in that mode would
        turn otherwise concurrent workers back into a queue. Keep the same
        interval per worker instead, so each connection retains a bounded
        cadence while the pool can make progress in parallel.
        """

        if not self.proxy or self._uses_direct_common_crawl(url):
            self.rate_limiter.wait()
            return
        limiter = getattr(self._local, "rate_limiter", None)
        if limiter is None:
            limiter = GlobalRateLimiter(self.minimum_interval)
            self._local.rate_limiter = limiter
        limiter.wait()

    def _record_success(self, url: str) -> None:
        if self.proxy and not self._uses_direct_common_crawl(url):
            return
        host = (urlsplit(url).hostname or "").casefold()
        with self._circuit_lock:
            self._consecutive_failures.pop(host, None)
            self._blocked_until.pop(host, None)

    def _record_failure(
        self,
        url: str,
        *,
        retry_after: float | None = None,
    ) -> None:
        if self.proxy and not self._uses_direct_common_crawl(url):
            return
        host = (urlsplit(url).hostname or "").casefold()
        with self._circuit_lock:
            failures = self._consecutive_failures.get(host, 0) + 1
            self._consecutive_failures[host] = failures
            if failures >= 3:
                exponent = min(3, failures - 3)
                circuit_delay = max(retry_after or 0.0, 15.0 * (2**exponent))
                self._blocked_until[host] = max(
                    self._blocked_until.get(host, 0.0),
                    time.monotonic() + circuit_delay,
                )

    def fetch(
        self,
        url: str,
        *,
        maximum_bytes: int,
    ) -> tuple[int, dict[str, str], bytes, str]:
        return self._fetch(
            url,
            maximum_bytes=maximum_bytes,
            request_headers=None,
            require_partial_content=False,
            maximum_attempts=self.attempts,
            request_timeout=self.timeout,
        )

    def fetch_limited(
        self,
        url: str,
        *,
        maximum_bytes: int,
        attempts: int,
        timeout: float,
    ) -> tuple[int, dict[str, str], bytes, str]:
        if attempts < 1:
            raise ValueError("attempts must be positive")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        return self._fetch(
            url,
            maximum_bytes=maximum_bytes,
            request_headers=None,
            require_partial_content=False,
            maximum_attempts=attempts,
            request_timeout=timeout,
        )

    def fetch_range(
        self,
        url: str,
        *,
        offset: int,
        length: int,
        maximum_bytes: int,
    ) -> tuple[int, dict[str, str], bytes, str]:
        if offset < 0:
            raise ValueError("range offset must not be negative")
        if length < 1:
            raise ValueError("range length must be positive")
        if length > maximum_bytes:
            raise ValueError(
                f"range length {length} exceeds {maximum_bytes} bytes"
            )
        return self._fetch(
            url,
            maximum_bytes=maximum_bytes,
            request_headers={
                "Range": f"bytes={offset}-{offset + length - 1}",
            },
            require_partial_content=True,
            maximum_attempts=1,
            request_timeout=min(self.timeout, 30.0),
        )

    def _fetch(
        self,
        url: str,
        *,
        maximum_bytes: int,
        request_headers: dict[str, str] | None,
        require_partial_content: bool,
        maximum_attempts: int,
        request_timeout: float,
    ) -> tuple[int, dict[str, str], bytes, str]:
        parsed_url = urlsplit(url)
        if (
            self._prefer_wayback_http
            and parsed_url.scheme.casefold() == "https"
            and (parsed_url.hostname or "").casefold()
            == "web.archive.org"
        ):
            url = parsed_url._replace(scheme="http").geturl()
        last_error: Exception | None = None
        for attempt in range(maximum_attempts):
            self._wait_for_circuit(url)
            self._wait_for_rate_slot(url)
            # httpx's read timeout is applied per socket read.  A replay
            # endpoint can therefore keep a worker occupied indefinitely by
            # sending a trickle of bytes just inside that per-read timeout.
            # Bound the complete response as well so validation batches remain
            # resumable and a stalled archive cannot consume every worker.
            response_deadline = time.monotonic() + max(1.0, request_timeout)
            try:
                with self._get_client(url).stream(
                    "GET",
                    url,
                    headers=request_headers,
                    timeout=request_timeout,
                ) as response:
                    status_code = response.status_code
                    headers = {
                        key.lower(): value
                        for key, value in response.headers.items()
                    }
                    if status_code in RETRYABLE_STATUS_CODES:
                        retry_after = _parse_retry_after(headers.get("retry-after"))
                        self._record_failure(
                            url,
                            retry_after=retry_after,
                        )
                        raise RetryableArchiveError(
                            f"retryable HTTP {status_code}",
                            retry_after=retry_after,
                        )
                    if status_code not in {200, 206}:
                        self._record_success(url)
                        return status_code, headers, b"", str(response.url)
                    if require_partial_content and status_code != 206:
                        self._record_success(url)
                        return status_code, headers, b"", str(response.url)
                    chunks = []
                    byte_count = 0
                    for chunk in response.iter_bytes():
                        if time.monotonic() >= response_deadline:
                            raise TimeoutError(
                                "archive response exceeded wall-clock timeout"
                            )
                        byte_count += len(chunk)
                        if byte_count > maximum_bytes:
                            raise ValueError(
                                f"response exceeds {maximum_bytes} bytes"
                            )
                        chunks.append(chunk)
                    self._record_success(url)
                    return status_code, headers, b"".join(chunks), str(response.url)
            except RetryableArchiveError as exc:
                last_error = exc
                if attempt + 1 < maximum_attempts:
                    time.sleep(exc.retry_after or min(60.0, 2.0 ** attempt))
            except (
                httpx.TransportError,
                httpx.TimeoutException,
                TimeoutError,
            ) as exc:
                last_error = exc
                self._record_failure(url)
                if attempt + 1 < maximum_attempts:
                    time.sleep(min(60.0, 2.0 ** (attempt + 1)))
        if last_error:
            parsed_url = urlsplit(url)
            if (
                isinstance(
                    last_error,
                    (
                        httpx.TransportError,
                        httpx.TimeoutException,
                        TimeoutError,
                    ),
                )
                and parsed_url.scheme.casefold() == "https"
                and (parsed_url.hostname or "").casefold()
                == "web.archive.org"
            ):
                # The bounded response loop raises the built-in
                # TimeoutError when a replay trickles bytes past the wall
                # clock.  Treat it like httpx transport/read timeouts so a
                # proxy node that stalls HTTPS can still be retried over the
                # already-supported Wayback HTTP endpoint.
                self._prefer_wayback_http = True
                insecure_wayback_url = parsed_url._replace(
                    scheme="http"
                ).geturl()
                return self._fetch(
                    insecure_wayback_url,
                    maximum_bytes=maximum_bytes,
                    request_headers=request_headers,
                    require_partial_content=require_partial_content,
                    maximum_attempts=maximum_attempts,
                    request_timeout=request_timeout,
                )
            raise last_error
        raise RuntimeError("archive fetch failed without an error")


class RetryableArchiveError(RuntimeError):
    def __init__(self, message: str, *, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


def _parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, min(300.0, float(value)))
    except ValueError:
        return None
