from __future__ import annotations

import gzip
import json
from pathlib import Path

import archive_v2


def test_articles_can_use_a_source_specific_capture_url(tmp_path: Path) -> None:
    manifest_object = "raw/news/reuters/run-1/manifest.json"
    manifest_path = tmp_path.joinpath(*manifest_object.split("/"))
    manifest_path.parent.mkdir(parents=True)
    manifest_path.write_text(json.dumps({
        "pagePolicy": {"capture": "browser", "captureUrl": "source", "bodySelectors": []},
    }), encoding="utf-8")
    candidate = {
        "articleId": "reuters:one",
        "sourceUrl": "https://www.reuters.com/world/example/",
        "canonicalUrl": "https://www.reuters.com/world/example",
        "title": "Example",
        "summary": None,
        "contentStatus": "metadata",
        "publishedAt": "2026-08-25T00:00:00Z",
    }
    manifest_path.with_name("candidates.jsonl.gz").write_bytes(gzip.compress(
        (json.dumps(candidate) + "\n").encode("utf-8"),
        mtime=0,
    ))
    run = {"sources": [{
        "sourceId": "reuters",
        "status": "ok",
        "output": {"manifest": manifest_object},
    }]}
    config = {"sources": [{
        "id": "reuters",
        "name": "Reuters",
        "language": "en",
        "discovery": {"kind": "sitemap", "url": "https://example.com/sitemap.xml"},
        "content": {"priority": ["browser-parser"]},
        "archive": {"mode": "browser"},
    }]}

    articles = archive_v2._articles(tmp_path, run, config)

    assert len(articles) == 1
    assert articles[0].url == candidate["sourceUrl"]


def test_canonical_extraction_prefers_bpc_rendered_dom_over_raw_preview() -> None:
    raw_preview = b"<html><article><p>Short publisher preview.</p></article></html>"
    rendered = (
        "<html><article>"
        + "".join(f"<p>Full rendered paragraph {index}. {'Article sentence. ' * 25}</p>" for index in range(4))
        + "</article></html>"
    ).encode()

    body = archive_v2._captured_article_body(rendered, raw_preview)

    assert body is not None
    assert body.count("<p>") == 4
    assert "Full rendered paragraph" in body
    assert "Short publisher preview" not in body
