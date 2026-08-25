from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path

import httpx

from times_pipeline.feeds import Source, collect_sources, load_sources, parse_feed


RSS = b"""<?xml version='1.0' encoding='UTF-8'?>
<rss version='2.0' xmlns:content='http://purl.org/rss/1.0/modules/content/'>
  <channel><item><title>Headline</title><link>https://news.example.test/story</link>
  <pubDate>Sat, 22 Aug 2026 10:00:00 GMT</pubDate>
  <content:encoded><![CDATA[<p>First paragraph.</p><p>Second paragraph.</p>]]></content:encoded>
  </item></channel>
</rss>"""


def source(content_policy: str = "summary-only") -> Source:
    return Source("example", "Example", "en", "https://publisher.example.test/feed", content_policy)


def test_parse_feed_keeps_summary_only_until_full_text_is_explicitly_licensed() -> None:
    article = parse_feed(RSS, source())[0]

    assert article.summary == "First paragraph.\n\nSecond paragraph."
    assert article.body == article.summary
    assert article.content_status == "summary"

    licensed = parse_feed(RSS, source("feed-body"))[0]
    assert licensed.body == "First paragraph.\n\nSecond paragraph."
    assert licensed.content_status == "full"


def test_parse_feed_skips_items_without_a_publisher_timestamp() -> None:
    undated = RSS.replace(
        b"<pubDate>Sat, 22 Aug 2026 10:00:00 GMT</pubDate>",
        b"",
    )

    assert parse_feed(undated, source()) == []


def test_load_sources_validates_content_policy(tmp_path: Path) -> None:
    config = tmp_path / "sources.json"
    config.write_text(json.dumps({
        "version": 1,
        "sources": [{
            "id": "example",
            "name": "Example",
            "language": "en",
            "feedUrl": "https://publisher.example.test/feed",
            "contentPolicy": "summary-only",
            "enabled": True,
        }],
    }), encoding="utf-8")

    assert load_sources(config) == (source(),)


def test_load_sources_accepts_multiple_public_feeds(tmp_path: Path) -> None:
    config = tmp_path / "sources.json"
    config.write_text(json.dumps({
        "version": 1,
        "sources": [{
            "id": "example",
            "name": "Example",
            "language": "en",
            "feedUrls": [
                "https://publisher.example.test/latest.xml",
                "https://publisher.example.test/world.xml",
            ],
        }],
    }), encoding="utf-8")

    loaded = load_sources(config)[0]
    assert loaded.feed_url == "https://publisher.example.test/latest.xml"
    assert loaded.feed_urls == (
        "https://publisher.example.test/latest.xml",
        "https://publisher.example.test/world.xml",
    )


def test_collect_sources_filters_to_requested_time_window() -> None:
    recent_rss = RSS.replace(
        b"</channel>",
        b"<item><title>Recent</title><link>https://news.example.test/recent</link>"
        b"<pubDate>Sat, 22 Aug 2026 11:30:00 GMT</pubDate><description>Recent body.</description>"
        b"</item></channel>",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=recent_rss, headers={"Content-Type": "application/rss+xml"})

    articles, _raw_feeds, statuses = asyncio.run(collect_sources(
        (source(),),
        now=datetime(2026, 8, 22, 12, tzinfo=timezone.utc),
        since=datetime(2026, 8, 22, 11, tzinfo=timezone.utc),
        transport=httpx.MockTransport(handler),
    ))

    assert [article.title for article in articles] == ["Recent"]
    assert statuses[0]["feedItems"] == 2
    assert statuses[0]["items"] == 1


def test_collect_sources_retries_transient_feed_failure() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(503, content=b"temporarily unavailable")
        return httpx.Response(200, content=RSS, headers={"Content-Type": "application/rss+xml"})

    articles, raw_feeds, statuses = asyncio.run(collect_sources(
        (Source("example", "Example", "en", "https://publisher.example.test/feed", "summary-only"),),
        now=datetime(2026, 8, 22, tzinfo=timezone.utc),
        transport=httpx.MockTransport(handler),
    ))

    assert len(articles) == 1
    assert len(raw_feeds) == 1
    assert statuses[0]["status"] == "ok"
    assert statuses[0]["attempts"] == 2
