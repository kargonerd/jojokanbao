from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from jojo_jiuwen_api.rss import fetch_all_sources  # noqa: E402
from jojo_jiuwen_api.settings import get_settings  # noqa: E402
from jojo_jiuwen_api.store import Store  # noqa: E402


DEFAULT_SOURCES = [
    ("Google News Top Stories", "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en"),
    ("Google News World", "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en"),
    ("Google News US", "https://news.google.com/rss/headlines/section/topic/NATION?hl=en-US&gl=US&ceid=US:en"),
    ("Google News Business", "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en"),
    ("Google News Technology", "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en"),
    ("Google News Science", "https://news.google.com/rss/headlines/section/topic/SCIENCE?hl=en-US&gl=US&ceid=US:en"),
    ("Google News Health", "https://news.google.com/rss/headlines/section/topic/HEALTH?hl=en-US&gl=US&ceid=US:en"),
    ("BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    ("BBC Technology", "https://feeds.bbci.co.uk/news/technology/rss.xml"),
    ("BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    ("NPR News", "https://feeds.npr.org/1001/rss.xml"),
    ("NPR World", "https://feeds.npr.org/1004/rss.xml"),
    ("New York Times World", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"),
    ("New York Times Business", "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml"),
    ("The Guardian World", "https://www.theguardian.com/world/rss"),
    ("The Guardian Technology", "https://www.theguardian.com/technology/rss"),
    ("TechCrunch", "https://techcrunch.com/feed/"),
    ("The Verge", "https://www.theverge.com/rss/index.xml"),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch at least 100 real RSS news items for JOJO Jiuwen.")
    parser.add_argument("--target", type=int, default=100, help="Minimum article count required after fetch.")
    parser.add_argument("--db-path", type=Path, default=None, help="SQLite DB path. Defaults to JIUWEN_DB_PATH.")
    return parser.parse_args()


def ensure_sources(store: Store) -> int:
    existing_urls = {source["rssUrl"] for source in store.list_sources()}
    created = 0
    for name, rss_url in DEFAULT_SOURCES:
        if rss_url in existing_urls:
            continue
        store.create_source(name, rss_url)
        existing_urls.add(rss_url)
        created += 1
    return created


async def main() -> int:
    args = parse_args()
    db_path = args.db_path or get_settings().db_path
    store = Store(db_path)
    created_sources = ensure_sources(store)
    fetch_results = await fetch_all_sources(store)
    articles = store.list_news(limit=max(args.target, 500))
    report = {
        "target": args.target,
        "articleCount": len(articles),
        "createdSources": created_sources,
        "sourceCount": len(store.list_sources()),
        "fetchResults": fetch_results,
        "sample": [
            {
                "id": item["id"],
                "title": item["title"],
                "source": (item.get("source") or {}).get("name"),
                "url": item.get("url"),
            }
            for item in articles[:10]
        ],
    }
    output_path = db_path.parent / "last_fetch_report.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if len(articles) < args.target:
        print(f"Expected at least {args.target} articles, got {len(articles)}.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
