from __future__ import annotations

from datetime import date
import gzip
import json
from pathlib import Path
import sqlite3
from urllib.parse import urlencode

from jojo_olds_api.bloomberg_bnn_catalog import (
    BNN_DAILY_SITEMAP_TEMPLATE,
    _sample_occurrence_ranks,
    bloomberg_bnn_summary,
    initialize_bloomberg_bnn_schema,
    parse_bloomberg_bnn_sitemap,
    parse_bloomberg_bnn_archive,
    process_bloomberg_infini_documents,
    process_bloomberg_infini_pages,
    process_bloomberg_infini_queries,
    process_bloomberg_bnn_pages,
    process_bloomberg_bnn_sitemaps,
)
from jojo_olds_api.news_models import CaptureCandidate, CaptureProvider
from jojo_olds_api.raw_archive_capture import ManifestItem, capture_item
from jojo_olds_api.sitemap_manifest import (
    export_sitemap_manifest,
    initialize_sitemap_schema,
    sitemap_source,
)


CANONICAL_URL = (
    "https://www.bloomberg.com/news/articles/2025-01-28/"
    "ai-s-electricity-demand-means-cool-new-tech-is-coming-to-boring-grids"
)
PARTNER_URL = (
    "https://www.bnnbloomberg.ca/business/technology/2025/01/28/"
    "ais-electricity-demand-means-cool-new-tech-is-coming-to-boring-grids/"
)
ARCHIVE_URL = (
    "https://web.archive.org/web/20250130163442id_/" + PARTNER_URL
)
HEADLINE = (
    "AI’s Electricity Demand Means Cool New Tech Is Coming to Boring Grids"
)
PARTNER_CANONICAL_URL = (
    "https://www.bloomberg.com/opinion/articles/2025-06-04/"
    "texas-is-going-about-its-hollywood-ambitions-all-wrong"
)
GENERIC_PARTNER_URL = (
    "https://www.livemint.com/entertainment/"
    "texas-is-going-about-its-hollywood-ambitions-all-wrong.html"
)
GENERIC_ARCHIVE_URL = (
    "https://web.archive.org/web/20250604150923id_/"
    + GENERIC_PARTNER_URL
)
GENERIC_HEADLINE = "Texas Is Going About Its Hollywood Ambitions All Wrong"


def test_infini_occurrence_sample_is_randomized_and_reproducible():
    segments = [[10, 30], [100, 140]]

    first = _sample_occurrence_ranks(
        segments,
        maximum=12,
        seed="bloomberg:2025:test",
    )
    repeated = _sample_occurrence_ranks(
        segments,
        maximum=12,
        seed="bloomberg:2025:test",
    )
    another_year = _sample_occurrence_ranks(
        segments,
        maximum=12,
        seed="bloomberg:2024:test",
    )

    assert first == repeated
    assert first != another_year
    assert len(first) == len(set(first)) == 12
    assert first != sorted(first)
    assert all(
        (shard == 0 and 10 <= rank < 30)
        or (shard == 1 and 100 <= rank < 140)
        for shard, rank in first
    )


def bnn_sitemap() -> bytes:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>{PARTNER_URL}</loc></url>
    </urlset>
    """.encode()


def bnn_article_html(
    *,
    include_original_link: bool = True,
    include_copyright: bool = True,
    canonical_url: str = CANONICAL_URL,
    headline: str = HEADLINE,
    date_published: str = "2025-01-28T18:01:38Z",
) -> bytes:
    paragraphs = "".join(
        (
            "<p>Licensed Bloomberg reporting paragraph "
            f"{index} contains substantive details about power grids, "
            "investment, technology, corporate strategy and market demand. "
            "This is complete article text rather than a preview or a "
            "subscription shell.</p>"
        )
        for index in range(1, 7)
    )
    original_link = (
        f'<a href="{canonical_url}">Original Bloomberg article</a>'
        if include_original_link
        else ""
    )
    copyright_text = (
        "<p>©2025 Bloomberg L.P.</p>" if include_copyright else ""
    )
    return f"""
    <!doctype html><html><head>
      <script type="application/ld+json">
      {{
        "@type": "NewsArticle",
        "headline": "{headline}",
        "datePublished": "{date_published}",
        "author": {{"name": "Akshat Rathi, Bloomberg News"}}
      }}
      </script>
    </head><body><article>
      {paragraphs}
      {original_link}
      {copyright_text}
    </article></body></html>
    """.encode() + (b" " * 2_048)


class StubArchiveClient:
    def __init__(self, *, article_html: bytes | None = None):
        self.article_html = article_html or bnn_article_html()

    def fetch(self, url: str, *, maximum_bytes: int):
        if url == BNN_DAILY_SITEMAP_TEMPLATE.format(day="2025-01-28"):
            return (
                200,
                {"content-type": "application/xml"},
                bnn_sitemap(),
                url,
            )
        if url.startswith("https://web.archive.org/web/timemap/json?"):
            expected = (
                "https://web.archive.org/web/timemap/json?"
                + urlencode({"url": PARTNER_URL})
            )
            assert url == expected
            payload = [
                [
                    "urlkey",
                    "timestamp",
                    "original",
                    "mimetype",
                    "statuscode",
                    "digest",
                    "length",
                ],
                [
                    "ca,bnnbloomberg)/business/technology/example",
                    "20250130163442",
                    PARTNER_URL,
                    "text/html",
                    "200",
                    "EXAMPLEDIGEST",
                    str(len(self.article_html)),
                ],
            ]
            return (
                200,
                {"content-type": "application/json"},
                json.dumps(payload).encode(),
                url,
            )
        if url == ARCHIVE_URL:
            return (
                200,
                {"content-type": "text/html; charset=utf-8"},
                self.article_html,
                ARCHIVE_URL,
            )
        raise AssertionError(f"unexpected URL: {url}")


class StubJsonResponse:
    def __init__(
        self,
        *,
        json_value: object | None = None,
        html_value: str = "",
    ):
        self._json_value = json_value
        self.content = html_value.encode()

    def json(self):
        return self._json_value

    def raise_for_status(self):
        return None


class StubInfiniClient:
    def __init__(self):
        self.search_calls = 0

    def post(self, url, json):
        if url.endswith("/find"):
            assert json["query"] == "©2025 Bloomberg L.P."
            return StubJsonResponse(
                json_value={
                    "count": 1,
                    "segment_by_shard": [[100, 101]],
                    "shard_years": ["2025"],
                }
            )
        assert url.endswith("/get_doc")
        assert json["rank"] == 100
        return StubJsonResponse(
            json_value={
                "doc_ix": 58050622,
                "doc_len": 6_822,
                "metadata": {
                    "url": GENERIC_PARTNER_URL,
                    "date": "2025-06-04",
                    "warc_source": (
                        "CC-NEWS-20250604125236-02430.warc.gz"
                    ),
                    "language": "eng",
                    "title": GENERIC_HEADLINE + " | Mint",
                    "author": "Bloomberg Published",
                    "sitename": "Mint",
                    "hostname": "www.livemint.com",
                },
            }
        )

    def get(self, url, params, headers=None):
        self.search_calls += 1
        assert url == "https://search.yahoo.com/search"
        assert params["p"].endswith("site:bloomberg.com")
        assert headers and headers["User-Agent"].startswith("Mozilla/5.0")
        return StubJsonResponse(
            html_value=f"""
            <html><body><ol id="web"><li>
              <div class="compTitle">
                <a href="{PARTNER_CANONICAL_URL}">
                  <h3>{GENERIC_HEADLINE}</h3>
                </a>
              </div>
            </li></ol></body></html>
            """
        )


def generic_partner_html() -> bytes:
    paragraphs = "".join(
        (
            "<p class='storyParagraph'>Licensed Bloomberg analysis "
            f"paragraph {index} contains substantive reporting about the "
            "film industry, public investment, tax credits, economic "
            "development and corporate strategy.</p>"
        )
        for index in range(1, 7)
    )
    return f"""
    <!doctype html><html><head>
      <script type="application/ld+json">
      {{
        "@type": "NewsArticle",
        "headline": "{GENERIC_HEADLINE}",
        "datePublished": "2025-06-04T18:37:00+05:30",
        "author": {{"name": "Bloomberg News"}}
      }}
      </script>
    </head><body>
      <div class="storyPage_storyContent__3xuFc">{paragraphs}</div>
      <p>©2025 Bloomberg L.P.</p>
    </body></html>
    """.encode() + (b" " * 2_048)


class StubPartnerArchiveClient:
    def fetch(self, url: str, *, maximum_bytes: int):
        if url.startswith("https://web.archive.org/web/timemap/json?"):
            expected = (
                "https://web.archive.org/web/timemap/json?"
                + urlencode({"url": GENERIC_PARTNER_URL})
            )
            assert url == expected
            payload = [
                [
                    "urlkey",
                    "timestamp",
                    "original",
                    "mimetype",
                    "statuscode",
                    "digest",
                    "length",
                ],
                [
                    "com,livemint)/entertainment/example",
                    "20250604150923",
                    GENERIC_PARTNER_URL,
                    "text/html",
                    "200",
                    "EXAMPLEDIGEST",
                    str(len(generic_partner_html())),
                ],
            ]
            return (
                200,
                {"content-type": "application/json"},
                json.dumps(payload).encode(),
                url,
            )
        if url == GENERIC_ARCHIVE_URL:
            return (
                200,
                {"content-type": "text/html; charset=utf-8"},
                generic_partner_html(),
                GENERIC_ARCHIVE_URL,
            )
        raise AssertionError(f"unexpected URL: {url}")


class StubEmbeddedPartnerArchiveClient(StubPartnerArchiveClient):
    def fetch(self, url: str, *, maximum_bytes: int):
        status, headers, content, final_url = super().fetch(
            url,
            maximum_bytes=maximum_bytes,
        )
        if url == GENERIC_ARCHIVE_URL:
            canonical = (
                f'<link rel="canonical" href="{PARTNER_CANONICAL_URL}">'
            ).encode()
            content = content.replace(b"</head>", canonical + b"</head>")
        return status, headers, content, final_url


def test_bloomberg_bnn_catalog_maps_embedded_original_and_exports(
    tmp_path: Path,
):
    connection = sqlite3.connect(":memory:")
    initialize_sitemap_schema(
        connection,
        source=sitemap_source("bloomberg"),
        from_year=2025,
        to_year=2025,
        sitemap_index=b"<sitemapindex/>",
    )
    initialize_bloomberg_bnn_schema(
        connection,
        from_year=2025,
        to_year=2025,
        today=date(2025, 1, 28),
    )
    connection.execute(
        """
        UPDATE bloomberg_bnn_days
        SET status='complete'
        WHERE sitemap_day != '2025-01-28'
        """
    )
    connection.execute(
        "UPDATE bloomberg_infini_queries SET status='complete'"
    )
    connection.commit()
    client = StubArchiveClient()

    sitemap_result = process_bloomberg_bnn_sitemaps(
        connection,
        http_client=client,
        maximum_days=1,
    )
    page_result = process_bloomberg_bnn_pages(
        connection,
        http_client=client,
        maximum=1,
    )
    destination = tmp_path / "bloomberg-manifest.jsonl.gz"
    manifest = export_sitemap_manifest(
        connection,
        publisher="bloomberg",
        destination=destination,
        from_year=2025,
        to_year=2025,
    )

    assert sitemap_result == {
        "processed": 1,
        "seen": 1,
        "accepted": 1,
        "errors": [],
    }
    assert page_result == {
        "attempted": 1,
        "resolved": 1,
        "rejected": 0,
        "errors": [],
    }
    assert bloomberg_bnn_summary(connection) == {
        "daysByStatus": {"complete": 28},
        "pagesByStatus": {"resolved": 1},
        "infiniQueriesByStatus": {"complete": 1},
        "infiniOccurrencesByStatus": {},
        "infiniPagesByStatus": {},
        "articlesByYear": {"2025": 1},
        "articles": 1,
        "shouldContinue": False,
    }
    assert manifest["articles"] == 1
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    assert row["canonicalUrl"] == CANONICAL_URL
    assert row["publishedAt"] == "2025-01-28T18:01:38+00:00"
    assert row["candidates"][0] == {
        "provider": "other",
        "snapshotUrl": ARCHIVE_URL,
        "expectedHeadline": HEADLINE,
    }


def test_parse_bloomberg_bnn_sitemap_rejects_other_hosts():
    content = b"""<urlset>
      <url><loc>https://example.com/story/2025/01/28/test/</loc></url>
      <url><loc>https://www.bnnbloomberg.ca/story/no-date/</loc></url>
    </urlset>"""

    assert parse_bloomberg_bnn_sitemap(
        content,
        from_year=2025,
        to_year=2025,
    ) == []


def test_bloomberg_bnn_rejects_wrong_copyright_year():
    content = bnn_article_html().replace(
        "©2025 Bloomberg L.P.".encode(),
        "©2024 Bloomberg L.P.".encode(),
    )

    result, reason = parse_bloomberg_bnn_archive(
        content,
        partner_url=PARTNER_URL,
        archive_url=ARCHIVE_URL,
        published_hint="2025-01-28T12:00:00+00:00",
    )

    assert result is None
    assert reason == "missing-bloomberg-copyright"


def test_bloomberg_bnn_mirrored_slug_maps_without_embedded_link():
    partner_url = (
        "https://www.bnnbloomberg.ca/bloomberg/2025/01/31/"
        "trump-tariffs-to-stoke-us-food-inflation/"
    )
    canonical_url = (
        "https://www.bloomberg.com/news/articles/2025-01-31/"
        "trump-tariffs-to-stoke-us-food-inflation"
    )
    archive_url = (
        "https://web.archive.org/web/20250201010000id_/" + partner_url
    )
    headline = "Trump Tariffs to Stoke US Food Inflation"

    result, reason = parse_bloomberg_bnn_archive(
        bnn_article_html(
            include_original_link=False,
            canonical_url=canonical_url,
            headline=headline,
            date_published="2025-01-31T18:01:38Z",
        ),
        partner_url=partner_url,
        archive_url=archive_url,
        published_hint="2025-01-31T12:00:00+00:00",
    )

    assert reason is None
    assert result is not None
    assert result["canonicalUrl"] == canonical_url
    assert result["mappingMethod"] == "mirrored-partner-slug"


def test_bloomberg_infini_copyright_catalog_resolves_validated_copy(
    tmp_path: Path,
):
    connection = sqlite3.connect(":memory:")
    initialize_bloomberg_bnn_schema(
        connection,
        from_year=2025,
        to_year=2025,
        today=date(2025, 1, 1),
    )
    connection.execute(
        "UPDATE bloomberg_bnn_days SET status='complete'"
    )
    connection.commit()
    source_client = StubInfiniClient()
    archive_client = StubPartnerArchiveClient()

    query_result = process_bloomberg_infini_queries(
        connection,
        http_client=source_client,
        maximum_years=1,
    )
    document_result = process_bloomberg_infini_documents(
        connection,
        http_client=source_client,
        maximum=1,
        workers=1,
        minimum_request_interval=0,
    )
    page_result = process_bloomberg_infini_pages(
        connection,
        search_client=source_client,
        archive_client=archive_client,
        maximum=1,
        minimum_request_interval=0,
    )

    assert query_result == {
        "processed": 1,
        "occurrences": 1,
        "errors": [],
    }
    assert document_result == {
        "attempted": 1,
        "accepted": 1,
        "rejected": 0,
        "errors": [],
    }
    assert page_result == {
        "attempted": 1,
        "resolved": 1,
        "rejected": 0,
        "errors": [],
    }
    assert source_client.search_calls == 1
    assert connection.execute(
        "SELECT mapping_method FROM bloomberg_bnn_articles"
    ).fetchone() == ("exact-headline-search",)

    summary = bloomberg_bnn_summary(connection)
    assert summary is not None
    assert summary["infiniQueriesByStatus"] == {"complete": 1}
    assert summary["infiniOccurrencesByStatus"] == {"accepted": 1}
    assert summary["infiniPagesByStatus"] == {"resolved": 1}
    assert summary["articlesByYear"] == {"2025": 1}
    assert summary["shouldContinue"] is False

    item = ManifestItem(
        publisher="bloomberg",
        canonical_url=PARTNER_CANONICAL_URL,
        published_at="2025-06-04T13:07:00+00:00",
        section="opinion",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=GENERIC_ARCHIVE_URL,
                expected_headline=GENERIC_HEADLINE,
            ),
        ),
    )
    capture = capture_item(
        item,
        archive_client=archive_client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )
    assert capture["status"] == "complete"
    signals = capture["capture"].quality_signals
    assert signals["bloombergPartnerValidated"] is True
    assert signals["syndicationBloombergCopyrightAttributed"] is True


def test_bloomberg_infini_prefers_embedded_original_link():
    connection = sqlite3.connect(":memory:")
    initialize_bloomberg_bnn_schema(
        connection,
        from_year=2025,
        to_year=2025,
        today=date(2025, 1, 1),
    )
    connection.execute(
        "UPDATE bloomberg_bnn_days SET status='complete'"
    )
    connection.commit()
    source_client = StubInfiniClient()

    process_bloomberg_infini_queries(
        connection,
        http_client=source_client,
        maximum_years=1,
    )
    process_bloomberg_infini_documents(
        connection,
        http_client=source_client,
        maximum=1,
        workers=1,
        minimum_request_interval=0,
    )
    result = process_bloomberg_infini_pages(
        connection,
        search_client=source_client,
        archive_client=StubEmbeddedPartnerArchiveClient(),
        maximum=1,
        minimum_request_interval=0,
    )

    assert result == {
        "attempted": 1,
        "resolved": 1,
        "rejected": 0,
        "errors": [],
    }
    assert source_client.search_calls == 0
    assert connection.execute(
        """
        SELECT canonical_url, mapping_method
        FROM bloomberg_bnn_articles
        """
    ).fetchone() == (
        PARTNER_CANONICAL_URL,
        "embedded-original-link",
    )


def test_bloomberg_bnn_capture_requires_embedded_original_link(
    tmp_path: Path,
):
    item = ManifestItem(
        publisher="bloomberg",
        canonical_url=CANONICAL_URL,
        published_at="2025-01-28T18:01:38+00:00",
        section="technology",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=ARCHIVE_URL,
                expected_headline=HEADLINE,
            ),
        ),
    )

    valid = capture_item(
        item,
        archive_client=StubArchiveClient(),
        output_dir=tmp_path / "valid",
        maximum_html_bytes=1_000_000,
    )
    invalid = capture_item(
        item,
        archive_client=StubArchiveClient(
            article_html=bnn_article_html(
                include_original_link=False,
            )
        ),
        output_dir=tmp_path / "invalid",
        maximum_html_bytes=1_000_000,
    )

    assert valid["status"] == "complete"
    signals = valid["capture"].quality_signals
    assert signals["bloombergBnnValidated"] is True
    assert signals["syndicationCanonicalArticleLinked"] is True
    assert signals["syndicationBloombergCopyrightAttributed"] is True
    assert signals["syndicationPartnerHostValidated"] is True
    assert invalid["status"] == "error"
    assert "missing-original-url-provenance" in invalid["error"]
