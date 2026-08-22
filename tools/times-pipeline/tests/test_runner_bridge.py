from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import times_pipeline.runner_bridge as bridge
from times_pipeline.feeds import Article, Source
from times_pipeline.webarchive import ArticleCapture, HttpExchange


class Parsed:
    def model_dump(self, **_kwargs):
        return {
            "formatVersion": "jojo-article/1",
            "articleId": "runner-id",
            "headline": "Parsed headline",
            "plainText": "A parsed article body that is longer than the feed summary.",
            "quality": {"status": "partial", "warnings": ["truncated-body"]},
        }


def test_enrich_articles_reuses_runner_parser_and_maps_partial_status(monkeypatch, tmp_path: Path) -> None:
    source = Source("bloomberg-markets", "Bloomberg", "en", None, "https://example.test/feed", "summary-only", "bloomberg")
    article = Article("article-one", "Feed headline", "Summary", "Summary", "summary", "https://bloomberg.com/story", NOW.isoformat(), source)
    final = HttpExchange(
        source.id, article.id, article.url, article.title, NOW.isoformat(), article.url,
        (), 200, "OK", (("Content-Type", "text/html"),), b"<html></html>",
    )
    capture = ArticleCapture(article.id, source.id, article.url, article.title, (final,), 4)
    calls = []

    def parse_article(body, **kwargs):
        calls.append((body, kwargs))
        return Parsed()

    monkeypatch.setattr(bridge, "_load_runner", lambda _root: parse_article)
    enriched, report = bridge.enrich_articles(
        [article], [capture], runner_root=tmp_path, require_runner=True, parsed_at=NOW,
    )

    assert calls[0][1]["publisher"] == "bloomberg"
    assert enriched[0].content_status == "partial"
    assert enriched[0].normalized["articleId"] == article.id
    assert report["partial"] == 1


def test_enrich_articles_classifies_unconfigured_parser_as_unsupported(monkeypatch, tmp_path: Path) -> None:
    source = Source("new-source", "New source", "en", None, "https://example.test/feed", "summary-only")
    article = Article("article-one", "Feed headline", "Summary", "Summary", "summary", "https://example.test/story", NOW.isoformat(), source)
    final = HttpExchange(
        source.id, article.id, article.url, article.title, NOW.isoformat(), article.url,
        (), 200, "OK", (("Content-Type", "text/html"),), b"<html></html>",
    )
    capture = ArticleCapture(article.id, source.id, article.url, article.title, (final,), 4)

    def unexpected_parser(*_args, **_kwargs):
        raise AssertionError("unsupported sources must not call the pinned parser")

    monkeypatch.setattr(bridge, "_load_runner", lambda _root: unexpected_parser)
    enriched, report = bridge.enrich_articles(
        [article], [capture], runner_root=tmp_path, require_runner=True, parsed_at=NOW,
    )

    assert enriched == [article]
    assert report["unsupported"] == 1
    assert report["error"] == 0


NOW = datetime(2026, 8, 22, 12, 0, tzinfo=timezone.utc)
