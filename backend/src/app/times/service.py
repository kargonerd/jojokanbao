from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import html
import json
from pathlib import Path
import re
from time import monotonic
from typing import Iterable
import xml.etree.ElementTree as ET

import httpx

from ..core.config import Settings
from ..core.errors import ApiError, ConfigurationError


USER_AGENT = "JOJO-Times/1.0 (+https://jojokanbao.cn)"
TAG_RE = re.compile(r"<[^>]+>")
CACHE_SECONDS = 300
# Match the scheduled coverage probe so reader requests reuse its RSSHub cache.
FEED_ITEM_LIMIT = 500


@dataclass(frozen=True, slots=True)
class Publisher:
    id: str
    name: str
    route: str
    language: str


SOURCES_CONFIG = Path(__file__).with_name("sources.json")


def load_publishers(config_path: Path = SOURCES_CONFIG) -> tuple[Publisher, ...]:
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Unable to read Times sources from {config_path}") from error
    if not isinstance(config, dict) or config.get("version") != 1:
        raise ValueError("Times sources must use config version 1")
    sources = config.get("sources")
    if not isinstance(sources, list):
        raise ValueError("Times sources config must contain a sources array")

    publishers: list[Publisher] = []
    seen_ids: set[str] = set()
    for position, source in enumerate(sources):
        if not isinstance(source, dict):
            raise ValueError(f"Times source at index {position} must be an object")
        enabled = source.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError(f"Times source at index {position} has an invalid enabled value")
        if not enabled:
            continue
        values = {field: source.get(field) for field in ("id", "name", "route", "language")}
        if any(not isinstance(value, str) or not value.strip() for value in values.values()):
            raise ValueError(f"Times source at index {position} is missing a required string field")
        source_id = values["id"].strip()
        route = values["route"].strip()
        if source_id in seen_ids:
            raise ValueError(f"Duplicate Times source id: {source_id}")
        if not route.startswith("/"):
            raise ValueError(f"Times source route must start with '/': {source_id}")
        seen_ids.add(source_id)
        publishers.append(Publisher(
            source_id,
            values["name"].strip(),
            route,
            values["language"].strip(),
        ))
    if not publishers:
        raise ValueError("Times sources config must enable at least one source")
    return tuple(publishers)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _element_text(node: ET.Element) -> str | None:
    value = "".join(node.itertext()).strip()
    return value or None


def _child_text(node: ET.Element, names: Iterable[str]) -> str | None:
    wanted = {name.lower() for name in names}
    for child in node:
        if _local_name(child.tag) in wanted:
            value = _element_text(child)
            if value:
                return value
    return None


def _entry_link(node: ET.Element) -> str | None:
    for child in node:
        if _local_name(child.tag) != "link":
            continue
        return child.get("href") or _element_text(child)
    return None


def _published_at(value: str | None) -> str:
    if value:
        try:
            parsed = parsedate_to_datetime(value)
        except (TypeError, ValueError, OverflowError):
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                parsed = None
        if parsed is not None:
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).isoformat()
    return datetime.now(timezone.utc).isoformat()


def _plain_text(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", html.unescape(TAG_RE.sub(" ", value))).strip()


def parse_feed(body: bytes, publisher: Publisher) -> list[dict]:
    root = ET.fromstring(body)
    root_name = _local_name(root.tag)
    if root_name not in {"rss", "rdf", "feed"}:
        raise ValueError("RSSHub returned an unsupported feed")
    entry_name = "entry" if root_name == "feed" else "item"
    items: list[dict] = []
    for node in root.iter():
        if _local_name(node.tag) != entry_name:
            continue
        title = _child_text(node, ("title",))
        url = _entry_link(node)
        if not title or not url:
            continue
        description = _plain_text(_child_text(node, ("description", "summary", "content", "encoded")))
        items.append({
            "id": hashlib.sha1(url.encode("utf-8")).hexdigest(),
            "title": _plain_text(title),
            "summary": description[:500] or None,
            "content": description[:20_000] or None,
            "url": url,
            "publishedAt": _published_at(_child_text(node, ("pubdate", "date", "published", "updated"))),
            "source": {"id": publisher.id, "name": publisher.name, "language": publisher.language},
        })
    return items


class TimesFeedService:
    def __init__(
        self,
        settings: Settings,
        transport: httpx.AsyncBaseTransport | None = None,
        publishers: tuple[Publisher, ...] | None = None,
    ) -> None:
        self._settings = settings
        self._transport = transport
        self._publishers = publishers if publishers is not None else load_publishers()
        self._cache: list[dict] = []
        self._cache_until = 0.0
        self._lock = asyncio.Lock()

    async def _fetch_publisher(self, client: httpx.AsyncClient, publisher: Publisher) -> list[dict] | None:
        try:
            response = await client.get(
                f"{self._settings.rsshub_url}{publisher.route}",
                params={"limit": FEED_ITEM_LIMIT, "key": self._settings.rsshub_access_key},
            )
            response.raise_for_status()
            return parse_feed(response.content, publisher)
        except (httpx.HTTPError, ET.ParseError, ValueError):
            return None

    async def all_news(self) -> list[dict]:
        if not self._settings.rsshub_access_key:
            raise ConfigurationError("时事内容源尚未配置")
        if self._cache_until > monotonic():
            return self._cache
        async with self._lock:
            if self._cache_until > monotonic():
                return self._cache
            async with httpx.AsyncClient(
                timeout=self._settings.rsshub_timeout_seconds,
                follow_redirects=True,
                transport=self._transport,
                headers={"Accept": "application/rss+xml, application/atom+xml, application/xml", "User-Agent": USER_AGENT},
            ) as client:
                tasks = [asyncio.create_task(self._fetch_publisher(client, publisher)) for publisher in self._publishers]
                done, pending = await asyncio.wait(tasks, timeout=self._settings.rsshub_timeout_seconds)
                for task in pending:
                    task.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
                feeds = [task.result() for task in done if not task.cancelled() and task.exception() is None]
            if not any(feed is not None for feed in feeds):
                if self._cache:
                    self._cache_until = monotonic() + 60
                    return self._cache
                raise ApiError(502, "rsshub_unavailable", "时事内容源暂时不可用")
            unique = {item["id"]: item for feed in feeds if feed for item in feed}
            self._cache = sorted(unique.values(), key=lambda item: item["publishedAt"], reverse=True)
            self._cache_until = monotonic() + CACHE_SECONDS
            return self._cache

    async def list_news(self, limit: int) -> list[dict]:
        news = await self.all_news()
        by_source: dict[str, list[dict]] = {}
        for item in news:
            by_source.setdefault(item["source"]["name"], []).append(item)
        if not by_source:
            return []

        quota = max(1, limit // len(by_source))
        selected: list[dict] = []
        remaining: list[dict] = []
        for source_items in by_source.values():
            selected.extend(source_items[:quota])
            remaining.extend(source_items[quota:])
        remaining.sort(key=lambda item: item["publishedAt"], reverse=True)
        selected.extend(remaining[: max(0, limit - len(selected))])
        return sorted(selected, key=lambda item: item["publishedAt"], reverse=True)[:limit]

    async def get_news(self, news_id: str) -> dict | None:
        return next((item for item in await self.all_news() if item["id"] == news_id), None)
