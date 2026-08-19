from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import html
import re

import feedparser

from .store import Store


USER_AGENT = "JOJO-Times/0.1 (+https://jojokanbao.cn)"
TAG_RE = re.compile(r"<[^>]+>")


def parse_date(value: str | None) -> str:
    if not value:
        return datetime.now(timezone.utc).isoformat()
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat()
    except Exception:
        return datetime.now(timezone.utc).isoformat()


def stable_id(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()


def clean_feed_text(value: str | None) -> str:
    if not value:
        return ""
    text = TAG_RE.sub(" ", value)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


async def fetch_all_sources(store: Store) -> list[dict]:
    results: list[dict] = []
    for source in store.list_sources():
        count = await fetch_source(store, source)
        results.append({"sourceId": source["id"], "count": count})
    return results


async def fetch_source(store: Store, source: dict) -> int:
    feed = feedparser.parse(source["rssUrl"], request_headers={"User-Agent": USER_AGENT})
    created = 0
    for entry in feed.entries:
        link = entry.get("link")
        title = entry.get("title")
        if not link or not title:
            continue
        summary = clean_feed_text(entry.get("summary") or entry.get("description"))
        content = summary
        if entry.get("content"):
            content = clean_feed_text(entry["content"][0].get("value") or summary)
        if store.upsert_news(
            {
                "id": stable_id(link),
                "title": title,
                "summary": summary,
                "content": content or title,
                "url": link,
                "publishedAt": parse_date(entry.get("published") or entry.get("updated")),
                "sourceId": source["id"],
            }
        ):
            created += 1
    store.mark_source_fetched(source["id"])
    return created
