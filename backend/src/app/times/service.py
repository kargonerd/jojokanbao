from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import html
import re
from time import monotonic
from typing import Iterable
import xml.etree.ElementTree as ET

import httpx

from ..core.config import Settings
from ..core.errors import ApiError, ConfigurationError


USER_AGENT = "JOJO-Times/1.0 (+https://jojokanbao.cn)"
TAG_RE = re.compile(r"<[^>]+>")
TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9-]{2,}|[\u4e00-\u9fff]{2,6}")
CACHE_SECONDS = 300
FEED_ITEM_LIMIT = 80


@dataclass(frozen=True, slots=True)
class Publisher:
    key: str
    name: str
    path: str


PUBLISHERS = (
    Publisher("bloomberg", "Bloomberg", "/bloomberg/markets"),
    Publisher("ap", "Associated Press", "/apnews/mobile"),
    Publisher("bbc", "BBC News", "/bbc"),
    Publisher("aljazeera", "Al Jazeera", "/aljazeera/english/news"),
    Publisher("npr", "NPR", "/npr/1001"),
    Publisher("dw", "DW", "/dw/rss/rss-en-all"),
    Publisher("cnbc", "CNBC", "/cnbc/rss"),
    Publisher("washingtonpost", "The Washington Post", "/washingtonpost/app/world"),
    Publisher("cbc", "CBC News", "/cbc/topics"),
    Publisher("rfi", "RFI", "/rfi"),
    Publisher("nikkei_asia", "Nikkei Asia", "/nikkei/asia"),
    Publisher("korea_herald", "The Korea Herald", "/koreaherald"),
    Publisher("cna", "中央通讯社", "/cna/aall"),
    Publisher("tass", "TASS", "/tass/world"),
    Publisher("people", "人民网", "/people"),
    Publisher("nyt", "The New York Times", "/nytimes/rss/HomePage"),
    Publisher("wsj", "The Wall Street Journal", "/wsj/en-us"),
    Publisher("reuters", "Reuters", "/reuters/world"),
    Publisher("zaobao", "联合早报", "/zaobao/realtime"),
    Publisher("caixin", "财新", "/caixin/latest"),
)


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
            "source": {"name": publisher.name},
        })
    return items


class TimesFeedService:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._settings = settings
        self._transport = transport
        self._cache: list[dict] = []
        self._cache_until = 0.0
        self._lock = asyncio.Lock()

    async def _fetch_publisher(self, client: httpx.AsyncClient, publisher: Publisher) -> list[dict] | None:
        try:
            response = await client.get(
                f"{self._settings.rsshub_url}{publisher.path}",
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
                feeds = await asyncio.gather(*(self._fetch_publisher(client, publisher) for publisher in PUBLISHERS))
            if not any(feed is not None for feed in feeds):
                raise ApiError(502, "rsshub_unavailable", "时事内容源暂时不可用")
            unique = {item["id"]: item for feed in feeds if feed for item in feed}
            self._cache = sorted(unique.values(), key=lambda item: item["publishedAt"], reverse=True)
            self._cache_until = monotonic() + CACHE_SECONDS
            return self._cache

    async def list_news(self, limit: int) -> list[dict]:
        return (await self.all_news())[:limit]

    async def get_news(self, news_id: str) -> dict | None:
        return next((item for item in await self.all_news() if item["id"] == news_id), None)

    async def stats(self) -> dict:
        news = await self.all_news()
        return {"total": len(news), "sourceCount": len({item["source"]["name"] for item in news})}

    async def digest(self, limit: int) -> dict:
        news = (await self.all_news())[:limit]
        sources = Counter(item["source"]["name"] for item in news)
        tokens = Counter(
            token.lower()
            for item in news
            for token in TOKEN_RE.findall(item["title"])
            if token.lower() not in {"the", "and", "news", "with", "from", "that", "this"}
        )
        return {
            "articleCount": len(news),
            "hotKeywords": [{"name": name, "weight": count} for name, count in tokens.most_common(12)],
            "attentionLanes": [],
            "starterQuestions": [
                "今天哪些事件被不同来源同时关注？",
                "哪些报道需要回到原始来源继续核对？",
            ] if news else [],
            "sourceCounts": [{"name": name, "count": count} for name, count in sources.most_common()],
        }
