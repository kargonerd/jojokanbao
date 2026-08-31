from __future__ import annotations

from dataclasses import replace
import gzip
import json
from pathlib import Path
import sqlite3

import httpx
import pytest

from jojo_news_archive.sources.ft.spec import ft_content_uuid_creation_year
from jojo_news_archive.sources.registry import (
    archive_source_spec,
    article_deduplication_key,
    article_url_publication_year,
    is_parser_validation_candidate,
    normalize_article_url,
)
from jojo_news_archive.capture.raw import manifest_item_from_row
from jojo_news_archive.sources.wsj.discovery.syndication import (
    initialize_wsj_syndication_schema,
    process_wsj_syndication_catalog,
    process_wsj_syndication_resolutions,
    resolve_wsj_original_url,
    wsj_syndication_count_for_year,
)
from jojo_news_archive.discovery.wayback import (
    CDXCapture,
    CDXPage,
    candidate_rank,
    discovery_summary,
    export_capture_manifest,
    extract_archived_published_at,
    infer_published_at,
    initialize_discovery_schema,
    initialize_archived_date_schema,
    next_discovery_query,
    parse_cdx_json,
    process_archived_dates,
    record_discovery_page,
    record_discovery_failure,
)
from jojo_news_archive.sources.wsj.discovery.wayback import (
    extract_wsj_legacy_published_at,
    initialize_wsj_legacy_date_schema,
    initialize_wsj_bluesky_schema,
    initialize_wsj_google_news_schema,
    initialize_wsj_rss_schema,
    process_wsj_bluesky_page,
    process_wsj_google_news_feed,
    process_wsj_rss_feeds,
    wsj_catalog_count_for_year,
    wsj_catalog_ready_for_capture,
    wsj_google_news_is_only_catalog_gap,
    wsj_google_news_should_continue,
)


def test_extract_wsj_legacy_published_at_from_at_vars():
    assert extract_wsj_legacy_published_at(
        """<script>AT_VARS = {publicationDate:'2003-01-27'};</script>"""
    ) == "2003-01-27T00:00:00+00:00"


def test_extract_wsj_legacy_published_at_from_json_ld():
    assert extract_wsj_legacy_published_at(
        """<script>{"datePublished":"2014-06-03T12:34:56Z"}</script>"""
    ) == "2014-06-03T12:34:56+00:00"


def test_extract_scmp_archived_published_at_from_legacy_node():
    assert extract_archived_published_at(
        """
        <div class="panel-pane pane-node-created pos-6">
          <div class="pane-content">
            Wednesday, 15 August, 2012, 2:10pm
          </div>
        </div>
        """,
        publisher="scmp",
    ) == "2012-08-15T14:10:00+08:00"


def test_extract_nikkei_archived_published_at_from_legacy_node():
    assert extract_archived_published_at(
        '<dd class="cmnc-publish">2013/9/11付</dd>',
        publisher="nikkei",
    ) == "2013-09-11T00:00:00+09:00"


def test_extract_nikkei_archived_published_at_from_json_ld():
    assert extract_archived_published_at(
        '<script type="application/ld+json">'
        '{"datePublished":"2015-03-18T05:30:00+09:00"}'
        "</script>",
        publisher="nikkei",
    ) == "2015-03-17T20:30:00+00:00"


def test_nikkei_archived_date_hydration_withholds_capture_year(
    tmp_path: Path,
):
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("nikkei")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2015,
        collapse="urlkey",
    )
    connection.execute("UPDATE discovery_queries SET status='complete'")
    canonical_url = (
        "https://www.nikkei.com/article/DGXNASFS1102U_R10C13A9PP8000"
    )
    connection.execute(
        """
        INSERT INTO candidates(
            canonical_url, published_at, timestamp, original_url,
            digest, mimetype, status_code, byte_count, rank_score
        ) VALUES (?, ?, ?, ?, '', 'text/html', 200, 1234, 0)
        """,
        (
            canonical_url,
            "2014-02-01T10:00:00+00:00",
            "20140201100000",
            canonical_url,
        ),
    )
    initialize_archived_date_schema(connection, publisher="nikkei")
    before = export_capture_manifest(
        connection,
        spec=spec,
        destination=tmp_path / "before.jsonl.gz",
        from_year=2010,
        to_year=2015,
    )
    assert before["articles"] == 0
    assert before["complete"] is False

    class Response:
        status_code = 200
        text = '<dd class="cmnc-publish">2013/9/11付</dd>'

        def raise_for_status(self):
            return None

    class Client:
        def get(self, url):
            assert "20140201100000id_" in url
            return Response()

    result = process_archived_dates(
        connection,
        publisher="nikkei",
        http_client=Client(),
        maximum=1,
    )
    assert result == {
        "attempted": 1,
        "found": 1,
        "noDate": 0,
        "failed": 0,
        "remaining": 0,
        "errors": [],
    }
    assert wsj_catalog_count_for_year(connection, 2013, spec=spec) == 1
    assert wsj_catalog_count_for_year(connection, 2014, spec=spec) == 0
    after_path = tmp_path / "after.jsonl.gz"
    after = export_capture_manifest(
        connection,
        spec=spec,
        destination=after_path,
        from_year=2010,
        to_year=2015,
    )
    assert after["articles"] == 1
    with gzip.open(after_path, "rt", encoding="utf-8") as handle:
        row = json.loads(next(handle))
    assert row["publishedAt"] == "2013-09-11T00:00:00+09:00"


def test_nikkei_archived_date_hydration_skips_stale_prefix_keys():
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("nikkei")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2015,
        collapse="urlkey",
    )
    valid_url = (
        "https://www.nikkei.com/article/DGXNASFS1102U_R10C13A9PP8000"
    )
    stale_urls = (
        "https://www.nikkei.com/article/D",
        "https://www.nikkei.com/article/"
        "DGKDASDC1600A_Y3A211C1FF2000/asset.js",
    )
    for index, canonical_url in enumerate((valid_url, *stale_urls)):
        connection.execute(
            """
            INSERT INTO candidates(
                canonical_url, published_at, timestamp, original_url,
                digest, mimetype, status_code, byte_count, rank_score
            ) VALUES (?, ?, ?, ?, ?, 'text/html', 200, 1234, 0)
            """,
            (
                canonical_url,
                "2014-02-01T10:00:00+00:00",
                f"2014020110000{index}",
                canonical_url,
                f"digest-{index}",
            ),
        )

    initialize_archived_date_schema(connection, publisher="nikkei")

    assert connection.execute(
        """
        SELECT canonical_url FROM archived_date_hydration
        ORDER BY canonical_url
        """
    ).fetchall() == [(valid_url,)]


def test_scmp_archived_date_hydration_withholds_capture_year(tmp_path: Path):
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("scmp")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2015,
        collapse="urlkey",
    )
    connection.execute("UPDATE discovery_queries SET status='complete'")
    canonical_url = (
        "https://www.scmp.com/article/1000041/"
        "change-media-group-raises-concern"
    )
    connection.execute(
        """
        INSERT INTO candidates(
            canonical_url, published_at, timestamp, original_url,
            digest, mimetype, status_code, byte_count, rank_score
        ) VALUES (?, ?, ?, ?, '', 'text/html', 200, 1234, 0)
        """,
        (
            canonical_url,
            "2013-06-15T17:27:27+00:00",
            "20130615172727",
            canonical_url,
        ),
    )
    initialize_archived_date_schema(connection, publisher="scmp")
    before = export_capture_manifest(
        connection,
        spec=spec,
        destination=tmp_path / "before.jsonl.gz",
        from_year=2010,
        to_year=2015,
    )
    assert before["articles"] == 0
    assert before["complete"] is False

    class Response:
        status_code = 200
        text = """
        <div class="pane-node-created">
          <div class="pane-content">
            Wednesday, 15 August, 2012, 2:10pm
          </div>
        </div>
        """

        def raise_for_status(self):
            return None

    class Client:
        def get(self, url):
            assert "20130615172727id_" in url
            return Response()

    result = process_archived_dates(
        connection,
        publisher="scmp",
        http_client=Client(),
        maximum=1,
    )
    assert result == {
        "attempted": 1,
        "found": 1,
        "noDate": 0,
        "failed": 0,
        "remaining": 0,
        "errors": [],
    }
    assert connection.execute(
        "SELECT published_at FROM candidates WHERE canonical_url=?",
        (canonical_url,),
    ).fetchone()[0] == "2012-08-15T14:10:00+08:00"
    assert wsj_catalog_count_for_year(connection, 2012, spec=spec) == 1
    assert wsj_catalog_count_for_year(connection, 2013, spec=spec) == 0
    after_path = tmp_path / "after.jsonl.gz"
    after = export_capture_manifest(
        connection,
        spec=spec,
        destination=after_path,
        from_year=2010,
        to_year=2015,
    )
    assert after["articles"] == 1
    with gzip.open(after_path, "rt", encoding="utf-8") as handle:
        row = json.loads(next(handle))
    assert row["publishedAt"] == "2012-08-15T14:10:00+08:00"


def test_discovery_schema_accepts_additive_wayback_patterns():
    connection = sqlite3.connect(":memory:")
    current = archive_source_spec("npr")
    original = replace(
        current,
        wayback_patterns=("www.npr.org/{year}/*",),
    )
    initialize_discovery_schema(
        connection,
        spec=original,
        from_year=2010,
        to_year=2010,
        collapse="urlkey",
    )
    connection.execute(
        "UPDATE discovery_queries SET status='complete'"
    )

    initialize_discovery_schema(
        connection,
        spec=current,
        from_year=2010,
        to_year=2010,
        collapse="urlkey",
    )

    assert connection.execute(
        "SELECT pattern, status FROM discovery_queries ORDER BY rowid"
    ).fetchall() == [
        ("www.npr.org/2010/*", "complete"),
        ("npr.org/2010/*", "pending"),
    ]


def test_discovery_schema_rejects_replaced_wayback_patterns():
    connection = sqlite3.connect(":memory:")
    current = archive_source_spec("npr")
    original = replace(
        current,
        wayback_patterns=("legacy.npr.org/{year}/*",),
    )
    initialize_discovery_schema(
        connection,
        spec=original,
        from_year=2010,
        to_year=2010,
        collapse="urlkey",
    )

    try:
        initialize_discovery_schema(
            connection,
            spec=current,
            from_year=2010,
            to_year=2010,
            collapse="urlkey",
        )
    except ValueError as exc:
        assert "different publisher, date window, or spec" in str(exc)
    else:
        raise AssertionError("replaced patterns must invalidate discovery state")


def test_discovery_schema_rejects_additive_patterns_from_another_scope():
    connection = sqlite3.connect(":memory:")
    current = archive_source_spec("npr")
    original = replace(
        current,
        wayback_patterns=("www.npr.org/{year}/*",),
    )
    initialize_discovery_schema(
        connection,
        spec=original,
        from_year=2010,
        to_year=2010,
        collapse="urlkey",
    )

    try:
        initialize_discovery_schema(
            connection,
            spec=replace(current, publisher="not-npr"),
            from_year=2010,
            to_year=2010,
            collapse="urlkey",
        )
    except ValueError as exc:
        assert "different publisher, date window, or spec" in str(exc)
    else:
        raise AssertionError("different publisher must invalidate discovery state")


def test_wsj_legacy_no_date_candidate_is_removed_from_year_pool():
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=archive_source_spec("wsj"),
        from_year=2010,
        to_year=2015,
        collapse="urlkey",
    )
    canonical_url = "https://www.wsj.com/articles/SB100014240527487"
    connection.execute(
        """
        INSERT INTO candidates(
            canonical_url, published_at, timestamp, original_url,
            digest, mimetype, status_code, byte_count, rank_score
        ) VALUES (?, ?, ?, ?, '', 'text/html', 200, 1234, 0)
        """,
        (
            canonical_url,
            "2012-04-03T12:00:00+00:00",
            "20120403120000",
            canonical_url,
        ),
    )
    initialize_wsj_legacy_date_schema(connection)
    connection.execute(
        """
        UPDATE wsj_legacy_date_hydration
        SET status='no-date'
        WHERE canonical_url=?
        """,
        (canonical_url,),
    )

    initialize_wsj_legacy_date_schema(connection)

    assert connection.execute(
        "SELECT COUNT(*) FROM candidates WHERE canonical_url=?",
        (canonical_url,),
    ).fetchone()[0] == 0


class StubWsjSyndicationResponse:
    def __init__(
        self,
        *,
        json_value: object | None = None,
        html_value: str = "",
        status_code: int = 200,
    ):
        self._json_value = json_value
        self.content = html_value.encode()
        self.text = html_value
        self.status_code = status_code

    def json(self):
        return self._json_value

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class StubWsjSyndicationClient:
    def __init__(self):
        self.requests: list[tuple[str, dict[str, str]]] = []

    def get(self, url, params, headers=None):
        self.requests.append((url, params))
        if url.endswith("/wp-json/wp/v2/posts"):
            return StubWsjSyndicationResponse(
                json_value=[
                    {
                        "id": 123,
                        "date_gmt": "2024-06-03T12:34:56",
                        "link": (
                            "https://www.tovima.com/wsj/"
                            "a-complete-licensed-wsj-copy/"
                        ),
                        "title": {
                            "rendered": (
                                "Investors Prepare for a Volatile "
                                "Summer in Global Markets"
                            )
                        },
                    },
                    {
                        "id": 456,
                        "date_gmt": "2024-06-04T12:34:56",
                        "link": "https://www.tovima.com/world/not-wsj/",
                        "title": {"rendered": "This row must be rejected"},
                    },
                ]
            )
        assert url == "https://search.yahoo.com/search"
        assert 'site:wsj.com' in params["p"]
        assert headers and headers["User-Agent"].startswith("Mozilla/5.0")
        canonical_url = (
            "https://www.wsj.com/finance/stocks/"
            "investors-prepare-for-a-volatile-summer-in-global-markets-"
            "a1b2c3d4"
        )
        return StubWsjSyndicationResponse(
            html_value=f"""
            <html><body><ol id="web"><li>
              <div class="compTitle"><a href="{canonical_url}">
                <h3>Investors Prepare for a Volatile Summer in Global
                Markets - The Wall Street Journal</h3>
              </a></div>
            </li></ol></body></html>
            """,
        )


def test_wsj_syndication_catalog_resolves_and_exports_partner_copy(
    tmp_path: Path,
):
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2024,
        to_year=2024,
        collapse="urlkey",
    )
    initialize_wsj_syndication_schema(connection)
    client = StubWsjSyndicationClient()

    catalog = process_wsj_syndication_catalog(
        connection,
        http_client=client,
        from_year=2024,
        to_year=2024,
        maximum_pages=1,
    )
    resolutions = process_wsj_syndication_resolutions(
        connection,
        spec=spec,
        http_client=client,
        maximum=10,
    )
    destination = tmp_path / "wsj-syndication-manifest.jsonl.gz"
    summary = export_capture_manifest(
        connection,
        spec=spec,
        destination=destination,
        from_year=2024,
        to_year=2024,
    )

    assert catalog == {
        "status": "complete",
        "pages": 1,
        "seen": 2,
        "accepted": 1,
    }
    assert resolutions == {
        "attempted": 1,
        "resolved": 1,
        "notFound": 0,
        "errors": [],
    }
    assert wsj_syndication_count_for_year(connection, 2024) == 1
    assert summary["articles"] == 1
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    assert row["canonicalUrl"] == (
        "https://www.wsj.com/finance/stocks/"
        "investors-prepare-for-a-volatile-summer-in-global-markets-a1b2c3d4"
    )
    assert row["publishedAt"] == "2024-06-03T12:34:56+00:00"
    assert row["candidates"][0] == {
        "provider": "other",
        "snapshotUrl": (
            "https://www.tovima.com/wsj/"
            "a-complete-licensed-wsj-copy/"
        ),
        "expectedHeadline": (
            "Investors Prepare for a Volatile Summer in Global Markets"
        ),
    }


def test_wsj_syndication_retries_not_found_after_resolver_upgrade():
    connection = sqlite3.connect(":memory:")
    initialize_wsj_syndication_schema(connection)
    connection.execute(
        """
        INSERT INTO wsj_syndication_articles(
            partner_url,
            published_at,
            expected_headline,
            resolution_status,
            resolution_attempts,
            updated_at
        ) VALUES (?, ?, ?, 'not-found', 3, ?)
        """,
        (
            "https://www.tovima.com/wsj/retry-this-copy/",
            "2024-06-03T12:34:56+00:00",
            "A Complete Wall Street Journal Headline",
            "2024-06-03T12:34:56+00:00",
        ),
    )
    connection.execute(
        """
        UPDATE wsj_syndication_metadata
        SET value='legacy-resolver'
        WHERE key='resolver_version'
        """
    )
    connection.commit()

    initialize_wsj_syndication_schema(connection)

    assert connection.execute(
        """
        SELECT resolution_status, resolution_attempts, last_error
        FROM wsj_syndication_articles
        """
    ).fetchone() == ("pending", 0, None)


def test_wsj_syndication_uses_google_news_when_yahoo_errors(
    monkeypatch,
):
    headline = (
        "Trump Makes a Call and U.S. Soccer Gets a Star Back—and "
        "the World Cup Is Raging"
    )
    canonical_url = (
        "https://www.wsj.com/sports/soccer/"
        "balogun-red-card-fifa-trump-infantino-abd58604"
    )

    class GoogleFallbackClient:
        def get(self, url, params, headers=None):
            if url == "https://search.yahoo.com/search":
                return httpx.Response(
                    500,
                    request=httpx.Request("GET", url),
                )
            assert url == "https://news.google.com/rss/search"
            assert params["q"] == f"{headline} site:wsj.com"
            return StubWsjSyndicationResponse(
                html_value="""
                <rss><channel><item>
                  <title>
                    Trump Makes a Call and U.S. Soccer Gets a Star Back—and
                    the World Cup Is Raging - The Wall Street Journal
                  </title>
                  <link>
                    https://news.google.com/rss/articles/ENCODED-ID
                  </link>
                  <pubDate>Mon, 06 Jul 2026 07:00:00 GMT</pubDate>
                </item></channel></rss>
                """
            )

    monkeypatch.setattr(
        "jojo_news_archive.discovery.wayback._decode_google_news_url",
        lambda http_client, url: canonical_url,
    )

    result = resolve_wsj_original_url(
        headline,
        expected_published_at="2026-07-06T23:00:16+00:00",
        spec=archive_source_spec("wsj"),
        http_client=GoogleFallbackClient(),
    )

    assert result == canonical_url


def test_wsj_syndication_rejects_stale_google_news_match(
    monkeypatch,
):
    headline = (
        "Trump Makes a Call and U.S. Soccer Gets a Star Back—and "
        "the World Cup Is Raging"
    )
    decoder_called = False

    class StaleGoogleClient:
        def get(self, url, params, headers=None):
            if url == "https://search.yahoo.com/search":
                return StubWsjSyndicationResponse(
                    html_value="<html><ol id='web'></ol></html>"
                )
            return StubWsjSyndicationResponse(
                html_value="""
                <rss><channel><item>
                  <title>
                    Trump Makes a Call and U.S. Soccer Gets a Star Back—and
                    the World Cup Is Raging - The Wall Street Journal
                  </title>
                  <link>
                    https://news.google.com/rss/articles/ENCODED-ID
                  </link>
                  <pubDate>Mon, 01 Jun 2026 07:00:00 GMT</pubDate>
                </item></channel></rss>
                """
            )

    def decode_google_news_url(http_client, url):
        nonlocal decoder_called
        decoder_called = True
        return (
            "https://www.wsj.com/sports/soccer/"
            "balogun-red-card-fifa-trump-infantino-abd58604"
        )

    monkeypatch.setattr(
        "jojo_news_archive.discovery.wayback._decode_google_news_url",
        decode_google_news_url,
    )

    result = resolve_wsj_original_url(
        headline,
        expected_published_at="2026-07-06T23:00:16+00:00",
        spec=archive_source_spec("wsj"),
        http_client=StaleGoogleClient(),
    )

    assert result is None
    assert decoder_called is False


def test_parse_cdx_json_extracts_resume_key():
    payload = json.dumps(
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
                "20200102125527",
                "https://www.bloomberg.com/news/articles/2020-01-01/example",
                "text/html",
                "200",
                "DIGEST",
                "35034",
            ],
            [],
            ["opaque-resume-key"],
        ]
    )

    page = parse_cdx_json(payload)

    assert len(page.captures) == 1
    assert page.captures[0].length == 35_034
    assert page.resume_key == "opaque-resume-key"


def test_source_url_normalization_accepts_articles_and_rejects_hubs():
    ap = archive_source_spec("ap")
    assert normalize_article_url(
        ap,
        "http://www.apnews.com/article/example?utm_source=test",
    ) == "https://apnews.com/article/example"
    assert normalize_article_url(ap, "https://apnews.com/hub/world-news") is None
    assert normalize_article_url(
        ap,
        "http://hosted.ap.org/dynamic/stories/A/AF_IVORY_COAST"
        "?SITE=AZPHG&SECTION=HOME&TEMPLATE=DEFAULT"
        "&CTIME=2011-01-11-15-30-46",
    ) == (
        "https://hosted.ap.org/dynamic/stories/A/AF_IVORY_COAST"
        "?CTIME=2011-01-11-15-30-46"
    )
    assert normalize_article_url(
        ap,
        "https://hosted2.ap.org/dynamic/stories/A/AF_IVORY_COAST"
        "?ctime=2011-01-11-15-30-46&SITE=AP",
    ) == (
        "https://hosted.ap.org/dynamic/stories/A/AF_IVORY_COAST"
        "?CTIME=2011-01-11-15-30-46"
    )
    assert normalize_article_url(
        ap,
        "https://hosted.ap.org/dynamic/stories/A/AF_IVORY_COAST?SITE=AP",
    ) is None
    # Partner catalogs retain Yahoo/Google/HuffPost URLs for historical AP
    # wire copies. They must remain valid AP parser inputs so supplemental
    # holdout capacity is not discarded by URL normalization.
    assert normalize_article_url(
        ap,
        "http://news.yahoo.com/s/ap/20110111/ap_on_re_eu/iran_nuclear"
        "?utm_source=test",
    ) == "https://news.yahoo.com/s/ap/20110111/ap_on_re_eu/iran_nuclear"
    assert normalize_article_url(
        ap,
        "https://www.google.com/hostednews/ap/article/ALeqM5example"
        "?docId=123",
    ) == "https://www.google.com/hostednews/ap/article/ALeqM5example"
    assert normalize_article_url(
        ap,
        "https://www.huffingtonpost.com/huff-wires/20110111/example",
    ) == "https://www.huffingtonpost.com/huff-wires/20110111/example"
    assert normalize_article_url(
        ap,
        "https://news.yahoo.com/s/ap/20110111/not-an-ap-story",
    ) is None
    assert article_url_publication_year(
        ap,
        "https://news.yahoo.com/s/ap/20110111/ap_on_re_eu/iran_nuclear",
    ) == 2011
    assert article_url_publication_year(
        ap,
        "https://www.huffingtonpost.com/huff-wires/20101223/example",
    ) == 2010
    assert article_url_publication_year(
        ap,
        "http://hosted.ap.org/dynamic/stories/A/AF_IVORY_COAST"
        "?SITE=AP&CTIME=2011-01-11-15-30-46",
    ) == 2011

    wsj = archive_source_spec("wsj")
    assert normalize_article_url(
        wsj,
        (
            "https://www.wsj.com/politics/"
            "modern-section-article-a1b2c3d4?mod=social"
        ),
    ) == (
        "https://www.wsj.com/politics/"
        "modern-section-article-a1b2c3d4"
    )
    assert normalize_article_url(
        wsj,
        "https://www.wsj.com/politics",
    ) is None
    assert normalize_article_url(
        wsj,
        (
            "https://www.wsj.com/articles/"
            "B3-BY423_health_PREVIEW_20181003165352.jpg"
        ),
    ) is None
    assert normalize_article_url(
        wsj,
        (
            "https://www.wsj.com/articles/"
            "dish-on-this-wednesday-crossword-july-26-48a57b4"
        ),
    ) is None

    reuters = archive_source_spec("reuters")
    assert normalize_article_url(
        reuters,
        "https://www.reuters.com/article/comments/idUS123",
    ) is None
    assert normalize_article_url(
        reuters,
        "https://www.reuters.com/article/slideshow/idUS123",
    ) is None
    assert normalize_article_url(
        reuters,
        "https://www.reuters.com/article/idUSKBN12345620150101",
    ) == (
        "https://www.reuters.com/article/idUSKBN12345620150101"
    )
    assert normalize_article_url(
        reuters,
        "https://www.reuters.com/article/idUS123%3C/body%3E",
    ) is None
    assert normalize_article_url(
        reuters,
        "https://www.reuters.com/article/idUS12320090101%7C",
    ) is None
    assert article_url_publication_year(
        reuters,
        "https://www.reuters.com/article/idUSTRES57D23Q20090816",
    ) == 2009
    wsj = archive_source_spec("wsj")
    assert article_url_publication_year(
        wsj,
        "https://www.wsj.com/articles/"
        "afghans-mourn-for-bombing-victims-1416846693",
    ) == 2014
    assert article_url_publication_year(
        wsj,
        "https://www.wsj.com/articles/"
        "accenture-looks-to-boost-ai-capabilities-through-"
        "mergers-11592818200",
    ) == 2020
    assert article_url_publication_year(
        wsj,
        "https://www.wsj.com/articles/"
        "abbott-beats-forecasts-on-strong-covid-19-testing-"
        "business-151594900170",
    ) == 2020

    nikkei = archive_source_spec("nikkei")
    assert article_url_publication_year(
        nikkei,
        "https://www.nikkei.com/article/"
        "DGXNASFS1102U_R10C13A9PP8000",
    ) == 2013
    assert article_url_publication_year(
        nikkei,
        "https://www.nikkei.com/article/"
        "DGKKZO79997580R21C14A1NNJP00",
    ) == 2014
    assert article_url_publication_year(
        nikkei,
        "https://www.nikkei.com/article/"
        "DGKDZO27658310Z20C11A4ML0000",
    ) == 2011
    assert article_url_publication_year(
        nikkei,
        "https://www.nikkei.com/article/"
        "DGXBZO40155290U2A400C1000000",
    ) is None
    assert article_url_publication_year(
        archive_source_spec("nyt"),
        "https://www.nytimes.com/2018/04/24/world/example.html",
    ) == 2018
    assert article_url_publication_year(
        archive_source_spec("nyt"),
        "https://www.nytimes.com/interactive/2016/obituaries/"
        "notable-deaths/garry-shandling",
    ) == 2016
    assert article_url_publication_year(
        nikkei,
        "https://www.nikkei.com/article/DGXZQOCD00001",
    ) is None

    ft = archive_source_spec("ft")
    assert normalize_article_url(
        ft,
        "https://ft.com/content/12345678-1234-1234-1234-123456789abc?share=1",
    ) == (
        "https://www.ft.com/content/"
        "12345678-1234-1234-1234-123456789abc"
    )
    assert ft_content_uuid_creation_year(
        "https://www.ft.com/content/016f4238-ad19-11e8-89a1-e5de165fa619",
    ) == 2018
    assert ft_content_uuid_creation_year(
        "https://www.ft.com/content/0037ad8e-547f-11e4-b2ea-00144feab7de",
    ) == 2014
    assert ft_content_uuid_creation_year(
        "https://www.ft.com/content/00bd522e-2a38-41e0-b906-00144feab49a",
    ) is None

    assert normalize_article_url(
        archive_source_spec("axios"),
        "https://www.axios.com/2020/01/02/example?utm_source=test",
    ) == "https://www.axios.com/2020/01/02/example"
    assert normalize_article_url(
        archive_source_spec("axios"),
        "https://axios.com/2019/01/11/example-story--",
    ) == "https://www.axios.com/2019/01/11/example-story"
    for suffix in ("%5C", "%0A", "%20", "%5c%0a"):
        assert normalize_article_url(
            archive_source_spec("axios"),
            "https://www.axios.com/2025/01/20/example-story" + suffix,
        ) == "https://www.axios.com/2025/01/20/example-story"
    assert normalize_article_url(
        archive_source_spec("npr"),
        "https://www.npr.org/2018/02/03/123456789/example",
    ) == "https://www.npr.org/2018/02/03/123456789/example"
    assert normalize_article_url(
        archive_source_spec("npr"),
        "https://www.npr.org/2017/05/29/530555477/example%0A",
    ) == "https://www.npr.org/2017/05/29/530555477/example"
    assert normalize_article_url(
        archive_source_spec("npr"),
        "https://www.npr.org/2018/04/03/598239092/example=",
    ) == "https://www.npr.org/2018/04/03/598239092/example"
    assert normalize_article_url(
        archive_source_spec("npr"),
        "https://www.npr.org/2010/11/29/131667596/example&sc=fb&cc=fp",
    ) == "https://www.npr.org/2010/11/29/131667596/example"
    assert article_deduplication_key(
        archive_source_spec("npr"),
        "https://www.npr.org/2010/12/02/131356105/updated-slug",
    ) == "npr:131356105"
    legacy_npr = (
        "https://www.npr.org/templates/story/story.php?storyId=131356105"
    )
    assert normalize_article_url(
        archive_source_spec("npr"), legacy_npr
    ) == legacy_npr
    assert normalize_article_url(
        archive_source_spec("npr"),
        "https://npr.org/templates/story/story.php&storyId=131356105",
    ) == legacy_npr
    assert article_deduplication_key(
        archive_source_spec("npr"), legacy_npr
    ) == "npr:131356105"
    ap = archive_source_spec("ap")
    assert article_deduplication_key(
        ap,
        "https://news.yahoo.com/s/ap/20110120/ap_en_mo/"
        "us_film_batman_anne_hathaway",
    ) == article_deduplication_key(
        ap,
        "https://news.yahoo.com/s/ap/20110121/ap_on_en_mo/"
        "us_film_batman_anne_hathaway_4",
    )
    assert article_deduplication_key(
        ap,
        "https://news.yahoo.com/s/ap/20100120/ap_en_mo/"
        "us_film_batman_anne_hathaway",
    ) != article_deduplication_key(
        ap,
        "https://news.yahoo.com/s/ap/20110120/ap_en_mo/"
        "us_film_batman_anne_hathaway",
    )
    aljazeera = archive_source_spec("aljazeera")
    assert not is_parser_validation_candidate(
        aljazeera,
        "https://www.aljazeera.com/gallery/2023/10/31/photo-18",
    )
    assert is_parser_validation_candidate(
        aljazeera,
        "https://www.aljazeera.com/gallery/2023/10/31/"
        "photos-dozens-killed-in-israeli-air-attack",
    )
    assert not is_parser_validation_candidate(
        aljazeera,
        "https://www.aljazeera.com/economy/2022/4/6/"
        "hold-has-indias-central-bank-avoided-tackling-high-inflation",
    )
    assert is_parser_validation_candidate(
        aljazeera,
        "https://www.aljazeera.com/economy/2022/4/6/"
        "has-indias-central-bank-avoided-tackling-high-inflation",
    )
    nyt = archive_source_spec("nyt")
    assert not is_parser_validation_candidate(
        nyt,
        "https://www.nytimes.com/interactive/2023/us/"
        "fannin-texas-covid-cases.html",
    )
    assert is_parser_validation_candidate(
        nyt,
        "https://www.nytimes.com/interactive/2023/us/"
        "where-americans-moved.html",
    )
    assert article_deduplication_key(
        aljazeera,
        "https://www.aljazeera.com/news/2025/12/2/"
        "report-finds-widespread-police-failings-over-uks-hillsborough-disaster",
    ) == article_deduplication_key(
        aljazeera,
        "https://www.aljazeera.com/sports/2025/12/2/"
        "report-finds-widespread-police-failings-over-uks-hillsborough-disaster",
    )
    assert article_deduplication_key(
        aljazeera,
        "https://www.aljazeera.com/news/2025/12/2/a-different-story",
    ) != article_deduplication_key(
        aljazeera,
        "https://www.aljazeera.com/sports/2025/12/2/"
        "report-finds-widespread-police-failings-over-uks-hillsborough-disaster",
    )
    assert normalize_article_url(
        archive_source_spec("npr"),
        "https://www.npr.org/templates/story/story.php",
    ) is None
    assert normalize_article_url(
        archive_source_spec("npr"),
        "https://www.npr.org/2010/11/02/130682288/election-2010-florida-results",
    ) is None
    assert normalize_article_url(
        archive_source_spec("nikkei"),
        "https://www.nikkei.com/article/DGXZQOCD00001/",
    ) == "https://www.nikkei.com/article/DGXZQOCD00001"
    assert normalize_article_url(
        archive_source_spec("nikkei"),
        (
            "https://www.nikkei.com/article/article/"
            "DGXBZO40155290U2A400C1000000"
        ),
    ) == (
        "https://www.nikkei.com/article/"
        "DGXBZO40155290U2A400C1000000"
    )
    assert normalize_article_url(
        archive_source_spec("nikkei"),
        "https://www.nikkei.com/article/DG",
    ) is None
    assert normalize_article_url(
        archive_source_spec("nikkei"),
        (
            "https://www.nikkei.com/article/"
            "DGKDASDG0401Y_V01C11A2CR0000/nkds.graph.min.js"
        ),
    ) is None
    assert normalize_article_url(
        archive_source_spec("zaobao"),
        "https://www.zaobao.com.sg/news/singapore/story20240102-1234567",
    ) == "https://www.zaobao.com.sg/news/singapore/story20240102-1234567"
    assert normalize_article_url(
        archive_source_spec("zaobao"),
        (
            "https://www.zaobao.com.sg/special/zbo/smnews/"
            "story20160131-577237"
        ),
    ) == (
        "https://www.zaobao.com.sg/special/zbo/smnews/"
        "story20160131-577237"
    )
    assert normalize_article_url(
        archive_source_spec("zaobao"),
        "https://www.zaobao.com.sg/realtime/world/story20160131",
    ) is None
    assert normalize_article_url(
        archive_source_spec("aljazeera"),
        "https://www.aljazeera.com/news/2020/1/2/example",
    ) == "https://www.aljazeera.com/news/2020/1/2/example"
    assert normalize_article_url(
        archive_source_spec("aljazeera"),
        "https://www.aljazeera.com/economy/2012/1/31/example",
    ) == "https://www.aljazeera.com/economy/2012/1/31/example"
    assert normalize_article_url(
        archive_source_spec("aljazeera"),
        "https://www.aljazeera.com/news/liveblog/2026/8/10/example",
    ) == "https://www.aljazeera.com/news/liveblog/2026/8/10/example"
    assert normalize_article_url(
        archive_source_spec("aljazeera"),
        "https://www.aljazeera.com/news/2010/02/2010212134228827506.html",
    ) == (
        "https://www.aljazeera.com/news/2010/02/"
        "2010212134228827506.html"
    )
    assert normalize_article_url(
        archive_source_spec("aljazeera"),
        "https://www.aljazeera.com/news/asia/2012/07/20127181234567890.html",
    ) == (
        "https://www.aljazeera.com/news/asia/2012/07/"
        "20127181234567890.html"
    )
    assert normalize_article_url(
        archive_source_spec("aljazeera"),
        (
            "https://www.aljazeera.com/news/2010/07/"
            "www.aljazeera.com/news/asia/2012/07/example.html"
        ),
    ) is None
    assert normalize_article_url(
        archive_source_spec("scmp"),
        "https://www.scmp.com/article/721725/corrections-clarifications",
    ) == "https://www.scmp.com/article/721725/corrections-clarifications"






def test_wsj_normalization_removes_encoded_whitespace_alias():
    spec = archive_source_spec("wsj")

    assert normalize_article_url(
        spec,
        "http://online.wsj.com/news/articles/"
        "SB10001424052702303281504579217850250721172%20/",
    ) == (
        "https://www.wsj.com/news/articles/"
        "SB10001424052702303281504579217850250721172"
    )


def test_date_inference_and_candidate_ranking_prefers_after_publication():
    published = infer_published_at(
        "https://www.nytimes.com/2020/01/02/world/example.html"
    )
    assert published == "2020-01-02T00:00:00+00:00"
    assert infer_published_at(
        "https://hosted.ap.org/dynamic/stories/A/AF_IVORY_COAST"
        "?CTIME=2011-01-11-15-30-46"
    ) == "2011-01-11T15:30:46+00:00"
    after = candidate_rank("20200102010000", published_at=published)
    before = candidate_rank("20200101010000", published_at=published)
    assert after < before
    assert infer_published_at(
        "https://www.reuters.com/article/"
        "01cyberaton-brief-idUSFWN0U201D20141218"
    ) == "2014-12-18T00:00:00+00:00"
    assert infer_published_at(
        "https://www.aljazeera.com/news/2010/02/"
        "2010212134228827506.html"
    ) == "2010-02-01T00:00:00+00:00"
    assert infer_published_at(
        "https://www.wsj.com/article/"
        "0,,BT-CO-20130516-704945,00.html"
    ) == "2013-05-16T00:00:00+00:00"
    assert infer_published_at(
        "https://www.wsj.com/articles/"
        "a-19th-century-island-home-in-south-carolina-1472740999"
    ) == "2016-09-01T00:00:00+00:00"
    assert infer_published_at(
        "https://www.wsj.com/articles/"
        "accenture-looks-to-boost-ai-capabilities-through-"
        "mergers-11592818200"
    ) == "2020-06-22T00:00:00+00:00"
    assert infer_published_at(
        "https://www.wsj.com/articles/"
        "abbott-beats-forecasts-on-strong-covid-19-testing-"
        "business-151594900170"
    ) == "2020-07-16T00:00:00+00:00"
    assert infer_published_at(
        "https://www.zaobao.com.sg/news/singapore/story20240102-1234567"
    ) == "2024-01-02T00:00:00+00:00"
    assert infer_published_at(
        "https://www.aljazeera.com/news/2020/1/2/example"
    ) == "2020-01-02T00:00:00+00:00"
    assert infer_published_at(
        "https://aljazeera.com/2011/03/4/legacy-story"
    ) == "2011-03-04T00:00:00+00:00"


def test_reuters_discovery_reclassifies_legacy_ids_by_publication_date():
    spec = archive_source_spec("reuters")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2015,
    )
    url = (
        "https://www.reuters.com/article/"
        "example-idUSL1N0AB12320120607"
    )
    connection.execute(
        """
        INSERT INTO candidates(
            canonical_url, published_at, timestamp, original_url,
            digest, mimetype, status_code, byte_count, rank_score
        ) VALUES (?, '2015-01-01T00:00:00+00:00', '20150102000000',
                  ?, 'digest', 'text/html', 200, 10000, 1)
        """,
        (url, url),
    )

    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2015,
    )

    assert connection.execute(
        "SELECT published_at FROM candidates WHERE canonical_url=?",
        (url,),
    ).fetchone() == ("2012-06-07T00:00:00+00:00",)




def test_discovery_keeps_three_best_candidates_and_exports_generic_manifest(
    tmp_path: Path,
):
    spec = archive_source_spec("bloomberg")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2020,
        to_year=2020,
    )
    pattern, _ = next_discovery_query(connection)
    original = (
        "https://www.bloomberg.com/news/articles/2020-01-01/example"
    )
    captures = tuple(
        CDXCapture(
            timestamp=f"2020010{day}120000",
            original=original,
            mimetype="text/html",
            status_code=200,
            digest=f"DIGEST-{day}",
            length=30_000 + day,
        )
        for day in range(1, 6)
    )

    page_result = record_discovery_page(
        connection,
        spec=spec,
        pattern=pattern,
        page=CDXPage(captures=captures, resume_key=None),
    )
    destination = tmp_path / "manifest.jsonl.gz"
    summary = export_capture_manifest(
        connection,
        spec=spec,
        destination=destination,
        from_year=2020,
        to_year=2020,
    )

    assert page_result["seen"] == 5
    assert connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0] == 3
    assert summary["articles"] == 1
    assert summary["candidates"] == 3
    assert summary["captureReady"] is False
    assert summary["yearCounts"] == {"2020": 1}
    assert discovery_summary(connection)["shouldContinue"] is True
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    item = manifest_item_from_row(row, publisher="bloomberg")
    assert item.canonical_url == original
    assert len(item.candidates) == 3
    assert item.candidates[0].byte_count is not None

    ready_summary = export_capture_manifest(
        connection,
        spec=spec,
        destination=destination,
        from_year=2020,
        to_year=2020,
        capture_minimum_per_year=1,
    )
    assert ready_summary["captureReady"] is True


def test_wsj_export_rejects_legacy_asset_rows(tmp_path: Path):
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2023,
        to_year=2023,
    )
    article_url = (
        "https://www.wsj.com/articles/"
        "markets-rally-on-new-economic-data-a1b2c3d4"
    )
    asset_url = (
        "https://www.wsj.com/articles/"
        "B3-BY423_health_PREVIEW_20181003165352.jpg"
    )
    connection.executemany(
        """
        INSERT INTO candidates(
            canonical_url, published_at, timestamp, original_url,
            digest, mimetype, status_code, byte_count, rank_score
        ) VALUES (?, '2023-06-01T00:00:00+00:00', '20230602000000',
                  ?, 'digest', 'text/html', 200, 10000, 1)
        """,
        ((article_url, article_url), (asset_url, asset_url)),
    )

    destination = tmp_path / "manifest.jsonl.gz"
    summary = export_capture_manifest(
        connection,
        spec=spec,
        destination=destination,
        from_year=2023,
        to_year=2023,
        capture_minimum_per_year=1,
    )

    assert wsj_catalog_count_for_year(connection, 2023) == 1
    assert summary["articles"] == 1
    assert summary["yearCounts"] == {"2023": 1}
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle]
    assert [row["canonicalUrl"] for row in rows] == [article_url]


def test_discovery_queries_follow_configured_order_not_lexical_order():
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2020,
        to_year=2020,
    )

    pattern, _ = next_discovery_query(connection)

    assert pattern == "www.wsj.com/articles/a*"


def test_no_date_url_uses_capture_time_for_year_stratification():
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2020,
        to_year=2020,
        collapse="urlkey",
    )
    pattern, _ = next_discovery_query(connection)
    original = "https://www.wsj.com/articles/example-slug"
    result = record_discovery_page(
        connection,
        spec=spec,
        pattern=pattern,
        page=CDXPage(
            captures=(
                CDXCapture(
                    timestamp="20200615120000",
                    original=original,
                    mimetype="text/html",
                    status_code=200,
                    digest="DIGEST",
                    length=50_000,
                ),
            ),
            resume_key=None,
        ),
    )

    published_at = connection.execute(
        "SELECT published_at FROM candidates WHERE canonical_url=?",
        (original,),
    ).fetchone()[0]

    assert published_at == "2020-06-15T12:00:00+00:00"


def test_discovery_initialization_prunes_out_of_window_candidates():
    spec = archive_source_spec("ft")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2020,
        to_year=2020,
        collapse="urlkey",
    )
    pattern, _ = next_discovery_query(connection)
    result = record_discovery_page(
        connection,
        spec=spec,
        pattern=pattern,
        page=CDXPage(
            captures=(
                CDXCapture(
                    timestamp="20130315120000",
                    original=(
                        "https://www.ft.com/content/"
                        "31fb47f2-9782-11e6-a1dc-bdf38d484582"
                    ),
                    mimetype="text/html",
                    status_code=200,
                    digest="OLD",
                    length=50_000,
                ),
            ),
            resume_key=None,
        ),
    )
    assert connection.execute(
        "SELECT COUNT(*) FROM candidates"
    ).fetchone()[0] == 0
    assert result == {
        "seen": 1,
        "accepted": 0,
        "hasMore": False,
    }
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
            (
                "https://www.ft.com/content/"
                "31fb47f2-9782-11e6-a1dc-bdf38d484582"
            ),
            "2013-03-15T12:00:00+00:00",
            "20130315120000",
            (
                "https://www.ft.com/content/"
                "31fb47f2-9782-11e6-a1dc-bdf38d484582"
            ),
            "OLD-MANUAL",
            "text/html",
            200,
            50_000,
            0,
        ),
    )
    connection.commit()

    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2020,
        to_year=2020,
        collapse="urlkey",
    )

    assert connection.execute(
        "SELECT COUNT(*) FROM candidates"
    ).fetchone()[0] == 0


def test_urlkey_discovery_round_robins_patterns():
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2020,
        to_year=2020,
        collapse="urlkey",
    )
    first_pattern, _ = next_discovery_query(connection)
    connection.execute(
        """
        UPDATE discovery_queries
        SET status='running', pages=5, resume_key='resume'
        WHERE pattern=?
        """,
        (first_pattern,),
    )

    next_pattern, _ = next_discovery_query(connection)

    assert next_pattern != first_pattern
    assert next_pattern == "www.wsj.com/articles/b*"


def test_urlkey_discovery_can_prioritize_a_publication_year():
    spec = archive_source_spec("npr")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2015,
        collapse="urlkey",
    )
    connection.execute(
        """
        UPDATE discovery_queries
        SET status='complete'
        WHERE pattern LIKE '%/2010/*'
        """
    )
    connection.execute(
        """
        UPDATE discovery_queries
        SET status='pending'
        WHERE pattern='npr.org/2010/*'
        """
    )

    default_pattern, _ = next_discovery_query(connection)
    prioritized_pattern, _ = next_discovery_query(
        connection,
        preferred_year=2010,
    )

    assert default_pattern != "npr.org/2010/*"
    assert prioritized_pattern == "npr.org/2010/*"


def test_urlkey_discovery_rejects_invalid_priority_year():
    connection = sqlite3.connect(":memory:")

    with pytest.raises(ValueError, match="preferred_year"):
        next_discovery_query(connection, preferred_year=99)


def test_pre_2014_wsj_discovery_prioritizes_legacy_article_urls():
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2015,
        collapse="urlkey",
    )

    pattern, _ = next_discovery_query(connection)

    assert pattern == "online.wsj.com/article/*"


def test_failed_pre_2014_legacy_query_rotates_to_other_patterns():
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2015,
        collapse="urlkey",
    )
    legacy_pattern, _ = next_discovery_query(connection)

    record_discovery_failure(
        connection,
        pattern=legacy_pattern,
        error="Wayback CDX query failed after 2 attempts",
    )
    next_pattern, _ = next_discovery_query(connection)

    assert legacy_pattern == "online.wsj.com/article/*"
    assert next_pattern == "www.wsj.com/articles/a*"
    failure = connection.execute(
        "SELECT failures, last_error FROM discovery_queries WHERE pattern=?",
        (legacy_pattern,),
    ).fetchone()
    assert failure == (1, "Wayback CDX query failed after 2 attempts")


def test_failed_urlkey_query_does_not_starve_healthy_patterns():
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2020,
        to_year=2020,
        collapse="urlkey",
    )
    failed_pattern, _ = next_discovery_query(connection)

    record_discovery_failure(
        connection,
        pattern=failed_pattern,
        error="temporary failure",
    )
    next_pattern, _ = next_discovery_query(connection)

    assert failed_pattern == "www.wsj.com/articles/a*"
    assert next_pattern == "www.wsj.com/articles/b*"


def test_repeatedly_failed_urlkey_query_rotates_behind_less_failed_peer():
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2020,
        to_year=2020,
        collapse="urlkey",
    )
    connection.execute("UPDATE discovery_queries SET status='complete'")
    patterns = (
        "www.wsj.com/articles/a*",
        "www.wsj.com/articles/b*",
    )
    connection.executemany(
        "UPDATE discovery_queries SET status='pending' WHERE pattern=?",
        [(pattern,) for pattern in patterns],
    )
    for _ in range(2):
        record_discovery_failure(
            connection,
            pattern=patterns[0],
            error="persistent broad-prefix timeout",
        )
    record_discovery_failure(
        connection,
        pattern=patterns[1],
        error="one transient timeout",
    )

    next_pattern, _ = next_discovery_query(connection)

    assert next_pattern == patterns[1]


def test_initialize_discovery_schema_migrates_legacy_query_columns():
    connection = sqlite3.connect(":memory:")
    connection.execute(
        """
        CREATE TABLE discovery_queries (
            pattern TEXT PRIMARY KEY,
            resume_key TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            pages INTEGER NOT NULL DEFAULT 0,
            rows_seen INTEGER NOT NULL DEFAULT 0,
            rows_accepted INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        )
        """
    )

    initialize_discovery_schema(
        connection,
        spec=archive_source_spec("npr"),
        from_year=2010,
        to_year=2015,
        collapse="urlkey",
    )

    columns = {
        row[1]
        for row in connection.execute(
            "PRAGMA table_info(discovery_queries)"
        )
    }
    assert {"failures", "last_error"} <= columns
    assert next_discovery_query(connection) is not None


def test_successful_legacy_page_resets_failure_priority():
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2015,
        collapse="urlkey",
    )
    legacy_pattern, _ = next_discovery_query(connection)
    record_discovery_failure(
        connection,
        pattern=legacy_pattern,
        error="temporary failure",
    )
    record_discovery_page(
        connection,
        spec=spec,
        pattern=legacy_pattern,
        page=CDXPage(captures=(), resume_key="resume-2"),
    )

    selected_pattern, resume_key = next_discovery_query(connection)

    assert selected_pattern == legacy_pattern
    assert resume_key == "resume-2"
    assert connection.execute(
        "SELECT failures, last_error FROM discovery_queries WHERE pattern=?",
        (legacy_pattern,),
    ).fetchone() == (0, None)


class StubBlueskyResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "cursor": "2025-01-01T00:00:00.000Z",
            "feed": [
                {
                    "post": {
                        "uri": "at://did:plc:wsj/post/one",
                        "record": {
                            "createdAt": "2025-01-02T03:04:05.000Z",
                        },
                        "embed": {
                            "external": {
                                "uri": (
                                    "https://www.wsj.com/politics/"
                                    "modern-story-a1b2c3d4?mod=social"
                                )
                            }
                        },
                    }
                },
                {
                    "post": {
                        "uri": "at://did:plc:wsj/post/two",
                        "record": {
                            "createdAt": "2025-01-01T03:04:05.000Z",
                        },
                        "embed": {
                            "external": {
                                "uri": "https://www.wsj.com/politics"
                            }
                        },
                    }
                },
            ],
        }


class StubBlueskyClient:
    def get(self, url, params):
        assert url.endswith("app.bsky.feed.getAuthorFeed")
        assert params["actor"] == "wsj.com"
        assert params["filter"] == "posts_with_links"
        return StubBlueskyResponse()


def test_wsj_bluesky_discovers_modern_section_urls(tmp_path: Path):
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2024,
        to_year=2026,
        collapse="urlkey",
    )
    initialize_wsj_bluesky_schema(connection)

    result = process_wsj_bluesky_page(
        connection,
        spec=spec,
        http_client=StubBlueskyClient(),
        from_year=2024,
        to_year=2026,
    )
    destination = tmp_path / "wsj-manifest.jsonl.gz"
    summary = export_capture_manifest(
        connection,
        spec=spec,
        destination=destination,
        from_year=2024,
        to_year=2026,
    )

    assert result["seen"] == 2
    assert result["accepted"] == 1
    assert result["hasMore"] is True
    assert wsj_catalog_count_for_year(connection, 2025) == 1
    assert summary["articles"] == 1
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    assert row["canonicalUrl"].endswith("/modern-story-a1b2c3d4")
    assert row["publishedAt"] == "2025-01-02T03:04:05+00:00"
    assert len(row["candidates"]) == 3
    assert all(
        candidate["provider"] == "wayback"
        for candidate in row["candidates"]
    )


class StubRSSResponse:
    content = b"""
    <rss version="2.0">
      <channel>
        <item>
          <link>https://www.wsj.com/finance/stocks/modern-rss-story-a1b2c3d4?mod=rss</link>
          <pubDate>Sat, 25 Jul 2026 12:34:56 GMT</pubDate>
        </item>
        <item>
          <link>https://www.wsj.com/podcasts/example</link>
          <pubDate>Sat, 25 Jul 2026 12:34:56 GMT</pubDate>
        </item>
      </channel>
    </rss>
    """

    def raise_for_status(self):
        return None


class StubRSSClient:
    def get(self, url):
        assert url == "https://feeds.example/wsj"
        return StubRSSResponse()


def test_wsj_official_rss_discovers_current_section_urls(
    tmp_path: Path,
):
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2024,
        to_year=2026,
        collapse="urlkey",
    )
    initialize_wsj_rss_schema(connection)

    result = process_wsj_rss_feeds(
        connection,
        spec=spec,
        http_client=StubRSSClient(),
        from_year=2024,
        to_year=2026,
        feed_urls=("https://feeds.example/wsj",),
    )
    destination = tmp_path / "wsj-rss-manifest.jsonl.gz"
    summary = export_capture_manifest(
        connection,
        spec=spec,
        destination=destination,
        from_year=2024,
        to_year=2026,
    )

    assert result["feedsChecked"] == 1
    assert result["itemsSeen"] == 2
    assert result["accepted"] == 1
    assert result["errors"] == []
    assert wsj_catalog_count_for_year(connection, 2026) == 1
    assert summary["articles"] == 1
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    assert row["canonicalUrl"].endswith(
        "/modern-rss-story-a1b2c3d4"
    )
    assert row["publishedAt"] == "2026-07-25T12:34:56+00:00"
    assert len(row["candidates"]) == 4
    assert row["candidates"][-1]["provider"] == "live-origin"


class StubGoogleNewsResponse:
    def __init__(self, value: str):
        self.text = value
        self.content = value.encode()

    def raise_for_status(self):
        return None


class StubGoogleNewsClient:
    def __init__(self):
        self.queries: list[str] = []

    def get(self, url, params=None):
        if url.endswith("/rss/search"):
            assert params["q"].startswith("site:wsj.com/articles")
            self.queries.append(params["q"])
            return StubGoogleNewsResponse(
                """
                <rss version="2.0">
                  <channel>
                    <item>
                      <link>https://news.google.com/rss/articles/ENCODED-ID</link>
                      <pubDate>Sat, 21 Sep 2024 07:00:00 GMT</pubDate>
                    </item>
                  </channel>
                </rss>
                """
            )
        assert url.endswith("/rss/articles/ENCODED-ID")
        return StubGoogleNewsResponse(
            '<c-wiz><div data-n-a-sg="SIGNATURE" '
            'data-n-a-ts="1726902000"></div></c-wiz>'
        )

    def post(self, url, data, headers):
        assert url.endswith("/data/batchexecute")
        assert "ENCODED-ID" in data["f.req"]
        assert headers["Origin"] == "https://news.google.com"
        inner = json.dumps(
            [
                "garturlres",
                (
                    "https://www.wsj.com/articles/"
                    "google-news-story-a1b2c3d4"
                ),
            ]
        )
        return StubGoogleNewsResponse(
            ")]}'\n\n"
            + json.dumps([["wrb.fr", "Fbv4je", inner]])
        )


def test_wsj_google_news_fills_historical_catalog_gap(
    tmp_path: Path,
):
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2024,
        to_year=2026,
        collapse="urlkey",
    )
    initialize_wsj_google_news_schema(connection)

    client = StubGoogleNewsClient()
    result = process_wsj_google_news_feed(
        connection,
        spec=spec,
        http_client=client,
        from_year=2024,
        to_year=2026,
        maximum_decodes=1,
        minimum_catalog=1,
    )
    destination = tmp_path / "wsj-google-news-manifest.jsonl.gz"
    summary = export_capture_manifest(
        connection,
        spec=spec,
        destination=destination,
        from_year=2024,
        to_year=2026,
    )

    assert result == {
        "status": "complete-target-met",
        "targetYear": 2024,
        "itemsSeen": 1,
        "decodesAttempted": 1,
        "accepted": 1,
        "catalogCount": 1,
        "errors": [],
    }
    assert wsj_catalog_count_for_year(connection, 2024) == 1
    assert client.queries == [
        "site:wsj.com/articles after:2024-01-01 before:2024-02-01"
    ]
    assert wsj_google_news_should_continue(
        connection,
        from_year=2024,
        to_year=2026,
    ) is True
    assert summary["articles"] == 1
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    assert row["canonicalUrl"].endswith(
        "/google-news-story-a1b2c3d4"
    )
    assert row["publishedAt"] == "2024-09-21T07:00:00+00:00"


def test_wsj_google_news_keeps_filling_2023_after_2024_is_ready():
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2023,
        to_year=2024,
        collapse="urlkey",
    )
    initialize_wsj_google_news_schema(connection)
    rows = [
        (
            f"https://www.wsj.com/articles/ready-2024-{index}",
            "2024-06-01T00:00:00+00:00",
            f"https://news.google.com/rss/articles/2024-{index}",
            "2026-01-01T00:00:00+00:00",
        )
        for index in range(2)
    ]
    rows.append(
        (
            "https://www.wsj.com/articles/one-2023",
            "2023-06-01T00:00:00+00:00",
            "https://news.google.com/rss/articles/2023-1",
            "2026-01-01T00:00:00+00:00",
        )
    )
    connection.executemany(
        """
        INSERT INTO wsj_google_news_articles(
            canonical_url,
            published_at,
            google_news_url,
            updated_at
        ) VALUES (?, ?, ?, ?)
        """,
        rows,
    )

    assert wsj_google_news_should_continue(
        connection,
        from_year=2023,
        to_year=2024,
        minimum_catalog=2,
    ) is True
    connection.execute(
        """
        INSERT INTO wsj_google_news_articles(
            canonical_url,
            published_at,
            google_news_url,
            updated_at
        ) VALUES (?, ?, ?, ?)
        """,
        (
            "https://www.wsj.com/articles/two-2023",
            "2023-07-01T00:00:00+00:00",
            "https://news.google.com/rss/articles/2023-2",
            "2026-01-01T00:00:00+00:00",
        ),
    )
    assert wsj_google_news_should_continue(
        connection,
        from_year=2023,
        to_year=2024,
        minimum_catalog=2,
    ) is False


def test_wsj_google_news_can_pause_cdx_when_only_supported_years_are_short():
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2022,
        to_year=2024,
        collapse="urlkey",
    )
    initialize_wsj_google_news_schema(connection)

    assert wsj_google_news_is_only_catalog_gap(
        connection,
        from_year=2022,
        to_year=2024,
        minimum_catalog=1,
    ) is False

    record_discovery_page(
        connection,
        spec=spec,
        pattern=next_discovery_query(connection)[0],
        page=CDXPage(
            captures=(
                CDXCapture(
                    timestamp="20220601000000",
                    original=(
                        "https://www.wsj.com/articles/"
                        "ready-2022-a1b2c3d4"
                    ),
                    mimetype="text/html",
                    status_code=200,
                    digest="READY-2022",
                    length=12_345,
                ),
            ),
            resume_key=None,
        ),
    )

    assert wsj_google_news_is_only_catalog_gap(
        connection,
        from_year=2022,
        to_year=2024,
        minimum_catalog=1,
    ) is True
    assert wsj_catalog_ready_for_capture(
        connection,
        from_year=2022,
        to_year=2024,
        minimum_catalog=1,
    ) is False

    connection.executemany(
        """
        INSERT INTO wsj_google_news_articles(
            canonical_url,
            published_at,
            google_news_url,
            updated_at
        ) VALUES (?, ?, ?, ?)
        """,
        [
            (
                f"https://www.wsj.com/articles/ready-{year}-a1b2c3d4",
                f"{year}-06-01T00:00:00+00:00",
                f"https://news.google.com/rss/articles/{year}",
                "2026-01-01T00:00:00+00:00",
            )
            for year in (2023, 2024)
        ],
    )
    assert wsj_catalog_ready_for_capture(
        connection,
        from_year=2022,
        to_year=2024,
        minimum_catalog=1,
    ) is True


def test_digest_discovery_keeps_exhausting_current_pattern():
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2020,
        to_year=2020,
        collapse="digest",
    )
    first_pattern, _ = next_discovery_query(connection)
    connection.execute(
        """
        UPDATE discovery_queries
        SET status='running', pages=5, resume_key='resume'
        WHERE pattern=?
        """,
        (first_pattern,),
    )

    next_pattern, _ = next_discovery_query(connection)

    assert next_pattern == first_pattern
