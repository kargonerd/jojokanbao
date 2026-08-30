from __future__ import annotations

from datetime import date
import gzip
import json
from pathlib import Path
import sqlite3

from jojo_olds_api.raw_archive_capture import manifest_item_from_row
from jojo_olds_api.reuters_sitemap_manifest import (
    discover_reuters_sitemap_captures,
    export_reuters_manifest,
    initialize_reuters_live_sitemaps,
    initialize_reuters_sitemap_schema,
    initialize_reuters_urlscan_queries,
    pending_reuters_live_sitemaps,
    pending_reuters_sitemaps,
    pending_reuters_urlscan_queries,
    process_reuters_live_sitemap,
    process_reuters_sitemap,
    process_reuters_urlscan_query,
)


CDX_RESPONSE = json.dumps(
    [
        [
            "timestamp",
            "original",
            "mimetype",
            "statuscode",
            "digest",
            "length",
        ],
        [
            "20230101031000",
            (
                "https://www.reuters.com/arc/outboundfeeds/sitemap/"
                "?outputType=xml&amp;from=100"
            ),
            "application/xml",
            "200",
            "DIGEST",
            "12345",
        ],
    ]
)

SITEMAP_XML = b"""<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.reuters.com/world/example-story-2022-12-31/</loc>
    <lastmod>2022-12-31T10:00:00Z</lastmod>
  </url>
  <url>
    <loc>https://www.reuters.com/graphics/example/</loc>
    <lastmod>2022-12-31T10:00:00Z</lastmod>
  </url>
</urlset>
"""

LIVE_INDEX_XML = b"""<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://www.reuters.com/arc/outboundfeeds/sitemap/?outputType=xml&amp;from=100</loc>
    <lastmod>2026-07-25T10:00:00Z</lastmod>
  </sitemap>
</sitemapindex>
"""

LIVE_SITEMAP_XML = b"""<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.reuters.com/world/live-story-2026-07-25/</loc>
    <lastmod>2026-07-25T10:00:00Z</lastmod>
  </url>
</urlset>
"""


class StubResponse:
    status_code = 200
    text = CDX_RESPONSE

    def raise_for_status(self):
        return None


class StubHTTPClient:
    def get(self, url, params):
        assert any(
            key == "filter" and value.startswith("original:")
            for key, value in params
        )
        return StubResponse()


class RetryableStubResponse:
    def __init__(self, status_code):
        self.status_code = status_code
        self.text = CDX_RESPONSE

    def raise_for_status(self):
        if self.status_code != 200:
            raise AssertionError("retryable status should be handled first")


class RetryableStubHTTPClient:
    def __init__(self):
        self.calls = 0

    def get(self, url, params):
        self.calls += 1
        return RetryableStubResponse(503 if self.calls == 1 else 200)


class StubArchiveClient:
    def fetch(self, url, *, maximum_bytes):
        assert "&from=100" in url
        assert len(SITEMAP_XML) < maximum_bytes
        return 200, {"content-type": "application/xml"}, SITEMAP_XML, url


class StubUrlscanResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "results": [
                {
                    "page": {
                        "url": (
                            "https://www.reuters.com/world/"
                            "urlscan-discovered-story-2024-01-03/"
                        )
                    },
                    "task": {"url": "https://example.com/redirect"},
                },
                {
                    "page": {"url": "https://www.reuters.com/"},
                    "task": {"url": "https://www.reuters.com/search/"},
                },
            ]
        }


class StubUrlscanClient:
    def get(self, url, params):
        assert url.endswith("/api/v1/search/")
        assert params["size"] == "100"
        assert "date:[2024-01-01 TO 2024-01-08]" in params["q"]
        return StubUrlscanResponse()


class StubLiveResponse:
    def __init__(self, content):
        self.content = content

    def raise_for_status(self):
        return None


class StubLiveClient:
    def get(self, url):
        if "sitemap-index" in url:
            return StubLiveResponse(LIVE_INDEX_XML)
        assert url.endswith("outputType=xml&from=100")
        return StubLiveResponse(LIVE_SITEMAP_XML)


def test_discovers_html_escaped_reuters_sitemap_urls():
    captures = discover_reuters_sitemap_captures(
        from_year=2021,
        to_year=2026,
        client=StubHTTPClient(),
    )

    assert captures == [
        {
            "timestamp": "20230101031000",
            "originalUrl": (
                "https://www.reuters.com/arc/outboundfeeds/sitemap/"
                "?outputType=xml&from=100"
            ),
            "digest": "DIGEST",
            "byteCount": 12345,
        }
    ]


def test_retries_transient_reuters_sitemap_cdx_failure():
    client = RetryableStubHTTPClient()

    captures = discover_reuters_sitemap_captures(
        from_year=2021,
        to_year=2026,
        attempts=2,
        retry_backoff_seconds=0,
        client=client,
    )

    assert client.calls == 2
    assert captures[0]["digest"] == "DIGEST"


def test_reuters_sitemap_capture_builds_article_manifest(tmp_path: Path):
    captures = discover_reuters_sitemap_captures(
        from_year=2021,
        to_year=2026,
        client=StubHTTPClient(),
    )
    connection = sqlite3.connect(":memory:")
    initialize_reuters_sitemap_schema(
        connection,
        from_year=2021,
        to_year=2026,
        captures=captures,
    )
    pending = pending_reuters_sitemaps(
        connection,
        maximum=10,
        maximum_attempts=3,
    )
    assert len(pending) == 1

    result = process_reuters_sitemap(
        connection,
        snapshot_url=pending[0][0],
        archive_client=StubArchiveClient(),
        from_year=2021,
        to_year=2026,
    )
    destination = tmp_path / "manifest.jsonl.gz"
    summary = export_reuters_manifest(
        connection,
        destination=destination,
        from_year=2021,
        to_year=2026,
        maximum_attempts=3,
    )

    assert result == {"status": "complete", "seen": 2, "accepted": 1}
    assert summary["complete"] is True
    assert summary["articles"] == 1
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    item = manifest_item_from_row(row, publisher="reuters")
    assert item.canonical_url == (
        "https://www.reuters.com/world/example-story-2022-12-31"
    )
    assert item.published_at == "2022-12-31T00:00:00+00:00"
    assert len(item.candidates) == 3


def test_urlscan_fills_historical_reuters_catalog_gaps(tmp_path: Path):
    connection = sqlite3.connect(":memory:")
    initialize_reuters_sitemap_schema(
        connection,
        from_year=2024,
        to_year=2024,
        captures=[],
    )
    added = initialize_reuters_urlscan_queries(
        connection,
        from_year=2024,
        to_year=2024,
        today=date(2025, 1, 1),
    )
    assert added == 53
    pending = pending_reuters_urlscan_queries(
        connection,
        maximum=1,
        maximum_attempts=3,
    )
    assert pending == [("2024-01-01", "2024-01-08")]

    result = process_reuters_urlscan_query(
        connection,
        window_start=pending[0][0],
        window_end=pending[0][1],
        http_client=StubUrlscanClient(),
        from_year=2024,
        to_year=2024,
    )
    connection.execute(
        "UPDATE reuters_urlscan_queries SET status='complete'"
    )
    destination = tmp_path / "urlscan-manifest.jsonl.gz"
    summary = export_reuters_manifest(
        connection,
        destination=destination,
        from_year=2024,
        to_year=2024,
        maximum_attempts=3,
    )

    assert result["status"] == "complete"
    assert result["accepted"] == 1
    assert summary["complete"] is True
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    assert row["canonicalUrl"].endswith(
        "/urlscan-discovered-story-2024-01-03"
    )
    assert row["candidates"][-1] == {
        "provider": "live-origin",
        "snapshotUrl": row["canonicalUrl"],
    }


def test_live_reuters_sitemap_fills_current_year_catalog(tmp_path: Path):
    connection = sqlite3.connect(":memory:")
    initialize_reuters_sitemap_schema(
        connection,
        from_year=2021,
        to_year=2026,
        captures=[],
    )
    client = StubLiveClient()
    added = initialize_reuters_live_sitemaps(
        connection,
        from_year=2021,
        to_year=2026,
        http_client=client,
        today=date(2026, 7, 25),
    )
    pending = pending_reuters_live_sitemaps(
        connection,
        maximum=10,
        maximum_attempts=3,
    )

    assert added == 1
    assert pending == [
        (
            "https://www.reuters.com/arc/outboundfeeds/sitemap/"
            "?outputType=xml&from=100"
        )
    ]
    result = process_reuters_live_sitemap(
        connection,
        sitemap_url=pending[0],
        http_client=client,
        from_year=2021,
        to_year=2026,
    )
    destination = tmp_path / "live-manifest.jsonl.gz"
    summary = export_reuters_manifest(
        connection,
        destination=destination,
        from_year=2021,
        to_year=2026,
        maximum_attempts=3,
    )

    assert result == {
        "status": "complete",
        "sitemapUrl": pending[0],
        "seen": 1,
        "accepted": 1,
    }
    assert summary["complete"] is True
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    assert row["canonicalUrl"].endswith("/live-story-2026-07-25")
    assert row["candidates"][-1] == {
        "provider": "live-origin",
        "snapshotUrl": row["canonicalUrl"],
    }


def test_urlscan_does_not_seed_years_with_catalog_buffer():
    connection = sqlite3.connect(":memory:")
    initialize_reuters_sitemap_schema(
        connection,
        from_year=2024,
        to_year=2024,
        captures=[],
    )
    connection.executemany(
        """
        INSERT INTO reuters_articles(
            canonical_url,
            published_at,
            source_snapshot_url,
            updated_at
        ) VALUES (?, '2024-01-01T00:00:00+00:00', 'test', 'test')
        """,
        (
            (f"https://www.reuters.com/world/test-{index}-2024-01-01",)
            for index in range(750)
        ),
    )

    added = initialize_reuters_urlscan_queries(
        connection,
        from_year=2024,
        to_year=2024,
        today=date(2025, 1, 1),
    )

    assert added == 0
    assert pending_reuters_urlscan_queries(
        connection,
        maximum=10,
        maximum_attempts=3,
    ) == []
