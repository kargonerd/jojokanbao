from pathlib import Path
import gzip
import sqlite3
import threading
import time

import httpx

from jojo_news_archive.bloomberg_archive_download import (
    ArchiveClient,
    derived_image_candidates,
    detect_image_type,
    extract_article,
    image_variant_key,
    initialize_download_schema,
    _image_quality_score,
    pending_articles,
    store_object,
)


ARTICLE_HTML = b"""
<!doctype html>
<html>
  <head>
    <script type="application/ld+json">
      {
        "@type": "NewsArticle",
        "headline": "Archived headline",
        "description": "Archived description",
        "author": [{"name": "One Author"}, {"name": "Two Author"}],
        "datePublished": "2020-01-02T03:04:05Z",
        "image": [
          "https://assets.bwbx.io/images/users/example/photo/v1/1200x800.jpg",
          "https://assets.bwbx.io/s3/javelin/public/social-default.jpg"
        ]
      }
    </script>
  </head>
  <body>
    <article>
      <h1>Fallback headline</h1>
      <div class="body-copy-v2">
        <p>First body paragraph with useful reporting.</p>
        <aside>Share this article</aside>
        <p>Second body paragraph with more reporting.</p>
        <figure>
          <source srcset="
            https://assets.bwbx.io/images/users/example/photo/v1/750x500.jpg 750w,
            https://assets.bwbx.io/images/users/example/photo/v1/488x325.jpg 488w
          ">
        </figure>
      </div>
      <div class="recommendations">
        <img src="https://assets.bwbx.io/images/users/example/related/v1/47x-1.jpg">
      </div>
    </article>
  </body>
</html>
"""


def test_archive_client_retries_wayback_over_http_after_tls_failure():
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if request.url.scheme == "https":
            raise httpx.ConnectError("TLS EOF", request=request)
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            content=b"<html><article>archive</article></html>",
            request=request,
        )

    client = ArchiveClient(
        attempts=1,
        client=httpx.Client(
            transport=httpx.MockTransport(handler),
            follow_redirects=True,
        ),
    )
    status, _headers, content, final_url = client.fetch(
        "https://web.archive.org/web/20140101000000id_/"
        "https://www.bloomberg.com/news/articles/example",
        maximum_bytes=10_000,
    )

    assert status == 200
    assert content == b"<html><article>archive</article></html>"
    assert final_url.startswith("http://web.archive.org/")
    assert [url.split(":", 1)[0] for url in requests] == ["https", "http"]

    requests.clear()
    try:
        status, _headers, _content, final_url = client.fetch(
            "https://web.archive.org/web/20140102000000id_/"
            "https://www.bloomberg.com/news/articles/second-example",
            maximum_bytes=10_000,
        )
    finally:
        client._provided_client.close()

    assert status == 200
    assert final_url.startswith("http://web.archive.org/")
    assert [url.split(":", 1)[0] for url in requests] == ["http"]


def test_archive_client_bounds_total_stream_response_time():
    class SlowStream(httpx.SyncByteStream):
        def __iter__(self):
            yield b"first"
            time.sleep(1.05)
            yield b"second"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            stream=SlowStream(),
            request=request,
        )

    client = ArchiveClient(
        attempts=1,
        timeout=1.0,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    try:
        try:
            client.fetch("https://example.test/slow", maximum_bytes=10_000)
        except TimeoutError as exc:
            assert "wall-clock timeout" in str(exc)
        else:
            raise AssertionError("slow stream should be bounded")
    finally:
        client._provided_client.close()


def test_archive_client_does_not_share_circuit_across_proxy_pool_nodes():
    client = ArchiveClient(
        attempts=1,
        proxy="http://127.0.0.1:18790",
        client=httpx.Client(transport=httpx.MockTransport(lambda request: None)),
    )
    url = "https://web.archive.org/web/example"
    try:
        for _ in range(10):
            client._record_failure(url)
        client._wait_for_circuit(url)
    finally:
        client._provided_client.close()

    assert client._consecutive_failures == {}
    assert client._blocked_until == {}


def test_archive_client_gives_proxy_pool_workers_independent_rate_slots():
    client = ArchiveClient(
        attempts=1,
        minimum_interval=0.5,
        proxy="http://127.0.0.1:18790",
        client=httpx.Client(transport=httpx.MockTransport(lambda request: None)),
    )
    worker_limiter: list[object] = []

    try:
        client._wait_for_rate_slot()
        main_limiter = client._local.rate_limiter

        def run_worker() -> None:
            client._wait_for_rate_slot()
            worker_limiter.append(client._local.rate_limiter)

        thread = threading.Thread(target=run_worker)
        thread.start()
        thread.join()
    finally:
        client._provided_client.close()

    assert worker_limiter
    assert worker_limiter[0] is not main_limiter
    assert client.rate_limiter is not main_limiter


def test_common_crawl_uses_direct_transport_even_with_archive_proxy():
    client = ArchiveClient(
        proxy="http://127.0.0.1:18790",
        attempts=1,
        minimum_interval=0,
    )
    try:
        assert client._uses_direct_common_crawl(
            "https://data.commoncrawl.org/cc-index/table/part-0.warc.gz"
        )
        assert client._uses_direct_common_crawl(
            "https://index.commoncrawl.org/CC-MAIN-2026-04-index"
        )
        assert not client._uses_direct_common_crawl(
            "https://web.archive.org/web/20200101000000id_/https://example.test"
        )

        direct_client = client._get_client(
            "https://data.commoncrawl.org/cc-index/table/part-0.warc.gz"
        )
        proxy_client = client._get_client("https://web.archive.org/web/example")
        assert direct_client is not proxy_client
        assert direct_client._trust_env is False
        assert proxy_client._trust_env is False
    finally:
        client.close()


def test_extract_article_body_metadata_and_image_family():
    result = extract_article(ARTICLE_HTML, base_url="https://www.bloomberg.com/example")

    assert result["title"] == "Archived headline"
    assert result["description"] == "Archived description"
    assert result["authors"] == ["One Author", "Two Author"]
    assert "First body paragraph" in result["bodyText"]
    assert "Share this article" not in result["bodyText"]
    assert len(result["imageGroups"]) == 1
    candidates = result["imageGroups"][0]["candidates"]
    assert candidates[0].endswith("/1200x800.jpg")
    assert any(candidate.endswith("/488x325.jpg") for candidate in candidates)


def test_image_variant_key_and_derived_candidates():
    url = "https://assets.bwbx.io/images/users/example/photo/v2/1200x-1.png"
    assert image_variant_key(url).endswith("/{width}x{height}.png")
    candidates = derived_image_candidates([url])
    assert candidates[0] == url
    assert candidates[-1].endswith("/320x-1.png")

    original = (
        "https://assets.bwbx.io/images/users/example/photo/v2/-1x-1.png"
    )
    assert image_variant_key(original) == image_variant_key(url)
    assert derived_image_candidates([original]) == [original]
    assert _image_quality_score(original) > _image_quality_score(url)


def test_image_detection_and_content_addressed_storage(tmp_path: Path):
    content = b"\x89PNG\r\n\x1a\nexample"
    assert detect_image_type(content) == ("image/png", "png")
    first = store_object(
        tmp_path,
        kind="images",
        content=content,
        extension="png",
        compress=False,
    )
    second = store_object(
        tmp_path,
        kind="images",
        content=content,
        extension="png",
        compress=False,
    )
    assert first == second
    assert (tmp_path / first.relative_path).read_bytes() == content

    compressed = store_object(
        tmp_path,
        kind="html",
        content=b"<html>archive</html>",
        extension="html",
        compress=True,
    )
    with gzip.open(tmp_path / compressed.relative_path, "rb") as stream:
        assert stream.read() == b"<html>archive</html>"


def test_download_schema_requires_and_records_authorization():
    connection = sqlite3.connect(":memory:")
    initialize_download_schema(
        connection,
        authorization_reference="license:test",
    )
    assert connection.execute(
        "SELECT value FROM archive_metadata WHERE key='authorization_reference'"
    ).fetchone()[0] == "license:test"


def test_pending_articles_bounds_recovery_attempts_but_not_interrupted_pending():
    connection = sqlite3.connect(":memory:")
    initialize_download_schema(
        connection,
        authorization_reference="license:test",
    )
    rows = [
        ("https://example.com/pending", "pending", 9),
        ("https://example.com/retryable", "error", 2),
        ("https://example.com/exhausted", "partial", 3),
    ]
    connection.executemany(
        """
        INSERT INTO articles(
            url, catalog_date, section, wayback_timestamp,
            wayback_snapshot_url, status, attempts, authorization_reference
        ) VALUES (?, '20200101', 'news', '20200101000000', ?, ?, ?, 'license:test')
        """,
        [
            (url, f"https://web.archive.org/web/20200101000000/{url}", status, attempts)
            for url, status, attempts in rows
        ],
    )

    selected = pending_articles(
        connection,
        retry_errors=True,
        maximum=None,
        maximum_record_attempts=3,
    )

    assert [article.url for article in selected] == [
        "https://example.com/pending",
        "https://example.com/retryable",
    ]
