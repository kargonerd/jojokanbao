from __future__ import annotations

import asyncio
import gzip
from dataclasses import replace
from io import BytesIO
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import zipfile

from warcio.archiveiterator import ArchiveIterator

from archive_v2 import _browser_article_body, _merge_capture_attempts, _select_proxy_candidates
from times_pipeline.feeds import Article, RawFeed, Source
from times_pipeline.webarchive import (
    ArticleCapture,
    HttpExchange,
    _limit_browser_response_rows,
    _page_body_with_dom_fallback,
    _wait_for_browser_extension_ready,
    capture_articles,
    select_articles_for_capture,
    write_web_archive,
)


NOW = datetime(2026, 8, 22, 12, 0, tzinfo=timezone.utc)
SOURCE = Source("example", "Example", "en", "https://example.test/feed", "summary-only")


class FakeExtensionWorker:
    def __init__(self, states: list[dict[str, int]]) -> None:
        self.states = states

    async def evaluate(self, _script: str) -> dict[str, int]:
        if len(self.states) > 1:
            return self.states.pop(0)
        return self.states[0]


class FakeExtensionContext:
    def __init__(self, worker: FakeExtensionWorker) -> None:
        self.service_workers = [worker]


def article(identifier: str, published_at: datetime = NOW) -> Article:
    return Article(
        id=identifier,
        title=f"Headline {identifier}",
        summary="Summary",
        body="Summary",
        content_status="summary",
        url=f"https://news.example.test/{identifier}",
        published_at=published_at.isoformat(),
        source=SOURCE,
    )


def exchange(value: Article) -> HttpExchange:
    return HttpExchange(
        source_id=value.source.id,
        article_id=value.id,
        canonical_url=value.url,
        title=value.title,
        captured_at=NOW.isoformat(),
        request_url=value.url,
        request_headers=(("User-Agent", "JOJO"), ("Cookie", "private-cookie")),
        status_code=200,
        reason_phrase="OK",
        response_headers=(("Content-Type", "text/html; charset=utf-8"), ("Content-Length", "999")),
        body=b"<html><article><p>Archived body.</p></article></html>",
    )


def test_proxy_retry_merge_keeps_failed_and_successful_page_attempts() -> None:
    value = article("proxy-retry")
    first = ArticleCapture(
        value.id,
        value.source.id,
        value.url,
        value.title,
        (replace(exchange(value), status_code=403, reason_phrase="Forbidden", is_page=True),),
        10,
        "HTTPStatus403",
        b"<html>failed rendered page</html>",
    )
    retry = ArticleCapture(
        value.id,
        value.source.id,
        value.url,
        value.title,
        (replace(exchange(value), is_page=True),),
        20,
        rendered_body=b"<html>successful rendered page</html>",
    )

    merged = _merge_capture_attempts(first, retry)

    assert [attempt.status_code for attempt in merged.exchanges] == [403, 200]
    assert merged.elapsed_ms == 30
    assert merged.error is None
    assert merged.final_exchange and merged.final_exchange.status_code == 200
    assert merged.rendered_body == b"<html>successful rendered page</html>"


def test_proxy_candidates_exclude_current_route_and_mix_fast_with_spread_nodes() -> None:
    candidates = _select_proxy_candidates(
        {"all": ["JOJO-TIMES-AUTO", "node-a", "node-b", "node-c", "node-d", "node-e", "node-f"], "now": "JOJO-TIMES-AUTO"},
        {"now": "node-a"},
        {"proxies": {
            "node-a": {"history": [{"delay": 10}]},
            "node-b": {"history": [{"delay": 20}]},
            "node-c": {"history": [{"delay": 30}]},
            "node-d": {"history": [{"delay": 40}]},
            "node-e": {"history": [{"delay": 200}]},
            "node-f": {"history": [{"delay": 300}]},
        }},
        "JOJO-TIMES-AUTO",
        4,
    )

    assert candidates[:3] == ["node-b", "node-c", "node-d"]
    assert candidates[3] == "node-e"
    assert "node-a" not in candidates


def test_wacz_contains_replayable_warc_cdxj_and_pages_without_secrets(tmp_path: Path) -> None:
    value = article("one")
    capture = ArticleCapture(value.id, value.source.id, value.url, value.title, (exchange(value),), 10)
    raw_feed = RawFeed(
        "example",
        b"<rss />",
        NOW.isoformat(),
        "application/rss+xml",
        url="https://rss.example.test/feed?limit=500",
        request_headers=(("Authorization", "secret-token"), ("Accept", "application/rss+xml")),
        response_headers=(("Content-Type", "application/rss+xml"),),
    )
    report = write_web_archive(
        tmp_path,
        raw_feeds=[raw_feed],
        captures=[capture],
        articles=[value],
        previous_state={"articles": {}},
        source_statuses=[{"id": "example", "status": "ok"}],
        generated_at=NOW,
        run_id="20260822T120000Z",
    )

    wacz_path = tmp_path / report["waczObject"].removeprefix("raw/")
    assert wacz_path.exists()
    with zipfile.ZipFile(wacz_path) as archive:
        assert set(archive.namelist()) == {
            "archive/data.warc.gz",
            "indexes/index.cdx.gz",
            "pages/pages.jsonl",
            "datapackage.json",
            "datapackage-digest.json",
        }
        warc = archive.read("archive/data.warc.gz")
        cdx_lines = gzip.decompress(archive.read("indexes/index.cdx.gz")).decode("utf-8").splitlines()
        pages = archive.read("pages/pages.jsonl").decode("utf-8").splitlines()
        datapackage = json.loads(archive.read("datapackage.json"))

    assert b"secret-token" not in warc
    assert b"private-cookie" not in warc
    record_types = []
    article_payload = None
    article_digests = None
    concurrent_to = None
    for record in ArchiveIterator(BytesIO(warc)):
        record_types.append(record.rec_type)
        if record.rec_type == "response" and record.rec_headers.get_header("WARC-Target-URI") == value.url:
            article_payload = record.content_stream().read()
            article_digests = (
                record.rec_headers.get_header("WARC-Payload-Digest"),
                record.rec_headers.get_header("WARC-Block-Digest"),
            )
        if record.rec_type == "request" and record.rec_headers.get_header("WARC-Target-URI") == value.url:
            concurrent_to = record.rec_headers.get_header("WARC-Concurrent-To")
    assert record_types == ["warcinfo", "response", "request", "response", "request"]
    assert article_payload == exchange(value).body
    assert all(digest and digest.startswith("sha1:") for digest in article_digests)
    assert concurrent_to and concurrent_to.startswith("<urn:uuid:")
    assert len(cdx_lines) == 2
    assert len(pages) == 2
    assert datapackage["profile"] == "wacz"
    assert "wacz_version" not in datapackage

    _key, _timestamp, cdx_json = cdx_lines[-1].split(" ", 2)
    row = json.loads(cdx_json)
    record_bytes = warc[int(row["offset"]):int(row["offset"]) + int(row["length"])]
    indexed = next(ArchiveIterator(BytesIO(record_bytes)))
    assert indexed.rec_type == "response"
    assert indexed.rec_headers.get_header("WARC-Target-URI") == row["url"]


def test_capture_selection_prioritizes_new_and_changed_then_refreshes() -> None:
    new = article("new")
    changed = article("changed")
    refresh = article("refresh")
    recent = article("recent")
    expired = article("expired", NOW - timedelta(days=8))
    state = {"articles": {
        "changed": {"fingerprint": "different", "lastAttempt": NOW.isoformat(), "httpStatus": 200},
        "refresh": {"fingerprint": _fingerprint(refresh), "lastAttempt": (NOW - timedelta(hours=25)).isoformat(), "httpStatus": 200},
        "recent": {"fingerprint": _fingerprint(recent), "lastAttempt": (NOW - timedelta(hours=1)).isoformat(), "httpStatus": 200},
    }}

    selected = select_articles_for_capture(
        [recent, refresh, changed, new, expired],
        state,
        now=NOW,
        retention_days=7,
        max_pages=3,
        refresh_hours=24,
        retry_hours=2,
    )

    assert [value.id for value in selected] == ["new", "changed", "refresh"]


def test_capture_selection_represents_each_source_before_filling_remaining_slots() -> None:
    second_source = Source("second", "Second", "en", "https://second.test/feed", "summary-only")
    newest = article("newest", NOW)
    older = article("older", NOW - timedelta(minutes=1))
    other = Article(
        id="other",
        title="Other source",
        summary="Summary",
        body="Summary",
        content_status="summary",
        url="https://second.test/other",
        published_at=(NOW - timedelta(minutes=2)).isoformat(),
        source=second_source,
    )

    selected = select_articles_for_capture(
        [newest, older, other],
        {"articles": {}},
        now=NOW,
        retention_days=7,
        max_pages=2,
        refresh_hours=24,
        retry_hours=2,
    )

    assert [value.id for value in selected] == ["newest", "other"]


def test_capture_selection_allows_feed_only_validation() -> None:
    assert select_articles_for_capture(
        [article("new")],
        {"articles": {}},
        now=NOW,
        retention_days=7,
        max_pages=0,
        refresh_hours=24,
        retry_hours=2,
    ) == []


def test_browser_response_limit_preserves_page_and_bounds_subresources() -> None:
    rows = [(f"response-{index}", f"https://example.test/{index}", index == 150) for index in range(200)]

    selected = _limit_browser_response_rows(rows, maximum=16)

    assert len(selected) == 16
    assert selected[:15] == rows[:15]
    assert selected[-1] == rows[150]


def test_browser_dom_is_only_a_fallback_for_an_empty_final_page() -> None:
    raw = b"<html>raw response</html>"
    rendered = b"<html>rendered DOM</html>"

    assert _page_body_with_dom_fallback(raw, rendered, is_final_page=True) == (raw, False)
    assert _page_body_with_dom_fallback(b"", rendered, is_final_page=False) == (b"", False)
    assert _page_body_with_dom_fallback(b"", rendered, is_final_page=True) == (rendered, True)


def test_browser_body_groups_source_selected_direct_text_blocks() -> None:
    blocks = "".join(
        f'<div data-testid="paragraph-{index}">Section {index}. {"Article sentence. " * 18}</div>'
        for index in range(3)
    )

    body = _browser_article_body(
        f"<html><body>{blocks}</body></html>".encode(),
        ("[data-testid^='paragraph-']",),
    )

    assert body is not None
    assert body.count("<p>") == 3


def test_browser_body_combines_reuters_paragraphs_and_article_list_blocks() -> None:
    intro = '<div data-testid="paragraph-0">' + "Reuters introduction. " * 20 + "</div>"
    details = "".join(
        '<div data-testid="unordered-0"><div data-testid="Body">'
        + f"Article detail {index}. " * 15
        + "</div></div>"
        for index in range(4)
    )
    unrelated = '<div data-testid="Body">Company widget that must not be included.</div>'
    selector = (
        "[data-testid^='paragraph-'], "
        "[data-testid^='unordered-'] [data-testid='Body'], "
        "[data-testid='SignOff'] [data-testid='Body']"
    )

    body = _browser_article_body(
        f"<html><body>{intro}{details}{unrelated}</body></html>".encode(),
        (selector,),
    )

    assert body is not None
    assert body.count("<p>") == 5
    assert "Company widget" not in body


def test_browser_extension_waits_for_default_sites_and_session_rules() -> None:
    worker = FakeExtensionWorker([
        {"siteCount": 0, "sessionRuleCount": 0},
        {"siteCount": 287, "sessionRuleCount": 412},
    ])

    state = asyncio.run(_wait_for_browser_extension_ready(
        FakeExtensionContext(worker),
        timeout_seconds=1.0,
    ))

    assert state == {"siteCount": 287, "sessionRuleCount": 412}


def _fingerprint(value: Article) -> str:
    import hashlib

    return hashlib.sha256(f"{value.url}\0{value.title}\0{value.published_at}".encode()).hexdigest()
