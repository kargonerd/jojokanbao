from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import sqlite3
from threading import Event, Thread
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlencode, urlsplit

import brotli
import pytest

from jojo_news_archive.discovery.ghostarchive import ghostarchive_search_url
from jojo_news_archive.models import (
    ArticleStatus,
    CaptureCandidate,
    CaptureProvider,
    CaptureRepresentation,
    ContentType,
    RawCapture,
)
from jojo_news_archive.parsing.parser import parse_article
from jojo_news_archive.sources.registry import source_module
from jojo_news_archive.sources.ap.capture import (
    AP_KNOWN_SYNDICATION_COPIES,
    AP_SYNDICATION_MINIMUM_BODY_CHARACTERS,
    _ap_capture_parser_evidence,
    _ap_syndication_search_urls,
    ap_syndication_search_url,
    discover_ap_syndication_candidates,
)
from jojo_news_archive.sources.axios.capture import _axios_capture_parser_evidence
from jojo_news_archive.sources.bloomberg.capture import (
    BLOOMBERG_SYNDICATION_MINIMUM_BODY_CHARACTERS,
    bloomberg_syndication_search_url,
)
from jojo_news_archive.sources.ft.capture import (
    FT_SYNDICATION_MINIMUM_BODY_CHARACTERS,
    _ft_capture_parser_evidence,
    discover_ft_syndication_candidates,
    ft_google_news_headline_search_url,
    ft_google_news_partner_search_url,
    ft_syndication_broad_title_search_url,
    ft_syndication_partner_site_search_url,
    ft_syndication_search_url,
    ft_syndication_title_search_url,
    ftchinese_title_search_url,
)
from jojo_news_archive.sources.nikkei.capture import (
    _nikkei_candidate_sort_key,
    _nikkei_capture_parser_evidence,
)
from jojo_news_archive.sources.nyt.capture import (
    NYT_SYNDICATION_MINIMUM_BODY_CHARACTERS,
    NYT_SYNDICATION_SEARCH_ENDPOINT,
    _capture_nyt_interactive_resources,
    nyt_headline_wordpress_search_url,
    nyt_syndication_search_url,
    nyt_syndication_title_search_url,
    nyt_trusted_wordpress_search_url,
)
from jojo_news_archive.sources.reuters.capture import (
    discover_reuters_syndication_candidates,
    reuters_syndication_search_url,
    reuters_syndication_title_search_url,
)
from jojo_news_archive.sources.scmp.capture import _scmp_capture_parser_evidence
from jojo_news_archive.sources.wsj.capture import (
    WSJ_SYNDICATION_MINIMUM_BODY_CHARACTERS,
    _wsj_capture_parser_evidence,
)
from jojo_news_archive.capture.raw import (
    ManifestItem,
    SYNDICATION_SEARCH_ENDPOINT,
    WAYBACK_TIMEMAP_ENDPOINT,
    _candidate_rejection_reasons,
    _common_crawl_first_candidate_sort_key,
    _common_crawl_discovery_urls,
    _decode_archived_html_content,
    _fetch_usable_candidate,
    archive_fallback_policy,
    arquivo_pt_cdx_url,
    arquivo_pt_prefix_cdx_url,
    capture_item,
    capture_summary,
    completed_capture_rejection_reason,
    completed_raw_capture,
    discover_arquivo_pt_candidates,
    discover_wayback_timemap_candidates,
    initialize_capture_schema,
    lease_pending_captures,
    load_capture_manifest,
    mark_capture_downloading,
    pending_captures,
    preindex_arquivo_pt_prefix_candidates,
    record_capture_result,
    release_capture_leases,
    reset_completed_capture_for_retry,
    resolved_capture_candidate,
    score_raw_capture,
    store_raw_html,
)


def test_candidate_rejection_reasons_explain_wsj_parser_rejection():
    signals = {
        "looksLikeHtml": True,
        "archiveErrorPage": False,
        "authenticationShell": True,
        "accessChallengeShell": False,
        "subscriptionShell": False,
        "ftTruncatedArticleShell": False,
        "redirectShell": False,
    }

    reasons = _candidate_rejection_reasons(
        status_code=200,
        content=b"<html></html>",
        signals=signals,
        source_rejection_reasons=("wsj-parser-unusable",),
    )

    assert reasons == (
        "authentication-shell",
        "wsj-parser-unusable",
    )


def test_candidate_rejection_reasons_preserve_wsj_auth_shell_exception():
    signals = {
        "looksLikeHtml": True,
        "archiveErrorPage": False,
        "authenticationShell": True,
        "accessChallengeShell": False,
        "subscriptionShell": False,
        "ftTruncatedArticleShell": False,
        "redirectShell": False,
    }

    signals["allowAuthenticationShell"] = True
    reasons = _candidate_rejection_reasons(
        status_code=200,
        content=b"<html></html>",
        signals=signals,
    )

    assert reasons == ()


def test_candidate_rejection_reasons_explain_npr_parser_rejection():
    signals = {
        "looksLikeHtml": True,
        "archiveErrorPage": False,
        "authenticationShell": False,
        "accessChallengeShell": False,
        "subscriptionShell": False,
        "ftTruncatedArticleShell": False,
        "redirectShell": False,
    }

    reasons = _candidate_rejection_reasons(
        status_code=200,
        content=b"<html></html>",
        signals=signals,
        source_rejection_reasons=("npr-parser-unusable",),
    )

    assert reasons == ("npr-parser-unusable",)


def test_nikkei_capture_parser_evidence_rejects_member_excerpt():
    usable, evidence = _nikkei_capture_parser_evidence(
        """
        <html><head>
          <title>パナソニック、汐留ビル売却を検討 ：日本経済新聞</title>
        </head><body>
          <div class="cmn-article_text">
            <p>パナソニックは東京の拠点であるビルを売却する検討に入った。
            巨額の赤字で現預金が流出しており、資産売却を加速して手元資金の
            厚みを増すのが狙いだ。売却後も賃貸…</p>
          </div>
          <p>会員限定です。電子版に登録すると続きをお読みいただけます。</p>
        </body></html>
        """.encode(),
        canonical_url=(
            "https://www.nikkei.com/article/"
            "DGKDZO49326620Y2A201C1TJ1000"
        ),
    )

    assert usable is False
    assert evidence["nikkeiCaptureParserUsable"] is False
    assert evidence["nikkeiCaptureExtractionStatus"] == "partial"
    assert evidence["nikkeiCaptureBodyCharacters"] > 0


def test_scmp_capture_parser_evidence_rejects_head_only_article_shell():
    usable, evidence = _scmp_capture_parser_evidence(
        b"""
        <html><head>
          <title>Singer Agnes Chan never received invitation</title>
          <script type="application/ld+json">
            {"@type":"NewsArticle","headline":"Singer Agnes Chan"}
          </script>
          <script>window.Drupal = {settings: {articleId: 2091756}};</script>
        </head></html>
        """ + (b" " * 20_000),
        canonical_url=(
            "https://www.scmp.com/news/hong-kong/politics/article/2091756/"
            "singer-agnes-chan-never-received-invitation"
        ),
    )

    assert usable is False
    assert evidence["scmpCaptureParserUsable"] is False
    assert evidence["scmpCaptureHeadOnlyArticleShell"] is True
    assert evidence["scmpCaptureVisibleCharacters"] < 300


def test_scmp_capture_parser_evidence_keeps_short_structured_alert():
    usable, evidence = _scmp_capture_parser_evidence(
        b"""
        <html><head><script type="application/ld+json">
          {"@type":"NewsArticle","headline":"Breaking news alert"}
        </script></head><body>
          <main><div class="field-name-body">
            <p>Hong Kong officials issued a short breaking news alert.</p>
          </div></main>
        </body></html>
        """,
        canonical_url=(
            "https://www.scmp.com/news/hong-kong/article/2099999/"
            "breaking-news-alert"
        ),
    )

    assert usable is True
    assert evidence["scmpCaptureHeadOnlyArticleShell"] is False


def test_stored_scmp_head_only_article_shell_is_requeued(tmp_path: Path):
    canonical_url = (
        "https://www.scmp.com/news/hong-kong/politics/article/2091756/"
        "singer-agnes-chan-never-received-invitation"
    )
    shell = b"""
      <html><head><title>Singer Agnes Chan</title>
      <script type="application/ld+json">
        {"@type":"NewsArticle","headline":"Singer Agnes Chan"}
      </script></head></html>
    """ + (b" " * 20_000)
    capture = RawCapture(
        article_id="scmp:" + ("s" * 64),
        publisher="scmp",
        canonical_url=canonical_url,
        published_at=datetime(2017, 4, 29, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20170430040922id_/"
                + canonical_url
            ),
        ),
        candidates_considered=[],
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=85,
        raw_html=store_raw_html(tmp_path, shell),
    )

    assert completed_capture_rejection_reason(
        capture,
        archive_root=tmp_path,
    ) == "scmp-capture-parser-incomplete"


def test_nikkei_capture_parser_evidence_rejects_modern_paywall_excerpt():
    usable, evidence = _nikkei_capture_parser_evidence(
        """
        <html><head><title>子ども1人にかかる教育費は？ ：日本経済新聞</title>
        </head><body><article>
          <section data-track-article-content>
            <p>残暑厳しい中、教育費について家族が話し合った。</p>
            <p>今後の支出を確認しながら準備を進めることにした...</p>
          </section>
          <div data-k2-component-name="k2-paywall-container">
            <p>この記事は会員限定です。登録すると続きをお読みいただけます。</p>
            <p>残り1902文字</p>
          </div>
        </article></body></html>
        """.encode(),
        canonical_url=(
            "https://www.nikkei.com/article/"
            "DGKDZO76011510S4A820C1PPE000"
        ),
    )

    assert usable is False
    assert evidence["nikkeiCaptureParserUsable"] is False
    assert evidence["nikkeiCaptureExtractionStatus"] == "partial"








def test_wsj_archive_capture_supports_secondary_archive_fallbacks():
    policy = source_module("wsj")
    assert policy.common_crawl_fallback
    assert policy.arquivo_pt_fallback


def test_nikkei_archive_capture_supports_secondary_archive_fallbacks():
    policy = source_module("nikkei")
    assert policy.common_crawl_fallback
    assert policy.arquivo_pt_fallback


def test_bloomberg_common_crawl_discovery_prefers_legacy_news_url():
    item = ManifestItem(
        publisher="bloomberg",
        canonical_url=(
            "https://www.bloomberg.com/news/articles/2014-05-13/"
            "kenya-may-reschedule-payment"
        ),
        published_at="2014-05-13T00:00:00Z",
        section=None,
        candidates=(),
    )

    assert _common_crawl_discovery_urls(item) == (
        "https://www.bloomberg.com/news/2014-05-13/"
        "kenya-may-reschedule-payment.html",
        item.canonical_url,
    )


def test_wsj_common_crawl_discovery_includes_http_archive_key():
    item = ManifestItem(
        publisher="wsj",
        canonical_url=(
            "https://www.wsj.com/articles/"
            "a-1945-harley-wla-back-together-again-1473779995"
        ),
        published_at="2016-09-13T00:00:00Z",
        section=None,
        candidates=(),
    )

    assert _common_crawl_discovery_urls(item) == (
        item.canonical_url,
        item.canonical_url.replace("https://", "http://", 1),
        item.canonical_url.replace("/articles/", "/amp/articles/", 1),
        item.canonical_url.replace(
            "https://www.wsj.com/articles/",
            "http://www.wsj.com/amp/articles/",
            1,
        ),
    )


def test_ft_archive_discovery_includes_scheme_and_host_variants():
    item = ManifestItem(
        publisher="ft",
        canonical_url=(
            "https://www.ft.com/content/"
            "01234567-89ab-cdef-0123-456789abcdef?segmentId=example"
        ),
        published_at="2016-09-13T00:00:00Z",
        section=None,
        candidates=(),
    )

    assert _common_crawl_discovery_urls(item) == (
        item.canonical_url,
        item.canonical_url.replace("https://", "http://", 1),
        item.canonical_url.replace("www.ft.com", "ft.com", 1),
        item.canonical_url.replace("https://www.ft.com", "http://ft.com", 1),
    )


def test_wsj_complete_legacy_video_survives_navigation_auth_marker(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.wsj.com/article/"
        "03BBDDAE-9165-4FC9-BC02-6F8609982191.html"
    )
    snapshot_url = (
        "https://web.archive.org/web/20111215163504id_/"
        "http://online.wsj.com/article/"
        "03BBDDAE-9165-4FC9-BC02-6F8609982191.html"
    )
    html = b"""
      <html><head><title>RIMM: Headed for Zero or a Takeover?</title>
        <meta name="description" content="WSJ reporters examine the
        decline of Research in Motion and its strategic options.">
      </head><body>
        <div class="account-navigation">Sign in to continue</div>
        <script>var AT_VARS={articleType:'Video - WSJ',
          publicationDate:'2011-12-15'};</script>
        <div id="masterVideoCenter"><div id="videoPlayer"></div></div>
      </body></html>
    """ + (b" " * 2_048)
    client = StubArchiveClient(
        {
            snapshot_url: (
                200,
                {"content-type": "text/html"},
                html,
                snapshot_url,
            )
        }
    )
    item = ManifestItem(
        publisher="wsj",
        canonical_url=canonical_url,
        published_at="2011-12-15T00:00:00Z",
        section=None,
        candidates=(candidate(snapshot_url, "20111215163504"),),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    capture = result["capture"]
    assert capture.quality_signals["authenticationShell"] is True
    assert capture.quality_signals["wsjCaptureParserUsable"] is True
    assert capture.quality_signals["wsjCaptureContentType"] == "video"


ARTICLE = b"""
<!doctype html>
<html>
  <head>
    <script type="application/ld+json">
      {"@type":"NewsArticle","headline":"Captured headline"}
    </script>
  </head>
  <body><article>
    <p>Captured article body contains substantive reporting and context.</p>
    <p>A second paragraph preserves evidence, timing and source details.</p>
    <p>A third paragraph completes the archived report for parser checks.</p>
    <p>Additional verified reporting records the response from named sources,
    explains the chronology and provides the figures needed to understand the
    development.</p>
    <p>The final section supplies historical context, describes the outcome and
    keeps this shared capture fixture clearly above the conservative boundary
    used to reject short metered Wall Street Journal previews.</p>
  </article></body>
</html>
""" + (b" " * 2_048)


class StubArchiveClient:
    def __init__(self, responses: dict[str, tuple[int, dict[str, str], bytes, str]]):
        self.responses = responses
        self.requests: list[str] = []
        self.limited_calls: list[tuple[str, int, float]] = []
        self.attempts = 2
        self.timeout = 30.0

    def fetch(self, url: str, *, maximum_bytes: int):
        self.requests.append(url)
        response = self.responses[url]
        if len(response[2]) > maximum_bytes:
            raise ValueError("too large")
        return response

    def fetch_limited(
        self,
        url: str,
        *,
        maximum_bytes: int,
        attempts: int,
        timeout: float,
    ):
        self.limited_calls.append((url, attempts, timeout))
        return self.fetch(url, maximum_bytes=maximum_bytes)




def test_archives_wayback_nyt_adventure_script_as_dependent_resource(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.nytimes.com/interactive/2022/10/07/books/"
        "review/southern-novels-quiz.html"
    )
    source_url = (
        "https://int.nyt.com/assets/adventure/js/"
        "southern-novels-adventure-production.js"
    )
    snapshot_url = (
        "https://web.archive.org/web/20221007165153id_/" + source_url
    )
    javascript = b"module.exports=JSON.parse('{\"entitiesById\":{}}');"
    client = StubArchiveClient(
        {
            snapshot_url: (
                200,
                {"content-type": "application/javascript; charset=utf-8"},
                javascript,
                snapshot_url,
            )
        }
    )
    item = ManifestItem(
        publisher="nyt",
        canonical_url=canonical_url,
        published_at="2022-10-07T00:00:00Z",
        section=None,
        candidates=(),
    )
    candidate = CaptureCandidate(
        provider=CaptureProvider.WAYBACK,
        snapshot_url=(
            "https://web.archive.org/web/20221007165153id_/"
            + canonical_url
        ),
    )
    html = (
        '<section class="interactive-content">'
        '<div id="adventure-project-container">'
        f'<script src="{source_url}"></script>'
        "</div></section>"
    ).encode()

    resources = _capture_nyt_interactive_resources(
        item,
        candidate=candidate,
        html_bytes=html,
        archive_client=client,
        output_dir=tmp_path,
    )

    assert client.requests == [snapshot_url]
    assert len(resources) == 1
    assert resources[0].source_url == source_url
    assert resources[0].content_type == "application/javascript"
    with gzip.open(tmp_path / resources[0].blob.path, "rb") as handle:
        assert handle.read() == javascript

    raw_html = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id=item.article_id,
        publisher="nyt",
        canonical_url=canonical_url,
        published_at="2022-10-07T00:00:00Z",
        selected_candidate=candidate,
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=raw_html,
        dependent_resources=resources,
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="nyt",
        authorization_reference="test",
    )
    connection.execute(
        """
        INSERT INTO captures(
            canonical_url, article_id, publisher, published_at, section,
            candidates_json, status, updated_at
        ) VALUES (?, ?, 'nyt', ?, NULL, '[]', 'pending', 'now')
        """,
        (canonical_url, item.article_id, item.published_at),
    )
    record_capture_result(
        connection,
        {
            "canonicalUrl": canonical_url,
            "status": "complete",
            "capture": capture,
            "recordPath": "records/test.json",
            "error": None,
        },
    )

    restored = completed_raw_capture(
        connection,
        canonical_url=canonical_url,
    )

    assert restored.dependent_resources == resources


def test_late_capture_error_does_not_clobber_completed_capture():
    canonical_url = "https://www.nytimes.com/2020/01/01/late-error.html"
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="nyt",
        authorization_reference="test",
    )
    connection.execute(
        """
        INSERT INTO captures(
            canonical_url, article_id, publisher, candidates_json,
            status, raw_path, raw_sha256, raw_bytes, stored_bytes,
            record_path, updated_at
        ) VALUES (
            ?, ?, 'nyt', '[]', 'complete',
            'objects/html/aa/example.html.gz', ?, 1000, 500,
            'records/aa/example.json', 'now'
        )
        """,
        (canonical_url, "nyt:" + ("a" * 64), "a" * 64),
    )

    record_capture_result(
        connection,
        {
            "canonicalUrl": canonical_url,
            "status": "error",
            "capture": None,
            "recordPath": None,
            "error": "late timeout from a duplicate lease",
        },
    )

    row = connection.execute(
        """
        SELECT status, raw_path, raw_sha256, record_path, last_error
        FROM captures
        WHERE canonical_url=?
        """,
        (canonical_url,),
    ).fetchone()
    assert row == (
        "complete",
        "objects/html/aa/example.html.gz",
        "a" * 64,
        "records/aa/example.json",
        None,
    )


def test_completed_capture_loads_legacy_state_without_resource_column():
    connection = sqlite3.connect(":memory:")
    connection.execute(
        """
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            article_id TEXT, publisher TEXT, published_at TEXT, section TEXT,
            selected_candidate_json TEXT, candidates_json TEXT,
            retrieved_at TEXT, final_url TEXT, http_status INTEGER,
            content_type TEXT, quality_score INTEGER,
            quality_signals_json TEXT, raw_path TEXT, raw_sha256 TEXT,
            raw_bytes INTEGER, stored_bytes INTEGER, status TEXT
        )
        """
    )
    canonical_url = "https://www.ft.com/content/legacy-state"
    candidate = CaptureCandidate(
        provider=CaptureProvider.WAYBACK,
        snapshot_url="https://web.archive.org/web/20200101000000id_/"
        + canonical_url,
    )
    connection.execute(
        """
        INSERT INTO captures VALUES (
            ?, ?, 'ft', '2020-01-01T00:00:00Z', NULL, ?, '[]',
            '2020-01-02T00:00:00Z', ?, 200, 'text/html', 100, '{}',
            'objects/html/aa/example.html.gz', ?, 1000, 500, 'complete'
        )
        """,
        (
            canonical_url,
            "ft:" + ("a" * 64),
            candidate.model_dump_json(by_alias=True),
            canonical_url,
            "b" * 64,
        ),
    )

    restored = completed_raw_capture(
        connection,
        canonical_url=canonical_url,
    )

    assert restored.raw_html.path == "objects/html/aa/example.html.gz"
    assert restored.dependent_resources == []


def test_known_ap_pakistan_copy_uses_exact_canonical_id():
    canonical_url = (
        "https://apnews.com/united-states-government-"
        "617290f5b8324b808390f3a7263b17"
    )

    assert canonical_url in AP_KNOWN_SYNDICATION_COPIES


def test_decodes_brotli_html_preserved_by_wayback():
    encoded = brotli.compress(ARTICLE)

    decoded, signals = _decode_archived_html_content(
        encoded,
        headers={"content-type": "text/html"},
        maximum_bytes=1_000_000,
    )

    assert decoded == ARTICLE
    assert signals["archivedContentEncodingDecoded"] == "br"
    assert signals["archivedEncodedBytes"] == len(encoded)
    assert signals["archivedDecodedBytes"] == len(ARTICLE)


def candidate(url: str, timestamp: str) -> CaptureCandidate:
    return CaptureCandidate(
        provider=CaptureProvider.WAYBACK,
        snapshot_url=url,
        captured_at=datetime.strptime(timestamp, "%Y%m%d%H%M%S").replace(
            tzinfo=timezone.utc
        ),
        mime_type="text/html",
        status_code=200,
    )


def wsj_syndication_html(
    *,
    headline: str,
    attribution: str,
) -> bytes:
    paragraphs = "".join(
        (
            "<p>Licensed financial reporting paragraph "
            f"{index} contains substantive market analysis, interviews "
            "with investors, company disclosures, historical comparisons "
            "and enough detail to represent the complete news article "
            "rather than a headline, preview, or subscription prompt.</p>"
        )
        for index in range(1, 6)
    )
    return f"""
    <!doctype html><html><head>
      <script type="application/ld+json">
      {{
        "@type": "NewsArticle",
        "headline": "{headline}",
        "datePublished": "2024-06-03T12:34:56Z",
        "author": {{"name": "{attribution}"}}
      }}
      </script>
    </head><body><article>
      <p>By Market Reporter, {attribution}</p>
      {paragraphs}
    </article></body></html>
    """.encode() + (b" " * 2_048)


def ft_syndication_html(
    *,
    headline: str,
    include_copyright: bool,
) -> bytes:
    paragraphs = "".join(
        (
            "<p>Licensed business reporting paragraph "
            f"{index} contains substantive details about the investment, "
            "executive comments, market conditions, financial disclosures "
            "and the competitive outlook. This is complete article text "
            "rather than a preview, search result, or subscription shell.</p>"
        )
        for index in range(1, 6)
    )
    copyright_text = (
        "<p>© 2024 The Financial Times Ltd. All rights reserved.</p>"
        "<p>This Financial Times article was legally licensed "
        "by AdvisorStream</p>"
        if include_copyright
        else ""
    )
    return f"""
    <!doctype html><html><head>
      <script type="application/ld+json">
      {{
        "@type": "NewsArticle",
        "headline": "{headline}",
        "datePublished": "2024-03-28T15:45:53Z",
        "author": {{"name": "Financial Times reporters"}}
      }}
      </script>
    </head><body><article>
      {paragraphs}
      {copyright_text}
    </article></body></html>
    """.encode() + (b" " * 2_048)


def test_ft_manifest_partner_copy_requires_strict_validation(
    tmp_path: Path,
):
    headline = (
        "Amazon writes its largest venture cheque yet "
        "for AI start-up Anthropic"
    )
    canonical_url = (
        "https://www.ft.com/content/"
        "a604bc55-26a5-42ca-a707-e6537abe0c1d"
    )
    partner_url = (
        "https://www.irishtimes.com/business/2024/03/28/"
        "amazon-invests-in-ai-start-up/"
    )
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2024-03-24T00:00:00+00:00",
        section="business",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=partner_url,
                expected_headline=headline,
            ),
            CaptureCandidate(
                provider=CaptureProvider.INFINI_NEWS,
                snapshot_url=(
                    "https://datasets-server.huggingface.co/rows?"
                    "dataset=ruggsea%2Finfini-news-corpus&"
                    "config=year_2024&split=train&offset=12345&length=1"
                ),
                source_url=partner_url,
                expected_headline=headline,
                warc_filename="CC-NEWS-20240328160318-02712.warc.gz",
            ),
        ),
    )
    client = StubArchiveClient(
        {
            partner_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                ft_syndication_html(
                    headline=headline,
                    include_copyright=True,
                ),
                partner_url,
            )
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    capture = result["capture"]
    assert capture.selected_candidate.provider == CaptureProvider.OTHER
    assert capture.quality_signals["ftSyndicationValidated"] is True
    assert (
        capture.quality_signals["syndicationFtCopyrightAttributed"]
        is True
    )
    assert (
        capture.quality_signals["syndicationAdvisorStreamLicensed"]
        is True
    )
    assert capture.quality_signals["syndicationDateDeltaDays"] == 4
    assert (
        capture.quality_signals["syndicationBodyCharacters"]
        >= FT_SYNDICATION_MINIMUM_BODY_CHARACTERS
    )
    assert capture.quality_signals["syndicationHeadlineOverlap"] == 1.0
    assert capture.quality_signals["syndicationPartnerHostValidated"] is True
    assert client.requests[-1] == partner_url
    assert not any("datasets-server.huggingface.co" in url for url in client.requests)


def test_ft_direct_infini_origin_falls_back_after_validation_failure(
    tmp_path: Path,
):
    headline = "Financial Times tests a complete direct-origin article"
    canonical_url = (
        "https://www.ft.com/content/"
        "a604bc55-26a5-42ca-a707-e6537abe0c1d"
    )
    row_url = (
        "https://datasets-server.huggingface.co/rows?"
        "dataset=ruggsea%2Finfini-news-corpus&config=year_2024&"
        "split=train&offset=54321&length=1"
    )
    body = "\n".join(
        [
            (
                "Direct Financial Times reporting paragraph "
                f"{index} contains detailed market evidence, executive "
                "interviews, financial disclosures, historical comparisons "
                "and enough substantive analysis for a complete article."
            )
            for index in range(1, 12)
        ]
        + [
            "To read the full story, subscribe or sign in for related "
            "coverage and newsletters."
        ]
    )
    payload = json.dumps(
        {
            "rows": [
                {
                    "row_idx": 54321,
                    "row": {
                        "url": canonical_url,
                        "year": 2024,
                        "title": headline,
                        "publish_date": "2024-03-28",
                        "text": body,
                        "warc_filename": (
                            "CC-NEWS-20240328160318-02712.warc.gz"
                        ),
                    },
                }
            ]
        }
    ).encode()
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2024-03-28T00:00:00+00:00",
        section="business",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.INFINI_NEWS,
                snapshot_url=row_url,
                source_url=canonical_url,
                expected_headline=headline,
                warc_filename=(
                    "CC-NEWS-20240328160318-02712.warc.gz"
                ),
            ),
        ),
    )
    client = StubArchiveClient(
        {
            row_url: (
                200,
                {"content-type": "application/json"},
                payload,
                row_url,
            )
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
        enable_common_crawl_fallback=True,
        enable_arquivo_pt_fallback=True,
    )

    assert result["status"] == "complete"
    capture = result["capture"]
    assert capture.quality_score == 100
    assert capture.quality_signals["ftInfiniOriginValidated"] is True
    assert capture.quality_signals["infiniOriginUrlValidated"] is True
    assert capture.quality_signals["infiniOriginBodyCharacters"] >= 1_000
    assert capture.quality_signals["hasStrongBodyMarker"] is True
    assert capture.quality_signals["subscriptionShell"] is False
    assert client.requests == [row_url]


    mismatched_payload = json.loads(payload)
    mismatched_payload["rows"][0]["row"]["publish_date"] = "2023-01-01"
    wayback_url = (
        "https://web.archive.org/web/20240329000000id_/"
        + canonical_url
    )
    mismatched_item = replace(
        item,
        candidates=(
            item.candidates[0],
            candidate(wayback_url, "20240329000000"),
        ),
    )
    mismatched_client = StubArchiveClient(
        {
            row_url: (
                200,
                {"content-type": "application/json"},
                json.dumps(mismatched_payload).encode(),
                row_url,
            ),
            wayback_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                wayback_url,
            ),
        }
    )

    mismatched_result = capture_item(
        mismatched_item,
        archive_client=mismatched_client,
        output_dir=tmp_path / "date-mismatch",
        maximum_html_bytes=1_000_000,
    )

    # A bad Infini row must not suppress a usable Wayback capture for the
    # same canonical article.  Older code returned immediately here and
    # never reached the AMP/Wayback fallback candidates.
    assert mismatched_result["status"] == "complete"
    assert (
        mismatched_result["capture"].selected_candidate.snapshot_url
        == wayback_url
    )
    assert mismatched_client.requests[0] == row_url
    assert mismatched_client.requests[-1] == wayback_url


def test_ft_infini_trial_offer_with_matching_date_is_rejected(
    tmp_path: Path,
):
    headline = "Premier Foods sales rise as consumers cook at home"
    canonical_url = (
        "https://www.ft.com/content/"
        "271255d8-a6d5-4d37-be0f-5ca439957a30"
    )
    row_url = (
        "https://datasets-server.huggingface.co/rows?"
        "dataset=ruggsea%2Finfini-news-corpus&config=year_2022&"
        "split=train&offset=271255&length=1"
    )
    trial_offer = "\n".join(
        [
            "What is included in my trial?",
            (
                "During your trial you will have complete digital access "
                "to FT.com with everything in both our Standard Digital "
                "and Premium Digital packages."
            ),
            (
                "Standard Digital includes access to a wealth of global "
                "news, analysis and expert opinion."
            ),
            (
                "Premium Digital includes access to our premier business "
                "column, Lex, as well as curated newsletters covering key "
                "business themes with original, in-depth reporting."
            ),
        ]
        + [
            (
                "You may change or cancel your subscription or trial at "
                "any time online. Your subscription will continue after "
                "the trial unless you cancel before the renewal date."
            )
            for _ in range(7)
        ]
    )
    payload = json.dumps(
        {
            "rows": [
                {
                    "row_idx": 271255,
                    "row": {
                        "url": canonical_url,
                        "year": 2022,
                        "title": headline,
                        "publish_date": "2022-11-16",
                        "text": trial_offer,
                        "warc_filename": (
                            "CC-NEWS-20221116124500-00001.warc.gz"
                        ),
                    },
                }
            ]
        }
    ).encode()
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2022-11-16T00:00:00+00:00",
        section="business",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.INFINI_NEWS,
                snapshot_url=row_url,
                source_url=canonical_url,
                expected_headline=headline,
                warc_filename=(
                    "CC-NEWS-20221116124500-00001.warc.gz"
                ),
            ),
        ),
    )
    client = StubArchiveClient(
        {
            row_url: (
                200,
                {"content-type": "application/json"},
                payload,
                row_url,
            )
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "error"
    assert "reject-ft-parser-unusable" in result["error"]
    assert client.requests.count(row_url) >= 1
    assert not (tmp_path / "objects").exists()


def test_ft_infini_subscription_shell_is_skipped_without_network():
    canonical_url = (
        "https://www.ft.com/content/"
        "a604bc55-26a5-42ca-a707-e6537abe0c1d"
    )
    candidate = CaptureCandidate(
        provider=CaptureProvider.INFINI_NEWS,
        snapshot_url=(
            "https://datasets-server.huggingface.co/rows?"
            "dataset=ruggsea%2Finfini-news-corpus&config=year_2018&"
            "split=train&offset=12345&length=1"
        ),
        source_url=canonical_url,
        expected_headline="Purchase a Digital Trial subscription for",
        warc_filename="CC-NEWS-20180328120000-00001.warc.gz",
    )
    client = StubArchiveClient({})

    response, failure = _fetch_usable_candidate(
        candidate,
        archive_client=client,
        maximum_html_bytes=1_000_000,
        canonical_url=canonical_url,
        publisher="ft",
    )

    assert response is None
    assert failure is None
    assert client.requests == []


def test_ft_jina_reader_html_is_validated_as_derived_origin(
    tmp_path: Path,
):
    headline = (
        "Amazon writes its largest venture cheque yet "
        "for AI start-up Anthropic"
    )
    canonical_url = (
        "https://www.ft.com/content/"
        "a604bc55-26a5-42ca-a707-e6537abe0c1d"
    )
    reader_url = "https://r.jina.ai/" + canonical_url
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2024-03-28T00:00:00+00:00",
        section="business",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=reader_url,
                source_url=canonical_url,
                expected_headline=headline,
            ),
        ),
    )
    client = StubArchiveClient(
        {
            reader_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                ft_syndication_html(
                    headline=headline,
                    include_copyright=False,
                ),
                canonical_url,
            )
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    capture = result["capture"]
    assert capture.selected_candidate.snapshot_url == reader_url
    assert capture.quality_signals["ftInfiniOriginValidated"] is True
    assert capture.quality_signals["infiniOriginHeadlineOverlap"] == 1.0


def test_ft_archive_today_html_is_validated_as_derived_origin(
    tmp_path: Path,
):
    headline = (
        "Amazon writes its largest venture cheque yet "
        "for AI start-up Anthropic"
    )
    canonical_url = (
        "https://www.ft.com/content/"
        "a604bc55-26a5-42ca-a707-e6537abe0c1d"
    )
    snapshot_url = "https://archive.ph/abc12"
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2024-03-28T00:00:00+00:00",
        section="business",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=snapshot_url,
                source_url=canonical_url,
                expected_headline=headline,
            ),
        ),
    )
    client = StubArchiveClient(
        {
            snapshot_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                ft_syndication_html(
                    headline=headline,
                    include_copyright=False,
                ),
                canonical_url,
            )
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    capture = result["capture"]
    assert capture.selected_candidate.snapshot_url == snapshot_url
    assert capture.quality_signals["ftGhostarchiveOriginValidated"] is True
    assert capture.quality_signals["ghostarchiveOriginHeadlineOverlap"] == 1.0


def test_ft_infini_news_row_is_stored_as_validated_derived_html(
    tmp_path: Path,
):
    headline = (
        "Amazon writes its largest venture cheque yet "
        "for AI start-up Anthropic"
    )
    canonical_url = (
        "https://www.ft.com/content/"
        "a604bc55-26a5-42ca-a707-e6537abe0c1d"
    )
    partner_url = (
        "https://www.irishtimes.com/business/2024/03/28/"
        "amazon-invests-in-ai-start-up/"
    )
    row_url = (
        "https://datasets-server.huggingface.co/rows?"
        "dataset=ruggsea%2Finfini-news-corpus&config=year_2024&"
        "split=train&offset=12345&length=1"
    )
    body = "\n".join(
        [
            (
                "Licensed business reporting paragraph "
                f"{index} contains substantive investment details, "
                "executive comments, market conditions, financial "
                "disclosures and competitive analysis."
            )
            for index in range(1, 8)
        ]
        + ["Copyright The Financial Times Limited 2024"]
    )
    payload = json.dumps(
        {
            "rows": [
                {
                    "row_idx": 12345,
                    "row": {
                        "url": partner_url,
                        "year": 2024,
                        "title": headline,
                        "publish_date": "2024-03-28",
                        "author": "Financial Times reporters",
                        "description": "Licensed Financial Times report.",
                        "text": body,
                        "warc_filename": (
                            "CC-NEWS-20240328160318-02712.warc.gz"
                        ),
                    }
                }
            ]
        }
    ).encode()
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2024-03-28T00:00:00+00:00",
        section="business",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.INFINI_NEWS,
                snapshot_url=row_url,
                source_url=partner_url,
                expected_headline=headline,
                warc_filename=(
                    "CC-NEWS-20240328160318-02712.warc.gz"
                ),
            ),
        ),
    )
    client = StubArchiveClient(
        {
            row_url: (
                200,
                {"content-type": "application/json"},
                payload,
                row_url,
            )
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    capture = result["capture"]
    assert capture.selected_candidate.provider == CaptureProvider.INFINI_NEWS
    assert capture.representation == CaptureRepresentation.DERIVED_HTML
    assert capture.final_url == partner_url
    assert capture.quality_signals["infiniNewsValidated"] is True
    assert capture.quality_signals["infiniNewsDerivedHtml"] is True
    assert capture.quality_signals["ftSyndicationValidated"] is True
    with gzip.open(tmp_path / capture.raw_html.path, "rb") as handle:
        derived = handle.read().decode("utf-8")
    assert 'data-jojo-representation="derived-infini-news"' in derived
    assert canonical_url in derived
    assert "Licensed business reporting paragraph 7" in derived
    article = parse_article(
        derived.encode(),
        publisher="ft",
        canonical_url=canonical_url,
        raw_capture=capture,
    )
    assert article.quality.status.value == "complete"
    assert article.quality.body_characters >= 400
    record = json.loads((tmp_path / result["recordPath"]).read_text())
    assert record["representation"] == "derived-html"
    assert record["selectedCandidate"]["sourceUrl"] == partner_url

    tampered = json.loads(payload)
    tampered["rows"][0]["row_idx"] = 12346
    tampered_client = StubArchiveClient(
        {
            row_url: (
                200,
                {"content-type": "application/json"},
                json.dumps(tampered).encode(),
                row_url,
            )
        }
    )
    rejected_row = capture_item(
        item,
        archive_client=tampered_client,
        output_dir=tmp_path / "wrong-row",
        maximum_html_bytes=1_000_000,
    )
    assert rejected_row["status"] == "error"
    assert "infini-news:ValueError" in rejected_row["error"]

    missing_warc_item = replace(
        item,
        candidates=(
            item.candidates[0].model_copy(
                update={"warc_filename": None}
            ),
        ),
    )
    rejected_warc = capture_item(
        missing_warc_item,
        archive_client=client,
        output_dir=tmp_path / "missing-warc",
        maximum_html_bytes=1_000_000,
    )
    assert rejected_warc["status"] == "error"
    assert "infini-news:ValueError" in rejected_warc["error"]


def test_ft_title_index_falls_back_to_validated_infini_row(
    tmp_path: Path,
):
    headline = (
        "Russians rehearsed using tactical nuclear weapons "
        "at early stage of conflict"
    )
    canonical_url = (
        "https://www.ft.com/content/"
        "6544119e-a511-4cfa-9243-13b8cf855c13"
    )
    snapshot_url = (
        "https://web.archive.org/web/20240229000000id_/"
        + canonical_url
    )
    partner_url = (
        "https://www.irishtimes.com/world/europe/2024/02/28/"
        "russians-rehearsed-using-tactical-nuclear-weapons/"
    )
    row_url = (
        "https://datasets-server.huggingface.co/rows?"
        "dataset=ruggsea%2Finfini-news-corpus&config=year_2024&"
        "split=train&offset=26225947&length=1"
    )
    warc_filename = "CC-NEWS-20240228173301-02619.warc.gz"
    body = "\n".join(
        [
            (
                "Licensed geopolitical reporting paragraph "
                f"{index} contains detailed evidence, official analysis, "
                "historical comparisons, strategic context and enough "
                "substantive reporting for a complete article."
            )
            for index in range(1, 9)
        ]
        + ["Copyright The Financial Times Limited 2024"]
    )
    payload = json.dumps(
        {
            "rows": [
                {
                    "row_idx": 26225947,
                    "row": {
                        "url": partner_url,
                        "year": 2024,
                        "title": headline,
                        "publish_date": "2024-02-28",
                        "text": body,
                        "warc_filename": warc_filename,
                    },
                }
            ]
        }
    ).encode()
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2024-02-28T00:00:00+00:00",
        section="world",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=snapshot_url,
                expected_headline=headline,
            ),
        ),
    )
    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.ft.com%2Fcontent%2F"
        "6544119e-a511-4cfa-9243-13b8cf855c13"
    )
    ghost_search_url = ghostarchive_search_url(canonical_url)
    client = StubArchiveClient(
        {
            ghost_search_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                b"<html><body>No archives</body></html>",
                ghost_search_url,
            ),
            timemap_url: (
                200,
                {"content-type": "application/json"},
                b'[["urlkey","timestamp","original","mimetype",'
                b'"statuscode"]]',
                timemap_url,
            ),
            snapshot_url: (
                404,
                {"content-type": "text/html"},
                b"",
                snapshot_url,
            ),
            partner_url: (
                404,
                {"content-type": "text/html"},
                b"",
                partner_url,
            ),
            row_url: (
                200,
                {"content-type": "application/json"},
                payload,
                row_url,
            ),
        }
    )
    lookups: list[tuple[str, str]] = []

    def lookup(
        indexed_item: ManifestItem,
        indexed_headline: str,
    ) -> tuple[CaptureCandidate, ...]:
        lookups.append((indexed_item.canonical_url, indexed_headline))
        return (
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=partner_url,
                expected_headline=headline,
            ),
            CaptureCandidate(
                provider=CaptureProvider.INFINI_NEWS,
                snapshot_url=row_url,
                source_url=partner_url,
                expected_headline=headline,
                warc_filename=warc_filename,
            ),
        )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
        enable_common_crawl_fallback=True,
        ft_syndication_lookup=lookup,
    )

    assert result["status"] == "complete"
    assert lookups == [(canonical_url, headline)]
    capture = result["capture"]
    assert capture.selected_candidate.provider == CaptureProvider.INFINI_NEWS
    assert capture.representation == CaptureRepresentation.DERIVED_HTML
    assert capture.quality_score == 100
    assert capture.quality_signals["ftSyndicationValidated"] is True
    assert capture.quality_signals["infiniNewsWarcFilename"] == warc_filename
    assert client.requests[-2:] == [partner_url, row_url]
    assert not any(
        "index.commoncrawl.org" in request
        for request in client.requests
    )


def test_ft_dynamic_syndication_keeps_searching_before_common_crawl(
    tmp_path: Path,
    monkeypatch,
):
    headline = "The great bond and equity conundrum"
    canonical_url = (
        "https://www.ft.com/content/"
        "95b72cd7-a7b7-4fdd-9afb-ce5fb13f3811"
    )
    snapshot_url = (
        "https://web.archive.org/web/20240328000000id_/"
        + canonical_url
    )
    partner_url = (
        "https://www.example-adviser.test/resources/articles/"
        "the-great-bond-and-equity-conundrum"
    )
    distractor_url = (
        "https://www.example-blog.test/markets/"
        "the-great-bond-and-equity-conundrum"
    )
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2024-03-28T00:00:00+00:00",
        section="markets",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=snapshot_url,
                expected_headline=headline,
            ),
        ),
    )
    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.ft.com%2Fcontent%2F"
        "95b72cd7-a7b7-4fdd-9afb-ce5fb13f3811"
    )
    client = StubArchiveClient(
        {
            timemap_url: (
                200,
                {"content-type": "application/json"},
                b'[["urlkey","timestamp","original","mimetype",'
                b'"statuscode"]]',
                timemap_url,
            ),
            snapshot_url: (
                404,
                {"content-type": "text/html; charset=utf-8"},
                b"",
                snapshot_url,
            ),
            partner_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                ft_syndication_html(
                    headline=headline,
                    include_copyright=True,
                ),
                partner_url,
            ),
            distractor_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                ft_syndication_html(
                    headline=headline,
                    include_copyright=False,
                ),
                distractor_url,
            ),
        }
    )

    discovery_calls: list[dict[str, object]] = []

    def fake_discovery(*args, **kwargs):
        discovery_calls.append(kwargs)
        candidate_url = (
            partner_url
            if kwargs.get("exhaustive")
            else distractor_url
        )
        return (
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=candidate_url,
                expected_headline=headline,
            ),
        )

    monkeypatch.setattr(
        "jojo_news_archive.sources.ft.capture."
        "discover_ft_syndication_candidates",
        fake_discovery,
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
        enable_common_crawl_fallback=True,
    )

    assert result["status"] == "complete"
    assert result["capture"].selected_candidate.snapshot_url == partner_url
    assert client.requests[-1] == partner_url
    assert [call.get("exhaustive", False) for call in discovery_calls] == [
        False,
        True,
    ]
    assert discovery_calls[-1]["skip_title_search"] is True
    assert not any(
        "index.commoncrawl.org" in request
        for request in client.requests
    )


def test_ft_manifest_partner_copy_rejects_missing_copyright(
    tmp_path: Path,
):
    headline = (
        "Amazon writes its largest venture cheque yet "
        "for AI start-up Anthropic"
    )
    partner_url = (
        "https://www.irishtimes.com/business/2024/03/28/"
        "independent-related-article/"
    )
    item = ManifestItem(
        publisher="ft",
        canonical_url=(
            "https://www.ft.com/content/"
            "a604bc55-26a5-42ca-a707-e6537abe0c1d"
        ),
        published_at="2024-03-28T00:00:00+00:00",
        section="business",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=partner_url,
                expected_headline=headline,
            ),
        ),
    )
    client = StubArchiveClient(
        {
            partner_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                ft_syndication_html(
                    headline=headline,
                    include_copyright=False,
                ),
                partner_url,
            )
        }
    )
    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "error"
    assert "missing-ft-copyright" in result["error"]
    assert not (tmp_path / "objects").exists()


def test_wsj_manifest_partner_copy_requires_strict_validation(
    tmp_path: Path,
):
    headline = "Investors Prepare for a Volatile Summer in Global Markets"
    canonical_url = (
        "https://www.wsj.com/finance/stocks/"
        "investors-prepare-for-a-volatile-summer-in-global-markets-a1b2c3d4"
    )
    partner_url = (
        "https://www.tovima.com/wsj/"
        "a-complete-licensed-wsj-copy/"
    )
    item = ManifestItem(
        publisher="wsj",
        canonical_url=canonical_url,
        published_at="2024-06-03T12:34:56+00:00",
        section="finance",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=partner_url,
                expected_headline=headline,
            ),
        ),
    )
    client = StubArchiveClient(
        {
            partner_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                wsj_syndication_html(
                    headline=headline,
                    attribution="The Wall Street Journal",
                ),
                partner_url,
            )
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    capture = result["capture"]
    assert capture.selected_candidate.provider == CaptureProvider.OTHER
    assert capture.quality_signals["wsjSyndicationValidated"] is True
    assert capture.quality_signals["syndicationWsjAttributed"] is True
    assert (
        capture.quality_signals["syndicationBodyCharacters"]
        >= WSJ_SYNDICATION_MINIMUM_BODY_CHARACTERS
    )
    assert capture.quality_signals["syndicationHeadlineOverlap"] == 1.0
    assert capture.quality_signals["syndicationPartnerHostValidated"] is True


def test_wsj_manifest_partner_copy_rejects_missing_attribution(
    tmp_path: Path,
):
    headline = "Investors Prepare for a Volatile Summer in Global Markets"
    partner_url = "https://www.tovima.com/wsj/unattributed-copy/"
    item = ManifestItem(
        publisher="wsj",
        canonical_url=(
            "https://www.wsj.com/finance/stocks/"
            "investors-prepare-for-a-volatile-summer-in-global-markets-"
            "a1b2c3d4"
        ),
        published_at="2024-06-03T12:34:56+00:00",
        section="finance",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=partner_url,
                expected_headline=headline,
            ),
        ),
    )
    client = StubArchiveClient(
        {
            partner_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                wsj_syndication_html(
                    headline=headline,
                    attribution="Independent Market Desk",
                ),
                partner_url,
            )
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "error"
    assert "missing-wsj-attribution" in result["error"]
    assert not (tmp_path / "objects").exists()


def test_wsj_manifest_partner_copy_rejects_unapproved_host(
    tmp_path: Path,
):
    headline = "Investors Prepare for a Volatile Summer in Global Markets"
    partner_url = "https://example.com/wsj/copied-page/"
    item = ManifestItem(
        publisher="wsj",
        canonical_url=(
            "https://www.wsj.com/finance/stocks/"
            "investors-prepare-for-a-volatile-summer-in-global-markets-"
            "a1b2c3d4"
        ),
        published_at="2024-06-03T12:34:56+00:00",
        section="finance",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=partner_url,
                expected_headline=headline,
            ),
        ),
    )
    client = StubArchiveClient(
        {
            partner_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                wsj_syndication_html(
                    headline=headline,
                    attribution="The Wall Street Journal",
                ),
                partner_url,
            )
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "error"
    assert "unexpected-partner-url" in result["error"]
    assert not (tmp_path / "objects").exists()


def test_legacy_manifest_loads_into_generic_capture_state(tmp_path: Path):
    manifest = tmp_path / "manifest.jsonl.gz"
    row = {
        "url": "https://www.bloomberg.com/news/articles/2020-01-01/example",
        "catalog_date": "2020-01-01T00:00:00+00:00",
        "section": "news",
        "wayback_timestamp": "20200102125527",
        "wayback_snapshot_url": (
            "https://web.archive.org/web/20200102125527id_/"
            "https://www.bloomberg.com/news/articles/2020-01-01/example"
        ),
        "wayback_digest": "EXAMPLE",
        "wayback_mimetype": "text/html",
    }
    with gzip.open(manifest, "wt", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")

    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="bloomberg",
        authorization_reference="authorization:test",
    )
    result = load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="bloomberg",
    )
    selected = pending_captures(
        connection,
        retry_errors=False,
        maximum=None,
        maximum_record_attempts=3,
    )

    assert result == {"manifestRows": 1, "inserted": 1}
    assert len(selected) == 1
    assert selected[0].publisher == "bloomberg"
    assert selected[0].candidates[0].provider == CaptureProvider.WAYBACK
    assert (
        selected[0].candidates[0].captured_at
        == datetime(2020, 1, 2, 12, 55, 27, tzinfo=timezone.utc)
    )


def test_capture_leases_are_disjoint_across_concurrent_connections(
    tmp_path: Path,
):
    state = tmp_path / "capture.sqlite3"
    first_connection = sqlite3.connect(state, timeout=5)
    initialize_capture_schema(
        first_connection,
        publisher="nyt",
        authorization_reference="authorization:test",
    )
    first_connection.executemany(
        """
        INSERT INTO captures(
            canonical_url, article_id, publisher, published_at,
            candidates_json, status, attempts, updated_at
        ) VALUES (?, ?, 'nyt', ?, '[]', 'pending', 0, ?)
        """,
        (
            (
                f"https://www.nytimes.com/2010/01/0{index}/example-{index}.html",
                f"nyt-{index}",
                f"2010-01-0{index}T00:00:00Z",
                "2026-08-23T00:00:00Z",
            )
            for index in range(1, 5)
        ),
    )
    first_connection.commit()
    second_connection = sqlite3.connect(state, timeout=5)
    initialize_capture_schema(
        second_connection,
        publisher="nyt",
        authorization_reference="authorization:test",
        recover_interrupted=False,
    )

    first = lease_pending_captures(
        first_connection,
        retry_errors=False,
        maximum=2,
        maximum_record_attempts=3,
    )
    second = lease_pending_captures(
        second_connection,
        retry_errors=False,
        maximum=2,
        maximum_record_attempts=3,
    )

    first_urls = {item.canonical_url for item in first}
    second_urls = {item.canonical_url for item in second}
    assert len(first_urls) == len(second_urls) == 2
    assert first_urls.isdisjoint(second_urls)
    assert first_connection.execute(
        "SELECT COUNT(*) FROM captures WHERE status='downloading' AND attempts=1"
    ).fetchone()[0] == 4

    assert release_capture_leases(first_connection, first) == 2
    assert first_connection.execute(
        "SELECT COUNT(*) FROM captures WHERE status='pending' AND attempts=0"
    ).fetchone()[0] == 2
    assert first_connection.execute(
        "SELECT COUNT(*) FROM captures WHERE status='downloading' AND attempts=1"
    ).fetchone()[0] == 2
    second_connection.close()
    first_connection.close()


def test_capture_lease_retries_a_brief_concurrent_write_lock(tmp_path: Path):
    state = tmp_path / "capture.sqlite3"
    setup = sqlite3.connect(state)
    initialize_capture_schema(
        setup,
        publisher="nyt",
        authorization_reference="authorization:test",
    )
    setup.execute(
        """
        INSERT INTO captures(
            canonical_url, article_id, publisher, published_at,
            candidates_json, status, attempts, updated_at
        ) VALUES (?, ?, 'nyt', ?, '[]', 'pending', 0, ?)
        """,
        (
            "https://www.nytimes.com/2010/01/01/example.html",
            "nyt-example",
            "2010-01-01T00:00:00Z",
            "2026-08-23T00:00:00Z",
        ),
    )
    setup.commit()
    setup.close()
    lock_acquired = Event()

    def hold_write_lock() -> None:
        holder = sqlite3.connect(state)
        holder.execute("BEGIN IMMEDIATE")
        lock_acquired.set()
        time.sleep(0.15)
        holder.commit()
        holder.close()

    thread = Thread(target=hold_write_lock)
    thread.start()
    assert lock_acquired.wait(timeout=2)
    worker = sqlite3.connect(state, timeout=0)

    leased = lease_pending_captures(
        worker,
        retry_errors=False,
        maximum=1,
        maximum_record_attempts=3,
    )

    thread.join(timeout=2)
    assert not thread.is_alive()
    assert [item.canonical_url for item in leased] == [
        "https://www.nytimes.com/2010/01/01/example.html"
    ]
    worker.close()


def test_axios_manifest_collapses_encoded_trailing_aliases(tmp_path: Path):
    canonical_url = "https://www.axios.com/2025/01/20/example-story"
    manifest = tmp_path / "manifest.jsonl"
    rows = []
    for suffix in ("", "%5C", "%0A", "%20"):
        source_url = canonical_url + suffix
        rows.append(
            {
                "publisher": "axios",
                "canonicalUrl": source_url,
                "publishedAt": "2025-01-20T00:00:00Z",
                "candidates": [
                    {
                        "provider": "wayback",
                        "snapshotUrl": (
                            "https://web.archive.org/web/20250121000000id_/"
                            + source_url
                        ),
                    }
                ],
            }
        )
    manifest.write_text(
        "".join(json.dumps(row) + "\n" for row in rows),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="axios",
        authorization_reference="authorization:test",
    )

    result = load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="axios",
    )

    assert result == {"manifestRows": 4, "inserted": 1}
    assert connection.execute(
        "SELECT canonical_url FROM captures"
    ).fetchall() == [(canonical_url,)]
    candidate_rows = json.loads(
        connection.execute(
            "SELECT candidates_json FROM captures WHERE canonical_url=?",
            (canonical_url,),
        ).fetchone()[0]
    )
    assert len(candidate_rows) == 4


def test_npr_manifest_normalizes_tracking_suffix_in_path(tmp_path: Path):
    canonical_url = (
        "https://www.npr.org/2012/01/14/145168801/"
        "alsop-sprach-zarathustra-the-conductor-decodes-strauss-iconic-tone-poem"
    )
    alias_url = canonical_url + "&sc=nl&cc=sod-20120120"
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_text(
        json.dumps(
            {
                "publisher": "npr",
                "canonicalUrl": alias_url,
                "publishedAt": "2012-01-14T00:00:00Z",
                "candidates": [
                    {
                        "provider": "wayback",
                        "snapshotUrl": (
                            "https://web.archive.org/web/20120115000000id_/"
                            + alias_url
                        ),
                    }
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="npr",
        authorization_reference="authorization:test",
    )

    result = load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="npr",
    )

    assert result == {"manifestRows": 1, "inserted": 1}
    assert connection.execute(
        "SELECT canonical_url FROM captures"
    ).fetchall() == [(canonical_url,)]


def test_interrupted_capture_does_not_consume_an_attempt():
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    connection.execute(
        """
        INSERT INTO captures(
            canonical_url, article_id, publisher, published_at, section,
            candidates_json, status, attempts, updated_at
        ) VALUES (
            'https://www.wsj.com/articles/interrupted',
            'wsj-interrupted',
            'wsj',
            '2017-01-01T00:00:00Z',
            NULL,
            '[]',
            'downloading',
            2,
            'now'
        )
        """
    )
    connection.commit()

    initialize_capture_schema(
        connection,
        publisher="wsj",
        authorization_reference="authorization:test",
    )

    assert connection.execute(
        "SELECT status, attempts, last_error FROM captures"
    ).fetchone() == (
        "pending",
        1,
        "interrupted before completion",
    )


def test_capture_schema_requeues_completed_tiny_html_shell():
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="npr",
        authorization_reference="authorization:test",
    )
    connection.execute(
        """
        INSERT INTO captures(
            canonical_url, article_id, publisher, candidates_json,
            status, attempts, content_type, quality_score, raw_bytes,
            updated_at
        ) VALUES (
            'https://www.npr.org/2012/05/03/151955581/example',
            'npr-example',
            'npr',
            '[]',
            'complete',
            1,
            'text/html',
            70,
            65,
            'now'
        )
        """
    )
    connection.commit()

    initialize_capture_schema(
        connection,
        publisher="npr",
        authorization_reference="authorization:test",
    )

    assert connection.execute(
        "SELECT status, attempts, last_error FROM captures"
    ).fetchone() == (
        "pending",
        0,
        "quality-recheck:tiny-html-shell",
    )


def test_pending_capture_prioritizes_quality_recheck_before_validation():
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="npr",
        authorization_reference="authorization:test",
    )
    connection.executemany(
        """
        INSERT INTO captures(
            canonical_url, article_id, publisher, published_at,
            candidates_json, status, attempts, last_error, updated_at
        ) VALUES (?, ?, 'npr', ?, '[]', 'pending', 0, ?, ?)
        """,
        (
            (
                "https://www.npr.org/2010/01/01/1/ordinary",
                "npr-ordinary",
                "2010-01-01T00:00:00Z",
                None,
                "2026-08-09T00:00:00Z",
            ),
            (
                "https://www.npr.org/2012/05/03/2/tiny-shell",
                "npr-repair",
                "2012-05-03T00:00:00Z",
                "quality-recheck:tiny-html-shell",
                "2026-08-09T01:00:00Z",
            ),
        ),
    )
    connection.commit()

    selected = pending_captures(
        connection,
        retry_errors=False,
        maximum=1,
        maximum_record_attempts=3,
        prioritize_parser_validation=True,
    )

    assert [item.canonical_url for item in selected] == [
        "https://www.npr.org/2012/05/03/2/tiny-shell"
    ]


def test_manifest_refresh_retries_errors_when_candidates_change(
    tmp_path: Path,
):
    canonical_url = "https://apnews.com/article/manifest-refresh"
    wayback_url = (
        "https://web.archive.org/web/20260102000000id_/"
        f"{canonical_url}"
    )
    manifest = tmp_path / "manifest.jsonl"

    def write_manifest(candidates: list[dict[str, object]]) -> None:
        manifest.write_text(
            json.dumps(
                {
                    "publisher": "ap",
                    "canonicalUrl": canonical_url,
                    "publishedAt": "2026-01-01T00:00:00Z",
                    "candidates": candidates,
                }
            )
            + "\n",
            encoding="utf-8",
        )

    write_manifest(
        [
            {
                "provider": "wayback",
                "snapshotUrl": wayback_url,
            }
        ]
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="ap",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="ap",
    )
    connection.execute(
        """
        UPDATE captures
        SET status='error',
            attempts=3,
            last_error='old candidates exhausted'
        """
    )
    connection.commit()

    write_manifest(
        [
            {
                "provider": "wayback",
                "snapshotUrl": wayback_url,
            },
            {
                "provider": "live-origin",
                "snapshotUrl": canonical_url,
            },
        ]
    )
    result = load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="ap",
    )
    row = connection.execute(
        """
        SELECT status, attempts, last_error, candidates_json
        FROM captures
        """
    ).fetchone()

    assert result == {"manifestRows": 1, "inserted": 1}
    assert row[0:3] == ("pending", 0, None)
    assert [
        candidate["provider"]
        for candidate in json.loads(row[3])
    ] == ["wayback", "live-origin"]


def test_manifest_refresh_corrects_completed_capture_publication_date(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.reuters.com/article/"
        "example-idUSL1N0AB12320120607"
    )
    manifest = tmp_path / "manifest.jsonl"

    def write_manifest(published_at: str) -> None:
        manifest.write_text(
            json.dumps(
                {
                    "publisher": "reuters",
                    "canonicalUrl": canonical_url,
                    "publishedAt": published_at,
                    "candidates": [
                        {
                            "provider": "wayback",
                            "snapshotUrl": (
                                "https://web.archive.org/web/"
                                "20150102000000id_/"
                                + canonical_url
                            ),
                        }
                    ],
                }
            )
            + "\n",
            encoding="utf-8",
        )

    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="reuters",
        authorization_reference="authorization:test",
    )
    write_manifest("2015-01-02T00:00:00+00:00")
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="reuters",
    )
    connection.execute("UPDATE captures SET status='complete'")
    write_manifest("2012-06-07T00:00:00+00:00")

    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="reuters",
    )

    assert connection.execute(
        "SELECT status, published_at FROM captures WHERE canonical_url=?",
        (canonical_url,),
    ).fetchone() == ("complete", "2012-06-07T00:00:00+00:00")


def test_manifest_refresh_preserves_preindexed_mirror_candidate(
    tmp_path: Path,
):
    canonical_url = "https://www.ft.com/content/preindexed-mirror"
    wayback_url = (
        "https://web.archive.org/web/20260102000000id_/"
        + canonical_url
    )
    mirror_url = (
        "https://m.ftchinese.com/interactive/283158/en?full=y"
    )
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_text(
        json.dumps(
            {
                "publisher": "ft",
                "canonicalUrl": canonical_url,
                "publishedAt": "2026-01-01T00:00:00Z",
                "candidates": [
                    {
                        "provider": "wayback",
                        "snapshotUrl": wayback_url,
                    }
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="ft",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="ft",
    )
    existing = json.loads(
        connection.execute(
            "SELECT candidates_json FROM captures"
        ).fetchone()[0]
    )
    connection.execute(
        "UPDATE captures SET candidates_json=?",
        (
            json.dumps(
                [
                    {
                        "provider": "other",
                        "snapshotUrl": mirror_url,
                        "expectedHeadline": "A validated mirror headline",
                    },
                    *existing,
                ]
            ),
        ),
    )
    connection.commit()

    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="ft",
    )
    candidates = json.loads(
        connection.execute(
            "SELECT candidates_json FROM captures"
        ).fetchone()[0]
    )

    assert [candidate["provider"] for candidate in candidates] == [
        "other",
        "wayback",
    ]
    assert candidates[0]["snapshotUrl"] == mirror_url


def test_manifest_refresh_preserves_preindexed_arquivo_candidates(
    tmp_path: Path,
):
    canonical_url = "https://www.wsj.com/articles/preindexed-arquivo"
    wayback_url = (
        "https://web.archive.org/web/20170102000000id_/" + canonical_url
    )
    arquivo_url = (
        "https://arquivo.pt/noFrame/replay/20170103000000/" + canonical_url
    )
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_text(
        json.dumps(
            {
                "publisher": "wsj",
                "canonicalUrl": canonical_url,
                "publishedAt": "2017-01-01T00:00:00Z",
                "candidates": [
                    {
                        "provider": "wayback",
                        "snapshotUrl": wayback_url,
                    }
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="wsj",
    )
    existing = json.loads(
        connection.execute("SELECT candidates_json FROM captures").fetchone()[0]
    )
    connection.execute(
        "UPDATE captures SET candidates_json=?",
        (
            json.dumps(
                [
                    {
                        "provider": "arquivo-pt",
                        "snapshotUrl": arquivo_url,
                        "digest": "ARQUIVO",
                    },
                    *existing,
                ]
            ),
        ),
    )
    connection.commit()

    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="wsj",
    )
    candidates = json.loads(
        connection.execute("SELECT candidates_json FROM captures").fetchone()[0]
    )

    assert [candidate["provider"] for candidate in candidates] == [
        "arquivo-pt",
        "wayback",
    ]
    assert candidates[0]["snapshotUrl"] == arquivo_url


def test_wsj_manifest_refresh_removes_stale_infini_candidate(
    tmp_path: Path,
):
    canonical_url = "https://www.wsj.com/articles/stale-infini-preview"
    wayback_url = (
        "https://web.archive.org/web/20170102000000id_/" + canonical_url
    )
    infini_url = (
        "https://datasets-server.huggingface.co/rows?"
        "dataset=ruggsea%2Finfini-news-corpus&config=year_2017&"
        "split=train&offset=42&length=1"
    )
    manifest = tmp_path / "manifest.jsonl"

    def write_manifest(candidates: list[dict[str, object]]) -> None:
        manifest.write_text(
            json.dumps(
                {
                    "publisher": "wsj",
                    "canonicalUrl": canonical_url,
                    "publishedAt": "2017-01-01T00:00:00Z",
                    "candidates": candidates,
                }
            )
            + "\n",
            encoding="utf-8",
        )

    write_manifest(
        [
            {
                "provider": "infini-news",
                "snapshotUrl": infini_url,
                "sourceUrl": canonical_url,
                "expectedHeadline": "A stale short WSJ preview",
            },
            {"provider": "wayback", "snapshotUrl": wayback_url},
        ]
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="wsj",
    )

    write_manifest([{"provider": "wayback", "snapshotUrl": wayback_url}])
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="wsj",
    )
    candidates = json.loads(
        connection.execute("SELECT candidates_json FROM captures").fetchone()[0]
    )

    assert [candidate["provider"] for candidate in candidates] == ["wayback"]


def test_capture_policy_upgrade_retries_errors_once(tmp_path: Path):
    canonical_url = "https://www.ft.com/content/policy-upgrade"
    snapshot_url = (
        "https://web.archive.org/web/20260102000000id_/"
        + canonical_url
    )
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_text(
        json.dumps(
            {
                "publisher": "ft",
                "canonicalUrl": canonical_url,
                "publishedAt": "2026-01-01T00:00:00Z",
                "candidates": [
                    {
                        "provider": "wayback",
                        "snapshotUrl": snapshot_url,
                    }
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="ft",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="ft",
    )
    connection.execute(
        """
        UPDATE archive_metadata
        SET value='ft-capture/old'
        WHERE key='capture_policy_version'
        """
    )
    connection.execute(
        """
        UPDATE captures
        SET status='error',
            attempts=3,
            last_error='old policy exhausted'
        """
    )
    connection.commit()

    initialize_capture_schema(
        connection,
        publisher="ft",
        authorization_reference="authorization:test",
    )
    first = connection.execute(
        "SELECT status, attempts, last_error FROM captures"
    ).fetchone()
    stored_version = connection.execute(
        """
        SELECT value
        FROM archive_metadata
        WHERE key='capture_policy_version'
        """
    ).fetchone()[0]
    connection.execute(
        """
        UPDATE captures
        SET status='error',
            attempts=2,
            last_error='current policy failure'
        """
    )
    connection.commit()

    initialize_capture_schema(
        connection,
        publisher="ft",
        authorization_reference="authorization:test",
    )
    second = connection.execute(
        "SELECT status, attempts, last_error FROM captures"
    ).fetchone()

    assert first == ("pending", 0, None)
    assert stored_version == source_module("ft").capture_policy_version
    assert second == ("error", 2, "current policy failure")


def test_capture_tries_fallback_and_stores_only_usable_raw_html(tmp_path: Path):
    first_url = "https://web.archive.org/web/20200101000000id_/https://example.com/a"
    second_url = "https://web.archive.org/web/20200102000000id_/https://example.com/a"
    error_page = (
        b"<html>Wayback Machine doesn't have that page archived.</html>"
    )
    client = StubArchiveClient(
        {
            first_url: (200, {"content-type": "text/html"}, error_page, first_url),
            second_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                ARTICLE,
                second_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="ap",
        canonical_url="https://apnews.com/article/example",
        published_at="2020-01-01T00:00:00Z",
        section="world",
        candidates=(
            candidate(first_url, "20200101000000"),
            candidate(second_url, "20200102000000"),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [first_url, second_url]
    capture = result["capture"]
    assert capture.selected_candidate.snapshot_url == second_url
    assert capture.raw_html.byte_count == len(ARTICLE)
    assert capture.quality_signals["archiveErrorPage"] is False
    with gzip.open(tmp_path / capture.raw_html.path, "rb") as handle:
        assert handle.read() == ARTICLE
    record = json.loads((tmp_path / result["recordPath"]).read_text("utf-8"))
    assert record["formatVersion"] == "jojo-raw-capture/1"
    assert record["canonicalUrl"] == item.canonical_url
    assert "plainText" not in record
    assert "bodyHtml" not in record


def test_npr_missing_404_capture_is_rejected_before_fallback(tmp_path: Path):
    canonical_url = "https://www.npr.org/2012/01/10/145002553/example"
    first_url = (
        "https://web.archive.org/web/20120111000000id_/" + canonical_url
    )
    second_url = (
        "https://web.archive.org/web/20120112000000id_/" + canonical_url
    )
    missing_page = b"""
    <html><head><title>Page Not Found</title></head>
      <body class="missing-404"><main><h1>Page Not Found</h1>
      <p>The requested NPR story could not be found.</p></main></body>
    </html>
    """ + (b" " * 2_048)
    client = StubArchiveClient(
        {
            first_url: (
                200,
                {"content-type": "text/html"},
                missing_page,
                first_url,
            ),
            second_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                second_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="npr",
        canonical_url=canonical_url,
        published_at="2012-01-10T00:00:00Z",
        section="news",
        candidates=(
            candidate(first_url, "20120111000000"),
            candidate(second_url, "20120112000000"),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [first_url, second_url]
    assert result["capture"].selected_candidate.snapshot_url == second_url
    assert result["capture"].quality_signals["archiveErrorPage"] is False


def test_ap_thin_live_origin_prefers_full_wayback_capture(tmp_path: Path):
    canonical_url = "https://apnews.com/article/historical-example"
    wayback_url = (
        "https://web.archive.org/web/20200102000000id_/"
        + canonical_url
    )
    thin_live_page = b"""
    <html><head>
      <script type="application/ld+json">
        {"@type":"NewsArticle","headline":"Historical AP headline"}
      </script>
    </head><body>
      <article>
        <div data-key="article"><p>Historical AP headline</p></div>
      </article>
    </body></html>
    """ + (b" " * 2_048)
    client = StubArchiveClient(
        {
            canonical_url: (
                200,
                {"content-type": "text/html"},
                thin_live_page,
                canonical_url,
            ),
            wayback_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                wayback_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="ap",
        canonical_url=canonical_url,
        published_at="2020-01-01T00:00:00Z",
        section="world",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.LIVE_ORIGIN,
                snapshot_url=canonical_url,
            ),
            candidate(wayback_url, "20200102000000"),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    capture = result["capture"]
    assert client.requests == [canonical_url, wayback_url]
    assert capture.selected_candidate.provider == CaptureProvider.WAYBACK
    assert capture.quality_score == 100


def test_zaobao_redirected_live_origin_prefers_wayback_capture(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.zaobao.com.sg/news/singapore/"
        "story20260216-8518903"
    )
    audio_brief_url = (
        "https://www.zaobao.com.sg/specials/the-audio-brief/20260216"
    )
    wayback_url = (
        "https://web.archive.org/web/20260217000000id_/" + canonical_url
    )
    audio_brief = b"""
    <html><head>
      <meta property="og:title" content="The Audio Brief">
      <meta property="og:url"
            content="https://www.zaobao.com.sg/specials/the-audio-brief/20260216">
    </head><body><article>
      <p>This is a complete but unrelated daily audio briefing page.</p>
      <p>It has enough text and images to pass generic quality checks.</p>
      <img src="https://static.zaobao.com.sg/the-audio-brief-cover.png">
    </article></body></html>
    """ + (b" " * 2_048)
    client = StubArchiveClient(
        {
            canonical_url: (
                200,
                {"content-type": "text/html"},
                audio_brief,
                audio_brief_url,
            ),
            wayback_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                wayback_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="zaobao",
        canonical_url=canonical_url,
        published_at="2026-02-16T00:00:00+08:00",
        section="singapore",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.LIVE_ORIGIN,
                snapshot_url=canonical_url,
            ),
            candidate(wayback_url, "20260217000000"),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
        enable_wayback_timemap_fallback=False,
        enable_common_crawl_fallback=False,
        enable_arquivo_pt_fallback=False,
    )

    assert result["status"] == "complete"
    assert client.requests == [canonical_url, wayback_url]
    assert (
        result["capture"].selected_candidate.provider
        == CaptureProvider.WAYBACK
    )


def test_stored_zaobao_redirected_live_origin_is_requeued(tmp_path: Path):
    canonical_url = (
        "https://www.zaobao.com.sg/news/singapore/"
        "story20260216-8518903"
    )
    audio_brief_url = (
        "https://www.zaobao.com.sg/specials/the-audio-brief/20260216"
    )
    content = b"""
    <html><head><meta property="og:title" content="The Audio Brief"></head>
    <body><article><p>A complete but unrelated audio briefing page.</p>
    <p>More briefing text makes this a substantial HTML response.</p>
    </article></body></html>
    """ + (b" " * 2_048)
    capture = RawCapture(
        article_id="zaobao:" + ("z" * 64),
        publisher="zaobao",
        canonical_url=canonical_url,
        published_at=datetime(2026, 2, 16, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.LIVE_ORIGIN,
            snapshot_url=canonical_url,
        ),
        candidates_considered=[],
        retrieved_at=datetime.now(timezone.utc),
        final_url=audio_brief_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=store_raw_html(tmp_path, content),
    )

    assert completed_capture_rejection_reason(
        capture,
        archive_root=tmp_path,
    ) == "zaobao-live-origin-target-mismatch"


def test_ap_thin_origin_recovers_validated_syndicated_copy(
    tmp_path: Path,
):
    canonical_url = (
        "https://apnews.com/united-states-presidential-election-"
        "general-news-events-example"
    )
    description = (
        "A North Carolina police department has rescinded its offer to "
        "send 50 police officers to the Republican National Convention, "
        "citing concerns about insurance coverage and preparedness."
    )
    source_page = f"""
    <html><head>
      <meta property="og:description" content="{description}">
      <script type="application/ld+json">{{
        "@type": "NewsArticle",
        "datePublished": "2016-05-27T20:51:05Z",
        "description": "{description}",
        "name": "AP News"
      }}</script>
    </head><body><main></main></body></html>
    """.encode() + (b" " * 2_048)
    partner_url = (
        "https://partner.example/police-department-wont-send-officers"
    )
    paragraphs = "".join(
        (
            f"<p>{description} Associated Press reporting paragraph "
            f"{index} adds verified details about the decision, local "
            "officials, convention planning and public safety.</p>"
        )
        for index in range(5)
    )
    partner_page = f"""
    <html><head><script type="application/ld+json">{{
      "@type": "NewsArticle",
      "headline": "Police department won't send officers to RNC",
      "datePublished": "2016-05-27T20:51:05Z",
      "author": {{"name": "The Associated Press"}}
    }}</script></head><body><article>{paragraphs}</article></body></html>
    """.encode() + (b" " * 2_048)
    search_url = ap_syndication_search_url(description)
    search_page = f"""
    <html><body><div class="result">
      <a class="result__a"
         href="//duckduckgo.com/l/?uddg={partner_url}">
        Police department won't send officers to RNC - Partner
      </a>
    </div></body></html>
    """.encode()
    client = StubArchiveClient(
        {
            canonical_url: (
                200,
                {"content-type": "text/html"},
                source_page,
                canonical_url,
            ),
            search_url: (
                200,
                {"content-type": "text/html"},
                search_page,
                search_url,
            ),
            partner_url: (
                200,
                {"content-type": "text/html"},
                partner_page,
                partner_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="ap",
        canonical_url=canonical_url,
        published_at="2016-05-27T20:51:05Z",
        section="politics",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.LIVE_ORIGIN,
                snapshot_url=canonical_url,
            ),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    capture = result["capture"]
    assert capture.selected_candidate.snapshot_url == partner_url
    assert capture.selected_candidate.provider == CaptureProvider.OTHER
    assert capture.quality_score == 100
    assert capture.quality_signals["apSyndicationValidated"] is True
    assert (
        capture.quality_signals["syndicationBodyCharacters"]
        >= AP_SYNDICATION_MINIMUM_BODY_CHARACTERS
    )
    assert capture.quality_signals["syndicationApAttributed"] is True


def test_ap_thin_origin_recovers_copy_from_structured_metadata(
    tmp_path: Path,
):
    canonical_url = (
        "https://apnews.com/united-states-government-example"
    )
    keywords = [
        "US-United-States-Pakistan",
        "Barack Obama",
        "Nawaz Sharif",
        "Foreign aid",
        "Drone surveillance and warfare",
        "Military and defense",
        "International relations",
        "Afghanistan",
        "Pakistan government",
    ]
    source_page = (
        "<html><head><script type='application/ld+json'>"
        + json.dumps(
            {
                "@type": "NewsArticle",
                "datePublished": "2013-10-19T19:44:15Z",
                "author": {"name": "Bradley Klapper"},
                "keywords": keywords,
            }
        )
        + "</script></head><body><main></main></body></html>"
    ).encode() + (b" " * 2_048)
    headline = "US quietly releases $1.6bn in aid to Pakistan"
    partner_url = "https://partner.example/us-aid-pakistan"
    paragraphs = "".join(
        (
            "<p>The United States quietly restored foreign aid to the "
            "Pakistan government before Nawaz Sharif met Barack Obama. "
            "The talks covered Afghanistan, military and defense policy, "
            "drone surveillance and international relations. Associated "
            f"Press reporting paragraph {index} provides further details."
            "</p>"
        )
        for index in range(4)
    )
    partner_page = f"""
    <html><head><script type="application/ld+json">{{
      "@type": "NewsArticle",
      "headline": "{headline}",
      "datePublished": "2013-10-19T14:30:00Z",
      "author": {{"name": "The Associated Press"}}
    }}</script></head><body><article>{paragraphs}</article></body></html>
    """.encode() + (b" " * 2_048)
    search_urls = _ap_syndication_search_urls(
        None,
        keywords,
        ["Bradley Klapper"],
    )
    assert len(search_urls) == 6
    empty_search = b"<html><body>No results</body></html>"
    result_search = f"""
    <html><body><div class="result">
      <a class="result__a"
         href="//duckduckgo.com/l/?uddg={partner_url}">
        {headline} - Partner
      </a>
    </div></body></html>
    """.encode()
    client = StubArchiveClient(
        {
            canonical_url: (
                200,
                {"content-type": "text/html"},
                source_page,
                canonical_url,
            ),
            search_urls[0]: (
                200,
                {"content-type": "text/html"},
                empty_search,
                search_urls[0],
            ),
            search_urls[1]: (
                200,
                {"content-type": "text/html"},
                empty_search,
                search_urls[1],
            ),
            search_urls[2]: (
                200,
                {"content-type": "text/html"},
                result_search,
                search_urls[2],
            ),
            partner_url: (
                200,
                {"content-type": "text/html"},
                partner_page,
                partner_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="ap",
        canonical_url=canonical_url,
        published_at="2013-10-19T19:44:15Z",
        section="politics",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.LIVE_ORIGIN,
                snapshot_url=canonical_url,
            ),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    capture = result["capture"]
    assert capture.selected_candidate.snapshot_url == partner_url
    assert capture.quality_score == 100
    assert capture.quality_signals["apSyndicationValidated"] is True
    assert (
        capture.quality_signals["syndicationMetadataTokenMatches"]
        >= 8
    )


def test_ap_live_origin_gallery_remains_full_quality(tmp_path: Path):
    canonical_url = "https://apnews.com/article/photo-gallery-example"
    slides = b"".join(
        (
            b'<div class="Carousel-slide">'
            + f'<img src="https://dims.apnews.com/photo-{index}.jpg">'.encode()
            + b"</div>"
        )
        for index in range(3)
    )
    gallery = (
        b"<html><body><article><main class=\"Page-main\">"
        b"<div class=\"Carousel\">"
        + slides
        + b"</div></main></article></body></html>"
        + (b" " * 2_048)
    )
    client = StubArchiveClient(
        {
            canonical_url: (
                200,
                {"content-type": "text/html"},
                gallery,
                canonical_url,
            )
        }
    )
    item = ManifestItem(
        publisher="ap",
        canonical_url=canonical_url,
        published_at="2025-01-01T00:00:00Z",
        section="photos",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.LIVE_ORIGIN,
                snapshot_url=canonical_url,
            ),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    capture = result["capture"]
    assert capture.selected_candidate.provider == CaptureProvider.LIVE_ORIGIN
    assert capture.quality_score == 100
    assert capture.quality_signals["apThinLiveOrigin"] is False


def test_ap_live_origin_title_shell_falls_back_to_archive(tmp_path: Path):
    canonical_url = "https://apnews.com/article/archived-report-example"
    archive_url = (
        "https://web.archive.org/web/20170727075535id_/"
        f"{canonical_url}"
    )
    shell = b"""
    <html><head>
      <meta property="og:title" content="An Archived AP Report">
      <meta property="og:description" content="An Archived AP Report">
      <meta property="article:published_time" content="2017-07-27T07:55:35Z">
      <meta property="og:image"
            content="https://assets.apnews.com/defaultshareimage-copy.png">
    </head><body>
      <main><div class="RichTextStoryBody">
        <p>An Archived AP Report</p>
      </div></main>
    </body></html>
    """ + (b" " * 2_048)
    article = b"""
    <html><head>
      <meta property="og:title" content="An Archived AP Report">
      <meta property="article:published_time" content="2017-07-27T07:55:35Z">
    </head><body>
      <main><div class="RichTextStoryBody">
        <p>The first paragraph contains the complete archived report and
        establishes the facts needed by readers.</p>
        <p>The second paragraph adds interviews, context and supporting
        details from the original Associated Press story.</p>
      </div></main>
    </body></html>
    """ + (b" " * 2_048)
    client = StubArchiveClient(
        {
            canonical_url: (
                200,
                {"content-type": "text/html"},
                shell,
                canonical_url,
            ),
            archive_url: (
                200,
                {"content-type": "text/html"},
                article,
                archive_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="ap",
        canonical_url=canonical_url,
        published_at="2017-07-27T07:55:35Z",
        section="archive",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.LIVE_ORIGIN,
                snapshot_url=canonical_url,
            ),
            CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=archive_url,
            ),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    capture = result["capture"]
    assert capture.selected_candidate.provider == CaptureProvider.WAYBACK
    assert capture.quality_signals["apCaptureParserUsable"] is True


def test_ap_live_origin_title_shell_is_not_persisted(tmp_path: Path):
    canonical_url = "https://apnews.com/article/incomplete-live-shell"
    shell = b"""
    <html><head>
      <meta property="og:title" content="Incomplete Live Shell">
      <meta property="og:description" content="Incomplete Live Shell">
      <meta property="og:image"
            content="https://assets.apnews.com/defaultshareimage-copy.png">
    </head><body>
      <main><div class="RichTextStoryBody">
        <p>Incomplete Live Shell</p>
      </div></main>
    </body></html>
    """ + (b" " * 2_048)
    client = StubArchiveClient(
        {
            canonical_url: (
                200,
                {"content-type": "text/html"},
                shell,
                canonical_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="ap",
        canonical_url=canonical_url,
        published_at=None,
        section=None,
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.LIVE_ORIGIN,
                snapshot_url=canonical_url,
            ),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "error"
    assert result["capture"] is None
    assert "ap-live-origin-parser-incomplete" in result["error"]


def test_capture_keeps_strong_article_instead_of_first_html_shell(
    tmp_path: Path,
):
    shell_url = (
        "https://web.archive.org/web/20200101000000id_/"
        "https://www.ft.com/content/example"
    )
    article_url = (
        "https://web.archive.org/web/20200102000000id_/"
        "https://amp.ft.com/content/example"
    )
    shell = (
        b"<!doctype html><html><body><p>Subscribe to read.</p></body></html>"
        + (b" " * 2_048)
    )
    client = StubArchiveClient(
        {
            shell_url: (
                200,
                {"content-type": "text/html"},
                shell,
                shell_url,
            ),
            article_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                article_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="ft",
        canonical_url="https://www.ft.com/content/example",
        published_at="2020-01-01T00:00:00Z",
        section=None,
        candidates=(
            candidate(shell_url, "20200101000000"),
            candidate(article_url, "20200102000000"),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [
        (
            "https://web.archive.org/web/timemap/json?"
            "url=https%3A%2F%2Fwww.ft.com%2Fcontent%2Fexample"
        ),
        shell_url,
        article_url,
    ]
    capture = result["capture"]
    assert capture.selected_candidate.snapshot_url == article_url
    assert capture.quality_score == 100
    assert capture.raw_html.byte_count == len(ARTICLE)
    assert len(list((tmp_path / "objects").rglob("*.html.gz"))) == 1


def test_arquivo_pt_candidates_are_exact_deduplicated_and_ranked():
    canonical_url = "https://www.ft.com/content/example"
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2020-01-01T00:00:00Z",
        section=None,
        candidates=(),
    )
    query_url = arquivo_pt_cdx_url(item)
    assert parse_qs(urlsplit(query_url).query)["filter"] == [
        "status:200",
        "mime:text/html",
    ]
    rows = [
        {
            "url": canonical_url,
            "timestamp": "20200201000000",
            "mime": "text/html",
            "status": "200",
            "digest": "FAR",
            "length": "30000",
        },
        {
            "url": canonical_url,
            "timestamp": "20200102000000",
            "mime": "text/html",
            "status": "200",
            "digest": "NEAR",
            "length": "25000",
        },
        {
            "url": canonical_url,
            "timestamp": "20200103000000",
            "mime": "text/html",
            "status": "200",
            "digest": "NEAR",
            "length": "26000",
        },
        {
            "url": "https://www.ft.com/content/different",
            "timestamp": "20200101000000",
            "mime": "text/html",
            "status": "200",
            "digest": "WRONG",
            "length": "27000",
        },
    ]
    payload = "\n".join(json.dumps(row) for row in rows).encode()
    client = StubArchiveClient(
        {
            query_url: (
                200,
                {"content-type": "text/x-ndjson"},
                payload,
                query_url,
            )
        }
    )

    candidates = discover_arquivo_pt_candidates(
        item,
        archive_client=client,
    )

    assert client.requests == [query_url]
    assert [candidate.digest for candidate in candidates] == ["NEAR", "FAR"]
    assert all(
        candidate.provider == CaptureProvider.ARQUIVO_PT
        for candidate in candidates
    )
    assert candidates[0].snapshot_url == (
        "https://arquivo.pt/noFrame/replay/20200102000000/"
        + canonical_url
    )


def test_arquivo_pt_prefix_query_is_bounded_to_publisher_and_year():
    query = parse_qs(
        urlsplit(
            arquivo_pt_prefix_cdx_url(
                publisher="wsj",
                year=2017,
            )
        ).query
    )

    assert query == {
        "url": ["www.wsj.com/articles/*"],
        "output": ["json"],
        "filter": ["status:200", "mime:text/html"],
        "from": ["2017"],
        "to": ["2017"],
        "limit": ["100000"],
    }


def test_preindexes_exact_arquivo_pt_prefix_candidates_without_resetting_state():
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="wsj",
        authorization_reference="test",
    )
    canonical_url = "https://www.wsj.com/articles/example"
    existing = CaptureCandidate(
        provider=CaptureProvider.WAYBACK,
        snapshot_url=(
            "https://web.archive.org/web/20170101000000id_/" + canonical_url
        ),
    )
    connection.executemany(
        """
        INSERT INTO captures(
            canonical_url, article_id, publisher, published_at, section,
            candidates_json, status, attempts, last_error, updated_at
        ) VALUES (?, ?, 'wsj', ?, NULL, ?, ?, ?, ?, 'before')
        """,
        [
            (
                canonical_url,
                "wsj:example",
                "2017-06-10T00:00:00Z",
                json.dumps([existing.model_dump(mode="json", by_alias=True)]),
                "error",
                2,
                "not found",
            ),
            (
                "https://www.wsj.com/articles/not-in-prefix-result",
                "wsj:other",
                "2017-02-01T00:00:00Z",
                "[]",
                "pending",
                0,
                None,
            ),
        ],
    )
    rows = [
        {
            "url": "http://www.wsj.com/articles/example",
            "timestamp": "20170611000000",
            "mime": "text/html",
            "status": "200",
            "digest": "NEAR",
            "length": "25000",
        },
        {
            "url": canonical_url,
            "timestamp": "20171201000000",
            "mime": "text/html",
            "status": "200",
            "digest": "FAR",
            "length": "30000",
        },
        {
            "url": canonical_url,
            "timestamp": "20170612000000",
            "mime": "text/html",
            "status": "200",
            "digest": "NEAR",
            "length": "26000",
        },
        {
            "url": canonical_url,
            "timestamp": "20160612000000",
            "mime": "text/html",
            "status": "200",
            "digest": "WRONG-YEAR",
        },
        {
            "url": canonical_url,
            "timestamp": "20170612000000",
            "mime": "image/jpeg",
            "status": "200",
            "digest": "WRONG-MIME",
        },
        {
            "url": "https://www.wsj.com/articles/different",
            "timestamp": "20170612000000",
            "mime": "text/html",
            "status": "200",
            "digest": "WRONG-URL",
        },
    ]

    metrics = preindex_arquivo_pt_prefix_candidates(
        connection,
        publisher="wsj",
        year=2017,
        rows=rows,
    )

    state = connection.execute(
        """
        SELECT candidates_json, status, attempts, last_error
        FROM captures WHERE canonical_url=?
        """,
        (canonical_url,),
    ).fetchone()
    candidates = [
        CaptureCandidate.model_validate(value)
        for value in json.loads(state[0])
    ]
    assert metrics == {
        "rowsRead": 6,
        "rowsMatched": 3,
        "targetsMatched": 1,
        "capturesUpdated": 1,
        "candidatesSelected": 2,
    }
    assert [candidate.digest for candidate in candidates[:2]] == ["NEAR", "FAR"]
    assert candidates[2] == existing
    assert state[1:] == ("error", 2, "not found")


def test_ft_capture_falls_back_to_validated_arquivo_pt_replay(
    tmp_path: Path,
):
    canonical_url = "https://www.ft.com/content/example"
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2020-01-01T00:00:00Z",
        section=None,
        candidates=(),
    )
    timemap_url = (
        "https://web.archive.org/web/timemap/json?"
        "url=https%3A%2F%2Fwww.ft.com%2Fcontent%2Fexample"
    )
    timemap = json.dumps(
        [["urlkey", "timestamp", "original", "mimetype", "statuscode"]]
    ).encode()
    query_url = arquivo_pt_cdx_url(item)
    replay_url = (
        "https://arquivo.pt/noFrame/replay/20210208222255/"
        + canonical_url
    )
    index = json.dumps(
        {
            "url": canonical_url,
            "timestamp": "20210208222255",
            "mime": "text/html",
            "status": "200",
            "digest": "ARQUIVO",
            "length": "28508",
        }
    ).encode()
    client = StubArchiveClient(
        {
            timemap_url: (
                200,
                {"content-type": "application/json"},
                timemap,
                timemap_url,
            ),
            query_url: (
                200,
                {"content-type": "text/x-ndjson"},
                index,
                query_url,
            ),
            replay_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                ARTICLE,
                replay_url,
            ),
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
        enable_arquivo_pt_fallback=True,
    )

    assert result["status"] == "complete"
    assert client.requests[0] == timemap_url
    assert client.requests[-2:] == [query_url, replay_url]
    capture = result["capture"]
    assert capture.selected_candidate.provider == CaptureProvider.ARQUIVO_PT
    assert capture.final_url == replay_url
    assert capture.quality_signals["arquivoPtReplayValidated"] is True


def test_ft_capture_uses_exact_wayback_before_common_crawl(tmp_path: Path):
    canonical_url = "https://www.ft.com/content/example"
    timemap_url = (
        "https://web.archive.org/web/timemap/json?"
        "url=https%3A%2F%2Fwww.ft.com%2Fcontent%2Fexample"
    )
    exact_url = (
        "https://web.archive.org/web/20200101120000id_/" + canonical_url
    )
    guessed_url = (
        "https://web.archive.org/web/20200102000000id_/" + canonical_url
    )
    timemap = json.dumps(
        [
            [
                "urlkey",
                "timestamp",
                "original",
                "mimetype",
                "statuscode",
                "digest",
            ],
            [
                "com,ft)/content/example",
                "20200101120000",
                canonical_url,
                "text/html",
                "200",
                "EXACT",
            ],
        ]
    ).encode()
    client = StubArchiveClient(
        {
            timemap_url: (
                200,
                {"content-type": "application/json"},
                timemap,
                timemap_url,
            ),
            exact_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                exact_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2020-01-01T00:00:00Z",
        section=None,
        candidates=(candidate(guessed_url, "20200102000000"),),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [timemap_url, exact_url]
    assert (
        result["capture"].selected_candidate.provider
        == CaptureProvider.WAYBACK
    )
    assert result["capture"].selected_candidate.snapshot_url == exact_url


def test_ft_capture_checks_later_exact_wayback_versions_before_common_crawl(
    tmp_path: Path,
):
    canonical_url = "https://www.ft.com/content/example"
    timemap_url = (
        "https://web.archive.org/web/timemap/json?"
        "url=https%3A%2F%2Fwww.ft.com%2Fcontent%2Fexample"
    )
    exact_urls = [
        (
            f"https://web.archive.org/web/2020010{day}120000id_/"
            f"{canonical_url}"
        )
        for day in range(1, 9)
    ]
    timemap = json.dumps(
        [
            [
                "urlkey",
                "timestamp",
                "original",
                "mimetype",
                "statuscode",
                "digest",
            ],
            *[
                [
                    "com,ft)/content/example",
                    f"2020010{day}120000",
                    canonical_url,
                    "text/html",
                    "200",
                    f"EXACT-{day}",
                ]
                for day in range(1, 9)
            ],
        ]
    ).encode()
    subscription_shell = (
        b"<!doctype html><html><body>Subscribe to read</body></html>"
        + (b" " * 2_048)
    )
    responses = {
        timemap_url: (
            200,
            {"content-type": "application/json"},
            timemap,
            timemap_url,
        ),
        **{
            url: (
                200,
                {"content-type": "text/html"},
                subscription_shell if index < 7 else ARTICLE,
                url,
            )
            for index, url in enumerate(exact_urls)
        },
    }
    client = StubArchiveClient(responses)
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2020-01-01T00:00:00Z",
        section=None,
        candidates=(),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [timemap_url, *exact_urls]
    assert result["capture"].selected_candidate.snapshot_url == exact_urls[-1]
    assert result["capture"].quality_score == 100


def test_ft_capture_falls_back_to_amp_timemap_when_canonical_is_empty(
    tmp_path: Path,
):
    canonical_url = "https://www.ft.com/content/example"
    amp_url = "https://amp.ft.com/content/example"
    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.ft.com%2Fcontent%2Fexample"
    )
    amp_timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Famp.ft.com%2Fcontent%2Fexample"
    )
    replay_url = (
        "https://web.archive.org/web/20190926012847id_/" + amp_url
    )
    timemap_header = [
        "urlkey",
        "timestamp",
        "original",
        "mimetype",
        "statuscode",
        "digest",
    ]
    amp_timemap = json.dumps(
        [
            timemap_header,
            [
                "com,ft)/content/example",
                "20190926012847",
                amp_url,
                "text/html",
                "200",
                "AMP-EXACT",
            ],
        ]
    ).encode()
    client = StubArchiveClient(
        {
            timemap_url: (
                200,
                {"content-type": "application/json"},
                json.dumps([]).encode(),
                timemap_url,
            ),
            amp_timemap_url: (
                200,
                {"content-type": "application/json"},
                amp_timemap,
                amp_timemap_url,
            ),
            replay_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                replay_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2018-09-01T00:00:00Z",
        section=None,
        candidates=(),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [timemap_url, amp_timemap_url, replay_url]
    assert result["capture"].selected_candidate.snapshot_url == replay_url
    assert result["capture"].selected_candidate.provider == CaptureProvider.WAYBACK


def test_bloomberg_capture_falls_back_to_exact_timemap_snapshot(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.bloomberg.com/news/articles/2024-01-09/"
        "white-house-example"
    )
    guessed_url = (
        "https://web.archive.org/web/20240110000000id_/" + canonical_url
    )
    exact_url = (
        "https://web.archive.org/web/20240109091704id_/" + canonical_url
    )
    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.bloomberg.com%2Fnews%2Farticles%2F"
        "2024-01-09%2Fwhite-house-example"
    )
    shell = (
        b"<html><head><title>Bloomberg - Are you a robot?</title></head>"
        b"<body>We've detected unusual activity.</body></html>"
        + (b" " * 2_048)
    )
    timemap = json.dumps(
        [
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
                "com,bloomberg)/news/articles/example",
                "20240109091704",
                canonical_url,
                "text/html",
                "200",
                "EXACT-DIGEST",
                str(len(ARTICLE)),
            ],
            [
                "com,bloomberg)/news/articles/example",
                "20240110000000",
                "https://www.bloomberg.com/tosv2.html",
                "text/html",
                "200",
                "SHELL-DIGEST",
                "12345",
            ],
        ]
    ).encode()
    client = StubArchiveClient(
        {
            guessed_url: (
                200,
                {"content-type": "text/html"},
                shell,
                (
                    "https://web.archive.org/web/20240110000000id_/"
                    "https://www.bloomberg.com/tosv2.html"
                ),
            ),
            timemap_url: (
                200,
                {"content-type": "application/json"},
                timemap,
                timemap_url,
            ),
            exact_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                exact_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="bloomberg",
        canonical_url=canonical_url,
        published_at="2024-01-09T09:00:00Z",
        section="politics",
        candidates=(candidate(guessed_url, "20240110000000"),),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [guessed_url, timemap_url, exact_url]
    capture = result["capture"]
    assert capture.selected_candidate.snapshot_url == exact_url
    assert capture.selected_candidate.digest == "EXACT-DIGEST"
    assert [value.snapshot_url for value in capture.candidates_considered] == [
        guessed_url,
        exact_url,
    ]


def test_bloomberg_capture_discovers_legacy_news_timemap_snapshot(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.bloomberg.com/news/articles/2014-01-09/"
        "white-house-example"
    )
    legacy_url = (
        "https://www.bloomberg.com/news/2014-01-09/"
        "white-house-example.html"
    )
    canonical_timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.bloomberg.com%2Fnews%2Farticles%2F"
        "2014-01-09%2Fwhite-house-example"
    )
    legacy_timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.bloomberg.com%2Fnews%2F2014-01-09%2F"
        "white-house-example.html"
    )
    exact_url = (
        "https://web.archive.org/web/20140109101704id_/" + legacy_url
    )
    header = [
        "urlkey",
        "timestamp",
        "original",
        "mimetype",
        "statuscode",
        "digest",
        "length",
    ]
    canonical_timemap = json.dumps([header]).encode()
    legacy_timemap = json.dumps(
        [
            header,
            [
                "com,bloomberg)/news/2014-01-09/white-house-example.html",
                "20140109101704",
                legacy_url,
                "text/html",
                "200",
                "LEGACY-DIGEST",
                str(len(ARTICLE)),
            ],
        ]
    ).encode()
    client = StubArchiveClient(
        {
            canonical_timemap_url: (
                200,
                {"content-type": "application/json"},
                canonical_timemap,
                canonical_timemap_url,
            ),
            legacy_timemap_url: (
                200,
                {"content-type": "application/json"},
                legacy_timemap,
                legacy_timemap_url,
            ),
            exact_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                exact_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="bloomberg",
        canonical_url=canonical_url,
        published_at="2014-01-09T09:00:00Z",
        section="politics",
        candidates=(),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [legacy_timemap_url, exact_url]
    capture = result["capture"]
    assert capture.selected_candidate.snapshot_url == exact_url
    assert capture.selected_candidate.digest == "LEGACY-DIGEST"


def test_reuters_capture_falls_back_to_exact_timemap_snapshot(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.reuters.com/business/energy/"
        "reactor-uses-fuel-2023-12-21"
    )
    guessed_url = (
        "https://web.archive.org/web/20231222000000id_/" + canonical_url
    )
    exact_url = (
        "https://web.archive.org/web/20231221121500id_/" + canonical_url
    )
    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.reuters.com%2Fbusiness%2Fenergy%2F"
        "reactor-uses-fuel-2023-12-21"
    )
    timemap = json.dumps(
        [
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
                "com,reuters)/business/energy/reactor-uses-fuel",
                "20231221121500",
                canonical_url,
                "text/html",
                "200",
                "REUTERS-EXACT",
                str(len(ARTICLE)),
            ],
        ]
    ).encode()
    missing = b"<html>Wayback Machine doesn't have that page archived.</html>"
    search_url = (
        SYNDICATION_SEARCH_ENDPOINT
        + "?p=reactor+uses+fuel+Reuters"
    )
    client = StubArchiveClient(
        {
            guessed_url: (
                404,
                {"content-type": "text/html"},
                missing,
                guessed_url,
            ),
            search_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                b"<html><body><ol id='web'></ol></body></html>",
                search_url,
            ),
            timemap_url: (
                200,
                {"content-type": "application/json"},
                timemap,
                timemap_url,
            ),
            exact_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                exact_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="reuters",
        canonical_url=canonical_url,
        published_at="2023-12-21T00:00:00Z",
        section="energy",
        candidates=(candidate(guessed_url, "20231222000000"),),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [
        guessed_url,
        search_url,
        timemap_url,
        exact_url,
    ]
    assert result["capture"].selected_candidate.snapshot_url == exact_url
    assert result["capture"].selected_candidate.digest == "REUTERS-EXACT"


def test_wsj_capture_falls_back_to_exact_timemap_snapshot(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.wsj.com/articles/"
        "markets-rally-on-economic-news-11673533499"
    )
    guessed_url = (
        "https://web.archive.org/web/20160102000000id_/" + canonical_url
    )
    exact_url = (
        "https://web.archive.org/web/20160101121500id_/" + canonical_url
    )
    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.wsj.com%2Farticles%2F"
        "markets-rally-on-economic-news-11673533499"
    )
    timemap = json.dumps(
        [
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
                "com,wsj)/articles/markets-rally",
                "20160101121500",
                canonical_url,
                "text/html",
                "200",
                "WSJ-EXACT",
                str(len(ARTICLE)),
            ],
        ]
    ).encode()
    client = StubArchiveClient(
        {
            guessed_url: (
                404,
                {"content-type": "text/html"},
                b"",
                guessed_url,
            ),
            timemap_url: (
                200,
                {"content-type": "application/json"},
                timemap,
                timemap_url,
            ),
            exact_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                exact_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="wsj",
        canonical_url=canonical_url,
        published_at="2016-01-01T12:00:00Z",
        section=None,
        candidates=(candidate(guessed_url, "20160102000000"),),
    )

    deferred_client = StubArchiveClient(client.responses)
    deferred = capture_item(
        item,
        archive_client=deferred_client,
        output_dir=tmp_path / "deferred",
        maximum_html_bytes=1_000_000,
        enable_wayback_timemap_fallback=False,
    )

    assert deferred["status"] == "error"
    assert deferred_client.requests == [guessed_url]

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [guessed_url, timemap_url, exact_url]
    assert result["capture"].selected_candidate.snapshot_url == exact_url
    assert result["capture"].selected_candidate.digest == "WSJ-EXACT"


def test_wsj_retry_prefers_exact_amp_timemap_snapshot(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.wsj.com/articles/"
        "archived-amp-full-text-beats-the-subscription-preview-1383088130"
    )
    guessed_url = (
        "https://web.archive.org/web/20131030000000id_/" + canonical_url
    )
    amp_url = canonical_url.replace("/articles/", "/amp/articles/", 1)
    amp_exact_url = (
        "https://web.archive.org/web/20210812174748id_/" + amp_url
    )
    amp_timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.wsj.com%2Famp%2Farticles%2F"
        "archived-amp-full-text-beats-the-subscription-preview-1383088130"
    )
    canonical_timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.wsj.com%2Farticles%2F"
        "archived-amp-full-text-beats-the-subscription-preview-1383088130"
    )
    amp_timemap = json.dumps(
        [
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
                "com,wsj)/amp/articles/archived-amp-full-text",
                "20210812174748",
                amp_url,
                "text/html",
                "200",
                "WSJ-AMP-EXACT",
                str(len(ARTICLE)),
            ],
        ]
    ).encode()
    client = StubArchiveClient(
        {
            guessed_url: (
                200,
                {"content-type": "text/html"},
                b"<html><body>Subscribe to continue reading</body></html>",
                guessed_url,
            ),
            canonical_timemap_url: (
                200,
                {"content-type": "application/json"},
                b"[]",
                canonical_timemap_url,
            ),
            amp_timemap_url: (
                200,
                {"content-type": "application/json"},
                amp_timemap,
                amp_timemap_url,
            ),
            amp_exact_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                amp_exact_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="wsj",
        canonical_url=canonical_url,
        published_at="2013-10-29T23:09:00Z",
        section=None,
        candidates=(candidate(guessed_url, "20131030000000"),),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
        enable_wayback_timemap_fallback=True,
        enable_common_crawl_fallback=True,
        enable_arquivo_pt_fallback=True,
    )

    assert result["status"] == "complete"
    assert client.requests == [
        guessed_url,
        canonical_timemap_url,
        amp_timemap_url,
        amp_exact_url,
    ]
    capture = result["capture"]
    assert capture.canonical_url == canonical_url
    assert capture.selected_candidate.snapshot_url == amp_exact_url
    assert capture.selected_candidate.digest == "WSJ-AMP-EXACT"


def test_wsj_retry_prefers_validated_arquivo_pt_before_common_crawl(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.wsj.com/articles/"
        "a-riverside-compound-in-germany-1485968536"
    )
    guessed_url = (
        "https://web.archive.org/web/20170202000000id_/" + canonical_url
    )
    item = ManifestItem(
        publisher="wsj",
        canonical_url=canonical_url,
        published_at="2017-02-01T18:34:40Z",
        section=None,
        candidates=(candidate(guessed_url, "20170202000000"),),
    )
    query_url = arquivo_pt_cdx_url(item)
    replay_url = (
        "https://arquivo.pt/noFrame/replay/20170201183440/"
        + canonical_url
    )
    index = json.dumps(
        {
            "url": canonical_url,
            "timestamp": "20170201183440",
            "mime": "text/html",
            "status": "200",
            "digest": "WSJ-ARQUIVO",
            "length": str(len(ARTICLE)),
        }
    ).encode()
    client = StubArchiveClient(
        {
            guessed_url: (
                404,
                {"content-type": "text/html"},
                b"",
                guessed_url,
            ),
            query_url: (
                200,
                {"content-type": "text/x-ndjson"},
                index,
                query_url,
            ),
            replay_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                ARTICLE,
                replay_url,
            ),
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
        enable_wayback_timemap_fallback=False,
        enable_common_crawl_fallback=True,
        enable_arquivo_pt_fallback=True,
    )

    assert result["status"] == "complete"
    assert client.requests == [guessed_url, query_url, replay_url]
    capture = result["capture"]
    assert capture.selected_candidate.provider == CaptureProvider.ARQUIVO_PT
    assert capture.selected_candidate.digest == "WSJ-ARQUIVO"
    assert capture.quality_signals["arquivoPtReplayValidated"] is True


def test_wsj_manifest_prefers_wayback_before_arquivo_pt(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.wsj.com/articles/"
        "wayback-full-text-beats-an-archive-subscription-shell-1234567890"
    )
    arquivo_url = (
        "https://arquivo.pt/noFrame/replay/20200101120000/" + canonical_url
    )
    wayback_url = (
        "https://web.archive.org/web/20200101130000id_/" + canonical_url
    )
    arquivo_candidate = CaptureCandidate(
        provider=CaptureProvider.ARQUIVO_PT,
        snapshot_url=arquivo_url,
        captured_at=datetime(2020, 1, 1, 12, tzinfo=timezone.utc),
        digest="ARQUIVO-SHELL",
        mime_type="text/html",
        status_code=200,
        byte_count=300_000,
    )
    wayback_candidate = CaptureCandidate(
        provider=CaptureProvider.WAYBACK,
        snapshot_url=wayback_url,
        captured_at=datetime(2020, 1, 1, 13, tzinfo=timezone.utc),
        digest="WAYBACK-ARTICLE",
        mime_type="text/html",
        status_code=200,
        byte_count=len(ARTICLE),
    )
    client = StubArchiveClient(
        {
            arquivo_url: (
                200,
                {"content-type": "text/html"},
                b"<html><body>Subscribe to continue reading</body></html>",
                arquivo_url,
            ),
            wayback_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                wayback_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="wsj",
        canonical_url=canonical_url,
        published_at="2020-01-01T12:30:00Z",
        section=None,
        candidates=(arquivo_candidate, wayback_candidate),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
        enable_wayback_timemap_fallback=False,
        enable_common_crawl_fallback=False,
        enable_arquivo_pt_fallback=False,
    )

    assert result["status"] == "complete"
    assert client.requests == [wayback_url]
    assert result["capture"].selected_candidate.provider == CaptureProvider.WAYBACK


def test_wsj_validation_defers_timemap_until_retry():
    first = archive_fallback_policy(
        publisher="wsj",
        parser_validation_enabled=True,
        prior_attempts=0,
    )
    retry = archive_fallback_policy(
        publisher="wsj",
        parser_validation_enabled=True,
        prior_attempts=1,
    )
    assert (first.wayback_timemap, first.common_crawl, first.arquivo_pt) == (
        False,
        False,
        False,
    )
    assert (retry.wayback_timemap, retry.common_crawl, retry.arquivo_pt) == (
        True,
        True,
        True,
    )


def test_ft_validation_defers_timemap_until_retry():
    first = archive_fallback_policy(
        publisher="ft",
        parser_validation_enabled=True,
        prior_attempts=0,
    )
    retry = archive_fallback_policy(
        publisher="ft",
        parser_validation_enabled=True,
        prior_attempts=1,
    )

    assert (
        first.wayback_timemap,
        first.common_crawl,
        first.arquivo_pt,
    ) == (False, True, True)
    assert (
        retry.wayback_timemap,
        retry.common_crawl,
        retry.arquivo_pt,
    ) == (True, True, True)


def test_ft_first_pass_still_uses_manifest_candidates_without_timemap(
    tmp_path: Path,
):
    canonical_url = "https://www.ft.com/content/example"
    snapshot_url = (
        "https://web.archive.org/web/20200101120000id_/" + canonical_url
    )
    client = StubArchiveClient(
        {
            snapshot_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                snapshot_url,
            )
        }
    )
    client.attempts = 1
    client.timeout = 12.0
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2020-01-01T00:00:00Z",
        section=None,
        candidates=(candidate(snapshot_url, "20200101120000"),),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
        enable_wayback_timemap_fallback=False,
    )

    assert result["status"] == "complete"
    assert client.requests == [snapshot_url]
    assert client.limited_calls == [(snapshot_url, 1, 12.0)]


def test_ft_first_pass_bounds_duplicate_manifest_snapshots(tmp_path: Path):
    canonical_url = "https://www.ft.com/content/example-duplicates"
    first_url = (
        "https://web.archive.org/web/20200101120000id_/" + canonical_url
    )
    second_url = (
        "https://web.archive.org/web/20200102120000id_/" + canonical_url
    )
    client = StubArchiveClient(
        {
            first_url: (503, {"content-type": "text/html"}, b"", first_url),
            second_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                second_url,
            ),
        }
    )
    client.attempts = 1
    client.timeout = 12.0
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2020-01-01T00:00:00Z",
        section=None,
        candidates=(
            candidate(first_url, "20200101120000"),
            candidate(second_url, "20200102120000"),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
        enable_wayback_timemap_fallback=False,
        enable_common_crawl_fallback=False,
        enable_arquivo_pt_fallback=False,
    )

    assert result["status"] == "error"
    assert client.requests[0] == first_url
    assert second_url not in client.requests


def test_wsj_validation_stages_secondary_archives_by_cost_and_yield():
    first = archive_fallback_policy(
        publisher="wsj",
        parser_validation_enabled=True,
        prior_attempts=0,
    )
    second = archive_fallback_policy(
        publisher="wsj",
        parser_validation_enabled=True,
        prior_attempts=1,
    )
    third = archive_fallback_policy(
        publisher="wsj",
        parser_validation_enabled=True,
        prior_attempts=2,
    )
    ordinary = archive_fallback_policy(
        publisher="npr",
        parser_validation_enabled=True,
        prior_attempts=0,
    )

    assert (
        first.wayback_timemap,
        first.common_crawl,
        first.arquivo_pt,
    ) == (False, False, False)
    assert (
        second.wayback_timemap,
        second.common_crawl,
        second.arquivo_pt,
    ) == (True, True, True)
    assert (
        third.wayback_timemap,
        third.common_crawl,
        third.arquivo_pt,
    ) == (True, True, True)
    assert (
        ordinary.wayback_timemap,
        ordinary.common_crawl,
        ordinary.arquivo_pt,
    ) == (True, True, True)


def test_nikkei_validation_keeps_timemap_and_stages_slow_fallbacks():
    first = archive_fallback_policy(
        publisher="nikkei",
        parser_validation_enabled=True,
        prior_attempts=0,
    )
    second = archive_fallback_policy(
        publisher="nikkei",
        parser_validation_enabled=True,
        prior_attempts=1,
    )
    third = archive_fallback_policy(
        publisher="nikkei",
        parser_validation_enabled=True,
        prior_attempts=2,
    )

    assert (
        first.wayback_timemap,
        first.common_crawl,
        first.arquivo_pt,
    ) == (True, False, False)
    assert (
        second.wayback_timemap,
        second.common_crawl,
        second.arquivo_pt,
    ) == (True, True, False)
    assert (
        third.wayback_timemap,
        third.common_crawl,
        third.arquivo_pt,
    ) == (True, True, True)


def test_nikkei_candidate_order_prefers_large_commoncrawl_records():
    wayback = CaptureCandidate(
        provider=CaptureProvider.WAYBACK,
        snapshot_url="https://web.archive.org/web/20150101000000id_/"
        "https://www.nikkei.com/article/example",
        captured_at=datetime(2015, 1, 1, tzinfo=timezone.utc),
        byte_count=200_000,
    )
    small_commoncrawl = CaptureCandidate(
        provider=CaptureProvider.COMMON_CRAWL,
        snapshot_url="https://data.commoncrawl.org/small.warc.gz",
        captured_at=datetime(2018, 1, 1, tzinfo=timezone.utc),
        byte_count=16_000,
    )
    large_commoncrawl = CaptureCandidate(
        provider=CaptureProvider.COMMON_CRAWL,
        snapshot_url="https://data.commoncrawl.org/large.warc.gz",
        captured_at=datetime(2020, 1, 1, tzinfo=timezone.utc),
        byte_count=33_000,
    )

    ordered = sorted(
        (wayback, small_commoncrawl, large_commoncrawl),
        key=lambda value: _nikkei_candidate_sort_key(
            value,
            published_at="2014-01-01T00:00:00+00:00",
        ),
    )

    assert ordered == [large_commoncrawl, small_commoncrawl, wayback]


def test_aljazeera_candidate_order_prefers_commoncrawl_before_wayback():
    wayback = CaptureCandidate(
        provider=CaptureProvider.WAYBACK,
        snapshot_url="https://web.archive.org/web/20160101000000id_/"
        "https://www.aljazeera.com/features/example",
        captured_at=datetime(2016, 1, 1, tzinfo=timezone.utc),
        byte_count=200_000,
    )
    commoncrawl = CaptureCandidate(
        provider=CaptureProvider.COMMON_CRAWL,
        snapshot_url="https://data.commoncrawl.org/example.warc.gz",
        captured_at=datetime(2026, 7, 1, tzinfo=timezone.utc),
        byte_count=59_000,
    )

    ordered = sorted(
        (wayback, commoncrawl),
        key=lambda value: _common_crawl_first_candidate_sort_key(
            value,
            published_at="2016-01-01T00:00:00+00:00",
        ),
    )

    assert ordered == [commoncrawl, wayback]


@pytest.mark.parametrize(
    ("publisher", "canonical_url"),
    [
        (
            "wsj",
            "https://www.wsj.com/articles/"
            "example-timemap-selection-11577836800",
        ),
        (
            "nikkei",
            "https://www.nikkei.com/article/"
            "DGXNASGG1701V_X10C12A7EA2000",
        ),
        (
            "nyt",
            "https://www.nytimes.com/2020/01/01/us/"
            "example-timemap-selection.html",
        ),
    ],
)
def test_metered_publishers_timemap_mixes_largest_and_nearest_captures(
    publisher: str,
    canonical_url: str,
):
    item = ManifestItem(
        publisher=publisher,
        canonical_url=canonical_url,
        published_at="2020-01-01T12:00:00Z",
        section=None,
        candidates=(),
    )
    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?" + urlencode(
        {"url": canonical_url}
    )
    rows = [
        [
            "urlkey",
            "timestamp",
            "original",
            "mimetype",
            "statuscode",
            "digest",
            "length",
        ]
    ]
    for index in range(1, 7):
        rows.append(
            [
                "com,wsj)/articles/example",
                f"2020010{index}120000",
                canonical_url,
                "text/html",
                "200",
                f"PREVIEW-{index}",
                str(100 + index),
            ]
        )
    rows.extend(
        [
            [
                "com,wsj)/articles/example",
                "20200301120000",
                canonical_url,
                "text/html",
                "200",
                "FULL-LARGEST",
                "900",
            ],
            [
                "com,wsj)/articles/example",
                "20200201120000",
                canonical_url,
                "text/html",
                "200",
                "FULL-SECOND",
                "800",
            ],
        ]
    )
    payload = json.dumps(rows).encode()
    client = StubArchiveClient(
        {
            timemap_url: (
                200,
                {"content-type": "application/json"},
                payload,
                timemap_url,
            )
        }
    )
    client.attempts = 1
    client.timeout = 7.0

    candidates = discover_wayback_timemap_candidates(
        item,
        archive_client=client,
        maximum_candidates=4,
    )

    assert [candidate.digest for candidate in candidates] == [
        "FULL-LARGEST",
        "FULL-SECOND",
        "PREVIEW-1",
        "PREVIEW-2",
    ]
    assert [candidate.byte_count for candidate in candidates] == [
        900,
        800,
        101,
        102,
    ]
    assert client.limited_calls == [(timemap_url, 1, 7.0)]


def test_nyt_capture_uses_exact_timemap_snapshot(tmp_path: Path):
    canonical_url = (
        "https://www.nytimes.com/2025/11/24/briefing/"
        "negotiating-peace-in-ukraine.html"
    )
    guessed_url = (
        "https://web.archive.org/web/20251125000000id_/" + canonical_url
    )
    exact_url = (
        "https://web.archive.org/web/20251124122247id_/" + canonical_url
    )
    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.nytimes.com%2F2025%2F11%2F24%2Fbriefing%2F"
        "negotiating-peace-in-ukraine.html"
    )
    timemap = json.dumps(
        [
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
                "com,nytimes)/2025/11/24/briefing/example.html",
                "20251124122247",
                canonical_url,
                "text/html",
                "200",
                "NYT-EXACT",
                str(len(ARTICLE)),
            ],
        ]
    ).encode()
    client = StubArchiveClient(
        {
            guessed_url: (
                404,
                {"content-type": "text/html"},
                b"",
                guessed_url,
            ),
            timemap_url: (
                200,
                {"content-type": "application/json"},
                timemap,
                timemap_url,
            ),
            exact_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                exact_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="nyt",
        canonical_url=canonical_url,
        published_at="2025-11-24T12:00:00Z",
        section=None,
        candidates=(candidate(guessed_url, "20251125000000"),),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [timemap_url, exact_url]
    assert result["capture"].selected_candidate.digest == "NYT-EXACT"


def test_nyt_capture_skips_timemap_for_preindexed_exact_snapshot(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.nytimes.com/2025/11/24/briefing/"
        "negotiating-peace-in-ukraine.html"
    )
    exact_url = (
        "https://web.archive.org/web/20251124122247id_/" + canonical_url
    )
    exact = CaptureCandidate(
        provider=CaptureProvider.WAYBACK,
        snapshot_url=exact_url,
        captured_at=datetime(2025, 11, 24, 12, 22, 47, tzinfo=timezone.utc),
        digest="NYT-PREINDEXED",
        mime_type="text/html",
        status_code=200,
        byte_count=len(ARTICLE),
    )
    client = StubArchiveClient(
        {
            exact_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                exact_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="nyt",
        canonical_url=canonical_url,
        published_at="2025-11-24T12:00:00Z",
        section=None,
        candidates=(exact,),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [exact_url]
    assert result["capture"].selected_candidate.digest == "NYT-PREINDEXED"


def test_nyt_capture_falls_back_to_validated_local_newspaper_copy(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.nytimes.com/2026/04/15/us/"
        "floods-michigan-cheboygan-dams-evacuation.html"
    )
    guessed_url = (
        "https://web.archive.org/web/20260416000000id_/" + canonical_url
    )
    syndicated_url = (
        "https://www.hawaiitribune-herald.com/2026/04/16/"
        "nation-world-news/dam-failure-could-imperil-thousands/"
    )
    item = ManifestItem(
        publisher="nyt",
        canonical_url=canonical_url,
        published_at="2026-04-15T16:00:00Z",
        section="us",
        candidates=(candidate(guessed_url, "20260416000000"),),
    )
    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.nytimes.com%2F2026%2F04%2F15%2Fus%2F"
        "floods-michigan-cheboygan-dams-evacuation.html"
    )
    trusted_search_url = nyt_trusted_wordpress_search_url(item)
    expected_headline = (
        "Dam Failure Could Imperil Thousands in Northern Michigan"
    )
    trusted_search_json = json.dumps(
        [
            {
                "date": "2026-04-16T00:05:00",
                "date_gmt": "2026-04-16T10:05:00",
                "link": syndicated_url,
                "title": {"rendered": expected_headline},
                "content": {
                    "rendered": (
                        "<p>Licensed copy.</p>"
                        f'<p>This article originally appeared in '
                        f'<a href="{canonical_url}">The New York Times</a>.</p>'
                    )
                },
            }
        ]
    ).encode()
    paragraphs = "".join(
        (
            "<p>Emergency reporting paragraph "
            f"{index} contains substantive details about evacuations, "
            "rising rivers, public safety warnings, emergency crews and "
            "the structural condition of multiple dams in Michigan. "
            "Officials described the affected communities and the response "
            "under way while residents prepared to leave their homes.</p>"
        )
        for index in range(1, 9)
    )
    syndicated_html = f"""
    <!doctype html><html><head>
      <meta property="og:title"
            content="Dam Failure Could Imperil Thousands in Northern Michigan">
      <script type="application/ld+json">
      {{
        "@type": "NewsArticle",
        "headline": "Dam Failure Could Imperil Thousands in Northern Michigan",
        "datePublished": "2026-04-16T00:05:00Z",
        "author": {{"name": "New York Times"}}
      }}
      </script>
    </head><body><main><div class="post-content">
      {paragraphs}
      <p>This article originally appeared in
        <a href="{canonical_url}">The New York Times</a>.
      </p>
    </div></main></body></html>
    """.encode() + (b" " * 2_048)
    empty_timemap = json.dumps(
        [["urlkey", "timestamp", "original", "mimetype", "statuscode"]]
    ).encode()
    client = StubArchiveClient(
        {
            guessed_url: (
                403,
                {"content-type": "text/html"},
                b"",
                guessed_url,
            ),
            timemap_url: (
                200,
                {"content-type": "application/json"},
                empty_timemap,
                timemap_url,
            ),
            trusted_search_url: (
                200,
                {"content-type": "application/json; charset=utf-8"},
                trusted_search_json,
                trusted_search_url,
            ),
            syndicated_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                syndicated_html,
                syndicated_url,
            ),
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [
        timemap_url,
        guessed_url,
        trusted_search_url,
        syndicated_url,
    ]
    capture = result["capture"]
    assert capture.selected_candidate.provider == CaptureProvider.OTHER
    assert capture.final_url == syndicated_url
    assert capture.quality_signals["nytSyndicationValidated"] is True
    assert capture.quality_signals["syndicationNytAttributed"] is True
    assert (
        capture.quality_signals["syndicationCanonicalArticleLinked"]
        is True
    )
    assert (
        capture.quality_signals["syndicationBodyCharacters"]
        >= NYT_SYNDICATION_MINIMUM_BODY_CHARACTERS
    )
    assert capture.quality_signals["syndicationHeadlineOverlap"] == 1.0


def test_nyt_manifest_direct_copy_requires_exact_canonical_provenance(
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
    item = ManifestItem(
        publisher="nyt",
        canonical_url=canonical_url,
        published_at="2026-04-15T00:00:00Z",
        section="us",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=syndicated_url,
            ),
        ),
    )
    paragraphs = "".join(
        (
            "<p>Licensed reporting paragraph "
            f"{index} contains full details about emergency workers, "
            "evacuations, damaged roads, rising rivers and the structural "
            "condition of dams across northern Michigan. Officials described "
            "the response while residents prepared to leave their homes.</p>"
        )
        for index in range(1, 9)
    )
    content = f"""
    <!doctype html><html><head>
      <script type="application/ld+json">
      {{
        "@type": "NewsArticle",
        "headline": "Dam failure could imperil thousands in Northern Michigan",
        "datePublished": "2026-04-16T00:05:00Z",
        "author": {{"name": "New York Times"}}
      }}
      </script>
    </head><body><div class="post-content">
      {paragraphs}
      <p>This article originally appeared in
        <a href="{canonical_url}">The New York Times</a>.
      </p>
    </div></body></html>
    """.encode() + (b" " * 2_048)
    client = StubArchiveClient(
        {
            syndicated_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                content,
                syndicated_url,
            )
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [syndicated_url]
    capture = result["capture"]
    assert capture.quality_signals["nytSyndicationValidated"] is True
    assert (
        capture.quality_signals["syndicationCanonicalArticleLinked"]
        is True
    )


def test_nyt_capture_uses_strict_headline_wordpress_copy(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.nytimes.com/2026/04/19/arts/design/"
        "milan-design-week-revivals.html"
    )
    guessed_url = (
        "https://web.archive.org/web/20260420000000id_/" + canonical_url
    )
    item = ManifestItem(
        publisher="nyt",
        canonical_url=canonical_url,
        published_at="2026-04-19T00:00:00Z",
        section="arts",
        candidates=(candidate(guessed_url, "20260420000000"),),
    )
    headline = "Vintage Designs Take on New Lives at Milan Design Week"
    syndicated_url = (
        "https://dnyuz.com/2026/04/19/"
        "vintage-designs-take-on-new-lives-at-milan-design-week/"
    )
    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.nytimes.com%2F2026%2F04%2F19%2Farts%2F"
        "design%2Fmilan-design-week-revivals.html"
    )
    trusted_search_url = nyt_trusted_wordpress_search_url(item)
    canonical_search_url = nyt_syndication_search_url(item)
    headline_wordpress_url = nyt_headline_wordpress_search_url(headline)
    canonical_search_html = f"""
    <html><body><ol id="web"><li><div class="compTitle">
      <a href="{canonical_url}"><h3>{headline} - The New York Times</h3></a>
    </div></li></ol></body></html>
    """.encode()
    headline_search_json = json.dumps(
        [
            {
                "date": "2026-04-19T10:37:50",
                "link": syndicated_url,
                "title": {"rendered": headline},
                "content": {
                    "rendered": (
                        "<p>Full licensed article body.</p>"
                        "<p>The post appeared first on "
                        '<a href="https://www.nytimes.com/">'
                        "New York Times</a>.</p>"
                    )
                },
            }
        ]
    ).encode()
    paragraphs = "".join(
        (
            "<p>Design reporting paragraph "
            f"{index} describes the makers, materials, exhibitions, "
            "historic furniture and contemporary production in enough "
            "detail to constitute a complete licensed article body. "
            "The reporting includes interviews, locations and context.</p>"
        )
        for index in range(1, 9)
    )
    syndicated_html = f"""
    <!doctype html><html><head>
      <script type="application/ld+json">
      {{
        "@type": "NewsArticle",
        "headline": "{headline}",
        "datePublished": "2026-04-19T10:37:50Z",
        "author": {{"name": "New York Times"}}
      }}
      </script>
    </head><body><main><div class="post-content">
      {paragraphs}
      <p>The post appeared first on
        <a href="https://www.nytimes.com/">New York Times</a>.
      </p>
    </div></main></body></html>
    """.encode() + (b" " * 2_048)
    empty_timemap = json.dumps(
        [["urlkey", "timestamp", "original", "mimetype", "statuscode"]]
    ).encode()
    client = StubArchiveClient(
        {
            guessed_url: (
                403,
                {"content-type": "text/html"},
                b"",
                guessed_url,
            ),
            timemap_url: (
                200,
                {"content-type": "application/json"},
                empty_timemap,
                timemap_url,
            ),
            trusted_search_url: (
                200,
                {"content-type": "application/json"},
                b"[]",
                trusted_search_url,
            ),
            canonical_search_url: (
                200,
                {"content-type": "text/html"},
                canonical_search_html,
                canonical_search_url,
            ),
            headline_wordpress_url: (
                200,
                {"content-type": "application/json"},
                headline_search_json,
                headline_wordpress_url,
            ),
            syndicated_url: (
                200,
                {"content-type": "text/html"},
                syndicated_html,
                syndicated_url,
            ),
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [
        timemap_url,
        guessed_url,
        trusted_search_url,
        canonical_search_url,
        headline_wordpress_url,
        syndicated_url,
    ]
    capture = result["capture"]
    assert capture.selected_candidate.snapshot_url == syndicated_url
    assert capture.quality_signals["nytSyndicationValidated"] is True
    assert (
        capture.quality_signals["syndicationCanonicalArticleLinked"]
        is False
    )


def test_nyt_syndication_rejects_unattributed_same_topic_article(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.nytimes.com/2026/04/15/us/"
        "floods-michigan-cheboygan-dams-evacuation.html"
    )
    guessed_url = (
        "https://web.archive.org/web/20260416000000id_/" + canonical_url
    )
    related_url = "https://example.com/michigan-dam-emergency"
    item = ManifestItem(
        publisher="nyt",
        canonical_url=canonical_url,
        published_at="2026-04-15T16:00:00Z",
        section="us",
        candidates=(candidate(guessed_url, "20260416000000"),),
    )
    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.nytimes.com%2F2026%2F04%2F15%2Fus%2F"
        "floods-michigan-cheboygan-dams-evacuation.html"
    )
    headline = "Dam Failure Could Imperil Thousands in Northern Michigan"
    search_url = nyt_syndication_search_url(item)
    title_search_url = nyt_syndication_title_search_url(headline)
    trusted_search_url = nyt_trusted_wordpress_search_url(item)
    search_html = f"""
    <html><body><ol id="web"><li><div class="compTitle">
      <a href="{canonical_url}"><h3>
        {headline} - The New York Times
      </h3></a>
    </div></li></ol></body></html>
    """.encode()
    title_search_html = f"""
    <html><body><ol id="web"><li><div class="compTitle">
      <a href="{related_url}"><h3>{headline}</h3></a>
    </div></li></ol></body></html>
    """.encode()
    paragraphs = "".join(
        (
            "<p>Independent reporting paragraph "
            f"{index} discusses the same emergency and contains enough "
            "substantive material to exceed the body threshold, but this "
            "copy has no source-service attribution and must be rejected. "
            "It includes descriptions of warnings, emergency crews, roads, "
            "weather conditions and residents leaving nearby homes.</p>"
        )
        for index in range(1, 9)
    )
    paragraphs += (
        "<p>The New York Times reported on a similar emergency last year, "
        "but that ordinary source mention does not make this independently "
        "written article a syndicated Times copy.</p>"
    )
    related_html = f"""
    <!doctype html><html><head>
      <script type="application/ld+json">
      {{
        "@type": "NewsArticle",
        "headline": "{headline}",
        "datePublished": "2026-04-16T00:05:00Z",
        "author": {{"name": "Independent Local Reporter"}}
      }}
      </script>
    </head><body><div class="post-content">
      {paragraphs}
    </div>
    <aside class="author-bio">
      Independent Local Reporter has contributed reporting to The New York
      Times Bits and Technology sections.
    </aside></body></html>
    """.encode() + (b" " * 2_048)
    empty_timemap = json.dumps(
        [["urlkey", "timestamp", "original", "mimetype", "statuscode"]]
    ).encode()
    client = StubArchiveClient(
        {
            guessed_url: (
                403,
                {"content-type": "text/html"},
                b"",
                guessed_url,
            ),
            timemap_url: (
                200,
                {"content-type": "application/json"},
                empty_timemap,
                timemap_url,
            ),
            trusted_search_url: (
                200,
                {"content-type": "application/json"},
                b"[]",
                trusted_search_url,
            ),
            search_url: (
                200,
                {"content-type": "text/html"},
                search_html,
                search_url,
            ),
            title_search_url: (
                200,
                {"content-type": "text/html"},
                title_search_html,
                title_search_url,
            ),
            related_url: (
                200,
                {"content-type": "text/html"},
                related_html,
                related_url,
            ),
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "error"
    assert "missing-nyt-attribution" in result["error"]
    assert not (tmp_path / "objects").exists()


def test_stored_nyt_syndication_rechecks_strict_provenance(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.nytimes.com/2010/08/31/technology/31chip.html"
    )
    paragraphs = "".join(
        (
            "<p>Independent technology report paragraph "
            f"{index} describes the acquisition, wireless chips, market "
            "strategy, regulatory review and company statements in enough "
            "detail to pass ordinary article-body quality checks.</p>"
        )
        for index in range(1, 9)
    )
    html = f"""
    <!doctype html><html><head>
      <script type="application/ld+json">
      {{
        "@type": "NewsArticle",
        "headline": "Intel to Buy Infineon Wireless Unit for $1.4 Billion",
        "datePublished": "2010-08-30T06:08:23-04:00",
        "author": {{"name": "Independent Technology Reporter"}}
      }}
      </script>
    </head><body><div class="post-content">{paragraphs}</div>
    <aside class="author-bio">The reporter formerly contributed to The New
    York Times technology section.</aside></body></html>
    """.encode() + (b" " * 2_048)
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="nyt:" + ("a" * 64),
        publisher="nyt",
        canonical_url=canonical_url,
        published_at=datetime(2010, 8, 31, tzinfo=timezone.utc),
        section="technology",
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.OTHER,
            snapshot_url=(
                "https://example.com/intel-infineon-independent-report"
            ),
        ),
        candidates_considered=[],
        retrieved_at=datetime.now(timezone.utc),
        final_url=(
            "https://example.com/intel-infineon-independent-report"
        ),
        http_status=200,
        content_type="text/html",
        quality_score=100,
        quality_signals={
            "syndicationOriginalHeadline": (
                "Intel to Buy Infineon Wireless Unit for $1.4 Billion"
            )
        },
        raw_html=blob,
    )

    assert completed_capture_rejection_reason(
        capture,
        archive_root=tmp_path,
    ) == "nyt-syndication-missing-nyt-attribution"


def test_unsupported_publisher_does_not_query_wayback_timemap(
    tmp_path: Path,
):
    canonical_url = "https://apnews.com/article/example"
    guessed_url = (
        "https://web.archive.org/web/20240110000000id_/" + canonical_url
    )
    client = StubArchiveClient(
        {
            guessed_url: (
                404,
                {"content-type": "text/html"},
                b"",
                guessed_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="ap",
        canonical_url=canonical_url,
        published_at="2024-01-09T09:00:00Z",
        section=None,
        candidates=(candidate(guessed_url, "20240110000000"),),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "error"
    assert client.requests == [guessed_url]


def test_reuters_capture_falls_back_to_validated_syndicated_html(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.reuters.com/business/autos-transportation/"
        "boeing-justice-department-seek-judges-approval-"
        "deal-opposed-by-crash-victims-2025-07-03"
    )
    guessed_url = (
        "https://web.archive.org/web/20250704000000id_/"
        + canonical_url
    )
    syndicated_url = (
        "https://www.yahoo.com/news/"
        "boeing-justice-department-seek-judges-035416509.html"
    )
    item = ManifestItem(
        publisher="reuters",
        canonical_url=canonical_url,
        published_at="2025-07-03T00:00:00Z",
        section="business",
        candidates=(candidate(guessed_url, "20250704000000"),),
    )
    search_url = reuters_syndication_search_url(item)
    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.reuters.com%2Fbusiness%2F"
        "autos-transportation%2Fboeing-justice-department-seek-"
        "judges-approval-deal-opposed-by-crash-victims-2025-07-03"
    )
    assert search_url.startswith(SYNDICATION_SEARCH_ENDPOINT)
    search_html = f"""
    <html><body><ol id="web"><li><h3>
      <a href="{syndicated_url}">Syndicated copy</a>
    </h3></li></ol></body></html>
    """.encode()
    syndicated_html = b"""
    <!doctype html><html><head>
      <script type="application/ld+json">
      {
        "@type": "NewsArticle",
        "headline": "Boeing and Justice Department seek judge's approval for deal opposed by crash victims' families",
        "datePublished": "2025-07-03T03:54:16Z",
        "author": {"name": "Reuters"}
      }
      </script>
    </head><body><article>
      <p>By David Shepardson</p>
      <p>(Reuters) - Boeing and the Justice Department asked a U.S. judge
      to approve an agreement concerning the 737 MAX case. This paragraph
      contains enough substantive reporting to identify the syndicated wire
      article and distinguish it from a search result, abstract, or shell.</p>
      <p>The agreement includes compensation for victims' families and other
      obligations. The report continues with court arguments, procedural
      history, financial terms, and responses from the parties so that the
      captured body is long enough for full-article validation.</p>
      <p>Additional reporting explains the earlier plea agreement, the two
      crashes, regulatory findings, and the positions taken by relatives.
      This is retained as the raw HTML supplied by the syndication host.</p>
    </article></body></html>
    """ + (b" " * 2_048)
    client = StubArchiveClient(
        {
            guessed_url: (
                401,
                {"content-type": "text/html"},
                b"",
                guessed_url,
            ),
            timemap_url: (
                200,
                {"content-type": "application/json"},
                json.dumps(
                    [[
                        "urlkey",
                        "timestamp",
                        "original",
                        "mimetype",
                        "statuscode",
                    ]]
                ).encode(),
                timemap_url,
            ),
            search_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                search_html,
                search_url,
            ),
            syndicated_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                syndicated_html,
                syndicated_url,
            ),
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [
        guessed_url,
        search_url,
        syndicated_url,
    ]
    capture = result["capture"]
    assert capture.selected_candidate.provider == CaptureProvider.OTHER
    assert capture.selected_candidate.snapshot_url == syndicated_url
    assert capture.final_url == syndicated_url
    assert capture.quality_signals["reutersSyndicationValidated"] is True
    assert capture.quality_signals["syndicationReutersAttributed"] is True
    assert capture.quality_signals["syndicationBodyCharacters"] >= 400


def test_reuters_syndication_uses_exact_title_second_search():
    canonical_url = (
        "https://www.reuters.com/business/autos-transportation/"
        "auto-industry-rocked-by-trumps-25-tariffs-us-imports-"
        "2025-03-27"
    )
    item = ManifestItem(
        publisher="reuters",
        canonical_url=canonical_url,
        published_at="2025-03-27T00:00:00Z",
        section="business",
        candidates=(),
    )
    expected_headline = (
        "Auto industry rocked by Trump's 25% tariffs on US imports"
    )
    initial_url = reuters_syndication_search_url(item)
    title_url = reuters_syndication_title_search_url(expected_headline)
    radio_url = (
        "https://www.933thedrive.com/2025/03/27/"
        "auto-industry-rocked-by-trumps-25-tariffs-on-us-imports/"
    )
    initial_html = f"""
    <html><body><ol id="web">
      <li><h3><a href="{canonical_url}">
        {expected_headline} - Reuters
      </a></h3></li>
      <li><h3><a href="https://example.com/different-story">
        A different story
      </a></h3></li>
    </ol></body></html>
    """.encode()
    title_html = f"""
    <html><body><ol id="web">
      <li><h3><a href="{radio_url}">
        {expected_headline} | Reuters
      </a></h3></li>
      <li><h3><a href="https://example.net/unrelated">
        Unrelated market report
      </a></h3></li>
    </ol></body></html>
    """.encode()
    client = StubArchiveClient(
        {
            initial_url: (
                200,
                {"content-type": "text/html"},
                initial_html,
                initial_url,
            ),
            title_url: (
                200,
                {"content-type": "text/html"},
                title_html,
                title_url,
            ),
        }
    )

    candidates = discover_reuters_syndication_candidates(
        item,
        archive_client=client,
    )

    assert client.requests == [initial_url, title_url]
    assert [candidate.snapshot_url for candidate in candidates] == [
        radio_url
    ]
    assert candidates[0].provider == CaptureProvider.OTHER
    assert candidates[0].expected_headline == expected_headline


def test_reuters_syndication_keeps_initial_results_when_title_search_fails():
    canonical_url = (
        "https://www.reuters.com/world/example-reuters-story-2025-03-27"
    )
    partner_url = "https://example.com/example-reuters-story"
    expected_headline = "Example Reuters story has a sufficiently long title"
    item = ManifestItem(
        publisher="reuters",
        canonical_url=canonical_url,
        published_at="2025-03-27T00:00:00Z",
        section="world",
        candidates=(),
    )
    initial_url = reuters_syndication_search_url(item)
    title_url = reuters_syndication_title_search_url(expected_headline)
    initial_html = f"""
    <html><body><ol id="web">
      <li><h3><a href="{canonical_url}">
        {expected_headline} - Reuters
      </a></h3></li>
      <li><h3><a href="{partner_url}">
        {expected_headline}
      </a></h3></li>
    </ol></body></html>
    """.encode()
    client = StubArchiveClient(
        {
            initial_url: (
                200,
                {"content-type": "text/html"},
                initial_html,
                initial_url,
            ),
            title_url: (
                503,
                {"content-type": "text/html"},
                b"",
                title_url,
            ),
        }
    )

    candidates = discover_reuters_syndication_candidates(
        item,
        archive_client=client,
    )

    assert client.requests == [initial_url, title_url]
    assert [candidate.snapshot_url for candidate in candidates] == [
        partner_url
    ]


def test_ft_capture_uses_paywall_metadata_to_find_validated_partner(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.ft.com/content/"
        "d8f6d8af-8235-43ae-a946-6d51da973ca4"
    )
    snapshot_url = (
        "https://web.archive.org/web/20260308005629id_/"
        + canonical_url
    )
    expected_headline = (
        "Rachel Reeves sticks to stability in face of Iran war "
        "and restive Labour MPs"
    )
    partner_url = (
        "https://example.com/2026/03/03/"
        "rachel-reeves-sticks-to-stability/"
    )
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2026-03-03T16:04:04.200Z",
        section="uk",
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=snapshot_url,
            ),
        ),
    )
    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Fwww.ft.com%2Fcontent%2F"
        "d8f6d8af-8235-43ae-a946-6d51da973ca4"
    )
    amp_timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?url=" + (
        "https%3A%2F%2Famp.ft.com%2Fcontent%2F"
        "d8f6d8af-8235-43ae-a946-6d51da973ca4"
    )
    ghost_search_url = ghostarchive_search_url(canonical_url)
    canonical_search_url = ft_syndication_search_url(item)
    google_headline_search_url = ft_google_news_headline_search_url(item)
    ftchinese_search_url = ftchinese_title_search_url(expected_headline)
    title_search_url = ft_syndication_title_search_url(
        expected_headline
    )
    paywall_html = f"""
    <!doctype html><html><head><title>Subscribe to read</title>
      <script type="application/ld+json">
      {{
        "@type": "NewsArticle",
        "headline": "{expected_headline}",
        "datePublished": "2026-03-03T16:04:04.200Z",
        "isAccessibleForFree": "False"
      }}
      </script>
    </head><body>
      <h1>{expected_headline}</h1>
      <div id="barrier-page">Subscribe to unlock this article</div>
    </body></html>
    """.encode() + (b" " * 90_000)
    search_html = f"""
    <html><body><ol id="web">
      <li><h3><a href="{canonical_url}">
        {expected_headline} - Financial Times
      </a></h3></li>
      <li><h3><a href="{partner_url}">
        {expected_headline}
      </a></h3></li>
    </ol></body></html>
    """.encode()
    partner_html = f"""
    <!doctype html><html><head>
      <script type="application/ld+json">
      {{
        "@type": "NewsArticle",
        "headline": "{expected_headline}",
        "datePublished": "2026-03-03T17:04:04Z",
        "author": {{"name": "Financial Times"}}
      }}
      </script>
    </head><body><article>
      <p>Copyright The Financial Times Limited 2026</p>
      <p>The chancellor used a deliberately short statement to project
      economic credibility while conflict abroad unsettled investors and
      members of her own party. The report describes the fiscal forecasts,
      the reaction in parliament, and the political calculation behind the
      speech in enough detail to identify a complete licensed copy.</p>
      <p>Officials argued that stable public finances would help households
      and businesses absorb the energy shock. Economists discussed gilt
      yields, inflation, borrowing, and the assumptions made by the fiscal
      watchdog, while Labour MPs pressed ministers for a clearer account of
      the choices that could follow if the conflict continued.</p>
      <p>The final section records responses from opposition politicians,
      investors, and government advisers. It also explains how the spring
      statement fits the wider budget timetable and why the chancellor
      chose reassurance over announcing another package of measures.</p>
    </article></body></html>
    """.encode() + (b" " * 2_048)
    client = StubArchiveClient(
        {
            ghost_search_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                b"<html><body>No archives</body></html>",
                ghost_search_url,
            ),
            timemap_url: (
                200,
                {"content-type": "application/json"},
                json.dumps(
                    [[
                        "urlkey",
                        "timestamp",
                        "original",
                        "mimetype",
                        "statuscode",
                    ]]
                ).encode(),
                timemap_url,
            ),
            amp_timemap_url: (
                200,
                {"content-type": "application/json"},
                json.dumps([]).encode(),
                amp_timemap_url,
            ),
            snapshot_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                paywall_html,
                snapshot_url,
            ),
            title_search_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                search_html,
                title_search_url,
            ),
            partner_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                partner_html,
                partner_url,
            ),
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [
        canonical_search_url,
        google_headline_search_url,
        ghost_search_url,
        timemap_url,
        amp_timemap_url,
        snapshot_url,
        ftchinese_search_url,
        title_search_url,
        partner_url,
    ]
    capture = result["capture"]
    assert capture.selected_candidate.snapshot_url == partner_url
    assert capture.quality_signals["ftSyndicationValidated"] is True
    assert capture.quality_signals["syndicationHeadlineOverlap"] == 1.0
    assert capture.quality_signals["syndicationFtCopyrightAttributed"] is True
    assert capture.quality_signals["syndicationBodyCharacters"] >= 400


def test_ft_syndication_recovers_missing_headline_from_google_news():
    canonical_url = (
        "https://www.ft.com/content/"
        "02a3b935-62dc-44a1-9957-6867e8ee1890"
    )
    expected_headline = (
        "Israel attacks Beirut days after Trump's showdown with Netanyahu"
    )
    partner_url = (
        "https://example.com/world/"
        "israel-attacks-beirut-after-trump-showdown"
    )
    item = ManifestItem(
        publisher="ft",
        canonical_url=canonical_url,
        published_at="2026-06-07T15:02:53.730Z",
        section="world",
        candidates=(),
    )
    canonical_search_url = ft_syndication_search_url(item)
    google_news_url = ft_google_news_headline_search_url(item)
    title_search_url = ft_syndication_title_search_url(
        expected_headline
    )
    broad_search_url = ft_syndication_broad_title_search_url(
        expected_headline
    )
    ftchinese_search_url = ftchinese_title_search_url(expected_headline)
    google_news_xml = f"""
    <?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel>
      <item>
        <title>{expected_headline} - Financial Times</title>
        <pubDate>Sun, 07 Jun 2026 07:00:00 GMT</pubDate>
        <source url="https://www.ft.com">Financial Times</source>
      </item>
      <item>
        <title>A different report with a nearby publication date</title>
        <pubDate>Sun, 07 Jun 2026 08:00:00 GMT</pubDate>
        <source url="https://example.net">Another Publisher</source>
      </item>
    </channel></rss>
    """.encode()
    broad_search_html = f"""
    <html><body><ol id="web">
      <li><h3><a href="{canonical_url}">
        {expected_headline} - Financial Times
      </a></h3></li>
      <li><h3><a href="{partner_url}">
        {expected_headline}
      </a></h3></li>
    </ol></body></html>
    """.encode()
    client = StubArchiveClient(
        {
            canonical_search_url: (
                200,
                {"content-type": "text/html"},
                b"<html><ol id='web'></ol></html>",
                canonical_search_url,
            ),
            google_news_url: (
                200,
                {"content-type": "application/rss+xml"},
                google_news_xml,
                google_news_url,
            ),
            title_search_url: (
                200,
                {"content-type": "text/html"},
                b"<html><ol id='web'></ol></html>",
                title_search_url,
            ),
            broad_search_url: (
                200,
                {"content-type": "text/html"},
                broad_search_html,
                broad_search_url,
            ),
        }
    )

    candidates = discover_ft_syndication_candidates(
        item,
        archive_client=client,
    )

    assert client.requests == [
        canonical_search_url,
        google_news_url,
        ftchinese_search_url,
        title_search_url,
        broad_search_url,
    ]
    assert [candidate.snapshot_url for candidate in candidates] == [
        partner_url
    ]
    assert candidates[0].expected_headline == expected_headline


def test_ft_syndication_refines_google_news_partner_host_with_yahoo():
    expected_headline = (
        "AI is forecast to put 200,000 European banking jobs "
        "at risk by 2030"
    )
    partner_url = (
        "https://www.irishtimes.com/business/2026/01/01/"
        "ai-is-forecast-to-put-200000-european-banking-jobs-"
        "at-risk-by-2030/"
    )
    item = ManifestItem(
        publisher="ft",
        canonical_url=(
            "https://www.ft.com/content/"
            "71e12f85-1edb-4156-8cb5-3fe8aef36d93"
        ),
        published_at="2026-01-01T08:00:00Z",
        section="banking",
        candidates=(),
    )
    title_search_url = ft_syndication_title_search_url(
        expected_headline
    )
    broad_search_url = ft_syndication_broad_title_search_url(
        expected_headline
    )
    google_news_url = ft_google_news_partner_search_url(
        expected_headline
    )
    ftchinese_search_url = ftchinese_title_search_url(
        expected_headline
    )
    partner_search_url = ft_syndication_partner_site_search_url(
        expected_headline,
        "www.irishtimes.com",
    )
    google_news_xml = f"""
    <?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel>
      <item>
        <title>
          AI is forecast to ‘put 200,000 European banking jobs at risk’
          by 2030 - The Irish Times
        </title>
        <pubDate>Thu, 01 Jan 2026 08:00:00 GMT</pubDate>
        <source url="https://www.irishtimes.com">The Irish Times</source>
      </item>
      <item>
        <title>{expected_headline} - Unrelated Archive</title>
        <pubDate>Thu, 01 Jan 2015 08:00:00 GMT</pubDate>
        <source url="https://unrelated.example">Unrelated Archive</source>
      </item>
    </channel></rss>
    """.encode()
    partner_search_html = f"""
    <html><body><ol id="web"><li><h3>
      <a href="{partner_url}">
        AI is forecast to put 200,000 European banking jobs at risk
        by 2030 - The Irish Times
      </a>
    </h3></li></ol></body></html>
    """.encode()
    empty_search = b"<html><ol id='web'></ol></html>"
    client = StubArchiveClient(
        {
            title_search_url: (
                200,
                {"content-type": "text/html"},
                empty_search,
                title_search_url,
            ),
            broad_search_url: (
                200,
                {"content-type": "text/html"},
                empty_search,
                broad_search_url,
            ),
            ftchinese_search_url: (
                200,
                {"content-type": "text/html"},
                empty_search,
                ftchinese_search_url,
            ),
            google_news_url: (
                200,
                {"content-type": "application/rss+xml"},
                google_news_xml,
                google_news_url,
            ),
            partner_search_url: (
                200,
                {"content-type": "text/html"},
                partner_search_html,
                partner_search_url,
            ),
        }
    )

    candidates = discover_ft_syndication_candidates(
        item,
        archive_client=client,
        expected_headline=expected_headline,
    )

    assert client.requests == [
        ftchinese_search_url,
        title_search_url,
        broad_search_url,
        google_news_url,
        partner_search_url,
    ]
    assert [candidate.snapshot_url for candidate in candidates] == [
        partner_url
    ]
    assert candidates[0].expected_headline == expected_headline


def test_ft_syndication_normalizes_ftchinese_result_to_full_mobile_view():
    expected_headline = "The great bond and equity conundrum"
    item = ManifestItem(
        publisher="ft",
        canonical_url=(
            "https://www.ft.com/content/"
            "4389caaa-b87a-4d4c-82a1-db161d3265d3"
        ),
        published_at="2026-06-12T04:00:22.942Z",
        section="markets",
        candidates=(),
    )
    title_search_url = ft_syndication_title_search_url(
        expected_headline
    )
    indexed_url = (
        "https://www.ftchinese.com/interactive/283158/en"
        "?utm_source=yahoo"
    )
    expected_url = (
        "https://m.ftchinese.com/interactive/283158/en"
        "?utm_source=yahoo&full=y"
    )
    search_html = f"""
    <html><body><ol id="web"><li><h3>
      <a href="{indexed_url}">
        {expected_headline} - Financial Times
      </a>
    </h3></li></ol></body></html>
    """.encode()
    client = StubArchiveClient(
        {
            title_search_url: (
                200,
                {"content-type": "text/html"},
                search_html,
                title_search_url,
            ),
        }
    )

    candidates = discover_ft_syndication_candidates(
        item,
        archive_client=client,
        expected_headline=expected_headline,
    )

    assert client.requests == [
        ftchinese_title_search_url(expected_headline),
        title_search_url,
    ]
    assert [candidate.snapshot_url for candidate in candidates] == [
        expected_url
    ]
    assert candidates[0].expected_headline == expected_headline


def test_ft_syndication_uses_official_ftchinese_search_fallback():
    expected_headline = "The great bond and equity conundrum"
    item = ManifestItem(
        publisher="ft",
        canonical_url=(
            "https://www.ft.com/content/"
            "4389caaa-b87a-4d4c-82a1-db161d3265d3"
        ),
        published_at="2026-06-12T04:00:22.942Z",
        section="markets",
        candidates=(),
    )
    title_search_url = ft_syndication_title_search_url(
        expected_headline
    )
    broad_search_url = ft_syndication_broad_title_search_url(
        expected_headline
    )
    ftchinese_search_url = ftchinese_title_search_url(
        expected_headline
    )
    empty_search = b"<html><ol id='web'></ol></html>"
    ftchinese_html = b"""
    <html><body>
      <a href="/interactive/283158">Chinese translation title</a>
      <a href="https://untrusted.example/interactive/999999">
        Untrusted result
      </a>
    </body></html>
    """
    client = StubArchiveClient(
        {
            title_search_url: (
                200,
                {"content-type": "text/html"},
                empty_search,
                title_search_url,
            ),
            broad_search_url: (
                200,
                {"content-type": "text/html"},
                empty_search,
                broad_search_url,
            ),
            ftchinese_search_url: (
                200,
                {"content-type": "text/html"},
                ftchinese_html,
                ftchinese_search_url,
            ),
        }
    )

    candidates = discover_ft_syndication_candidates(
        item,
        archive_client=client,
        expected_headline=expected_headline,
    )

    assert client.requests == [
        ftchinese_search_url,
    ]
    assert [candidate.snapshot_url for candidate in candidates] == [
        "https://m.ftchinese.com/interactive/283158/en?full=y"
    ]
    assert candidates[0].expected_headline == expected_headline


def test_ft_syndication_uses_allowed_partner_sitemap(
    monkeypatch,
):
    expected_headline = "The great bond and equity conundrum"
    item = ManifestItem(
        publisher="ft",
        canonical_url=(
            "https://www.ft.com/content/"
            "4389caaa-b87a-4d4c-82a1-db161d3265d3"
        ),
        published_at="2026-06-11T07:00:00Z",
        section="markets",
        candidates=(),
    )
    broad_search_url = ft_syndication_broad_title_search_url(
        expected_headline
    )
    google_news_url = ft_google_news_partner_search_url(
        expected_headline
    )
    ftchinese_search_url = ftchinese_title_search_url(
        expected_headline
    )
    sitemap_url = "https://www.davidruler.com/sitemap.xml"
    partner_url = (
        "https://www.davidruler.com/resources/articles/"
        "the-great-bond-and-equity-conundrum"
    )
    empty_search = b"<html><ol id='web'></ol></html>"
    empty_google_news = (
        b"<?xml version='1.0'?><rss version='2.0'><channel></channel></rss>"
    )
    sitemap = f"""
    <?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>
        https://davidruler-staging.vercel.app/resources/articles/
        the-great-bond-and-equity-conundrum
      </loc></url>
    </urlset>
    """.replace("\n        ", "").encode()
    client = StubArchiveClient(
        {
            broad_search_url: (
                200,
                {"content-type": "text/html"},
                empty_search,
                broad_search_url,
            ),
            ftchinese_search_url: (
                200,
                {"content-type": "text/html"},
                empty_search,
                ftchinese_search_url,
            ),
            google_news_url: (
                200,
                {"content-type": "application/rss+xml"},
                empty_google_news,
                google_news_url,
            ),
            sitemap_url: (
                200,
                {"content-type": "application/xml"},
                sitemap,
                sitemap_url,
            ),
        }
    )
    monkeypatch.setattr(
        "jojo_news_archive.sources.ft.capture._ft_known_partner_urls",
        None,
    )

    candidates = discover_ft_syndication_candidates(
        item,
        archive_client=client,
        expected_headline=expected_headline,
        skip_title_search=True,
        exhaustive=True,
    )

    assert client.requests == [
        broad_search_url,
        ftchinese_search_url,
        google_news_url,
        sitemap_url,
    ]
    assert [candidate.snapshot_url for candidate in candidates] == [
        partner_url
    ]


def test_reuters_syndication_rejects_unattributed_related_article(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.reuters.com/world/example-related-story-2025-07-03"
    )
    guessed_url = (
        "https://web.archive.org/web/20250704000000id_/"
        + canonical_url
    )
    related_url = "https://example.com/example-related-story"
    item = ManifestItem(
        publisher="reuters",
        canonical_url=canonical_url,
        published_at="2025-07-03T00:00:00Z",
        section="world",
        candidates=(candidate(guessed_url, "20250704000000"),),
    )
    search_url = reuters_syndication_search_url(item)
    search_html = f"""
    <html><body><ol id="web"><li><h3>
      <a href="{related_url}">Related article</a>
    </h3></li></ol></body></html>
    """.encode()
    related_html = b"""
    <!doctype html><html><head>
      <script type="application/ld+json">
      {
        "@type": "NewsArticle",
        "headline": "Example related story",
        "datePublished": "2025-07-03T03:00:00Z",
        "author": {"name": "Another Publisher"}
      }
      </script>
    </head><body><article>
      <p>This independently written report discusses a similar subject but
      does not carry the wire service byline or attribution required by the
      archive. It has enough text to pass a naive length-only article check.</p>
      <p>More unrelated reporting is included here to ensure the rejection is
      caused by provenance validation rather than by a short-body threshold.
      The candidate must never be stored as if it were the original wire.</p>
      <p>A final paragraph adds context and length while still omitting any
      reference to the source whose canonical URL is being archived.</p>
    </article></body></html>
    """ + (b" " * 2_048)
    client = StubArchiveClient(
        {
            guessed_url: (
                401,
                {"content-type": "text/html"},
                b"",
                guessed_url,
            ),
            search_url: (
                200,
                {"content-type": "text/html"},
                search_html,
                search_url,
            ),
            related_url: (
                200,
                {"content-type": "text/html"},
                related_html,
                related_url,
            ),
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "error"
    assert "missing-reuters-attribution" in result["error"]
    assert not (tmp_path / "objects").exists()


def test_bloomberg_capture_falls_back_to_validated_syndicated_html(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.bloomberg.com/news/articles/2024-06-03/"
        "tories-fail-to-dent-labour-polling-lead-in-early-uk-campaign"
    )
    guessed_url = (
        "https://web.archive.org/web/20240604000000id_/"
        + canonical_url
    )
    syndicated_url = (
        "https://www.yahoo.com/news/"
        "tories-fail-to-dent-labour-polling-lead-040000123.html"
    )
    item = ManifestItem(
        publisher="bloomberg",
        canonical_url=canonical_url,
        published_at="2024-06-03T00:00:00Z",
        section="politics",
        candidates=(candidate(guessed_url, "20240604000000"),),
    )
    search_url = bloomberg_syndication_search_url(item)
    search_html = f"""
    <html><body><ol id="web"><li><h3>
      <a href="{syndicated_url}">Licensed syndicated copy</a>
    </h3></li></ol></body></html>
    """.encode()
    syndicated_html = b"""
    <!doctype html><html><head>
      <meta property="og:site_name" content="Yahoo News">
      <script type="application/ld+json">
      {
        "@type": "NewsArticle",
        "headline": "Tories Fail to Dent Labour Polling Lead in Early UK Campaign",
        "datePublished": "2024-06-03T04:00:00Z",
        "author": {"name": "Bloomberg News"}
      }
      </script>
    </head><body><article>
      <div class="article-content">
        <p>Bloomberg News reports that the governing party failed to narrow
        the opposition's polling lead during the opening stage of the UK
        election campaign. The survey provides a detailed national snapshot
        and identifies the issues shaping voter decisions.</p>
        <p>The report explains changes among several demographic groups,
        compares the findings with earlier polling, and includes responses
        from campaign officials. This supplies substantive reporting rather
        than a headline, search snippet, or related-story card.</p>
        <p>Additional analysis covers the parties' economic messages,
        leadership ratings, constituency strategy, and the timetable before
        voting day. The complete licensed copy is retained as raw HTML for
        reproducible parser validation.</p>
      </div>
    </article></body></html>
    """ + (b" " * 2_048)
    client = StubArchiveClient(
        {
            guessed_url: (
                401,
                {"content-type": "text/html"},
                b"",
                guessed_url,
            ),
            search_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                search_html,
                search_url,
            ),
            syndicated_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                syndicated_html,
                syndicated_url,
            ),
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests[0] == guessed_url
    assert client.requests[1].startswith(WAYBACK_TIMEMAP_ENDPOINT)
    assert client.requests[-2:] == [search_url, syndicated_url]
    capture = result["capture"]
    assert capture.selected_candidate.provider == CaptureProvider.OTHER
    assert capture.final_url == syndicated_url
    assert capture.quality_signals["bloombergSyndicationValidated"] is True
    assert capture.quality_signals["syndicationBloombergAttributed"] is True
    assert (
        capture.quality_signals["syndicationBodyCharacters"]
        >= BLOOMBERG_SYNDICATION_MINIMUM_BODY_CHARACTERS
    )


def test_bloomberg_manifest_candidates_only_skips_dynamic_discovery(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.bloomberg.com/news/articles/2024-06-03/"
        "manifest-candidate-only"
    )
    snapshot_url = (
        "https://web.archive.org/web/20240604000000id_/" + canonical_url
    )
    item = ManifestItem(
        publisher="bloomberg",
        canonical_url=canonical_url,
        published_at="2024-06-03T00:00:00Z",
        section="politics",
        candidates=(candidate(snapshot_url, "20240604000000"),),
    )
    client = StubArchiveClient(
        {
            snapshot_url: (
                404,
                {"content-type": "text/html"},
                b"",
                snapshot_url,
            ),
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
        bloomberg_manifest_candidates_only=True,
    )

    assert result["status"] == "error"
    assert client.requests == [snapshot_url]
    assert not (tmp_path / "objects").exists()


def test_bloomberg_syndication_rejects_short_paywall_preview(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.bloomberg.com/news/articles/2020-12-14/"
        "bank-m-a-deep-freeze-thaws-with-wave-of-billion-dollar-deals"
    )
    guessed_url = (
        "https://web.archive.org/web/20201215000000id_/" + canonical_url
    )
    partner_url = (
        "https://www.afr.com/companies/financial-services/"
        "bank-m-and-a-deep-freeze-thaws-with-billion-dollar-deal-wave-"
        "20201215-p56nn6"
    )
    item = ManifestItem(
        publisher="bloomberg",
        canonical_url=canonical_url,
        published_at="2020-12-14T00:00:00Z",
        section="business",
        candidates=(candidate(guessed_url, "20201215000000"),),
    )
    search_url = bloomberg_syndication_search_url(item)
    search_html = f"""
    <html><body><ol id="web"><li><h3>
      <a href="{partner_url}">Licensed Bloomberg copy</a>
    </h3></li></ol></body></html>
    """.encode()
    partner_html = b"""
    <!doctype html><html><head>
      <script type="application/ld+json">
      {
        "@type": "NewsArticle",
        "headline": "Bank M&A Deep Freeze Thaws With Wave of Billion-Dollar Deals",
        "datePublished": "2020-12-14T12:00:00Z",
        "author": {"name": "Bloomberg"}
      }
      </script>
    </head><body><article><div class="article-content">
      <p>Huntington Bancshares announced a multibillion-dollar regional bank
      deal, and industry executives said more mergers and acquisitions were
      likely after the market's pandemic freeze.</p>
      <p>Bloomberg reported that low interest rates, tight margins, executive
      succession and pressure to grow were driving the renewed deal wave.
      These two paragraphs are only the publicly visible preview.</p>
      <p>Subscribe to gift this article.</p>
      <p>Already a subscriber? Login</p>
    </div></article></body></html>
    """ + (b" " * 2_048)
    client = StubArchiveClient(
        {
            guessed_url: (
                401,
                {"content-type": "text/html"},
                b"",
                guessed_url,
            ),
            search_url: (
                200,
                {"content-type": "text/html"},
                search_html,
                search_url,
            ),
            partner_url: (
                200,
                {"content-type": "text/html"},
                partner_html,
                partner_url,
            ),
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "error"
    assert "suspected-paywall-shell" in result["error"]
    assert not (tmp_path / "objects").exists()


def test_bloomberg_syndication_rejects_unattributed_related_article(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.bloomberg.com/news/articles/2024-06-03/"
        "tories-fail-to-dent-labour-polling-lead-in-early-uk-campaign"
    )
    guessed_url = (
        "https://web.archive.org/web/20240604000000id_/"
        + canonical_url
    )
    related_url = "https://example.com/tories-fail-to-dent-labour-lead"
    item = ManifestItem(
        publisher="bloomberg",
        canonical_url=canonical_url,
        published_at="2024-06-03T00:00:00Z",
        section="politics",
        candidates=(candidate(guessed_url, "20240604000000"),),
    )
    search_url = bloomberg_syndication_search_url(item)
    search_html = f"""
    <html><body><ol id="web"><li><h3>
      <a href="{related_url}">Related article</a>
    </h3></li></ol></body></html>
    """.encode()
    related_html = b"""
    <!doctype html><html><head>
      <script type="application/ld+json">
      {
        "@type": "NewsArticle",
        "headline": "Tories Fail to Dent Labour Polling Lead in Early UK Campaign",
        "datePublished": "2024-06-03T04:00:00Z",
        "author": {"name": "Another Publisher"}
      }
      </script>
    </head><body><article>
      <p>An independently written article may have the same headline and
      publication date, but it lacks the required source attribution. The
      validator must not silently treat it as the canonical publisher copy.</p>
      <p>More unrelated reporting is included to exceed the minimum body
      length and prove that provenance, rather than a naive length check,
      causes this candidate to be rejected by the archive.</p>
      <p>A final paragraph adds enough detail for a complete parser result
      while deliberately omitting any reference to the canonical publisher
      or its news service.</p>
    </article></body></html>
    """ + (b" " * 2_048)
    client = StubArchiveClient(
        {
            guessed_url: (
                401,
                {"content-type": "text/html"},
                b"",
                guessed_url,
            ),
            search_url: (
                200,
                {"content-type": "text/html"},
                search_html,
                search_url,
            ),
            related_url: (
                200,
                {"content-type": "text/html"},
                related_html,
                related_url,
            ),
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "error"
    assert "missing-bloomberg-attribution" in result["error"]
    assert not (tmp_path / "objects").exists()


def test_capture_state_records_result_and_summary(tmp_path: Path):
    url = "https://web.archive.org/web/20200102000000id_/https://example.com/a"
    item = ManifestItem(
        publisher="ft",
        canonical_url="https://www.ft.com/content/example",
        published_at="2020-01-01T00:00:00Z",
        section=None,
        candidates=(candidate(url, "20200102000000"),),
    )
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_text(
        json.dumps(
            {
                "publisher": "ft",
                "canonical_url": item.canonical_url,
                "published_at": item.published_at,
                "candidates": [
                    value.model_dump(mode="json", by_alias=True, exclude_none=True)
                    for value in item.candidates
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="ft",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="ft",
    )
    selected = pending_captures(
        connection,
        retry_errors=False,
        maximum=1,
        maximum_record_attempts=3,
    )[0]
    mark_capture_downloading(connection, selected)
    result = capture_item(
        selected,
        archive_client=StubArchiveClient(
            {url: (200, {"content-type": "text/html"}, ARTICLE, url)}
        ),
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )
    record_capture_result(connection, result)

    row = connection.execute(
        "SELECT status, attempts, raw_sha256, record_path FROM captures"
    ).fetchone()
    summary = capture_summary(connection, output_dir=tmp_path)

    assert row[0:2] == ("complete", 1)
    assert len(row[2]) == 64
    assert row[3].endswith(".json")
    assert summary["capturesByStatus"] == {"complete": 1}
    assert summary["rawHtmlBytes"] == len(ARTICLE)
    assert summary["objectsOnDisk"] == 1
    assert summary["recordsOnDisk"] == 1


def test_content_addressed_storage_is_deterministic(tmp_path: Path):
    first = store_raw_html(tmp_path, ARTICLE)
    second = store_raw_html(tmp_path, ARTICLE)

    assert first == second
    assert first.content_encoding == "gzip"
    assert len(list((tmp_path / "objects").rglob("*.html.gz"))) == 1


def test_capture_item_reattaches_an_orphaned_immutable_record(
    tmp_path: Path,
):
    url = (
        "https://web.archive.org/web/20100102000000id_/"
        "https://www.bloomberg.com/news/articles/2010-01-01/example"
    )
    item = ManifestItem(
        publisher="bloomberg",
        canonical_url=(
            "https://www.bloomberg.com/news/articles/2010-01-01/example"
        ),
        published_at="2010-01-01T00:00:00Z",
        section="business",
        candidates=(candidate(url, "20100102000000"),),
    )
    client = StubArchiveClient(
        {
            url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                url,
            ),
        }
    )

    first = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )
    second = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert first["status"] == second["status"] == "complete"
    assert first["recordPath"] == second["recordPath"]
    assert (
        first["capture"].retrieved_at
        == second["capture"].retrieved_at
    )
    assert first["capture"].raw_html == second["capture"].raw_html


def test_raw_quality_rejects_archive_error_page():
    score, signals = score_raw_capture(
        b"<html>Wayback Machine doesn't have that page archived.</html>",
        http_status=200,
        content_type="text/html",
    )

    assert score < 100
    assert signals["looksLikeHtml"] is True
    assert signals["archiveErrorPage"] is True


def test_raw_quality_rejects_nginx_default_server_page():
    content = b"""
    <html><head><title>Welcome to nginx!</title></head>
    <body bgcolor="white" text="black">
      <center><h1>Welcome to nginx!</h1></center>
    </body></html>
    """

    score, signals = score_raw_capture(
        content,
        http_status=200,
        content_type="text/html",
    )

    assert score < 70
    assert signals["serverPlaceholderShell"] is True


def test_raw_quality_rejects_tiny_archive_burn_stub():
    content = b"\n\n<!--  Burned on demand at 2012-07-05 23:11:03 -->"

    score, signals = score_raw_capture(
        content,
        http_status=200,
        content_type="text/html",
    )

    assert score < 70
    assert signals["looksLikeHtml"] is True
    assert signals["tinyHtmlShell"] is True


def test_npr_capture_skips_nginx_placeholder_for_next_candidate(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.npr.org/2012/05/09/152339471/"
        "u-s-wholesale-stockpiles-edged-higher-in-march"
    )
    placeholder_url = (
        "https://web.archive.org/web/20120510000000id_/" + canonical_url
    )
    article_url = (
        "https://web.archive.org/web/20120511000000id_/" + canonical_url
    )
    placeholder = b"""
    <html><head><title>Welcome to nginx!</title></head>
    <body bgcolor="white" text="black">
      <center><h1>Welcome to nginx!</h1></center>
    </body></html>
    """
    client = StubArchiveClient(
        {
            placeholder_url: (
                200,
                {"content-type": "text/html"},
                placeholder,
                placeholder_url,
            ),
            article_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                article_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="npr",
        canonical_url=canonical_url,
        published_at="2012-05-09T00:00:00Z",
        section=None,
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=placeholder_url,
            ),
            CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=article_url,
            ),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [placeholder_url, article_url]
    assert result["capture"].selected_candidate.snapshot_url == article_url


def test_npr_capture_skips_parser_incomplete_privacy_page(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.npr.org/2017/05/29/530555477/"
        "new-show-black-crows"
    )
    privacy_url = (
        "https://web.archive.org/web/20220901164451id_/"
        "https://choice.npr.org/index.html?origin=" + canonical_url
    )
    article_url = (
        "https://web.archive.org/web/20170601000000id_/" + canonical_url
    )
    privacy_page = b"""
    <html><head><title>Cookie Consent and Choices</title></head>
    <body><article><h1>Cookie Consent and Choices</h1>
      <p>Please choose whether NPR may use cookies on this device.</p>
    </article></body></html>
    """ + (b" " * 10_000)
    article = b"""
    <html><head>
      <meta property="og:title" content="New show tells stories">
      <meta property="article:published_time"
            content="2017-05-29T12:00:00Z">
    </head><body><div id="storytext">
      <p>The first paragraph reports on the people behind the production and
      explains why their testimony matters to listeners across the region.
      It includes enough concrete context to establish this as the archived
      article rather than a navigation or consent page.</p>
      <p>The second paragraph describes how the reporting team gathered the
      interviews, verified the accounts and edited the material for radio.
      Those details continue the substantive article body for this test.</p>
      <p>The final paragraph provides additional historical context, names
      the communities involved and explains what audiences will hear when
      the program is broadcast.</p>
    </div></body></html>
    """
    client = StubArchiveClient(
        {
            privacy_url: (
                200,
                {"content-type": "text/html"},
                privacy_page,
                privacy_url,
            ),
            article_url: (
                200,
                {"content-type": "text/html"},
                article,
                article_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="npr",
        canonical_url=canonical_url,
        published_at="2017-05-29T00:00:00Z",
        section=None,
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=privacy_url,
            ),
            CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=article_url,
            ),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [privacy_url, article_url]
    assert result["capture"].selected_candidate.snapshot_url == article_url


def test_completed_npr_editorial_removal_notice_is_requeued(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.npr.org/2018/04/03/598239092/"
        "the-man-who-spent-100k"
    )
    snapshot_url = (
        "https://web.archive.org/web/20180404000000id_/" + canonical_url
    )
    content = b"""
    <html><head>
      <meta property="og:title" content="The Man Who Spent $100K">
      <meta property="article:published_time"
            content="2018-04-03T12:00:00Z">
    </head><body><div id="storytext"><p><em>
      This story has been temporarily removed pending an editorial review.
    </em></p></div></body></html>
    """ + (b" " * 10_000)
    blob = store_raw_html(tmp_path, content)
    capture = RawCapture(
        article_id="npr:" + ("c" * 64),
        publisher="npr",
        canonical_url=canonical_url,
        published_at=datetime(2018, 4, 3, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=snapshot_url,
        ),
        candidates_considered=[],
        retrieved_at=datetime.now(timezone.utc),
        final_url=snapshot_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    assert completed_capture_rejection_reason(
        capture,
        archive_root=tmp_path,
    ) == "npr-capture-parser-incomplete"


def test_npr_capture_discovers_alternate_http_timemap_after_tiny_stub(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.npr.org/2012/05/09/152339471/"
        "u-s-wholesale-stockpiles-edged-higher-in-march"
    )
    original_url = canonical_url.replace("https://", "http://")
    placeholder_url = (
        "https://web.archive.org/web/20120509192313id_/" + original_url
    )
    article_url = (
        "https://web.archive.org/web/20120510192313id_/" + original_url
    )
    https_timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?" + (
        "url=https%3A%2F%2Fwww.npr.org%2F2012%2F05%2F09%2F152339471%2F"
        "u-s-wholesale-stockpiles-edged-higher-in-march"
    )
    http_timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?" + (
        "url=http%3A%2F%2Fwww.npr.org%2F2012%2F05%2F09%2F152339471%2F"
        "u-s-wholesale-stockpiles-edged-higher-in-march"
    )
    placeholder = b"\n\n<!-- Burned on demand at 2012-07-05 23:11:03 -->"
    header = [
        "urlkey",
        "timestamp",
        "original",
        "mimetype",
        "statuscode",
        "digest",
        "length",
    ]
    http_timemap = json.dumps(
        [
            header,
            [
                "org,npr)/example",
                "20120509192313",
                original_url,
                "text/html",
                "200",
                "PLACEHOLDER",
                str(len(placeholder)),
            ],
            [
                "org,npr)/example",
                "20120510192313",
                original_url,
                "text/html",
                "200",
                "ARTICLE",
                str(len(ARTICLE)),
            ],
        ]
    ).encode()
    client = StubArchiveClient(
        {
            placeholder_url: (
                200,
                {"content-type": "text/html"},
                placeholder,
                placeholder_url,
            ),
            https_timemap_url: (
                200,
                {"content-type": "application/json"},
                json.dumps([header]).encode(),
                https_timemap_url,
            ),
            http_timemap_url: (
                200,
                {"content-type": "application/json"},
                http_timemap,
                http_timemap_url,
            ),
            article_url: (
                200,
                {"content-type": "text/html"},
                ARTICLE,
                article_url,
            ),
        }
    )
    item = ManifestItem(
        publisher="npr",
        canonical_url=canonical_url,
        published_at="2012-05-09T00:00:00Z",
        section=None,
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=placeholder_url,
                captured_at=datetime(
                    2012,
                    5,
                    9,
                    19,
                    23,
                    13,
                    tzinfo=timezone.utc,
                ),
                digest="PLACEHOLDER",
            ),
        ),
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )

    assert result["status"] == "complete"
    assert client.requests == [
        placeholder_url,
        https_timemap_url,
        http_timemap_url,
        article_url,
    ]
    assert result["capture"].selected_candidate.snapshot_url == article_url


def test_completed_nginx_placeholder_is_requeued_by_quality_audit(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.npr.org/2012/05/09/152339471/"
        "u-s-wholesale-stockpiles-edged-higher-in-march"
    )
    snapshot_url = (
        "https://web.archive.org/web/20120510000000id_/" + canonical_url
    )
    content = b"""
    <html><head><title>Welcome to nginx!</title></head>
    <body bgcolor="white" text="black">
      <center><h1>Welcome to nginx!</h1></center>
    </body></html>
    """
    blob = store_raw_html(tmp_path, content)
    capture = RawCapture(
        article_id="npr:" + ("a" * 64),
        publisher="npr",
        canonical_url=canonical_url,
        published_at=datetime(2012, 5, 9, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=snapshot_url,
        ),
        candidates_considered=[],
        retrieved_at=datetime.now(timezone.utc),
        final_url=snapshot_url,
        http_status=200,
        content_type="text/html",
        quality_score=70,
        raw_html=blob,
    )

    assert completed_capture_rejection_reason(
        capture,
        archive_root=tmp_path,
    ) == "server-placeholder-shell"


def test_completed_tiny_burn_stub_is_requeued_by_quality_audit(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.npr.org/2012/05/03/151955581/"
        "bull-fights-bankruptcy-and-a-damn-dangerous-book"
    )
    snapshot_url = (
        "https://web.archive.org/web/20120706031557id_/" + canonical_url
    )
    content = b"\n\n<!-- Burned on demand at 2012-07-05 23:11:03 -->"
    blob = store_raw_html(tmp_path, content)
    capture = RawCapture(
        article_id="npr:" + ("b" * 64),
        publisher="npr",
        canonical_url=canonical_url,
        published_at=datetime(2012, 5, 3, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=snapshot_url,
        ),
        candidates_considered=[],
        retrieved_at=datetime.now(timezone.utc),
        final_url=snapshot_url,
        http_status=200,
        content_type="text/html",
        quality_score=70,
        raw_html=blob,
    )

    assert completed_capture_rejection_reason(
        capture,
        archive_root=tmp_path,
    ) == "tiny-html-shell"


def test_raw_quality_rejects_authentication_shell():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>Log In - The New York Times</title></head>
        <body><p>Log in to continue.</p></body></html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
        final_url="https://myaccount.nytimes.com/auth/login?URI=article",
    )

    assert score < 85
    assert signals["authenticationShell"] is True


def test_raw_quality_rejects_legacy_zaobao_regauth_redirect():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>Zaobao registration</title></head>
        <body><div id="navigation-shell">Login</div></body></html>
        """ + (b" " * 22_000),
        http_status=200,
        content_type="text/html",
        final_url=(
            "https://web.archive.org/web/20160607123024id_/"
            "http://acc-reg.sphdigital.com/RegAuth2/zh2Login.html"
            "?svc=zbs&goto=%2Famserver%2Fcdcservlet%3FTARGET%3D"
            "http%253A%252F%252Fwww.zaobao.com.sg%252Fforum%252Fstory"
        ),
    )

    assert score < 85
    assert signals["authenticationShell"] is True


def test_raw_quality_rejects_access_challenge_shell():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>Bloomberg - Are you a robot?</title></head>
        <body><p>We've detected unusual activity from your network.</p></body>
        </html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
    )

    assert score < 85
    assert signals["accessChallengeShell"] is True


def test_raw_quality_rejects_bloomberg_terms_violation_redirect():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>Terms of Service Violation</title></head>
        <body><p>Your usage has been flagged as a violation of our terms
        of service. Please confirm that you are not a robot.</p></body>
        </html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
        final_url=(
            "https://web.archive.org/web/20180919041634id_/"
            "https://www.bloomberg.com/tosv2.html?url=encoded"
        ),
    )

    assert score < 85
    assert signals["accessChallengeShell"] is True


def test_raw_quality_rejects_email_login_redirect_with_empty_shell():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>The New York Times</title></head>
        <body></body></html>
        """ + (b" " * 20_000),
        http_status=200,
        content_type="text/html",
        final_url=(
            "https://myaccount.nytimes.com/auth/enter-email"
            "?response_type=cookie"
        ),
    )

    assert score < 85
    assert signals["authenticationShell"] is True


def test_raw_quality_rejects_nyt_lire_shell_without_login_title():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>The New York Times</title>
        <meta name="sourceApp" content="nyt-lire"></head>
        <body><div id="myAccountAuth" class="full-page"></div>
        <script src="/lire_ui/js/unified-lire.bundle.js"></script></body>
        </html>
        """ + (b" " * 20_000),
        http_status=200,
        content_type="text/html",
    )

    assert score < 85
    assert signals["authenticationShell"] is True


def test_raw_quality_rejects_client_challenge_shell():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>Client Challenge</title></head>
        <body><p>JavaScript is disabled in your browser. A required part of
        this site couldn't load.</p></body></html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
    )

    assert score < 85
    assert signals["accessChallengeShell"] is True


def test_raw_quality_rejects_ft_zephr_barrier_shell():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>Article headline</title></head>
        <body><div id="barrier-page">
        <h1>Article headline</h1>
        <span>Subscribe to unlock this article</span>
        </div>
        <script>
        window.Zephr.outcomes['paywall'] = {
          featureLabel: 'Paywall'
        };
        </script></body></html>
        """ + (b" " * 220_000),
        http_status=200,
        content_type="text/html",
    )

    assert score < 85
    assert signals["subscriptionShell"] is True


def test_raw_quality_rejects_ft_legacy_subscription_landing_pages():
    for title in (
        "Register to read | Financial Times",
        "Become an FT subscriber to read | Financial Times",
        "Subscribe to a slice of the FT | Financial Times",
        "Try FT for free | Financial Times",
    ):
        score, signals = score_raw_capture(
            (
                f"""
                <html><head><title>{title}</title>
                <script type="application/ld+json">
                {{"@type":"NewsArticle","headline":"Navigation teaser"}}
                </script></head>
                <body><main>Choose a subscription to continue.</main></body>
                </html>
                """
            ).encode()
            + (b" " * 90_000),
            http_status=200,
            content_type="text/html",
        )

        assert score < 85
        assert signals["hasArticleMarker"] is True
        assert signals["hasStrongBodyMarker"] is False
        assert signals["subscriptionShell"] is True


def test_raw_quality_rejects_ft_legacy_barrier_variants():
    modern_score, modern_signals = score_raw_capture(
        b"""
        <html><body>
          <div class="barrier-grid__article-title">
            Archived headline without article body
          </div>
        </body></html>
        """ + (b" " * 220_000),
        http_status=200,
        content_type="text/html",
        final_url=(
            "https://web.archive.org/web/20161009061251id_/"
            "https://www.ft.com/content/example"
        ),
    )
    legacy_score, legacy_signals = score_raw_capture(
        b"""
        <html><head><title>Archived FT headline - FT.com</title></head>
        <body><nav>World Companies Markets Subscribe Sign in</nav></body>
        </html>
        """ + (b" " * 32_000),
        http_status=200,
        content_type="text/html",
        final_url=(
            "https://web.archive.org/web/20160622180631id_/"
            "http://www.ft.com/cms/s/example,Authorised=false.html"
            "?classification=conditional_standard&iab=barrier-app"
        ),
    )

    assert modern_score < 85
    assert modern_signals["subscriptionShell"] is True
    assert legacy_score < 85
    assert legacy_signals["subscriptionShell"] is True
    assert legacy_signals["ftLegacyBarrierUrl"] is True


def test_raw_quality_rejects_ft_professional_access_error_redirect():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>Monetary Policy Radar | Financial Times</title>
        </head><body></body></html>
        """ + (b" " * 90_000),
        http_status=200,
        content_type="text/html",
        final_url=(
            "https://web.archive.org/web/20260223182234id_/"
            "https://professional-monetary-policy-radar.ft.com/"
            "access-error/example"
        ),
    )

    assert score < 85
    assert signals["accessChallengeShell"] is True


def test_raw_quality_rejects_truncated_ft_article_body():
    score, signals = score_raw_capture(
        b"""
        <html><head><script type="application/ld+json">
        {"@type":"NewsArticle","headline":"Archived FT article",
         "articleBody":"Only a short archived teaser survives here."}
        </script></head><body><article>
        <div class="article__content-body">
          <p>Only a short archived teaser survives here.</p>
        </div></article></body></html>
        """ + (b" " * 90_000),
        http_status=200,
        content_type="text/html",
        final_url=(
            "https://web.archive.org/web/20180901000000id_/"
            "https://www.ft.com/content/example"
        ),
    )

    assert score < 85
    assert signals["ftTruncatedArticleShell"] is True
    assert signals["ftBodyCharacters"] < 100


def test_raw_quality_rejects_ft_chinese_percentage_preview():
    score, signals = score_raw_capture(
        """
        <html><body>
          <div id="story-body-container" class="story-body">
            <p>First visible paragraph from the Financial Times story.</p>
            <p>Second visible paragraph with additional reporting.</p>
            <p>Third visible paragraph before the subscription barrier.</p>
            <div class="clearfloat"><strong>
              您已阅读12%（426字），剩余88%（3217字）包含更多重要信息，
            </strong>订阅以继续探索完整内容，并享受更多专属服务。</div>
          </div>
        </body></html>
        """.encode()
        + (b" " * 90_000),
        http_status=200,
        content_type="text/html",
        final_url="https://m.ftchinese.com/interactive/284389/en?full=y",
    )

    assert score < 85
    assert signals["ftTruncatedArticleShell"] is True
    assert signals["ftExplicitTruncationNotice"] is True


def test_raw_quality_rejects_bloomberg_teaser_body():
    score, signals = score_raw_capture(
        b"""
        <html><body>
          <div class="teaser-body__b6065d89">
            <div class="body-content teaser-content__388dc739">
              <p>An occasional glimpse inside the world of selling very
              expensive homes.</p>
              <p>Words fail me. I am blown away by this house.</p>
            </div>
          </div>
        </body></html>
        """ + (b" " * 90_000),
        http_status=200,
        content_type="text/html",
        final_url=(
            "https://web.archive.org/web/20221204041948id_/"
            "https://www.bloomberg.com/news/articles/2022-12-03/example"
        ),
    )

    assert score < 85
    assert signals["bloombergTeaserShell"] is True


def test_raw_quality_keeps_image_led_ft_data_story():
    images = b"".join(
        b"<figure><img src='https://www.ft.com/image.png'></figure>"
        for _ in range(3)
    )
    score, signals = score_raw_capture(
        (
            b"<html><head><script type='application/ld+json'>"
            b'{"@type":"NewsArticle","headline":"FT data story"}'
            b"</script></head><body><article>"
            b"<div class='article__content-body'>"
            + images
            + b"</div></article></body></html>"
            + (b" " * 90_000)
        ),
        http_status=200,
        content_type="text/html",
        final_url=(
            "https://web.archive.org/web/20181001000000id_/"
            "https://www.ft.com/content/image-led"
        ),
    )

    assert score >= 85
    assert signals["ftTruncatedArticleShell"] is False
    assert signals["ftBodyImages"] == 3


def test_raw_quality_rejects_javascript_redirect_shell():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>Archived interactive</title></head>
        <body><article><div class="interactive-graphic"><script>
        var destUrl = "https://www.nytimes.com/guides/privacy";
        window.location = fullUrl;
        </script></div></article></body></html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
    )

    assert score < 85
    assert signals["redirectShell"] is True


def test_raw_quality_rejects_legacy_nyt_advertisement_redirect():
    score, signals = score_raw_capture(
        b"""
        <html><head>
          <meta http-equiv="refresh"
                content="15;url=/article.html?adxnnl=1">
          <title>NY Times Advertisement</title>
        </head><body>Please wait while the article loads.</body></html>
        """,
        http_status=200,
        content_type="text/html",
        final_url=(
            "https://web.archive.org/web/20120117030929id_/"
            "http://www.nytimes.com/2010/05/06/fashion/06skin.html"
        ),
    )

    assert score < 60
    assert signals["redirectShell"] is True


def test_raw_quality_rejects_legacy_nyt_glogin_page():
    score, signals = score_raw_capture(
        (
            b"<html><head><title>Article - The New York Times</title>"
            b"</head><body><main>Member Center login is required.</main>"
            b"</body></html>"
            + (b" " * 2_048)
        ),
        http_status=200,
        content_type="text/html",
        final_url=(
            "https://web.archive.org/web/20100720073349id_/"
            "http://www.nytimes.com/glogin?URI=http://www.nytimes.com/"
            "2010/06/04/us/politics/04pentagon.html"
        ),
    )

    assert score < 60
    assert signals["authenticationShell"] is True


def test_stored_challenge_shell_is_requeued_by_current_policy(
    tmp_path: Path,
):
    canonical_url = "https://www.ft.com/content/example"
    snapshot_url = (
        "https://web.archive.org/web/20240101000000id_/" + canonical_url
    )
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_text(
        json.dumps(
            {
                "publisher": "ft",
                "canonicalUrl": canonical_url,
                "publishedAt": "2024-01-01T00:00:00Z",
                "candidates": [
                    {
                        "provider": "wayback",
                        "snapshotUrl": snapshot_url,
                    }
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="ft",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="ft",
    )
    shell = (
        b"<html><head><title>Client Challenge</title></head>"
        b"<body>JavaScript is disabled in your browser.</body></html>"
    )
    blob = store_raw_html(tmp_path, shell)
    capture = RawCapture(
        article_id="ft:" + ("a" * 64),
        publisher="ft",
        canonical_url=canonical_url,
        published_at=datetime(2024, 1, 1, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=snapshot_url,
        ),
        candidates_considered=[],
        retrieved_at=datetime.now(timezone.utc),
        final_url=snapshot_url,
        http_status=200,
        content_type="text/html",
        quality_score=85,
        raw_html=blob,
    )
    record_capture_result(
        connection,
        {
            "canonicalUrl": canonical_url,
            "status": "complete",
            "capture": capture,
            "recordPath": "records/example.json",
            "error": None,
        },
    )

    reason = completed_capture_rejection_reason(
        capture,
        archive_root=tmp_path,
    )
    reset_completed_capture_for_retry(
        connection,
        canonical_url=canonical_url,
        reason=str(reason),
    )
    row = connection.execute(
        "SELECT status, attempts, last_error FROM captures"
    ).fetchone()

    assert reason == "access-challenge-shell"
    assert row[0:2] == ("pending", 0)
    assert "access-challenge-shell" in row[2]


def test_stored_bloomberg_partner_paywall_preview_is_requeued(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.bloomberg.com/news/articles/2020-12-14/"
        "bank-m-a-deep-freeze-thaws-with-wave-of-billion-dollar-deals"
    )
    partner_url = (
        "https://www.afr.com/companies/financial-services/"
        "bank-m-and-a-deep-freeze-thaws-with-billion-dollar-deal-wave-"
        "20201215-p56nn6"
    )
    shell = b"""
    <!doctype html><html><head>
      <meta property="og:title"
            content="Bank M&A Deep Freeze Thaws With Wave of Billion-Dollar Deals">
      <meta property="article:published_time"
            content="2020-12-14T12:00:00Z">
    </head><body><article><div class="article-content">
      <p>Huntington Bancshares announced a multibillion-dollar regional bank
      deal, and industry executives said more mergers and acquisitions were
      likely after the market's pandemic freeze.</p>
      <p>Bloomberg reported that low interest rates, tight margins, executive
      succession and pressure to grow were driving the renewed deal wave.
      These two paragraphs are only the publicly visible preview.</p>
      <p>Subscribe to gift this article.</p>
      <p>Already a subscriber? Login</p>
    </div></article></body></html>
    """ + (b" " * 2_048)
    blob = store_raw_html(tmp_path, shell)
    capture = RawCapture(
        article_id="bloomberg:" + ("b" * 64),
        publisher="bloomberg",
        canonical_url=canonical_url,
        published_at=datetime(2020, 12, 14, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.OTHER,
            snapshot_url=partner_url,
        ),
        candidates_considered=[],
        retrieved_at=datetime.now(timezone.utc),
        final_url=partner_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    reason = completed_capture_rejection_reason(
        capture,
        archive_root=tmp_path,
    )

    assert reason == "bloomberg-syndication-paywall-shell"


def test_raw_quality_rejects_subscription_shell_without_article_body():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>Subscribe to read | Financial Times</title></head>
        <body><article><p>Discover all the plans currently available in your
        country</p></article></body></html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
    )

    assert score < 85
    assert signals["subscriptionShell"] is True


def test_raw_quality_rejects_zaobao_microtransaction_shell_with_body_marker():
    score, signals = score_raw_capture(
        """
        <html><head>
          <script type="application/ld+json">
            {"@type":"NewsArticle","articleBody":"Short preview"}
          </script>
        </head><body>
          <div class="article-content js-fontsized">
            <div class="article-content-rawhtml">
              <p>（作者是大学副教授）</p>
              <div class="article-microtransaction">
                <div class="cta-subscribe">
                  请<span id="js-cta-microtransaction">订阅或登录</span>，
                  以继续阅读全文！
                </div>
              </div>
            </div>
          </div>
        </body></html>
        """.encode("utf-8")
        + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
        final_url=(
            "http://web.archive.org/web/20200103082326id_/"
            "https://www.zaobao.com.sg/zopinions/views/"
            "story20200102-1017772"
        ),
    )

    assert score < 85
    assert signals["hasStrongBodyMarker"] is True
    assert signals["zaobaoMicrotransactionShell"] is True
    assert signals["subscriptionShell"] is True


def test_raw_quality_rejects_wsj_continue_reading_shell():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>A WSJ article</title></head>
        <body><article><p>A short preview sentence.</p>
        <div>Continue reading your article with a
        <strong>WSJ subscription</strong></div>
        <a>Already a subscriber?</a></article></body></html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
    )

    assert score < 85
    assert signals["subscriptionShell"] is True


def test_raw_quality_rejects_wsj_full_story_subscription_preview():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>A WSJ gallery</title></head>
        <body><article>
          <h1>A Duplex Penthouse in the Heart of Singapore</h1>
          <p>A single image caption survives in this archived preview.</p>
          <div>To Read the Full Story, Subscribe or Sign In</div>
        </article></body></html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
    )

    assert score < 85
    assert signals["subscriptionShell"] is True


def test_raw_quality_rejects_wsj_empty_article_jsonld_shell():
    score, signals = score_raw_capture(
        b"""
        <html><head><script type="application/ld+json">
        {
          "@type": "NewsArticle",
          "headline": "",
          "datePublished": "",
          "url": "https://www.wsj.com/articles/"
        }
        </script></head><body><article>
          <h2>Most Popular Articles</h2>
        </article></body></html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
    )

    assert score < 85
    assert signals["subscriptionShell"] is True
    assert signals["wsjEmptyArticleShell"] is True


def test_raw_quality_rejects_wsj_distil_captcha_redirect():
    score, signals = score_raw_capture(
        b"""
        <!doctype html><html><head>
        <meta name="robots" content="NOINDEX, NOFOLLOW">
        <meta http-equiv="refresh"
              content="10; url=/distil_r_captcha.html?Ref=/articles/example">
        </head><body>
          <div id="distil_ident_block">&nbsp;</div>
        </body></html>
        """,
        http_status=200,
        content_type="text/html",
    )

    assert score < 85
    assert signals["accessChallengeShell"] is True


def test_wsj_capture_parser_evidence_rejects_empty_legacy_article_shell():
    usable, signals = _wsj_capture_parser_evidence(
        b"""
        <html><head>
          <meta property="og:title" content="Archived WSJ report">
          <meta property="article:published_time"
                content="2014-12-11T21:03:00Z">
        </head><body>
          <div class="articleHeader"></div>
          <aside>Top Stories Subscriber Content Read Preview</aside>
        </body></html>
        """,
        canonical_url=(
            "https://www.wsj.com/articles/"
            "archived-wsj-report-1418347811"
        ),
    )

    assert usable is False
    assert signals["wsjCaptureExtractionStatus"] == "unsupported"


def test_wsj_capture_parser_evidence_uses_formal_validation_mode(
    monkeypatch: pytest.MonkeyPatch,
):
    calls: list[bool] = []

    def fake_parse_article(*args, **kwargs):
        calls.append(bool(kwargs.get("allow_generic_syndication")))
        return SimpleNamespace(
            content_type=ContentType.ARTICLE,
            quality=SimpleNamespace(
                status=ArticleStatus.COMPLETE,
                body_characters=1_000,
                images_selected=0,
            ),
        )

    monkeypatch.setattr(
        "jojo_news_archive.parsing.parser.parse_article",
        fake_parse_article,
    )

    usable, _ = _wsj_capture_parser_evidence(
        b"<html><body><article>complete</article></body></html>",
        canonical_url=(
            "https://www.wsj.com/articles/formal-validation-1590000000"
        ),
    )

    assert usable is True
    assert calls == [False]


def test_wsj_capture_parser_evidence_rejects_one_image_gallery_shell():
    usable, signals = _wsj_capture_parser_evidence(
        b"""
        <html><head>
          <meta property="og:title" content="A Charleston Home">
          <meta property="article:published_time"
                content="2018-01-17T00:00:00Z">
          <meta name="article.type" content="Infogrfx Slide Show">
          <meta name="page.content.type" content="slideshow">
          <meta property="og:image"
                content="https://si.wsj.net/public/resources/lead.jpg">
          <meta name="description" content="A photographic home tour.">
          <script type="application/ld+json">
            {"@type":"NewsArticle","image":[
              "https://si.wsj.net/public/resources/lead.jpg",
              "https://si.wsj.net/public/resources/alternate.jpg"
            ]}
          </script>
        </head><body><article>
          <p>Article Not Supported</p>
          <p>This article contains media that is not currently supported.</p>
        </article></body></html>
        """,
        canonical_url=(
            "https://www.wsj.com/articles/"
            "a-charleston-home-for-a-family-1516204648"
        ),
    )

    assert usable is False
    assert signals["wsjCaptureContentType"] == "gallery"
    assert signals["wsjCaptureImagesSelected"] < 3


def test_wsj_capture_rejects_long_description_slideshow_shell():
    description = (
        "This photographic home tour describes a large historic property, "
        "its gardens, architecture, interior design and asking price in "
        "enough detail to exceed the ordinary article body threshold."
    )
    usable, signals = _wsj_capture_parser_evidence(
        f"""
        <html><head>
          <meta property="og:title" content="A Hamptons Cottage">
          <meta property="article:published_time"
                content="2019-02-05T15:00:00Z">
          <meta property="og:image"
                content="https://si.wsj.net/public/resources/lead.jpg">
          <meta name="description" content="{description}">
        </head><body><article>
          <div class="wsj-article-headline-wrap slideshow-article">
            <h2 class="sub-head">{description}</h2>
          </div>
          <div class="wsj-snippet-body">
            <p>This article contains media that is not currently supported.</p>
          </div>
        </article></body></html>
        """.encode(),
        canonical_url=(
            "https://www.wsj.com/articles/"
            "a-hamptons-cottage-with-a-garden-11549378800"
        ),
    )

    assert usable is False
    assert signals["wsjCaptureContentType"] == "gallery"
    assert signals["wsjCaptureExtractionStatus"] == "partial"
    assert signals["wsjCaptureImagesSelected"] < 3


def test_axios_capture_parser_evidence_rejects_visual_redirect_stub(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        "jojo_news_archive.parsing.parser.parse_article",
        lambda *args, **kwargs: SimpleNamespace(
            content_type=ContentType.ARTICLE,
            quality=SimpleNamespace(
                status=ArticleStatus.PARTIAL,
                body_characters=96,
                images_selected=1,
            ),
            plain_text=(
                "See Axios Visuals' best data visualizations, illustrations, "
                "comics and collaborations from 2024."
            ),
        ),
    )

    usable, signals = _axios_capture_parser_evidence(
        b"<html><article>archived redirect</article></html>",
        canonical_url="https://www.axios.com/2025/01/02/2024-best-visuals-axios",
    )

    assert usable is False
    assert signals["axiosCaptureVisualRedirectStub"] is True


def test_axios_capture_parser_evidence_rejects_empty_article_shell(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        "jojo_news_archive.parsing.parser.parse_article",
        lambda *args, **kwargs: SimpleNamespace(
            content_type=ContentType.ARTICLE,
            quality=SimpleNamespace(
                status=ArticleStatus.PARTIAL,
                body_characters=0,
                images_selected=0,
            ),
            plain_text="",
        ),
    )

    usable, signals = _axios_capture_parser_evidence(
        b"<html><article>metadata-only shell</article></html>",
        canonical_url=(
            "https://www.axios.com/2017/12/16/"
            "trump-at-the-cia-1513388116"
        ),
    )

    assert usable is False
    assert signals["axiosCaptureVisualRedirectStub"] is False
    assert signals["axiosCaptureEmptyArticleShell"] is True


@pytest.mark.parametrize(
    ("status", "content_type", "body_characters", "images_selected"),
    [
        (ArticleStatus.COMPLETE, ContentType.ARTICLE, 96, 1),
        (ArticleStatus.PARTIAL, ContentType.INTERACTIVE, 96, 1),
        (ArticleStatus.PARTIAL, ContentType.ARTICLE, 96, 3),
    ],
)
def test_axios_capture_parser_evidence_keeps_non_stub_formats(
    monkeypatch: pytest.MonkeyPatch,
    status: ArticleStatus,
    content_type: ContentType,
    body_characters: int,
    images_selected: int,
):
    monkeypatch.setattr(
        "jojo_news_archive.parsing.parser.parse_article",
        lambda *args, **kwargs: SimpleNamespace(
            content_type=content_type,
            quality=SimpleNamespace(
                status=status,
                body_characters=body_characters,
                images_selected=images_selected,
            ),
            plain_text=(
                "See Axios Visuals' best data visualizations, illustrations, "
                "comics and collaborations from 2024."
            ),
        ),
    )

    usable, signals = _axios_capture_parser_evidence(
        b"<html><article>archived story</article></html>",
        canonical_url="https://www.axios.com/2025/01/02/example",
    )

    assert usable is True
    assert signals["axiosCaptureVisualRedirectStub"] is False


def test_stored_axios_visual_redirect_stub_is_requeued(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    canonical_url = "https://www.axios.com/2025/01/02/2024-best-visuals-axios"
    shell = b"<html><body><article>archived redirect</article></body></html>" + (
        b" " * 2_048
    )
    blob = store_raw_html(tmp_path, shell)
    capture = RawCapture(
        article_id="axios:" + ("a" * 64),
        publisher="axios",
        canonical_url=canonical_url,
        published_at=datetime(2025, 1, 2, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20250502000000id_/" + canonical_url
            ),
        ),
        candidates_considered=[],
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )
    monkeypatch.setattr(
        "jojo_news_archive.sources.axios.capture._axios_capture_parser_evidence",
        lambda *args, **kwargs: (
            False,
            {"axiosCaptureVisualRedirectStub": True},
        ),
    )

    reason = completed_capture_rejection_reason(
        capture,
        archive_root=tmp_path,
    )

    assert reason == "axios-capture-parser-incomplete"


def test_ap_capture_parser_evidence_rejects_unhydrated_score_table():
    usable, signals = _ap_capture_parser_evidence(
        b"""
        <html><head>
          <meta property="og:title"
                content="Single-A Florida State League Glance">
          <meta property="article:published_time"
                content="2023-08-25T05:18:29Z">
        </head><body>
          <div class="RichTextStoryBody">
            <p>All Times EDT</p><table><tr><th>East Division</th></tr></table>
          </div>
        </body></html>
        """,
        canonical_url=(
            "https://apnews.com/"
            "single-a-florida-state-league-glance-example"
        ),
    )

    assert usable is False
    assert signals["apCaptureExtractionStatus"] == "partial"


def test_ft_capture_parser_evidence_rejects_registration_shell():
    usable, signals = _ft_capture_parser_evidence(
        b"""
        <html><head>
          <meta property="og:title" content="Register to read this article">
          <meta property="article:published_time"
                content="2023-10-18T17:00:00Z">
        </head><body>
          <main><h1>Register to read this article</h1></main>
        </body></html>
        """,
        canonical_url=(
            "https://www.ft.com/content/"
            "68e8a9e3-c5f0-46be-a517-30d2f14d7df2"
        ),
    )

    assert usable is False
    assert signals["ftCaptureExtractionStatus"] == "unsupported"


def test_raw_quality_rejects_wsj_structured_snippet_view():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>A WSJ article</title>
        <script type="application/json">
        {"isSnippetView":true,"articleBodySchema":[{"@type":"ImageObject"}]}
        </script></head>
        <body><article data-testid="article-body">
        <p>The first two paragraphs are visible but the rest is omitted.</p>
        </article></body></html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
    )

    assert score < 85
    assert signals["hasStrongBodyMarker"] is True
    assert signals["subscriptionShell"] is True


def test_raw_quality_rejects_wsj_legacy_snippet_template():
    score, signals = score_raw_capture(
        b"""
        <html><head>
          <meta name="article.template" content="snippet">
          <meta property="og:title" content="A metered WSJ report">
        </head><body><article>
          <div class="wsj-snippet-body">
            <p>Only the opening paragraph of this report is visible.</p>
          </div>
          <div class="snippet-promotion">Subscribe to continue reading.</div>
        </article></body></html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
    )

    assert score < 85
    assert signals["subscriptionShell"] is True


def test_stored_wsj_subscription_shell_keeps_complete_article(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.wsj.com/articles/"
        "a-complete-archived-article-1482289646"
    )
    shell = b"""
    <!doctype html><html><head>
      <meta property="og:title"
            content="A Complete Archived Article">
      <script type="application/json">
        {"isSnippetView":true}
      </script>
    </head><body>
      <article data-testid="article-body">
        <p>The archived page contains the complete first paragraph with
        enough reporting detail to establish that this is article text.</p>
          <p>A second substantive paragraph continues the report and provides
          additional facts, context and quotations from the original story.</p>
          <p>A third paragraph records the chronology, response from named
          sources, supporting figures and the consequences of the development
          for readers.</p>
          <p>The final section supplies additional verified context so this
          complete article is clearly distinct from a short metered preview
          containing only its opening lines.</p>
      </article>
      <div>Continue reading your article with a WSJ subscription.</div>
      <div>Already a subscriber?</div>
    </body></html>
    """ + (b" " * 2_048)
    blob = store_raw_html(tmp_path, shell)
    capture = RawCapture(
        article_id="wsj:" + ("c" * 64),
        publisher="wsj",
        canonical_url=canonical_url,
        published_at=datetime(2016, 12, 21, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20161222000000id_/"
                + canonical_url
            ),
        ),
        candidates_considered=[],
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=40,
        raw_html=blob,
    )

    _, signals = score_raw_capture(
        shell,
        http_status=200,
        content_type="text/html",
        final_url=canonical_url,
    )
    reason = completed_capture_rejection_reason(
        capture,
        archive_root=tmp_path,
    )

    assert signals["subscriptionShell"] is True
    assert reason is None


def test_stored_wsj_subscription_shell_still_rejects_short_preview(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.wsj.com/articles/"
        "a-short-archived-preview-1482289646"
    )
    shell = b"""
    <html><head>
      <meta property="og:title" content="A Short Archived Preview">
      <script type="application/json">{"isSnippetView":true}</script>
    </head><body><article>
      <p>A short preview sentence.</p>
    </article></body></html>
    """ + (b" " * 2_048)
    blob = store_raw_html(tmp_path, shell)
    capture = RawCapture(
        article_id="wsj:" + ("d" * 64),
        publisher="wsj",
        canonical_url=canonical_url,
        published_at=datetime(2016, 12, 21, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20161222000000id_/"
                + canonical_url
            ),
        ),
        candidates_considered=[],
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=40,
        raw_html=blob,
    )

    reason = completed_capture_rejection_reason(
        capture,
        archive_root=tmp_path,
    )

    assert reason == "subscription-shell"


def test_stored_wsj_video_with_auth_marker_is_not_requeued(
    tmp_path: Path,
):
    canonical_url = "https://www.wsj.com/article/legacy-video-123"
    html = b"""
    <html><head>
      <title>Legacy WSJ Video</title>
      <meta name="description" content="WSJ reporters examine the
      recovery and its strategic options in this video report.">
    </head><body>
      <div class="account-navigation">Sign in to continue</div>
      <script>var AT_VARS={articleType:"Video - WSJ",
        publicationDate:"2011-12-15"};</script>
      <div id="masterVideoCenter"><div id="videoPlayer"></div></div>
    </body></html>
    """ + (b" " * 2_048)
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="wsj:" + ("v" * 64),
        publisher="wsj",
        canonical_url=canonical_url,
        published_at=datetime(2011, 12, 15, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20111215163504id_/"
                + canonical_url
            ),
        ),
        candidates_considered=[],
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=25,
        raw_html=blob,
    )

    _, signals = score_raw_capture(
        html,
        http_status=200,
        content_type="text/html",
        final_url=canonical_url,
    )
    reason = completed_capture_rejection_reason(
        capture,
        archive_root=tmp_path,
    )

    assert signals["authenticationShell"] is True
    assert reason is None


@pytest.mark.parametrize(
    ("publisher", "canonical_url", "expected_reason"),
    [
        (
            "ap",
            "https://apnews.com/article/incomplete-example",
            "ap-capture-parser-incomplete",
        ),
        (
            "reuters",
            "https://www.reuters.com/article/incomplete-idUSL1N123",
            "reuters-capture-parser-incomplete",
        ),
        (
            "ft",
            "https://www.ft.com/content/incomplete-example",
            "ft-capture-parser-incomplete",
        ),
        (
            "wsj",
            "https://www.wsj.com/articles/incomplete-example-123",
            "wsj-capture-parser-incomplete",
        ),
    ],
)
def test_stored_incomplete_capture_is_requeued_by_parser_evidence(
    tmp_path: Path,
    publisher: str,
    canonical_url: str,
    expected_reason: str,
):
    shell = b"""
    <html><head>
      <meta property="og:title" content="Archived report">
      <meta property="article:published_time"
            content="2020-01-01T00:00:00Z">
    </head><body><article><p>Only a truncated preview.</p></article></body>
    </html>
    """ + (b" " * 2_048)
    blob = store_raw_html(tmp_path, shell)
    capture = RawCapture(
        article_id=f"{publisher}:" + ("e" * 64),
        publisher=publisher,
        canonical_url=canonical_url,
        published_at=datetime(2020, 1, 1, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20200102000000id_/"
                + canonical_url
            ),
        ),
        candidates_considered=[],
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=85,
        raw_html=blob,
    )

    assert completed_capture_rejection_reason(
        capture,
        archive_root=tmp_path,
    ) == expected_reason


def test_raw_quality_rejects_bloomberg_login_to_keep_reading_shell():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>A Bloomberg article preview</title></head>
        <body><article><p>Several preview paragraphs are shown here.</p>
        <h2>Already a subscriber?</h2>
        <p>Log in to keep reading or access research tools and resources.</p>
        </article></body></html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
    )

    assert score < 85
    assert signals["subscriptionShell"] is True


def test_raw_quality_keeps_subscription_page_with_structured_article_body():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>Subscribe to read | Financial Times</title>
        <script type="application/ld+json">
        {"@type":"NewsArticle","articleBody":"Full archived article body."}
        </script></head><body></body></html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
    )

    assert score >= 85
    assert signals["subscriptionShell"] is False


def test_raw_quality_keeps_article_body_with_subscription_footer():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>Archived Financial Times article</title></head>
        <body><div class="article__content-body"><p>Full article text.</p></div>
        <footer>During your trial you will have complete digital access to
        FT.com.</footer></body></html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
    )

    assert score >= 85
    assert signals["subscriptionShell"] is False


def test_raw_quality_keeps_legacy_ft_amp_article_body():
    score, signals = score_raw_capture(
        b"""
        <html><head><title>Archived Financial Times article</title></head>
        <body><article>
          <div class="article-body" itemprop="articleBody">
            <p>France's highest court revived a corruption probe into the
            former president after rejecting his argument about taped phone
            conversations with his lawyer and a senior prosecutor.</p>
            <p>The ruling means the investigation will resume and may lead
            to a trial while the politician prepares to seek his party's
            nomination in the next presidential election.</p>
          </div>
        </article></body></html>
        """ + (b" " * 2_048),
        http_status=200,
        content_type="text/html",
        final_url=(
            "https://web.archive.org/web/20160624005500id_/"
            "https://amp.ft.com/content/"
            "12333d72-f038-11e5-9f20-c3a047354386"
        ),
    )

    assert score >= 85
    assert signals["ftBodyCharacters"] >= 250
    assert signals["ftTruncatedArticleShell"] is False


def test_wayback_candidate_records_actual_redirected_snapshot():
    requested = candidate(
        (
            "https://web.archive.org/web/20200115000000id_/"
            "https://example.com/article"
        ),
        "20200115000000",
    )
    resolved = resolved_capture_candidate(
        requested,
        final_url=(
            "https://web.archive.org/web/20200114235538id_/"
            "https://example.com/article"
        ),
        http_status=200,
        content_type="text/html",
        byte_count=1234,
    )

    assert resolved.snapshot_url.startswith(
        "https://web.archive.org/web/20200114235538id_/"
    )
    assert resolved.captured_at == datetime(
        2020,
        1,
        14,
        23,
        55,
        38,
        tzinfo=timezone.utc,
    )
    assert resolved.byte_count == 1234


def test_wsj_direct_infini_origin_is_validated_as_derived_html(
    tmp_path: Path,
):
    headline = "Global Markets Rally as Investors Reassess Economic Outlook"
    canonical_url = (
        "https://www.wsj.com/articles/"
        "global-markets-rally-as-investors-reassess-outlook-1483518944"
    )
    row_url = (
        "https://datasets-server.huggingface.co/rows?"
        "dataset=ruggsea%2Finfini-news-corpus&config=year_2017&"
        "split=train&offset=54321&length=1"
    )
    body = "\n".join(
        (
            "Wall Street Journal reporting paragraph "
            f"{index} contains market data, executive interviews, "
            "historical comparisons and detailed economic analysis."
        )
        for index in range(1, 18)
    )
    warc_filename = "CC-NEWS-20170104084927-00052.warc.gz"
    payload = json.dumps(
        {
            "rows": [
                {
                    "row_idx": 54321,
                    "row": {
                        "url": canonical_url,
                        "year": 2017,
                        "title": headline,
                        "publish_date": "2017-01-04",
                        "author": "WSJ Staff",
                        "description": "Detailed market report.",
                        "text": body,
                        "warc_filename": warc_filename,
                    },
                }
            ]
        }
    ).encode()
    item = ManifestItem(
        publisher="wsj",
        canonical_url=canonical_url,
        published_at="2017-01-04T00:00:00+00:00",
        section=None,
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.INFINI_NEWS,
                snapshot_url=row_url,
                source_url=canonical_url,
                expected_headline=headline,
                warc_filename=warc_filename,
            ),
        ),
    )
    client = StubArchiveClient(
        {
            row_url: (
                200,
                {"content-type": "application/json"},
                payload,
                row_url,
            )
        }
    )

    result = capture_item(
        item,
        archive_client=client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
        enable_common_crawl_fallback=False,
        enable_arquivo_pt_fallback=False,
    )

    assert result["status"] == "complete"
    capture = result["capture"]
    assert capture.selected_candidate.provider == CaptureProvider.INFINI_NEWS
    assert capture.representation == CaptureRepresentation.DERIVED_HTML
    assert capture.quality_score == 100
    assert capture.quality_signals["wsjInfiniOriginValidated"] is True
    assert capture.quality_signals["infiniOriginUrlValidated"] is True
    assert capture.quality_signals["infiniOriginBodyCharacters"] >= 1_000
    with gzip.open(tmp_path / capture.raw_html.path, "rb") as handle:
        derived = handle.read()
    article = parse_article(
        derived,
        publisher="wsj",
        canonical_url=canonical_url,
        raw_capture=capture,
    )
    assert article.quality.status.value == "complete"
    assert article.canonical_url == canonical_url
