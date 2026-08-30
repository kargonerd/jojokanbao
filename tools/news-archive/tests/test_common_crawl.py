from __future__ import annotations

from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import time

import httpx
import pytest

from jojo_news_archive.bloomberg_archive_download import (
    ArchiveClient,
    RetryableArchiveError,
)
from jojo_news_archive.common_crawl import (
    CommonCrawlCircuitOpenError,
    COLLECTION_INFO_URL,
    DATA_BASE_URL,
    _same_article_url,
    discover_common_crawl_candidates,
    fetch_common_crawl_candidate,
)
from jojo_news_archive.news_models import CaptureCandidate, CaptureProvider
from jojo_news_archive.raw_archive_capture import ManifestItem, capture_item


CANONICAL_URL = (
    "https://www.ft.com/content/"
    "5f389a80-96f1-4979-8eeb-fe484dc10cad"
)
COLLECTION_URL = (
    "https://index.commoncrawl.org/CC-MAIN-2023-23-index"
)
WARC_FILENAME = (
    "crawl-data/CC-MAIN-2023-23/segments/example/warc/"
    "CC-MAIN-20230531-example.warc.gz"
)
WARC_URL = DATA_BASE_URL + WARC_FILENAME


def test_bloomberg_legacy_and_current_article_urls_are_equivalent():
    assert _same_article_url(
        "http://www.bloomberg.com/news/2014-05-13/"
        "kenya-may-reschedule-payment.html",
        "https://www.bloomberg.com/news/articles/2014-05-13/"
        "kenya-may-reschedule-payment",
    )


ARTICLE = b"""
<!doctype html>
<html>
  <head>
    <title>US-China tensions have upended global order</title>
    <script type="application/ld+json">
      {
        "@type": "NewsArticle",
        "headline": "US-China tensions have upended global order",
        "datePublished": "2023-05-31T17:13:52Z",
        "articleBody": "A complete Financial Times article body includes substantive reporting, source context and enough detail for the normalized parser quality threshold."
      }
    </script>
  </head>
  <body>
    <article>
      <div data-trackable="article-body">
        <p>A complete Financial Times article body used for archive QA
        includes substantive reporting, source context and enough detail
        for the normalized parser quality threshold.</p>
      </div>
    </article>
  </body>
</html>
""" + (b" " * 2_048)


class StubCommonCrawlClient:
    def __init__(
        self,
        *,
        responses: dict[
            str,
            tuple[int, dict[str, str], bytes, str],
        ],
        range_response: tuple[int, dict[str, str], bytes, str] | None = None,
    ) -> None:
        self.responses = responses
        self.range_response = range_response
        self.requests: list[str] = []
        self.range_requests: list[tuple[str, int, int, int]] = []

    def fetch(self, url: str, *, maximum_bytes: int):
        self.requests.append(url)
        response = self.responses[url]
        if len(response[2]) > maximum_bytes:
            raise ValueError("too large")
        return response

    def fetch_range(
        self,
        url: str,
        *,
        offset: int,
        length: int,
        maximum_bytes: int,
    ):
        self.range_requests.append((url, offset, length, maximum_bytes))
        if self.range_response is None:
            raise AssertionError("unexpected range request")
        if len(self.range_response[2]) > maximum_bytes:
            raise ValueError("too large")
        return self.range_response


def _collection_payload() -> bytes:
    return json.dumps(
        [
            {
                "id": "CC-MAIN-2026-25",
                "cdx-api": (
                    "https://index.commoncrawl.org/"
                    "CC-MAIN-2026-25-index"
                ),
                "from": "2026-06-05T21:48:11",
                "to": "2026-06-18T19:32:05",
            },
            {
                "id": "CC-MAIN-2023-23",
                "cdx-api": COLLECTION_URL,
                "from": "2023-05-27T22:35:15",
                "to": "2023-06-11T02:30:20",
            },
            {
                "id": "CC-MAIN-2023-14",
                "cdx-api": (
                    "https://index.commoncrawl.org/"
                    "CC-MAIN-2023-14-index"
                ),
                "from": "2023-03-20T08:35:13",
                "to": "2023-04-02T13:50:54",
            },
        ]
    ).encode()


def _index_payload(*, compressed_length: int) -> bytes:
    return (
        json.dumps(
            {
                "urlkey": "com,ft)/content/example",
                "timestamp": "20230601083000",
                "url": CANONICAL_URL,
                "mime": "text/html",
                "status": "200",
                "digest": "COMMONCRAWLDIGEST",
                "length": str(compressed_length),
                "offset": "123456",
                "filename": WARC_FILENAME,
            }
        )
        + "\n"
    ).encode()


def _warc_record(
    content: bytes = ARTICLE,
    *,
    content_encoding: str | None = None,
    declared_content_length: int | None = None,
    warc_truncated: str | None = None,
) -> bytes:
    payload = (
        b"HTTP/1.1 200 OK\r\n"
        b"Content-Type: text/html; charset=utf-8\r\n"
        + (
            f"Content-Encoding: {content_encoding}\r\n".encode()
            if content_encoding
            else b""
        )
        + (
            "Content-Length: "
            f"{declared_content_length if declared_content_length is not None else len(content)}"
            "\r\n"
        ).encode()
        + b"\r\n"
        + content
    )
    record = (
        b"WARC/1.0\r\n"
        b"WARC-Type: response\r\n"
        + f"WARC-Target-URI: {CANONICAL_URL}\r\n".encode()
        + b"WARC-Date: 2023-06-01T08:30:00Z\r\n"
        + (
            f"WARC-Truncated: {warc_truncated}\r\n".encode()
            if warc_truncated
            else b""
        )
        + f"Content-Length: {len(payload)}\r\n".encode()
        + b"\r\n"
        + payload
        + b"\r\n\r\n"
    )
    return gzip.compress(record, mtime=0)


def _client_for_record(
    compressed: bytes,
    *,
    wayback_response: tuple[
        int,
        dict[str, str],
        bytes,
        str,
    ] | None = None,
) -> StubCommonCrawlClient:
    index_prefix = COLLECTION_URL + "?"
    responses = {
        COLLECTION_INFO_URL: (
            200,
            {"content-type": "application/json"},
            _collection_payload(),
            COLLECTION_INFO_URL,
        ),
    }
    client = StubCommonCrawlClient(
        responses=responses,
        range_response=(
            206,
            {"content-type": "application/octet-stream"},
            compressed,
            WARC_URL,
        ),
    )
    client._index_prefix = index_prefix
    client._index_payload = _index_payload(
        compressed_length=len(compressed)
    )
    client._wayback_response = wayback_response
    original_fetch = client.fetch

    def fetch(url: str, *, maximum_bytes: int):
        if url.startswith(index_prefix):
            client.requests.append(url)
            return (
                200,
                {"content-type": "application/x-ndjson"},
                client._index_payload,
                url,
            )
        if (
            url != COLLECTION_INFO_URL
            and url.startswith("https://index.commoncrawl.org/")
        ):
            client.requests.append(url)
            return (
                404,
                {"content-type": "application/json"},
                b"",
                url,
            )
        if wayback_response is not None and url.startswith(
            "https://web.archive.org/"
        ):
            client.requests.append(url)
            return wayback_response
        return original_fetch(url, maximum_bytes=maximum_bytes)

    client.fetch = fetch
    return client


def test_discovers_publication_near_common_crawl_record():
    compressed = _warc_record()
    client = _client_for_record(compressed)

    candidates = discover_common_crawl_candidates(
        CANONICAL_URL,
        published_at="2023-05-31T17:13:52Z",
        archive_client=client,
        maximum_collections=1,
    )

    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.provider == CaptureProvider.COMMON_CRAWL
    assert candidate.snapshot_url == WARC_URL
    assert candidate.captured_at == datetime(
        2023,
        6,
        1,
        8,
        30,
        tzinfo=timezone.utc,
    )
    assert candidate.warc_filename == WARC_FILENAME
    assert candidate.warc_offset == 123456
    assert candidate.warc_length == len(compressed)
    assert client.requests[1].startswith(COLLECTION_URL + "?")
    assert "matchType=exact" in client.requests[1]


def test_fetches_and_decodes_common_crawl_warc_range():
    compressed = _warc_record()
    client = _client_for_record(compressed)
    candidate = CaptureCandidate(
        provider=CaptureProvider.COMMON_CRAWL,
        snapshot_url=WARC_URL,
        captured_at=datetime(
            2023,
            6,
            1,
            8,
            30,
            tzinfo=timezone.utc,
        ),
        warc_filename=WARC_FILENAME,
        warc_offset=123456,
        warc_length=len(compressed),
    )

    status, headers, content, final_url = fetch_common_crawl_candidate(
        candidate,
        archive_client=client,
        maximum_html_bytes=5_000_000,
    )

    assert status == 200
    assert headers["content-type"] == "text/html; charset=utf-8"
    assert content == ARTICLE
    assert final_url == CANONICAL_URL
    assert client.range_requests == [
        (
            WARC_URL,
            123456,
            len(compressed),
            25_000_000,
        )
    ]


def test_rejects_origin_truncated_common_crawl_warc_response():
    compressed = _warc_record(
        ARTICLE[:100],
        warc_truncated="length",
    )
    client = _client_for_record(compressed)
    candidate = CaptureCandidate(
        provider=CaptureProvider.COMMON_CRAWL,
        snapshot_url=WARC_URL,
        warc_filename=WARC_FILENAME,
        warc_offset=123456,
        warc_length=len(compressed),
    )

    with pytest.raises(ValueError, match="origin-truncated \\(length\\)"):
        fetch_common_crawl_candidate(
            candidate,
            archive_client=client,
            maximum_html_bytes=5_000_000,
        )


def test_decodes_encoded_common_crawl_http_body_without_truncating_it():
    encoded = gzip.compress(ARTICLE, mtime=0)
    compressed = _warc_record(
        encoded,
        content_encoding="gzip",
        declared_content_length=len(encoded),
    )
    client = _client_for_record(compressed)
    candidate = CaptureCandidate(
        provider=CaptureProvider.COMMON_CRAWL,
        snapshot_url=WARC_URL,
        warc_filename=WARC_FILENAME,
        warc_offset=123456,
        warc_length=len(compressed),
    )

    status, headers, content, _ = fetch_common_crawl_candidate(
        candidate,
        archive_client=client,
        maximum_html_bytes=5_000_000,
    )

    assert status == 200
    assert content == ARTICLE
    assert "content-encoding" not in headers
    assert "content-length" not in headers


def test_accepts_common_crawl_body_decoded_with_stale_gzip_headers():
    compressed = _warc_record(
        ARTICLE,
        content_encoding="gzip",
        declared_content_length=17,
    )
    client = _client_for_record(compressed)
    candidate = CaptureCandidate(
        provider=CaptureProvider.COMMON_CRAWL,
        snapshot_url=WARC_URL,
        warc_filename=WARC_FILENAME,
        warc_offset=123456,
        warc_length=len(compressed),
    )

    status, headers, content, _ = fetch_common_crawl_candidate(
        candidate,
        archive_client=client,
        maximum_html_bytes=5_000_000,
    )

    assert status == 200
    assert content == ARTICLE
    assert "content-encoding" not in headers
    assert "content-length" not in headers


def test_archive_client_sends_bounded_http_range():
    seen_range: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_range.append(request.headers.get("range"))
        return httpx.Response(
            206,
            headers={"content-type": "application/octet-stream"},
            content=b"range-response",
            request=request,
        )

    http_client = httpx.Client(
        transport=httpx.MockTransport(handler),
        follow_redirects=True,
    )
    client = ArchiveClient(
        client=http_client,
        attempts=1,
        minimum_interval=0,
    )

    status, _, content, _ = client.fetch_range(
        WARC_URL,
        offset=100,
        length=14,
        maximum_bytes=14,
    )

    assert status == 206
    assert content == b"range-response"
    assert seen_range == ["bytes=100-113"]
    http_client.close()


def test_archive_client_circuit_breaker_is_isolated_by_host():
    def handler(request: httpx.Request) -> httpx.Response:
        status = 503 if request.url.host == "bad.example" else 200
        return httpx.Response(
            status,
            content=b"ok" if status == 200 else b"",
            request=request,
        )

    http_client = httpx.Client(
        transport=httpx.MockTransport(handler),
        follow_redirects=True,
    )
    client = ArchiveClient(
        client=http_client,
        attempts=1,
        minimum_interval=0,
    )
    for _ in range(3):
        with pytest.raises(RetryableArchiveError):
            client.fetch(
                "https://bad.example/archive",
                maximum_bytes=100,
            )

    started = time.monotonic()
    status, _, content, _ = client.fetch(
        "https://good.example/archive",
        maximum_bytes=100,
    )

    assert time.monotonic() - started < 1
    assert status == 200
    assert content == b"ok"
    http_client.close()


def test_archive_client_limited_fetch_caps_transport_attempts():
    requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        raise httpx.ConnectTimeout("timed out", request=request)

    http_client = httpx.Client(
        transport=httpx.MockTransport(handler),
        follow_redirects=True,
    )
    client = ArchiveClient(
        client=http_client,
        attempts=6,
        minimum_interval=0,
    )

    with pytest.raises(httpx.ConnectTimeout):
        client.fetch_limited(
            "https://index.commoncrawl.org/example",
            maximum_bytes=100,
            attempts=2,
            timeout=0.1,
        )

    assert requests == 2
    http_client.close()


def test_common_crawl_discovery_fails_fast_while_index_circuit_is_open():
    requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        raise AssertionError("open Common Crawl circuit must skip transport")

    http_client = httpx.Client(
        transport=httpx.MockTransport(handler),
        follow_redirects=True,
    )
    client = ArchiveClient(
        client=http_client,
        attempts=1,
        minimum_interval=0,
    )
    for _ in range(3):
        client._record_failure(COLLECTION_INFO_URL)

    started = time.monotonic()
    with pytest.raises(CommonCrawlCircuitOpenError):
        discover_common_crawl_candidates(
            CANONICAL_URL,
            published_at="2023-05-31T17:13:52Z",
            archive_client=client,
        )

    assert time.monotonic() - started < 0.5
    assert requests == 0
    http_client.close()


def test_ft_capture_uses_valid_common_crawl_after_wayback_shell(
    tmp_path: Path,
):
    compressed = _warc_record()
    wayback_url = (
        "https://web.archive.org/web/20230602000000id_/"
        + CANONICAL_URL
    )
    client = _client_for_record(
        compressed,
        wayback_response=(
            200,
            {"content-type": "text/html"},
            b"<html><title>Subscribe to read | Financial Times</title></html>",
            wayback_url,
        ),
    )
    item = ManifestItem(
        publisher="ft",
        canonical_url=CANONICAL_URL,
        published_at="2023-05-31T17:13:52Z",
        section=None,
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=wayback_url,
            ),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=5_000_000,
        enable_common_crawl_fallback=True,
    )

    assert result["status"] == "complete"
    capture = result["capture"]
    assert capture.selected_candidate.provider == CaptureProvider.COMMON_CRAWL
    assert capture.final_url == CANONICAL_URL
    assert capture.quality_score == 100
    assert capture.quality_signals["commonCrawlWarcValidated"] is True
    assert wayback_url in client.requests
    assert client.requests.index(wayback_url) < client.requests.index(
        COLLECTION_INFO_URL
    )
