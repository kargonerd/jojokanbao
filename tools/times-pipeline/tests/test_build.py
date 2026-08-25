from __future__ import annotations

from datetime import datetime, timezone
from dataclasses import replace
import gzip
import json
from pathlib import Path
import shutil

from times_pipeline.build import CATALOG_OBJECT, DATASET_INDEX_OBJECT, LATEST_OBJECT, build_times_release
from times_pipeline.feeds import Article, RawFeed, Source
from times_pipeline.jox import read_jox_json


NOW = datetime(2026, 8, 22, 12, 0, tzinfo=timezone.utc)
SOURCE = Source("example", "Example", "en", "https://publisher.example.test/feed", "summary-only")


def article(identifier: str, hour: int, day: str = "2026-08-22") -> Article:
    return Article(
        id=identifier,
        title=f"Headline {identifier}",
        summary=f"Summary {identifier}",
        body=f"Summary {identifier}",
        content_status="summary",
        url=f"https://publisher.example.test/{identifier}",
        published_at=f"{day}T{hour:02d}:00:00+00:00",
        source=SOURCE,
    )


def build(output: Path, articles: list[Article], previous: Path | None = None) -> dict:
    return build_times_release(
        articles=articles,
        raw_feeds=[RawFeed("example", b"<rss />", NOW.isoformat(), "application/rss+xml")],
        source_statuses=[{"id": "example", "name": "Example", "status": "ok", "items": len(articles)}],
        output_directory=output,
        previous_directory=previous,
        now=NOW,
    )


def test_build_uses_newspaper_layout_and_emits_es_ready_documents(tmp_path: Path) -> None:
    output = tmp_path / "build"
    report = build(output, [article("article-one", 10), article("article-two", 11)])

    assert report["fetchedArticles"] == 2
    latest_path = output / "delivery" / "content" / "newspapers" / "times" / "latest.jox"
    latest = read_jox_json(latest_path, LATEST_OBJECT)
    assert [row["id"] for row in latest["articles"]] == ["article-two", "article-one"]

    index_path = output / "delivery" / "content" / "newspapers" / "times" / "index.jox"
    index = read_jox_json(index_path, DATASET_INDEX_OBJECT)
    assert index["type"] == "newspaper"
    assert index["items"][0]["manifestObject"] == "items/2026/08/2026-08-22/manifest.jox"

    manifest_key = "content/newspapers/times/items/2026/08/2026-08-22/manifest.jox"
    manifest_path = output / "delivery" / Path(*manifest_key.split("/"))
    manifest = read_jox_json(manifest_path, manifest_key)
    assert manifest["content"]["schema"] == "jojo-content/newspaper/1"
    assert len(manifest["content"]["articles"]) == 2
    assert all(descriptor["object"].startswith("articles/") for descriptor in manifest["content"]["articles"])

    canonical_path = output / "canonical" / "newspapers" / "times" / "items" / "2026" / "08" / "2026-08-22.json.gz"
    with gzip.open(canonical_path, "rt", encoding="utf-8") as stream:
        canonical = json.load(stream)
    assert canonical["content"]["schema"] == "jojo-content/newspaper/1"
    assert len(canonical["content"]["placements"]) == 2

    search_path = output / "search" / "times" / "runs" / report["runId"] / "documents.jsonl.gz"
    with gzip.open(search_path, "rt", encoding="utf-8") as stream:
        documents = [json.loads(line) for line in stream if line.strip()]
    assert {document["targetType"] for document in documents} == {"article"}
    assert {document["itemType"] for document in documents} == {"newspaper"}
    catalog = read_jox_json(output / "delivery" / "catalog.jox", CATALOG_OBJECT)
    assert catalog["datasets"] == [{
        "datasetId": "times",
        "type": "newspaper",
        "title": "今日时事",
        "language": "mul",
        "indexObject": DATASET_INDEX_OBJECT,
        "publicationStatus": "published",
        "access": "public",
    }]


def test_build_merges_previous_latest_and_dataset_index(tmp_path: Path) -> None:
    first = tmp_path / "first"
    build(first, [article("article-one", 10)])
    previous = tmp_path / "previous"
    previous.mkdir()
    shutil.copy2(first / "delivery" / Path(*LATEST_OBJECT.split("/")), previous / "latest.jox")
    shutil.copy2(first / "delivery" / Path(*DATASET_INDEX_OBJECT.split("/")), previous / "index.jox")
    shutil.copy2(first / "delivery" / "catalog.jox", previous / "catalog.jox")

    second = tmp_path / "second"
    build(second, [article("article-two", 11)], previous)
    latest = read_jox_json(second / "delivery" / Path(*LATEST_OBJECT.split("/")), LATEST_OBJECT)
    index = read_jox_json(second / "delivery" / Path(*DATASET_INDEX_OBJECT.split("/")), DATASET_INDEX_OBJECT)

    assert [row["id"] for row in latest["articles"]] == ["article-two", "article-one"]
    assert latest["revision"] == 2
    assert len(index["items"]) == 1
    assert index["revision"] == 2
    assert not (second / "delivery" / "catalog.jox").exists()


def test_build_does_not_emit_expired_or_unchanged_article_objects(tmp_path: Path) -> None:
    first = tmp_path / "first"
    build(first, [article("article-one", 10)])
    previous = tmp_path / "previous"
    previous.mkdir()
    shutil.copy2(first / "delivery" / Path(*LATEST_OBJECT.split("/")), previous / "latest.jox")
    shutil.copy2(first / "delivery" / Path(*DATASET_INDEX_OBJECT.split("/")), previous / "index.jox")
    shutil.copy2(first / "delivery" / "catalog.jox", previous / "catalog.jox")

    second = tmp_path / "second"
    report = build(second, [article("article-one", 10), article("expired", 10, "2026-08-01")], previous)

    articles_root = second / "delivery" / "content" / "newspapers" / "times" / "items"
    assert not articles_root.exists()
    assert report["fetchedArticles"] == 2
    assert report["latestArticles"] == 1
    assert report["changedIssues"] == []
    assert report["searchDocuments"] == 0


def test_build_does_not_downgrade_previous_full_text_when_feed_only_has_summary(tmp_path: Path) -> None:
    first = tmp_path / "first"
    full = replace(
        article("article-one", 10),
        body="This is the complete archived article body.",
        content_status="full",
    )
    build(first, [full])
    previous = tmp_path / "previous"
    previous.mkdir()
    shutil.copy2(first / "delivery" / Path(*LATEST_OBJECT.split("/")), previous / "latest.jox")
    shutil.copy2(first / "delivery" / Path(*DATASET_INDEX_OBJECT.split("/")), previous / "index.jox")
    shutil.copy2(first / "delivery" / "catalog.jox", previous / "catalog.jox")
    canonical_relative = Path("canonical/newspapers/times/items/2026/08/2026-08-22.json.gz")
    (previous / canonical_relative.parent).mkdir(parents=True)
    shutil.copy2(first / canonical_relative, previous / canonical_relative)

    second = tmp_path / "second"
    build(second, [article("article-one", 10), article("article-two", 11)], previous)
    latest = read_jox_json(second / "delivery" / Path(*LATEST_OBJECT.split("/")), LATEST_OBJECT)
    previous_row = next(row for row in latest["articles"] if row["id"] == "article-one")
    assert previous_row["contentStatus"] == "full"

    with gzip.open(second / canonical_relative, "rt", encoding="utf-8") as stream:
        canonical = json.load(stream)
    previous_article = next(row for row in canonical["content"]["articles"] if row["id"] == "article-one")
    assert previous_article["body"]["value"] == full.body
