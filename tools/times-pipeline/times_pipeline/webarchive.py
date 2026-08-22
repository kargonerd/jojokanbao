from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
from typing import Any, Iterable
from urllib.parse import urljoin, urlsplit
from uuid import uuid4
import zipfile

import httpx
from warcio.statusandheaders import StatusAndHeaders
from warcio.warcwriter import WARCWriter

from .feeds import Article, RawFeed, USER_AGENT


ARCHIVE_STATE_VERSION = "jojo-web-archive-state/1"
ARCHIVE_RUN_VERSION = "jojo-web-archive-run/1"
WACZ_VERSION = "1.2.0"
MAX_REDIRECTS = 8
SENSITIVE_HEADERS = frozenset({"authorization", "cookie", "proxy-authorization", "x-api-key"})
SENSITIVE_RESPONSE_HEADERS = frozenset({"set-cookie"})
SENSITIVE_QUERY_NAMES = frozenset({"access_key", "api_key", "apikey", "key", "token"})
BROWSER_RETRY_STATUSES = frozenset({403, 408, 425, 429, 500, 502, 503, 504})


@dataclass(frozen=True, slots=True)
class HttpExchange:
    source_id: str
    article_id: str | None
    canonical_url: str
    title: str | None
    captured_at: str
    request_url: str
    request_headers: tuple[tuple[str, str], ...]
    status_code: int
    reason_phrase: str
    response_headers: tuple[tuple[str, str], ...]
    body: bytes
    truncated: bool = False
    request_method: str = "GET"
    is_page: bool = False


@dataclass(frozen=True, slots=True)
class ArticleCapture:
    article_id: str
    source_id: str
    canonical_url: str
    title: str
    exchanges: tuple[HttpExchange, ...]
    elapsed_ms: int
    error: str | None = None

    @property
    def final_exchange(self) -> HttpExchange | None:
        pages = [exchange for exchange in self.exchanges if exchange.is_page]
        return pages[-1] if pages else (self.exchanges[-1] if self.exchanges else None)


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _archive_safe_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
    except ValueError:
        return value
    if not parsed.query:
        return parsed._replace(fragment="").geturl()
    safe_parts = []
    for part in parsed.query.split("&"):
        name = part.partition("=")[0].casefold()
        if name not in SENSITIVE_QUERY_NAMES:
            safe_parts.append(part)
    return parsed._replace(query="&".join(safe_parts), fragment="").geturl()


def _safe_request_headers(headers: Iterable[tuple[str, str]]) -> tuple[tuple[str, str], ...]:
    return tuple((name, value) for name, value in headers if name.casefold() not in SENSITIVE_HEADERS)


def _normalized_response_headers(
    headers: Iterable[tuple[str, str]], body_length: int, truncated: bool
) -> tuple[tuple[str, str], ...]:
    excluded = {"content-encoding", "content-length", "transfer-encoding"}
    result = [
        (name, value)
        for name, value in headers
        if name.casefold() not in excluded | SENSITIVE_RESPONSE_HEADERS
    ]
    result.append(("Content-Length", str(body_length)))
    if truncated:
        result.append(("X-JOJO-Capture-Truncated", "true"))
    return tuple(result)


def load_archive_state(previous_directory: Path | None) -> dict[str, Any]:
    if previous_directory is None:
        return {"formatVersion": ARCHIVE_STATE_VERSION, "articles": {}}
    path = previous_directory / "archive-state.json.gz"
    if not path.exists():
        return {"formatVersion": ARCHIVE_STATE_VERSION, "articles": {}}
    try:
        value = json.loads(gzip.decompress(path.read_bytes()))
    except (OSError, gzip.BadGzipFile, json.JSONDecodeError, UnicodeDecodeError):
        return {"formatVersion": ARCHIVE_STATE_VERSION, "articles": {}}
    if not isinstance(value, dict) or value.get("formatVersion") != ARCHIVE_STATE_VERSION:
        return {"formatVersion": ARCHIVE_STATE_VERSION, "articles": {}}
    if not isinstance(value.get("articles"), dict):
        value["articles"] = {}
    return value


def _article_fingerprint(article: Article) -> str:
    value = f"{article.url}\0{article.title}\0{article.published_at}"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def select_articles_for_capture(
    articles: Iterable[Article],
    state: dict[str, Any],
    *,
    now: datetime,
    retention_days: int,
    max_pages: int,
    refresh_hours: float,
    retry_hours: float,
) -> list[Article]:
    if max_pages < 0 or refresh_hours <= 0 or retry_hours <= 0:
        raise ValueError("Archive limits and refresh intervals must be valid")
    if max_pages == 0:
        return []
    cutoff = now.astimezone(timezone.utc) - timedelta(days=retention_days)
    rows = state.get("articles", {}) if isinstance(state, dict) else {}
    ranked: list[tuple[int, datetime, Article]] = []
    for article in articles:
        published = _parse_datetime(article.published_at)
        if not article.source.archive_pages or published is None or published < cutoff:
            continue
        previous = rows.get(article.id) if isinstance(rows, dict) else None
        fingerprint = _article_fingerprint(article)
        if not isinstance(previous, dict):
            rank = 0
        elif previous.get("fingerprint") != fingerprint:
            rank = 1
        else:
            last_attempt = _parse_datetime(previous.get("lastAttempt"))
            status = previous.get("httpStatus")
            wait_hours = retry_hours if previous.get("error") or status not in range(200, 400) else refresh_hours
            if last_attempt is not None and now.astimezone(timezone.utc) - last_attempt < timedelta(hours=wait_hours):
                continue
            rank = 2 if wait_hours == retry_hours else 3
        ranked.append((rank, published, article))
    ranked.sort(key=lambda row: (row[0], -row[1].timestamp(), row[2].id))
    selected: list[Article] = []
    selected_ids: set[str] = set()
    represented_sources: set[str] = set()
    for _rank, _published, article in ranked:
        if article.source.id in represented_sources:
            continue
        selected.append(article)
        selected_ids.add(article.id)
        represented_sources.add(article.source.id)
        if len(selected) == max_pages:
            return selected
    for _rank, _published, article in ranked:
        if article.id in selected_ids:
            continue
        selected.append(article)
        if len(selected) == max_pages:
            break
    return selected


async def _capture_one(
    client: httpx.AsyncClient,
    article: Article,
    *,
    maximum_response_bytes: int,
) -> ArticleCapture:
    started = asyncio.get_running_loop().time()
    captured_at = datetime.now(timezone.utc).isoformat()
    current_url = article.url
    exchanges: list[HttpExchange] = []
    error: str | None = None
    try:
        for redirect_index in range(MAX_REDIRECTS + 1):
            async with client.stream("GET", current_url, follow_redirects=False) as response:
                body = bytearray()
                truncated = False
                async for chunk in response.aiter_bytes():
                    remaining = maximum_response_bytes - len(body)
                    if remaining <= 0:
                        truncated = True
                        break
                    body.extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        truncated = True
                        break
                safe_url = _archive_safe_url(str(response.request.url))
                exchanges.append(HttpExchange(
                    source_id=article.source.id,
                    article_id=article.id,
                    canonical_url=article.url,
                    title=article.title,
                    captured_at=captured_at,
                    request_url=safe_url,
                    request_headers=_safe_request_headers(response.request.headers.multi_items()),
                    status_code=response.status_code,
                    reason_phrase=response.reason_phrase or "",
                    response_headers=_normalized_response_headers(response.headers.multi_items(), len(body), truncated),
                    body=bytes(body),
                    truncated=truncated,
                    is_page=True,
                ))
                location = response.headers.get("location")
                if response.status_code not in {301, 302, 303, 307, 308} or not location:
                    break
                if redirect_index == MAX_REDIRECTS:
                    error = "TooManyRedirects"
                    break
                current_url = urljoin(str(response.url), location)
    except (httpx.HTTPError, ValueError) as exc:
        error = type(exc).__name__
    elapsed_ms = round((asyncio.get_running_loop().time() - started) * 1_000)
    return ArticleCapture(
        article_id=article.id,
        source_id=article.source.id,
        canonical_url=article.url,
        title=article.title,
        exchanges=tuple(exchanges),
        elapsed_ms=elapsed_ms,
        error=error,
    )


async def capture_articles(
    articles: Iterable[Article],
    *,
    timeout_seconds: float,
    workers: int,
    maximum_response_bytes: int,
    transport: httpx.AsyncBaseTransport | None = None,
    engine: str = "http",
    proxy_server: str | None = None,
    browser_executable: str | None = None,
    browser_retries: int = 4,
    maximum_page_bytes: int = 25_000_000,
) -> list[ArticleCapture]:
    if (
        timeout_seconds <= 0
        or workers < 1
        or maximum_response_bytes < 1
        or browser_retries < 0
        or maximum_page_bytes < maximum_response_bytes
    ):
        raise ValueError("Article capture settings must be positive")
    if engine == "browser":
        if transport is not None:
            raise ValueError("Custom httpx transports cannot be used by the browser capture engine")
        return await _capture_articles_browser(
            articles,
            timeout_seconds=timeout_seconds,
            workers=workers,
            maximum_response_bytes=maximum_response_bytes,
            maximum_page_bytes=maximum_page_bytes,
            proxy_server=proxy_server,
            browser_executable=browser_executable,
            retries=browser_retries,
        )
    if engine != "http":
        raise ValueError(f"Unsupported article capture engine: {engine}")
    semaphore = asyncio.Semaphore(workers)
    limits = httpx.Limits(max_connections=workers, max_keepalive_connections=workers)
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(timeout_seconds),
        headers={"Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", "User-Agent": USER_AGENT},
        limits=limits,
        transport=transport,
    ) as client:
        async def guarded(article: Article) -> ArticleCapture:
            async with semaphore:
                return await _capture_one(client, article, maximum_response_bytes=maximum_response_bytes)

        return list(await asyncio.gather(*(guarded(article) for article in articles)))


def _is_page_response(response: Any, page: Any) -> bool:
    try:
        return bool(response.request.is_navigation_request() and response.request.frame == page.main_frame)
    except Exception:
        return False


async def _playwright_headers(value: Any) -> tuple[tuple[str, str], ...]:
    try:
        rows = await value.headers_array()
        return tuple((str(row["name"]), str(row["value"])) for row in rows)
    except Exception:
        try:
            rows = await value.all_headers()
            return tuple((str(name), str(item)) for name, item in rows.items())
        except Exception:
            return ()


async def _browser_attempt(
    browser: Any,
    article: Article,
    *,
    timeout_seconds: float,
    maximum_response_bytes: int,
    maximum_page_bytes: int,
) -> tuple[list[HttpExchange], int | None, str | None]:
    from playwright.async_api import Error as PlaywrightError
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError

    chrome_version = browser.version
    user_agent = (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        f"(KHTML, like Gecko) Chrome/{chrome_version} Safari/537.36"
    )
    context = await browser.new_context(
        user_agent=user_agent,
        locale="en-US",
        timezone_id="UTC",
        viewport={"width": 1440, "height": 1000},
        java_script_enabled=True,
    )
    try:
        page = await context.new_page()
        page.set_default_timeout(round(timeout_seconds * 1_000))
        observed: list[Any] = []
        page.on("response", lambda response: observed.append(response))
        navigation_error: str | None = None
        try:
            await page.goto(
                article.url,
                wait_until="domcontentloaded",
                timeout=round(timeout_seconds * 1_000),
            )
            try:
                await page.wait_for_load_state(
                    "networkidle",
                    timeout=min(round(timeout_seconds * 500), 10_000),
                )
            except PlaywrightTimeoutError:
                pass
            for _index in range(4):
                await page.evaluate("window.scrollBy(0, Math.max(window.innerHeight * 0.8, 600))")
                await asyncio.sleep(0.2)
            await asyncio.sleep(0.5)
        except PlaywrightTimeoutError:
            navigation_error = "BrowserTimeout"
        except PlaywrightError as exc:
            navigation_error = type(exc).__name__

        exchanges: list[HttpExchange] = []
        captured_bytes = 0
        main_status: int | None = None
        captured_at = datetime.now(timezone.utc).isoformat()
        for response in observed:
            request_url = str(response.url)
            if not request_url.startswith(("http://", "https://")):
                continue
            is_page = _is_page_response(response, page)
            if is_page:
                main_status = int(response.status)
            if not is_page and captured_bytes >= maximum_page_bytes:
                continue
            try:
                body = await response.body()
            except PlaywrightError:
                body = b""
            remaining = maximum_page_bytes - captured_bytes
            if is_page:
                remaining = max(remaining, maximum_response_bytes)
            limit = min(maximum_response_bytes, max(remaining, 0))
            truncated = len(body) > limit
            body = body[:limit]
            captured_bytes += len(body)
            request_headers = await _playwright_headers(response.request)
            response_headers = await _playwright_headers(response)
            exchanges.append(HttpExchange(
                source_id=article.source.id,
                article_id=article.id,
                canonical_url=article.url,
                title=article.title,
                captured_at=captured_at,
                request_url=_archive_safe_url(request_url),
                request_headers=_safe_request_headers(request_headers),
                status_code=int(response.status),
                reason_phrase=str(response.status_text or ""),
                response_headers=_normalized_response_headers(response_headers, len(body), truncated),
                body=body,
                truncated=truncated,
                request_method=str(response.request.method or "GET").upper(),
                is_page=is_page,
            ))
        return exchanges, main_status, navigation_error
    finally:
        await context.close()


async def _capture_one_browser(
    browser: Any,
    article: Article,
    *,
    timeout_seconds: float,
    maximum_response_bytes: int,
    maximum_page_bytes: int,
    proxy_server: str | None,
    browser_executable: str | None,
    retries: int,
) -> ArticleCapture:
    started = asyncio.get_running_loop().time()
    exchanges: list[HttpExchange] = []
    error: str | None = None
    for attempt in range(retries + 1):
        try:
            attempt_exchanges, status, attempt_error = await _browser_attempt(
                browser,
                article,
                timeout_seconds=timeout_seconds,
                maximum_response_bytes=maximum_response_bytes,
                maximum_page_bytes=maximum_page_bytes,
            )
        except Exception as exc:
            attempt_exchanges, status, attempt_error = [], None, type(exc).__name__
        exchanges.extend(attempt_exchanges)
        should_retry = status is None or status in BROWSER_RETRY_STATUSES
        if not should_retry:
            error = None if status is not None and 200 <= status < 400 else f"HTTPStatus{status}"
            break
        error = attempt_error or (f"HTTPStatus{status}" if status is not None else "BrowserNoResponse")
        if attempt < retries:
            await asyncio.sleep(0.25)
    elapsed_ms = round((asyncio.get_running_loop().time() - started) * 1_000)
    return ArticleCapture(
        article_id=article.id,
        source_id=article.source.id,
        canonical_url=article.url,
        title=article.title,
        exchanges=tuple(exchanges),
        elapsed_ms=elapsed_ms,
        error=error,
    )


async def _capture_articles_browser(
    articles: Iterable[Article],
    *,
    timeout_seconds: float,
    workers: int,
    maximum_response_bytes: int,
    maximum_page_bytes: int,
    proxy_server: str | None,
    browser_executable: str | None,
    retries: int,
) -> list[ArticleCapture]:
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise RuntimeError("Browser capture requires the playwright Python package") from exc

    values = list(articles)
    if not values:
        return []
    semaphore = asyncio.Semaphore(workers)
    async with async_playwright() as playwright:
        launch_options: dict[str, Any] = {
            "headless": True,
            "ignore_default_args": ["--enable-automation", "--hide-scrollbars"],
            "args": [
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--disable-features=IsolateOrigins,site-per-process",
                "--disable-site-isolation-trials",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        }
        if browser_executable:
            launch_options["executable_path"] = browser_executable
        if proxy_server:
            launch_options["proxy"] = {"server": proxy_server}
        browser = await playwright.chromium.launch(**launch_options)
        try:
            async def guarded(article: Article) -> ArticleCapture:
                async with semaphore:
                    return await _capture_one_browser(
                        browser,
                        article,
                        timeout_seconds=timeout_seconds,
                        maximum_response_bytes=maximum_response_bytes,
                        maximum_page_bytes=maximum_page_bytes,
                        proxy_server=proxy_server,
                        browser_executable=browser_executable,
                        retries=retries,
                    )

            return list(await asyncio.gather(*(guarded(article) for article in values)))
        finally:
            await browser.close()


def _feed_exchange(raw_feed: RawFeed) -> HttpExchange:
    url = raw_feed.url or f"https://archive.invalid/feeds/{raw_feed.source_id}"
    headers = raw_feed.response_headers or (("Content-Type", raw_feed.content_type or "application/xml"),)
    return HttpExchange(
        source_id=raw_feed.source_id,
        article_id=None,
        canonical_url=url,
        title=f"{raw_feed.source_id} feed",
        captured_at=raw_feed.fetched_at,
        request_url=url,
        request_headers=_safe_request_headers(raw_feed.request_headers),
        status_code=raw_feed.status_code,
        reason_phrase=raw_feed.reason_phrase,
        response_headers=_normalized_response_headers(headers, len(raw_feed.body), False),
        body=raw_feed.body,
    )


def _warc_date(value: str) -> str:
    parsed = _parse_datetime(value) or datetime.now(timezone.utc)
    return parsed.isoformat(timespec="seconds").replace("+00:00", "Z")


def _cdx_timestamp(value: str) -> str:
    parsed = _parse_datetime(value) or datetime.now(timezone.utc)
    return parsed.strftime("%Y%m%d%H%M%S")


def _request_target(url: str) -> str:
    parsed = urlsplit(url)
    target = parsed.path or "/"
    return f"{target}?{parsed.query}" if parsed.query else target


def _surt(url: str) -> str:
    parsed = urlsplit(url)
    host = (parsed.hostname or "archive.invalid").casefold().strip(".")
    host_parts = list(reversed([part for part in host.split(".") if part]))
    port = f":{parsed.port}" if parsed.port else ""
    path = parsed.path or "/"
    query = f"?{parsed.query}" if parsed.query else ""
    return f"{','.join(host_parts)}{port}){path}{query}"


def _sha1_digest(body: bytes) -> str:
    value = base64.b32encode(hashlib.sha1(body).digest()).decode("ascii").rstrip("=")
    return f"sha1:{value}"


def _write_warc(exchanges: Iterable[HttpExchange], filename: str) -> tuple[bytes, list[dict[str, Any]]]:
    stream = BytesIO()
    writer = WARCWriter(stream, gzip=True, warc_version="WARC/1.1")
    writer.write_record(writer.create_warcinfo_record(filename, {
        "software": "JOJO Times Offline Pipeline",
        "format": "WARC File Format 1.1",
        "conformsTo": "https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/",
    }))
    index_rows: list[dict[str, Any]] = []
    for exchange in exchanges:
        response_headers = StatusAndHeaders(
            f"{exchange.status_code} {exchange.reason_phrase}".strip(),
            list(exchange.response_headers),
            protocol="HTTP/1.1",
        )
        response_record = writer.create_warc_record(
            exchange.request_url,
            "response",
            payload=BytesIO(exchange.body),
            http_headers=response_headers,
            warc_headers_dict={
                "WARC-Date": _warc_date(exchange.captured_at),
                "WARC-Record-ID": f"<urn:uuid:{uuid4()}>",
            },
        )
        offset = stream.tell()
        writer.write_record(response_record)
        length = stream.tell() - offset
        response_id = response_record.rec_headers.get_header("WARC-Record-ID")

        request_headers = StatusAndHeaders(
            f"{exchange.request_method} {_request_target(exchange.request_url)} HTTP/1.1",
            list(exchange.request_headers),
            protocol="",
            is_http_request=True,
        )
        request_record = writer.create_warc_record(
            exchange.request_url,
            "request",
            payload=BytesIO(),
            http_headers=request_headers,
            warc_headers_dict={
                "WARC-Date": _warc_date(exchange.captured_at),
                "WARC-Concurrent-To": response_id,
                "WARC-Record-ID": f"<urn:uuid:{uuid4()}>",
            },
        )
        writer.write_record(request_record)
        content_type = next(
            (value.split(";", 1)[0].strip() for name, value in exchange.response_headers if name.casefold() == "content-type"),
            "application/octet-stream",
        )
        index_rows.append({
            "key": _surt(exchange.request_url),
            "timestamp": _cdx_timestamp(exchange.captured_at),
            "url": exchange.request_url,
            "mime": content_type,
            "status": exchange.status_code,
            "digest": _sha1_digest(exchange.body),
            "length": length,
            "offset": offset,
            "filename": filename,
        })
    return stream.getvalue(), index_rows


def _resource(path: str, body: bytes) -> dict[str, Any]:
    return {
        "name": path.rsplit("/", 1)[-1],
        "path": path,
        "hash": f"sha256:{hashlib.sha256(body).hexdigest()}",
        "bytes": len(body),
    }


def _wacz_bytes(
    exchanges: list[HttpExchange],
    captures: Iterable[ArticleCapture],
    *,
    run_id: str,
    generated_at: datetime,
) -> tuple[bytes, dict[str, Any]]:
    warc_name = "data.warc.gz"
    warc, index_rows = _write_warc(exchanges, warc_name)
    cdx = b"".join(
        f"{row.pop('key')} {row.pop('timestamp')} ".encode("utf-8") + _json_bytes(row)
        for row in sorted(index_rows, key=lambda row: (row["key"], row["timestamp"], row["offset"]))
    )
    cdx_gzip = gzip.compress(cdx, compresslevel=9, mtime=0)
    page_lines = [_json_bytes({"format": "json-pages-1.0", "id": "pages", "title": "JOJO Times Web Archive"})]
    page_count = 0
    for capture in captures:
        final = capture.final_exchange
        if final is None:
            continue
        page_lines.append(_json_bytes({
            "id": capture.article_id,
            "url": final.request_url,
            "ts": _warc_date(final.captured_at),
            "title": capture.title,
            "source": capture.source_id,
            "httpStatus": final.status_code,
        }))
        page_count += 1
    pages = b"".join(page_lines)
    resources = {
        "archive/data.warc.gz": warc,
        "indexes/index.cdx.gz": cdx_gzip,
        "pages/pages.jsonl": pages,
    }
    datapackage = _json_bytes({
        "profile": "wacz",
        "title": "JOJO Times Web Archive",
        "created": generated_at.astimezone(timezone.utc).isoformat(),
        "software": "JOJO Times Offline Pipeline",
        "resources": [_resource(path, body) for path, body in resources.items()],
    })
    resources["datapackage.json"] = datapackage
    resources["datapackage-digest.json"] = _json_bytes({
        "path": "datapackage.json",
        "hash": f"sha256:{hashlib.sha256(datapackage).hexdigest()}",
    })
    output = BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for path, body in resources.items():
            archive.writestr(path, body)
    return output.getvalue(), {
        "responses": len(exchanges),
        "pages": page_count,
        "warcBytes": len(warc),
        "waczBytes": output.tell(),
    }


def write_web_archive(
    raw_root: Path,
    *,
    raw_feeds: Iterable[RawFeed],
    captures: list[ArticleCapture],
    articles: Iterable[Article],
    previous_state: dict[str, Any],
    source_statuses: list[dict[str, Any]],
    generated_at: datetime,
    run_id: str,
) -> dict[str, Any]:
    relative_run_root = Path("web-archives") / "times" / generated_at.strftime("%Y/%m/%d") / run_id
    run_root = raw_root / relative_run_root
    run_root.mkdir(parents=True, exist_ok=True)
    exchanges = [_feed_exchange(raw_feed) for raw_feed in raw_feeds]
    exchanges.extend(exchange for capture in captures for exchange in capture.exchanges)
    wacz_name = f"times-{run_id}.wacz"
    wacz, metrics = _wacz_bytes(exchanges, captures, run_id=run_id, generated_at=generated_at)
    (run_root / wacz_name).write_bytes(wacz)
    wacz_object = (Path("raw") / relative_run_root / wacz_name).as_posix()

    article_values = {article.id: article for article in articles}
    previous_rows = previous_state.get("articles", {}) if isinstance(previous_state, dict) else {}
    state_rows = dict(previous_rows) if isinstance(previous_rows, dict) else {}
    for capture in captures:
        final = capture.final_exchange
        article = article_values.get(capture.article_id)
        normalized = article.normalized if article is not None else None
        quality = normalized.get("quality", {}) if isinstance(normalized, dict) else {}
        state_rows[capture.article_id] = {
            "sourceId": capture.source_id,
            "url": capture.canonical_url,
            "fingerprint": _article_fingerprint(article) if article is not None else None,
            "lastAttempt": generated_at.astimezone(timezone.utc).isoformat(),
            "capturedAt": final.captured_at if final is not None else None,
            "httpStatus": final.status_code if final is not None else None,
            "responseCount": len(capture.exchanges),
            "error": capture.error,
            "waczObject": wacz_object,
            "parserStatus": quality.get("status") if isinstance(quality, dict) else None,
        }
    state = {
        "formatVersion": ARCHIVE_STATE_VERSION,
        "updatedAt": generated_at.astimezone(timezone.utc).isoformat(),
        "articles": state_rows,
    }
    state_path = raw_root / "web-archives" / "times" / "state.json.gz"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_bytes(gzip.compress(_json_bytes(state), compresslevel=9, mtime=0))

    run_value = {
        "formatVersion": ARCHIVE_RUN_VERSION,
        "runId": run_id,
        "generatedAt": generated_at.astimezone(timezone.utc).isoformat(),
        "waczObject": wacz_object,
        "sources": source_statuses,
        "feedResponses": len(list(raw_feeds)),
        "articleAttempts": len(captures),
        "articleFailures": sum(capture.error is not None or capture.final_exchange is None for capture in captures),
        **metrics,
    }
    (run_root / "run.json").write_bytes(_json_bytes(run_value))
    return run_value
