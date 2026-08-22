from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
import hashlib
import json
from pathlib import Path
import re
from typing import Iterable
from urllib.parse import urlsplit
from urllib.parse import parse_qsl, urlencode, urlunsplit
import xml.etree.ElementTree as ET

import httpx


USER_AGENT = "JOJO-Times-Offline/1.0 (+https://jojokanbao.cn)"
FEED_ITEM_LIMIT = 500
CONTENT_POLICIES = frozenset({"summary-only", "feed-body"})
TRANSIENT_FEED_STATUSES = frozenset({429, 500, 502, 503, 504})
FEED_RETRY_DELAYS_SECONDS = (1.0, 3.0)


@dataclass(frozen=True, slots=True)
class Source:
    id: str
    name: str
    language: str
    route: str | None
    feed_url: str | None
    content_policy: str
    parser_id: str | None = None
    archive_pages: bool = True
    feed_urls: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Article:
    id: str
    title: str
    summary: str | None
    body: str
    content_status: str
    url: str
    published_at: str
    source: Source
    translations: dict[str, dict] = field(default_factory=dict)
    normalized: dict | None = None


@dataclass(frozen=True, slots=True)
class RawFeed:
    source_id: str
    body: bytes
    fetched_at: str
    content_type: str | None
    url: str = ""
    status_code: int = 200
    reason_phrase: str = "OK"
    request_headers: tuple[tuple[str, str], ...] = ()
    response_headers: tuple[tuple[str, str], ...] = ()


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"script", "style"}:
            self._ignored_depth += 1
        elif tag.lower() in {"br", "p", "div", "li", "blockquote", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style"} and self._ignored_depth:
            self._ignored_depth -= 1
        elif tag.lower() in {"p", "div", "li", "blockquote", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._ignored_depth:
            self.parts.append(data)


def plain_text(value: str | None) -> str:
    if not value:
        return ""
    parser = _TextExtractor()
    parser.feed(value)
    text = "".join(parser.parts)
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    return "\n\n".join(line for line in lines if line)


def load_sources(config_path: Path) -> tuple[Source, ...]:
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Unable to read Times sources from {config_path}") from error
    if not isinstance(config, dict) or config.get("version") != 1:
        raise ValueError("Times sources must use config version 1")
    rows = config.get("sources")
    if not isinstance(rows, list):
        raise ValueError("Times sources config must contain a sources array")

    sources: list[Source] = []
    seen_ids: set[str] = set()
    for position, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"Times source at index {position} must be an object")
        enabled = row.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError(f"Times source at index {position} has an invalid enabled value")
        if not enabled:
            continue
        required = {key: row.get(key) for key in ("id", "name", "language")}
        if any(not isinstance(value, str) or not value.strip() for value in required.values()):
            raise ValueError(f"Times source at index {position} is missing a required string field")
        source_id = str(required["id"]).strip()
        if source_id in seen_ids:
            raise ValueError(f"Duplicate Times source id: {source_id}")
        route_value = row.get("route")
        feed_url_value = row.get("feedUrl")
        feed_urls_value = row.get("feedUrls")
        route = route_value.strip() if isinstance(route_value, str) and route_value.strip() else None
        feed_url = feed_url_value.strip() if isinstance(feed_url_value, str) and feed_url_value.strip() else None
        if feed_url is not None and feed_urls_value is not None:
            raise ValueError(f"Times source cannot define both feedUrl and feedUrls: {source_id}")
        feed_urls: tuple[str, ...] = ()
        if feed_urls_value is not None:
            if not isinstance(feed_urls_value, list) or not feed_urls_value:
                raise ValueError(f"Times source feedUrls must be a non-empty array: {source_id}")
            if any(not isinstance(value, str) or not value.strip() for value in feed_urls_value):
                raise ValueError(f"Times source feedUrls must contain strings: {source_id}")
            feed_urls = tuple(dict.fromkeys(value.strip() for value in feed_urls_value))
            feed_url = feed_urls[0]
        if (route is None) == (feed_url is None):
            raise ValueError(f"Times source must define exactly one of route or feedUrl: {source_id}")
        if route is not None and not route.startswith("/"):
            raise ValueError(f"Times source route must start with '/': {source_id}")
        for configured_url in feed_urls or ((feed_url,) if feed_url is not None else ()):
            parsed = urlsplit(configured_url)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError(f"Times source feedUrl must be a credential-free HTTPS URL: {source_id}")
        content_policy = row.get("contentPolicy", "summary-only")
        if content_policy not in CONTENT_POLICIES:
            raise ValueError(f"Unsupported contentPolicy for Times source {source_id}: {content_policy}")
        parser_id_value = row.get("parserId")
        parser_id = parser_id_value.strip() if isinstance(parser_id_value, str) and parser_id_value.strip() else None
        archive_pages = row.get("archivePages", True)
        if not isinstance(archive_pages, bool):
            raise ValueError(f"Times source {source_id} has an invalid archivePages value")
        seen_ids.add(source_id)
        sources.append(Source(
            id=source_id,
            name=str(required["name"]).strip(),
            language=str(required["language"]).strip(),
            route=route,
            feed_url=feed_url,
            content_policy=content_policy,
            parser_id=parser_id,
            archive_pages=archive_pages,
            feed_urls=feed_urls,
        ))
    if not sources:
        raise ValueError("Times sources config must enable at least one source")
    return tuple(sources)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _element_value(node: ET.Element) -> str | None:
    value = "".join(node.itertext()).strip()
    return value or None


def _child_value(node: ET.Element, names: Iterable[str]) -> str | None:
    wanted = {name.lower() for name in names}
    for child in node:
        if _local_name(child.tag) in wanted:
            value = _element_value(child)
            if value:
                return value
    return None


def _entry_link(node: ET.Element) -> str | None:
    for child in node:
        if _local_name(child.tag) != "link":
            continue
        value = child.get("href") or _element_value(child)
        if value:
            return value.strip()
    return None


def _published_at(value: str | None) -> str | None:
    parsed: datetime | None = None
    if value:
        try:
            parsed = parsedate_to_datetime(value)
        except (TypeError, ValueError, OverflowError):
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                parsed = None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _article_id(source_id: str, url: str) -> str:
    digest = hashlib.sha256(f"{source_id}\0{url}".encode("utf-8")).hexdigest()[:24]
    return f"article-{digest}"


def _archive_safe_url(value: str) -> str:
    parsed = urlsplit(value)
    query = urlencode([
        (name, item)
        for name, item in parse_qsl(parsed.query, keep_blank_values=True)
        if name.casefold() not in {"key", "access_key", "token"}
    ])
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, ""))


def _archive_safe_headers(headers: httpx.Headers) -> tuple[tuple[str, str], ...]:
    excluded = {"authorization", "cookie", "proxy-authorization", "x-api-key"}
    return tuple(
        (name, value)
        for name, value in headers.multi_items()
        if name.casefold() not in excluded
    )


def parse_feed(body: bytes, source: Source) -> list[Article]:
    root = ET.fromstring(body)
    root_name = _local_name(root.tag)
    if root_name not in {"rss", "rdf", "feed"}:
        raise ValueError("News source returned an unsupported feed")
    entry_name = "entry" if root_name == "feed" else "item"
    articles: list[Article] = []
    seen_ids: set[str] = set()
    for node in root.iter():
        if _local_name(node.tag) != entry_name:
            continue
        title = plain_text(_child_value(node, ("title",)))
        url = _entry_link(node)
        if not title or not url:
            continue
        article_id = _article_id(source.id, url)
        if article_id in seen_ids:
            continue
        published_at = _published_at(
            _child_value(node, ("pubdate", "date", "published", "updated")),
        )
        if published_at is None:
            continue
        feed_body = plain_text(_child_value(node, ("encoded", "content", "description", "summary")))
        summary = feed_body[:500].strip() or None
        if source.content_policy == "feed-body" and feed_body:
            article_body = feed_body[:100_000]
            content_status = "full"
        else:
            article_body = summary or ""
            content_status = "summary"
        seen_ids.add(article_id)
        articles.append(Article(
            id=article_id,
            title=title[:1_000],
            summary=summary,
            body=article_body,
            content_status=content_status,
            url=url,
            published_at=published_at,
            source=source,
        ))
    return articles


async def collect_sources(
    sources: tuple[Source, ...],
    *,
    rsshub_url: str,
    rsshub_access_key: str | None,
    timeout_seconds: float = 60.0,
    rsshub_workers: int = 3,
    now: datetime | None = None,
    since: datetime | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[list[Article], list[RawFeed], list[dict]]:
    fetched_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    window_start = since.astimezone(timezone.utc) if since is not None else None
    if rsshub_workers < 1:
        raise ValueError("RSSHub worker count must be positive")
    if any(source.route is not None for source in sources) and not rsshub_access_key:
        raise RuntimeError("JOJOKANBAO_RSSHUB_ACCESS_KEY is required for configured RSSHub routes")
    articles: list[Article] = []
    raw_feeds: list[RawFeed] = []
    statuses: list[dict] = []
    rsshub_semaphore = asyncio.Semaphore(rsshub_workers)

    async with httpx.AsyncClient(
        timeout=timeout_seconds,
        follow_redirects=True,
        transport=transport,
        headers={
            "Accept": "application/rss+xml, application/atom+xml, application/xml",
            "User-Agent": USER_AGENT,
        },
    ) as client:
        async def collect(source: Source) -> tuple[list[Article], list[RawFeed], dict]:
            started = asyncio.get_running_loop().time()
            if source.route is not None:
                endpoints = ((f"{rsshub_url.rstrip('/')}{source.route}", {"limit": FEED_ITEM_LIMIT, "key": rsshub_access_key}),)
                transport_kind = "rsshub"
            else:
                assert source.feed_url is not None
                endpoints = tuple((url, None) for url in (source.feed_urls or (source.feed_url,)))
                transport_kind = "public-rss"

            async def fetch_endpoint(url: str, params: dict | None) -> tuple[list[Article], RawFeed | None, dict]:
                response = None
                attempts = 0
                try:
                    for attempts, retry_delay in enumerate((*FEED_RETRY_DELAYS_SECONDS, None), start=1):
                        if transport_kind == "rsshub":
                            async with rsshub_semaphore:
                                response = await client.get(url, params=params)
                        else:
                            response = await client.get(url, params=params)
                        if response.status_code not in TRANSIENT_FEED_STATUSES or retry_delay is None:
                            break
                        await asyncio.sleep(retry_delay)
                    assert response is not None
                    response.raise_for_status()
                    parsed = parse_feed(response.content, source)
                    return parsed, RawFeed(
                        source_id=source.id,
                        body=response.content,
                        fetched_at=fetched_at.isoformat(),
                        content_type=response.headers.get("content-type"),
                        url=_archive_safe_url(str(response.url)),
                        status_code=response.status_code,
                        reason_phrase=response.reason_phrase,
                        request_headers=_archive_safe_headers(response.request.headers),
                        response_headers=tuple(response.headers.multi_items()),
                    ), {"attempts": attempts, "feedBytes": len(response.content)}
                except (httpx.HTTPError, ET.ParseError, ValueError) as error:
                    status_code = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
                    return [], None, {
                        "url": _archive_safe_url(url),
                        "httpStatus": status_code,
                        "error": type(error).__name__,
                        "attempts": attempts,
                    }

            endpoint_results = await asyncio.gather(*(fetch_endpoint(url, params) for url, params in endpoints))
            successful = [(values, raw, detail) for values, raw, detail in endpoint_results if raw is not None]
            failures = [detail for _values, raw, detail in endpoint_results if raw is None]
            elapsed_ms = round((asyncio.get_running_loop().time() - started) * 1_000)
            if not successful:
                first_error = failures[0] if failures else {}
                elapsed_ms = round((asyncio.get_running_loop().time() - started) * 1_000)
                return [], [], {
                    "id": source.id,
                    "name": source.name,
                    "status": "error",
                    "transport": transport_kind,
                    "httpStatus": first_error.get("httpStatus"),
                    "error": first_error.get("error", "FeedError"),
                    "attempts": sum(int(detail.get("attempts", 0)) for detail in failures),
                    "feedResponses": 0,
                    "failedFeedResponses": len(failures),
                    "endpointErrors": failures,
                    "elapsedMs": elapsed_ms,
                }

            parsed_all = [article for values, _raw, _detail in successful for article in values]
            unique_articles = list({article.id: article for article in parsed_all}.values())
            published_values = [datetime.fromisoformat(article.published_at) for article in unique_articles]
            if window_start is not None:
                parsed_in_window = [
                    article
                    for article, published in zip(unique_articles, published_values, strict=True)
                    if published.astimezone(timezone.utc) >= window_start
                ]
            else:
                parsed_in_window = unique_articles
            return parsed_in_window, [raw for _values, raw, _detail in successful if raw is not None], {
                "id": source.id,
                "name": source.name,
                "status": "partial" if failures else "ok",
                "transport": transport_kind,
                "items": len(parsed_in_window),
                "feedItems": len(parsed_all),
                "uniqueFeedItems": len(unique_articles),
                "feedBytes": sum(int(detail.get("feedBytes", 0)) for _values, _raw, detail in successful),
                "feedResponses": len(successful),
                "failedFeedResponses": len(failures),
                "endpointErrors": failures,
                "oldestPublishedAt": min(published_values).isoformat() if published_values else None,
                "newestPublishedAt": max(published_values).isoformat() if published_values else None,
                "windowStart": window_start.isoformat() if window_start is not None else None,
                "attempts": sum(int(detail.get("attempts", 0)) for _values, _raw, detail in successful) + sum(int(detail.get("attempts", 0)) for detail in failures),
                "elapsedMs": elapsed_ms,
            }

        results = await asyncio.gather(*(collect(source) for source in sources))
    for source_articles, source_raw_feeds, status in results:
        articles.extend(source_articles)
        raw_feeds.extend(source_raw_feeds)
        statuses.append(status)
    if not articles:
        raise RuntimeError("No Times source returned usable articles")
    deduplicated = {article.id: article for article in articles}
    return list(deduplicated.values()), raw_feeds, statuses
