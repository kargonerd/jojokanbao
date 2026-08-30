from __future__ import annotations

from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import sqlite3

import httpx

from jojo_news_archive.sources.registry import archive_source_spec
from jojo_news_archive.discovery.ft_syndication import (
    _next_document_rows,
    _next_resolution_rows,
    ft_syndication_summary,
    initialize_ft_syndication_schema,
    load_ft_syndication_title_index,
    process_ft_infini_documents,
    process_ft_infini_queries,
    process_ft_syndication_resolutions,
    resolve_ft_original_url,
)
from jojo_news_archive.capture.raw import manifest_item_from_row
from jojo_news_archive.discovery.nyt_syndication import (
    initialize_nyt_syndication_schema,
    next_nyt_syndication_resolution,
    next_nyt_syndication_query,
    nyt_syndication_summary,
    record_nyt_syndication_page,
    record_nyt_syndication_resolution,
    resolve_nyt_syndication_search,
)
from jojo_news_archive.discovery.sitemap import (
    export_sitemap_manifest,
    initialize_sitemap_schema,
    next_sitemap_query,
    parse_sitemap_index,
    parse_url_sitemap,
    record_sitemap,
    sitemap_wayback_candidates,
    sitemap_source,
    wayback_candidates,
)
from jojo_news_archive.discovery.wayback import (
    CDXCapture,
    CDXPage,
    initialize_discovery_schema,
    next_discovery_query,
    record_discovery_page,
)


INDEX_XML = b"""<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://www.nytimes.com/sitemaps/new/sitemap-2019-12.xml.gz</loc></sitemap>
  <sitemap><loc>https://www.nytimes.com/sitemaps/new/sitemap-2020-01.xml.gz</loc></sitemap>
  <sitemap><loc>https://www.nytimes.com/sitemaps/new/sitemap-2021-02.xml.gz</loc></sitemap>
</sitemapindex>
"""

URL_XML = b"""<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.nytimes.com/2020/01/14/dining/example.html?utm_source=x</loc>
    <lastmod>2020-01-14T10:00:00Z</lastmod>
  </url>
  <url>
    <loc>https://www.nytimes.com/crosswords/game</loc>
    <lastmod>2020-01-14T10:00:00Z</lastmod>
  </url>
</urlset>
"""


class StubFtSyndicationResponse:
    def __init__(
        self,
        *,
        json_value: object | None = None,
        html_value: str = "",
        status_code: int = 200,
    ):
        self._json_value = json_value
        self.content = html_value.encode()
        self.status_code = status_code

    def json(self):
        return self._json_value

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class StubFtSyndicationClient:
    def post(self, url, json):
        if url.endswith("/find"):
            assert json["query"] == (
                "Copyright The Financial Times Limited"
            )
            return StubFtSyndicationResponse(
                json_value={
                    "count": 1,
                    "segment_by_shard": [[100, 101]],
                    "shard_years": ["2024"],
                }
            )
        assert url.endswith("/get_doc")
        assert json["rank"] == 100
        return StubFtSyndicationResponse(
            json_value={
                "doc_ix": 12345,
                "doc_len": 5_000,
                "metadata": {
                    "url": (
                        "https://www.irishtimes.com/business/2024/03/28/"
                        "amazon-invests-in-ai-start-up/"
                    ),
                    "date": "2024-03-28",
                    "language": "eng",
                    "hostname": "www.irishtimes.com",
                    "warc_source": (
                        "CC-NEWS-20240328160318-02712.warc.gz"
                    ),
                    "title": (
                        "Amazon writes its largest venture cheque yet "
                        "for AI start-up Anthropic"
                    ),
                },
            }
        )

    def get(self, url, params, headers=None):
        assert url == "https://search.yahoo.com/search"
        assert "site:ft.com" in params["p"]
        assert headers and headers["User-Agent"].startswith("Mozilla/5.0")
        return StubFtSyndicationResponse(
            html_value="""
            <html><body><ol id="web"><li>
              <div class="compTitle">
                <a href="https://www.ft.com/content/a604bc55-26a5-42ca-a707-e6537abe0c1d">
                  <h3>Amazon writes its largest venture cheque yet for
                  AI start-up Anthropic</h3>
                </a>
              </div>
            </li></ol></body></html>
            """
        )


def test_ft_infini_catalog_resolves_and_exports_licensed_copy(
    tmp_path: Path,
):
    connection = sqlite3.connect(":memory:")
    initialize_sitemap_schema(
        connection,
        source=sitemap_source("ft"),
        from_year=2024,
        to_year=2024,
        sitemap_index=INDEX_XML,
    )
    initialize_ft_syndication_schema(
        connection,
        from_year=2024,
        to_year=2024,
    )
    client = StubFtSyndicationClient()

    query_result = process_ft_infini_queries(
        connection,
        http_client=client,
        maximum_years=1,
    )
    document_result = process_ft_infini_documents(
        connection,
        http_client=client,
        maximum=1,
        workers=1,
        minimum_request_interval=0,
    )
    resolution_result = process_ft_syndication_resolutions(
        connection,
        http_client=client,
        maximum=1,
        minimum_request_interval=0,
    )
    connection.execute(
        """
        INSERT INTO sitemap_articles(
            canonical_url,
            published_at,
            source_sitemap,
            updated_at
        ) VALUES (?, ?, ?, ?)
        """,
        (
            (
                "https://www.ft.com/content/"
                "a604bc55-26a5-42ca-a707-e6537abe0c1d"
            ),
            "2024-03-15T12:00:00+00:00",
            "https://www.ft.com/sitemaps/2024-03.xml",
            "2024-03-28T16:00:00+00:00",
        ),
    )
    connection.commit()
    destination = tmp_path / "ft-syndication-manifest.jsonl.gz"
    manifest = export_sitemap_manifest(
        connection,
        publisher="ft",
        destination=destination,
        from_year=2024,
        to_year=2024,
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
    assert resolution_result == {
        "attempted": 1,
        "resolved": 1,
        "notFound": 0,
        "errors": [],
    }
    assert ft_syndication_summary(connection) == {
        "queriesByStatus": {"complete": 1},
        "occurrencesByStatus": {"accepted": 1},
        "resolutionsByStatus": {"resolved": 1},
        "articlesByYear": {"2024": 1},
        "articles": 1,
        "shouldContinue": False,
    }
    assert manifest["articles"] == 1
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    assert row["canonicalUrl"] == (
        "https://www.ft.com/content/"
        "a604bc55-26a5-42ca-a707-e6537abe0c1d"
    )
    assert row["publishedAt"] == "2024-03-28T00:00:00+00:00"
    assert row["candidates"][0] == {
        "provider": "other",
        "snapshotUrl": (
            "https://www.irishtimes.com/business/2024/03/28/"
            "amazon-invests-in-ai-start-up/"
        ),
        "expectedHeadline": (
            "Amazon writes its largest venture cheque yet "
            "for AI start-up Anthropic"
        ),
    }
    assert row["candidates"][1] == {
        "provider": "infini-news",
        "snapshotUrl": (
            "https://datasets-server.huggingface.co/rows?"
            "dataset=ruggsea%2Finfini-news-corpus&config=year_2024&"
            "split=train&offset=12345&length=1"
        ),
        "sourceUrl": (
            "https://www.irishtimes.com/business/2024/03/28/"
            "amazon-invests-in-ai-start-up/"
        ),
        "expectedHeadline": (
            "Amazon writes its largest venture cheque yet "
            "for AI start-up Anthropic"
        ),
        "warcFilename": "CC-NEWS-20240328160318-02712.warc.gz",
    }


def test_ft_title_index_recovers_provenance_without_canonical_search(
    tmp_path: Path,
):
    catalog_path = tmp_path / "ft-discovery.sqlite3"
    connection = sqlite3.connect(catalog_path)
    initialize_ft_syndication_schema(
        connection,
        from_year=2024,
        to_year=2024,
    )
    connection.execute(
        """
        INSERT INTO ft_syndication_unresolved(
            partner_url,
            published_at,
            expected_headline,
            source_year,
            document_index,
            warc_source,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "https://www.irishtimes.com/world/europe/2024/02/28/"
            "russians-rehearsed-using-tactical-nuclear-weapons/",
            "2024-02-28T00:00:00+00:00",
            "Russians rehearsed using tactical nuclear weapons "
            "at early stage of conflict",
            2024,
            26225947,
            "CC-NEWS-20240228173301-02619.warc.gz",
            "2024-03-01T00:00:00+00:00",
        ),
    )
    connection.commit()
    connection.close()

    index = load_ft_syndication_title_index(catalog_path)
    candidates = index.candidates_for(
        published_at="2024-02-28T12:00:00+00:00",
        headline=(
            "Russians rehearsed using tactical nuclear weapons "
            "at early stage of conflict"
        ),
    )

    assert index.size == 1
    assert [candidate.provider.value for candidate in candidates] == [
        "other",
        "infini-news",
    ]
    assert candidates[1].snapshot_url.endswith(
        "config=year_2024&split=train&offset=26225947&length=1"
    )
    assert candidates[1].warc_filename == (
        "CC-NEWS-20240228173301-02619.warc.gz"
    )
    assert candidates[0].expected_headline == (
        "Russians rehearsed using tactical nuclear weapons "
        "at early stage of conflict"
    )
    assert index.candidates_for(
        published_at="2024-03-10T00:00:00+00:00",
        headline=candidates[1].expected_headline or "",
    ) == ()

def test_ft_catalog_work_is_balanced_across_years():
    connection = sqlite3.connect(":memory:")
    initialize_ft_syndication_schema(
        connection,
        from_year=2016,
        to_year=2018,
    )
    now = datetime.now(timezone.utc).isoformat()
    for year in range(2016, 2019):
        for rank in range(3):
            connection.execute(
                """
                INSERT INTO ft_syndication_occurrences(
                    year, shard_index, rank, updated_at
                ) VALUES (?, 0, ?, ?)
                """,
                (year, rank, now),
            )
            connection.execute(
                """
                INSERT INTO ft_syndication_unresolved(
                    partner_url,
                    published_at,
                    expected_headline,
                    source_year,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    f"https://partner.example/{year}/{rank}",
                    f"{year}-01-{rank + 1:02d}T00:00:00+00:00",
                    f"Financial Times licensed article {year} number {rank}",
                    year,
                    now,
                ),
            )
    connection.commit()

    document_rows = _next_document_rows(connection, maximum=6)
    assert [row[0] for row in document_rows] == [
        2018,
        2017,
        2016,
        2018,
        2017,
        2016,
    ]
    resolution_rows = _next_resolution_rows(connection, maximum=6)
    assert [int(row[3]) for row in resolution_rows] == [
        2018,
        2017,
        2016,
        2018,
        2017,
        2016,
    ]


def test_ft_original_resolution_rejects_partial_title_match():
    expected_headline = (
        "Amazon writes its largest venture cheque yet "
        "for AI start-up Anthropic"
    )
    canonical_url = (
        "https://www.ft.com/content/"
        "a604bc55-26a5-42ca-a707-e6537abe0c1d"
    )

    class PartialTitleClient:
        def get(self, url, params, headers=None):
            assert url == "https://search.yahoo.com/search"
            assert params["p"] in {
                f'"{expected_headline}" site:ft.com',
                f'"{expected_headline}"',
            }
            assert headers and headers["User-Agent"].startswith(
                "Mozilla/5.0"
            )
            return StubFtSyndicationResponse(
                html_value=f"""
                <html><body><ol id="web"><li>
                  <div class="compTitle"><a href="{canonical_url}">
                    <h3>Amazon writes largest venture cheque for Anthropic</h3>
                  </a></div>
                </li></ol></body></html>
                """
            )

    result = resolve_ft_original_url(
        expected_headline,
        spec=archive_source_spec("ft"),
        http_client=PartialTitleClient(),
    )

    assert result is None


def test_ft_original_resolution_retries_yahoo_without_site_filter():
    expected_headline = (
        "AI forecast to put 200,000 European banking jobs at risk by 2030"
    )
    canonical_url = (
        "https://www.ft.com/content/"
        "71e12f85-1edb-4156-8cb5-3fe8aef36d93"
    )
    encoded_url = (
        "https%3a%2f%2fwww.ft.com%2fcontent%2f"
        "71e12f85-1edb-4156-8cb5-3fe8aef36d93"
    )

    class BroadYahooClient:
        def get(self, url, params, headers=None):
            assert url == "https://search.yahoo.com/search"
            assert headers and headers["User-Agent"].startswith(
                "Mozilla/5.0"
            )
            if params["p"].endswith("site:ft.com"):
                return StubFtSyndicationResponse(
                    html_value="<html><ol id='web'></ol></html>"
                )
            assert params["p"] == f'"{expected_headline}"'
            return StubFtSyndicationResponse(
                html_value=f"""
                <html><body><ol id="web"><li>
                  <div class="compTitle">
                    <a href="https://r.search.yahoo.com/RU={encoded_url}/RK=2">
                      <h3>{expected_headline}</h3>
                    </a>
                  </div>
                </li></ol></body></html>
                """
            )

    result = resolve_ft_original_url(
        expected_headline,
        spec=archive_source_spec("ft"),
        http_client=BroadYahooClient(),
    )

    assert result == canonical_url


def test_ft_original_resolution_uses_strict_google_news_fallback(
    monkeypatch,
):
    expected_headline = (
        "Microsoft chief Satya Nadella warns AI boom could falter "
        "without wider adoption"
    )
    canonical_url = (
        "https://www.ft.com/content/"
        "2a29cbc9-7183-4f68-a1d2-bc88189672e6"
    )
    google_news_url = (
        "https://news.google.com/rss/articles/ENCODED-ID"
    )

    class GoogleFallbackClient:
        def get(self, url, params, headers=None):
            assert headers and headers["User-Agent"].startswith(
                "Mozilla/5.0"
            )
            if url == "https://search.yahoo.com/search":
                return StubFtSyndicationResponse(
                    html_value="<html><ol id='web'></ol></html>"
                )
            assert url == "https://news.google.com/rss/search"
            assert params == {
                "q": f"{expected_headline} site:ft.com",
                "hl": "en-US",
                "gl": "US",
                "ceid": "US:en",
            }
            return StubFtSyndicationResponse(
                html_value=f"""
                <rss><channel><item>
                  <title>
                    AI boom could falter without wider adoption,
                    Microsoft chief Satya Nadella warns - Financial Times
                  </title>
                  <link>{google_news_url}</link>
                  <pubDate>Tue, 20 Jan 2026 08:00:00 GMT</pubDate>
                </item></channel></rss>
                """
            )

    def decode_google_news_url(http_client, url):
        assert isinstance(http_client, GoogleFallbackClient)
        assert url == google_news_url
        return canonical_url

    monkeypatch.setattr(
        "jojo_news_archive.discovery.ft_syndication._decode_google_news_url",
        decode_google_news_url,
    )

    result = resolve_ft_original_url(
        expected_headline,
        expected_published_at="2026-01-20T00:00:00+00:00",
        spec=archive_source_spec("ft"),
        http_client=GoogleFallbackClient(),
    )

    assert result == canonical_url


def test_ft_original_resolution_uses_google_news_when_yahoo_errors(
    monkeypatch,
):
    expected_headline = (
        "Microsoft chief Satya Nadella warns AI boom could falter "
        "without wider adoption"
    )
    canonical_url = (
        "https://www.ft.com/content/"
        "2a29cbc9-7183-4f68-a1d2-bc88189672e6"
    )

    class YahooErrorClient:
        def get(self, url, params, headers=None):
            if url == "https://search.yahoo.com/search":
                return httpx.Response(
                    500,
                    request=httpx.Request("GET", url),
                )
            return StubFtSyndicationResponse(
                html_value="""
                <rss><channel><item>
                  <title>
                    AI boom could falter without wider adoption,
                    Microsoft chief Satya Nadella warns - Financial Times
                  </title>
                  <link>
                    https://news.google.com/rss/articles/ENCODED-ID
                  </link>
                  <pubDate>Tue, 20 Jan 2026 08:00:00 GMT</pubDate>
                </item></channel></rss>
                """
            )

    monkeypatch.setattr(
        "jojo_news_archive.discovery.ft_syndication._decode_google_news_url",
        lambda http_client, url: canonical_url,
    )

    result = resolve_ft_original_url(
        expected_headline,
        expected_published_at="2026-01-20T00:00:00+00:00",
        spec=archive_source_spec("ft"),
        http_client=YahooErrorClient(),
    )

    assert result == canonical_url


def test_ft_original_resolution_rejects_google_news_date_mismatch(
    monkeypatch,
):
    expected_headline = (
        "Microsoft chief Satya Nadella warns AI boom could falter "
        "without wider adoption"
    )
    decoder_called = False

    class WrongDateClient:
        def get(self, url, params, headers=None):
            if url == "https://search.yahoo.com/search":
                return StubFtSyndicationResponse(
                    html_value="<html><ol id='web'></ol></html>"
                )
            return StubFtSyndicationResponse(
                html_value="""
                <rss><channel><item>
                  <title>
                    AI boom could falter without wider adoption,
                    Microsoft chief Satya Nadella warns - Financial Times
                  </title>
                  <link>
                    https://news.google.com/rss/articles/ENCODED-ID
                  </link>
                  <pubDate>Tue, 13 Jan 2026 08:00:00 GMT</pubDate>
                </item></channel></rss>
                """
            )

    def decode_google_news_url(http_client, url):
        nonlocal decoder_called
        decoder_called = True
        return (
            "https://www.ft.com/content/"
            "2a29cbc9-7183-4f68-a1d2-bc88189672e6"
        )

    monkeypatch.setattr(
        "jojo_news_archive.discovery.ft_syndication._decode_google_news_url",
        decode_google_news_url,
    )

    result = resolve_ft_original_url(
        expected_headline,
        expected_published_at="2026-01-20T00:00:00+00:00",
        spec=archive_source_spec("ft"),
        http_client=WrongDateClient(),
    )

    assert result is None
    assert decoder_called is False


def test_index_and_url_sitemap_parsing():
    source = sitemap_source("nyt")
    children = parse_sitemap_index(
        INDEX_XML,
        source=source,
        from_year=2020,
        to_year=2020,
    )
    assert children == [
        (
            "https://www.nytimes.com/sitemaps/new/sitemap-2020-01.xml.gz",
            2020,
            1,
        )
    ]
    assert parse_url_sitemap(URL_XML)[0][1] == "2020-01-14T10:00:00Z"


def test_aljazeera_archive_and_daily_sitemap_indexes_are_combined():
    archive_index = b"""<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://www.aljazeera.com/sitemaps/article-archive/2012/01.xml</loc></sitemap>
      <sitemap><loc>https://www.aljazeera.com/sitemaps/article-archive/2009/12.xml</loc></sitemap>
    </sitemapindex>
    """
    daily_index = b"""<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://www.aljazeera.com/sitemaps/article-new/10-08-2026.xml</loc></sitemap>
      <sitemap><loc>https://www.aljazeera.com/sitemaps/article-new/31-12-2025.xml</loc></sitemap>
    </sitemapindex>
    """
    source = sitemap_source("aljazeera")
    assert parse_sitemap_index(
        archive_index,
        source=source,
        from_year=2010,
        to_year=2026,
    ) == [
        (
            "https://www.aljazeera.com/sitemaps/"
            "article-archive/2012/01.xml",
            2012,
            1,
        )
    ]
    assert parse_sitemap_index(
        daily_index,
        source=source,
        from_year=2026,
        to_year=2026,
    ) == [
        (
            "https://www.aljazeera.com/sitemaps/"
            "article-new/10-08-2026.xml",
            2026,
            8,
        )
    ]

    connection = sqlite3.connect(":memory:")
    initialize_sitemap_schema(
        connection,
        source=source,
        from_year=2010,
        to_year=2026,
        sitemap_index=archive_index,
        supplemental_sitemap_indexes=(daily_index,),
    )
    assert connection.execute(
        """
        SELECT sitemap_url, year, month
        FROM sitemap_queries
        ORDER BY year, month, sitemap_url
        """
    ).fetchall() == [
        (
            "https://www.aljazeera.com/sitemaps/"
            "article-archive/2012/01.xml",
            2012,
            1,
        ),
        (
            "https://www.aljazeera.com/sitemaps/"
            "article-new/31-12-2025.xml",
            2025,
            12,
        ),
        (
            "https://www.aljazeera.com/sitemaps/"
            "article-new/10-08-2026.xml",
            2026,
            8,
        ),
    ]


def test_zaobao_monthly_sitemap_index_is_supported():
    content = b"""<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://www.zaobao.com.sg/sitemaps/sitemap-201601.xml</loc></sitemap>
      <sitemap><loc>https://www.zaobao.com.sg/sitemaps/sitemap-202608.xml</loc></sitemap>
    </sitemapindex>
    """
    assert parse_sitemap_index(
        content,
        source=sitemap_source("zaobao"),
        from_year=2016,
        to_year=2026,
    ) == [
        (
            "https://www.zaobao.com.sg/sitemaps/sitemap-201601.xml",
            2016,
            1,
        ),
        (
            "https://www.zaobao.com.sg/sitemaps/sitemap-202608.xml",
            2026,
            8,
        ),
    ]


def test_axios_monthly_sitemap_excludes_local_editions():
    content = b"""<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://www.axios.com/sitemaps/jan-2025.xml</loc></sitemap>
      <sitemap><loc>https://www.axios.com/sitemaps/aug-2026.xml</loc></sitemap>
      <sitemap><loc>https://www.axios.com/sitemaps/austin/aug-2026.xml</loc></sitemap>
      <sitemap><loc>https://www.axios.com/sitemaps/news.xml</loc></sitemap>
    </sitemapindex>
    """
    assert parse_sitemap_index(
        content,
        source=sitemap_source("axios"),
        from_year=2025,
        to_year=2026,
    ) == [
        ("https://www.axios.com/sitemaps/jan-2025.xml", 2025, 1),
        ("https://www.axios.com/sitemaps/aug-2026.xml", 2026, 8),
    ]


def test_axios_local_sitemap_selects_only_local_editions():
    content = b"""<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://www.axios.com/sitemaps/jan-2017.xml</loc></sitemap>
      <sitemap><loc>https://www.axios.com/sitemaps/charlotte/jan-2017.xml</loc></sitemap>
      <sitemap><loc>https://www.axios.com/sitemaps/austin/aug-2026.xml</loc></sitemap>
      <sitemap><loc>https://www.axios.com/sitemaps/news.xml</loc></sitemap>
    </sitemapindex>
    """
    assert parse_sitemap_index(
        content,
        source=sitemap_source("axios-local"),
        from_year=2017,
        to_year=2026,
    ) == [
        ("https://www.axios.com/sitemaps/charlotte/jan-2017.xml", 2017, 1),
        ("https://www.axios.com/sitemaps/austin/aug-2026.xml", 2026, 8),
    ]


def test_scmp_official_archive_uses_named_months():
    content = b"""<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://www.scmp.com/sitemap/archives/articles/2020_jan.xml</loc></sitemap>
      <sitemap><loc>https://www.scmp.com/sitemap/archives/articles/2021_DEC.xml</loc></sitemap>
      <sitemap><loc>https://www.scmp.com/sitemap/archives/articles/2019_dec.xml</loc></sitemap>
    </sitemapindex>
    """
    source = sitemap_source("scmp")

    assert source.index_url == (
        "https://www.scmp.com/sitemap/archives-0.xml"
    )
    assert parse_sitemap_index(
        content,
        source=source,
        from_year=2020,
        to_year=2021,
    ) == [
        (
            "https://www.scmp.com/sitemap/archives/articles/2020_jan.xml",
            2020,
            1,
        ),
        (
            "https://www.scmp.com/sitemap/archives/articles/2021_DEC.xml",
            2021,
            12,
        ),
    ]


def test_repairs_known_historical_sitemap_xml_defects():
    content = b"""<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url>
        <loc>https://www.ft.com/content/12345678-1234-1234-1234-123456789abc?x=1&y=2</loc>
        <lastmod>2015-03-02T10:00:00Z</lastmod>
      </url>
      <url>
        <loc>https://www.ft.com/content/abcdefab-1234-1234-1234-abcdefabcdef</loc>
        <lastmod>2015-03-03T10:00:00Z</lastmod>
      </url>\x0b
    </urlset>"""
    assert parse_url_sitemap(content) == [
        (
            "https://www.ft.com/content/"
            "12345678-1234-1234-1234-123456789abc?x=1&y=2",
            "2015-03-02T10:00:00Z",
        ),
        (
            "https://www.ft.com/content/"
            "abcdefab-1234-1234-1234-abcdefabcdef",
            "2015-03-03T10:00:00Z",
        ),
    ]


def test_sitemap_state_exports_publication_near_wayback_candidates(
    tmp_path: Path,
):
    source = sitemap_source("nyt")
    connection = sqlite3.connect(":memory:")
    initialize_sitemap_schema(
        connection,
        source=source,
        from_year=2020,
        to_year=2020,
        sitemap_index=INDEX_XML,
    )
    query = next_sitemap_query(connection)
    assert query is not None
    result = record_sitemap(
        connection,
        publisher_spec=archive_source_spec("nyt"),
        sitemap_url=query[0],
        year=query[1],
        month=query[2],
        content=URL_XML,
    )
    destination = tmp_path / "manifest.jsonl.gz"
    summary = export_sitemap_manifest(
        connection,
        publisher="nyt",
        destination=destination,
        from_year=2020,
        to_year=2020,
    )

    assert result == {"seen": 2, "accepted": 1}
    assert summary["complete"] is True
    assert summary["articles"] == 1
    assert summary["candidates"] == 3
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    item = manifest_item_from_row(row, publisher="nyt")
    assert item.published_at == "2020-01-14T00:00:00+00:00"
    assert len(item.candidates) == 3
    assert "/web/20200115000000id_/" in item.candidates[0].snapshot_url
    assert item.candidates[0].captured_at is None


def test_ft_sitemap_manifest_merges_exact_wayback_urlkey_discovery(
    tmp_path: Path,
):
    source = sitemap_source("ft")
    spec = archive_source_spec("ft")
    overlapping_url = (
        "https://www.ft.com/content/"
        "a604bc55-26a5-42ca-a707-e6537abe0c1d"
    )
    discovered_url = (
        "https://www.ft.com/content/"
        "6eb9ad7b-c5eb-47e4-b27a-3d536fefe99a"
    )
    out_of_window_url = (
        "https://www.ft.com/content/"
        "31fb47f2-9782-11e6-a1dc-bdf38d484582"
    )
    index = b"""<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap>
        <loc>https://www.ft.com/sitemaps/archive-2024-03.xml</loc>
      </sitemap>
    </sitemapindex>
    """
    sitemap = f"""<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url>
        <loc>{overlapping_url}</loc>
        <lastmod>2024-03-28T12:00:00Z</lastmod>
      </url>
    </urlset>
    """.encode()
    connection = sqlite3.connect(":memory:")
    initialize_sitemap_schema(
        connection,
        source=source,
        from_year=2024,
        to_year=2024,
        sitemap_index=index,
    )
    sitemap_query = next_sitemap_query(connection)
    assert sitemap_query is not None
    record_sitemap(
        connection,
        publisher_spec=spec,
        sitemap_url=sitemap_query[0],
        year=sitemap_query[1],
        month=sitemap_query[2],
        content=sitemap,
    )
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2024,
        to_year=2024,
        collapse="urlkey",
    )
    pattern, _ = next_discovery_query(connection)
    record_discovery_page(
        connection,
        spec=spec,
        pattern=pattern,
        page=CDXPage(
            captures=(
                CDXCapture(
                    timestamp="20240328121500",
                    original=overlapping_url,
                    mimetype="text/html",
                    status_code=200,
                    digest="OVERLAP",
                    length=52_000,
                ),
                CDXCapture(
                    timestamp="20240402100000",
                    original=discovered_url,
                    mimetype="text/html",
                    status_code=200,
                    digest="DISCOVERED",
                    length=63_000,
                ),
                CDXCapture(
                    timestamp="20131005100000",
                    original=out_of_window_url,
                    mimetype="text/html",
                    status_code=200,
                    digest="OUT-OF-WINDOW",
                    length=61_000,
                ),
            ),
            resume_key=None,
        ),
    )
    connection.execute(
        """
        INSERT INTO candidates(
            canonical_url,
            published_at,
            timestamp,
            original_url,
            digest,
            mimetype,
            status_code,
            byte_count,
            rank_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            out_of_window_url,
            "2013-10-05T10:00:00+00:00",
            "20131005100000",
            out_of_window_url,
            "OUT-OF-WINDOW-MANUAL",
            "text/html",
            200,
            61_000,
            0,
        ),
    )

    destination = tmp_path / "ft-merged-manifest.jsonl.gz"
    summary = export_sitemap_manifest(
        connection,
        publisher="ft",
        destination=destination,
        from_year=2024,
        to_year=2024,
    )
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle]
    by_url = {row["canonicalUrl"]: row for row in rows}

    assert summary["articles"] == 2
    assert set(by_url) == {overlapping_url, discovered_url}
    assert out_of_window_url not in by_url
    overlap = manifest_item_from_row(
        by_url[overlapping_url],
        publisher="ft",
    )
    discovered = manifest_item_from_row(
        by_url[discovered_url],
        publisher="ft",
    )
    assert overlap.published_at == "2024-03-28T12:00:00+00:00"
    assert overlap.candidates[0].digest == "OVERLAP"
    assert overlap.candidates[0].captured_at is not None
    assert discovered.candidates[0].digest == "DISCOVERED"
    assert discovered.candidates[0].captured_at is not None
    assert discovered.canonical_url == discovered_url


def test_candidate_fallback_for_unknown_publication_date_uses_latest():
    result = wayback_candidates(
        "https://www.ft.com/content/example",
        published_at=None,
    )
    assert result == [
        {
            "provider": "wayback",
            "snapshotUrl": (
                "https://web.archive.org/web/2id_/"
                "https://www.ft.com/content/example"
            ),
        }
    ]


def test_ft_sitemap_candidates_try_amp_before_canonical():
    result = sitemap_wayback_candidates(
        "ft",
        "https://www.ft.com/content/fd3df9ba-4480-11ea-abea-0c7a29cd66fe",
        published_at="2020-02-01T00:00:00Z",
    )

    assert len(result) == 6
    assert result[0]["snapshotUrl"].endswith(
        "https://amp.ft.com/content/fd3df9ba-4480-11ea-abea-0c7a29cd66fe"
    )
    assert result[3]["snapshotUrl"].endswith(
        "https://www.ft.com/content/fd3df9ba-4480-11ea-abea-0c7a29cd66fe"
    )


def test_current_year_sitemap_candidates_include_live_fallback():
    year = datetime.now(timezone.utc).year
    canonical_url = (
        f"https://www.nytimes.com/{year}/01/02/world/example.html"
    )

    result = sitemap_wayback_candidates(
        "nyt",
        canonical_url,
        published_at=f"{year}-01-02T00:00:00+00:00",
    )

    assert len(result) == 4
    assert result[-1] == {
        "provider": "live-origin",
        "snapshotUrl": canonical_url,
    }


def test_nyt_partner_catalog_adds_exact_canonical_direct_candidate(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.nytimes.com/2026/04/15/us/"
        "floods-michigan-cheboygan-dams-evacuation.html"
    )
    syndicated_url = (
        "https://www.hawaiitribune-herald.com/2026/04/16/"
        "nation-world-news/dam-failure-could-imperil-thousands/"
    )
    connection = sqlite3.connect(":memory:")
    initialize_sitemap_schema(
        connection,
        source=sitemap_source("nyt"),
        from_year=2026,
        to_year=2026,
        sitemap_index=INDEX_XML,
    )
    initialize_nyt_syndication_schema(
        connection,
        from_year=2026,
        to_year=2026,
    )
    query = next_nyt_syndication_query(connection)
    assert query is not None
    year, page, request_url = query
    content = json.dumps(
        [
            {
                "date": "2026-04-16T00:05:00",
                "date_gmt": "2026-04-16T10:05:00",
                "link": syndicated_url,
                "title": {
                    "rendered": (
                        "Dam failure could imperil thousands "
                        "in Northern Michigan"
                    )
                },
                "content": {
                    "rendered": (
                        "<p>Full licensed article body.</p>"
                        "<ins>This article originally appeared in "
                        f'<a href="{canonical_url}">'
                        "The New York Times</a>.</ins>"
                    )
                },
            },
            {
                "date": "2026-04-16T00:05:00",
                "link": "https://example.com/unrelated",
                "title": {"rendered": "Unrelated article"},
                "content": {"rendered": "<p>No canonical source link.</p>"},
            },
        ]
    ).encode()
    result = record_nyt_syndication_page(
        connection,
        year=year,
        page=page,
        request_url=request_url,
        content=content,
        total_pages=2,
    )

    assert result == {
        "seen": 2,
        "accepted": 1,
        "unresolved": 0,
        "totalPages": 2,
    }
    next_query = next_nyt_syndication_query(connection)
    assert next_query is not None
    assert next_query[0:2] == (2026, 2)
    assert nyt_syndication_summary(connection) == {
        "queriesByStatus": {"complete": 1, "pending": 1},
        "articles": 1,
        "resolutionByStatus": {},
        "resolutionNeeded": 0,
        "shouldContinue": True,
    }

    destination = tmp_path / "nyt-partner-manifest.jsonl.gz"
    summary = export_sitemap_manifest(
        connection,
        publisher="nyt",
        destination=destination,
        from_year=2026,
        to_year=2026,
    )
    assert summary["articles"] == 1
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    item = manifest_item_from_row(row, publisher="nyt")
    assert item.canonical_url == canonical_url
    assert item.published_at == "2026-04-15T00:00:00+00:00"
    assert item.candidates[0].provider.value == "other"
    assert item.candidates[0].snapshot_url == syndicated_url
    assert (
        item.candidates[0].expected_headline
        == "Dam failure could imperil thousands in Northern Michigan"
    )


def test_nyt_partner_catalog_resolves_legacy_copy_by_title_and_date():
    canonical_url = (
        "https://www.nytimes.com/2024/01/01/upshot/"
        "2024-election-trump-biden.html"
    )
    syndicated_url = (
        "https://www.hawaiitribune-herald.com/2024/01/02/"
        "nation-world-news/looking-ahead-to-five-things/"
    )
    headline = "Looking ahead to 5 things that will shape the 2024 election"
    connection = sqlite3.connect(":memory:")
    initialize_nyt_syndication_schema(
        connection,
        from_year=2024,
        to_year=2024,
    )
    query = next_nyt_syndication_query(connection)
    assert query is not None
    year, page, request_url = query
    result = record_nyt_syndication_page(
        connection,
        year=year,
        page=page,
        request_url=request_url,
        content=json.dumps(
            [
                {
                    "date": "2024-01-02T00:05:00",
                    "date_gmt": "2024-01-02T10:05:00",
                    "link": syndicated_url,
                    "title": {"rendered": headline},
                    "content": {
                        "rendered": (
                            "<p>Legacy full body without a source link.</p>"
                        )
                    },
                }
            ]
        ).encode(),
        total_pages=1,
    )
    assert result["accepted"] == 0
    assert result["unresolved"] == 1
    resolution = next_nyt_syndication_resolution(connection)
    assert resolution is not None
    search_html = f"""
    <html><body><ol id="web"><li><div class="compTitle">
      <a href="{canonical_url}"><h3>
        Looking Ahead to 5 Things That Will Shape the 2024 Election
      </h3></a>
    </div></li></ol></body></html>
    """.encode()
    resolved = resolve_nyt_syndication_search(
        search_html,
        headline=headline,
        partner_published_at="2024-01-02T10:05:00",
    )
    assert resolved == (
        canonical_url,
        "2024-01-01T00:00:00+00:00",
    )
    record_nyt_syndication_resolution(
        connection,
        syndicated_url=syndicated_url,
        partner_published_at="2024-01-02T10:05:00",
        headline=headline,
        source_endpoint="https://example.com/wp-json/wp/v2/posts",
        resolved=resolved,
    )
    assert next_nyt_syndication_resolution(connection) is None
    assert nyt_syndication_summary(connection) == {
        "queriesByStatus": {"complete": 1},
        "articles": 1,
        "resolutionByStatus": {"complete": 1},
        "resolutionNeeded": 0,
        "shouldContinue": False,
    }


def test_ap_historical_sitemap_candidates_include_live_fallback():
    canonical_url = (
        "https://apnews.com/article/"
        "historical-story-0123456789abcdef0123456789abcdef"
    )

    result = sitemap_wayback_candidates(
        "ap",
        canonical_url,
        published_at="2016-01-15T12:00:00+00:00",
    )

    assert len(result) == 4
    assert result[0] == {
        "provider": "live-origin",
        "snapshotUrl": canonical_url,
    }
    assert all(
        candidate["provider"] == "wayback"
        for candidate in result[1:]
    )
