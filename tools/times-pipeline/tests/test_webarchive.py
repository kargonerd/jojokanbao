from __future__ import annotations

import gzip
from io import BytesIO
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import zipfile

from warcio.archiveiterator import ArchiveIterator

from times_pipeline.feeds import Article, RawFeed, Source
from times_pipeline.webarchive import (
    ArticleCapture,
    HttpExchange,
    _limit_browser_response_rows,
    _rendered_page_exchange,
    capture_articles,
    select_articles_for_capture,
    write_web_archive,
)


NOW = datetime(2026, 8, 22, 12, 0, tzinfo=timezone.utc)
SOURCE = Source("example", "Example", "en", None, "https://example.test/feed", "summary-only")


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
    second_source = Source("second", "Second", "en", None, "https://second.test/feed", "summary-only")
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


def test_capture_selection_retries_http_200_when_full_text_was_not_captured() -> None:
    pending = article("pending", NOW - timedelta(hours=3))
    state = {"articles": {
        pending.id: {
            "fingerprint": _fingerprint(pending),
            "lastAttempt": (NOW - timedelta(hours=3)).isoformat(),
            "httpStatus": 200,
            "fullTextCaptured": False,
        },
    }}

    selected = select_articles_for_capture(
        [pending],
        state,
        now=NOW,
        retention_days=7,
        max_pages=1,
        refresh_hours=24,
        retry_hours=2,
    )

    assert [value.id for value in selected] == [pending.id]


def test_capture_selection_does_not_retry_recent_missing_full_text() -> None:
    pending = article("pending", NOW - timedelta(hours=1))
    state = {"articles": {
        pending.id: {
            "fingerprint": _fingerprint(pending),
            "lastAttempt": (NOW - timedelta(hours=1)).isoformat(),
            "httpStatus": 200,
            "fullTextCaptured": False,
        },
    }}

    selected = select_articles_for_capture(
        [pending],
        state,
        now=NOW,
        retention_days=7,
        max_pages=1,
        refresh_hours=24,
        retry_hours=2,
    )

    assert selected == []


def test_capture_selection_rechecks_hard_paywall_after_refresh_interval() -> None:
    pending = article("pending", NOW - timedelta(days=2))
    state = {"articles": {
        pending.id: {
            "fingerprint": _fingerprint(pending),
            "lastAttempt": (NOW - timedelta(days=2)).isoformat(),
            "httpStatus": 200,
            "fullTextCaptured": False,
            "failureReason": "hard-paywall",
        },
    }}

    selected = select_articles_for_capture(
        [pending],
        state,
        now=NOW,
        retention_days=7,
        max_pages=1,
        refresh_hours=24,
        retry_hours=2,
    )

    assert selected == [pending]


def test_capture_selection_does_not_recheck_recent_hard_paywall() -> None:
    pending = article("pending", NOW - timedelta(hours=1))
    state = {"articles": {
        pending.id: {
            "fingerprint": _fingerprint(pending),
            "lastAttempt": (NOW - timedelta(hours=1)).isoformat(),
            "httpStatus": 200,
            "fullTextCaptured": False,
            "failureReason": "hard-paywall",
        },
    }}

    selected = select_articles_for_capture(
        [pending],
        state,
        now=NOW,
        retention_days=7,
        max_pages=1,
        refresh_hours=24,
        retry_hours=2,
    )

    assert selected == []


def test_capture_selection_round_robins_sources_and_prioritizes_missing_full_text() -> None:
    second_source = Source("second", "Second", "en", None, "https://second.test/feed", "summary-only")
    first_full = article("first-full", NOW)
    first_full = Article(
        id=first_full.id,
        title=first_full.title,
        summary=first_full.summary,
        body="Full body",
        content_status="full",
        url=first_full.url,
        published_at=first_full.published_at,
        source=first_full.source,
    )
    first_pending = article("first-pending", NOW - timedelta(minutes=2))
    second_pending = Article(
        id="second-pending",
        title="Second pending",
        summary="Summary",
        body="Summary",
        content_status="summary",
        url="https://second.test/pending",
        published_at=(NOW - timedelta(minutes=1)).isoformat(),
        source=second_source,
    )
    second_pending_older = Article(
        id="second-pending-older",
        title="Second pending older",
        summary="Summary",
        body="Summary",
        content_status="summary",
        url="https://second.test/pending-older",
        published_at=(NOW - timedelta(minutes=3)).isoformat(),
        source=second_source,
    )

    selected = select_articles_for_capture(
        [first_full, first_pending, second_pending, second_pending_older],
        {"articles": {}},
        now=NOW,
        retention_days=7,
        max_pages=4,
        refresh_hours=24,
        retry_hours=2,
    )

    assert [value.id for value in selected] == [
        "second-pending",
        "first-pending",
        "second-pending-older",
        "first-full",
    ]


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


def test_rendered_page_exchange_is_last_page_candidate_and_is_bounded() -> None:
    value = article("rendered")
    rendered_body = b"<html><article>Rendered article body</article></html>"
    rendered = _rendered_page_exchange(
        value,
        captured_at=NOW.isoformat(),
        request_url=f"{value.url}?token=secret&view=full#fragment",
        user_agent="JOJO Chromium",
        status_code=403,
        body=rendered_body,
        maximum_response_bytes=32,
    )

    assert rendered is not None
    assert rendered.is_page is True
    assert rendered.status_code == 403
    assert rendered.reason_phrase == "Rendered DOM"
    assert rendered.request_url == f"{value.url}?view=full"
    assert rendered.request_headers == (("User-Agent", "JOJO Chromium"),)
    assert rendered.body == rendered_body[:32]
    assert rendered.truncated is True
    assert ("X-JOJO-Rendered-DOM", "true") in rendered.response_headers
    assert ("X-JOJO-Capture-Truncated", "true") in rendered.response_headers


def _fingerprint(value: Article) -> str:
    import hashlib

    return hashlib.sha256(f"{value.url}\0{value.title}\0{value.published_at}".encode()).hexdigest()
