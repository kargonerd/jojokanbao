from __future__ import annotations

from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path

import pytest

from jojo_news_archive.models import (
    BlobReference,
    CaptureCandidate,
    CaptureProvider,
    RawCapture,
)
from tools.export_canonical_batch import export_batch, write_jsonl


RAW_RUN_MANIFEST = "raw/archive/runs/2026/08/30/test-run/manifest.json"


def _html(*, headline: str = "A complete archive story", repeats: int = 6) -> bytes:
    prose = (
        "The report explains the latest development, identifies the people "
        "involved, and places the decision in its wider public context. " * repeats
    )
    return f"""
    <html><head><script type="application/ld+json">{{
      "@type":"NewsArticle", "headline":"{headline}",
      "datePublished":"2020-01-02T12:00:00Z", "author":{{"name":"Reporter"}}
    }}</script></head><body><article id="storytext">
      <p>{prose}</p><p>{prose} Additional detail.</p>
      <p>{prose} Final context.</p>
    </article></body></html>
    """.encode()


def _record(
    root: Path,
    *,
    publisher: str = "npr",
    canonical_url: str = "https://www.npr.org/2020/01/02/123/archive-story",
    quality_score: int = 100,
    suffix: str = "one",
    html: bytes | None = None,
) -> str:
    html = html if html is not None else _html()
    digest = hashlib.sha256(html).hexdigest()
    compressed = gzip.compress(html, mtime=0)
    raw_root = f"raw/archive/v1/{publisher}/2020-2020/wayback/raw"
    blob_path = f"objects/html/{digest[:2]}/{digest}.html.gz"
    blob = root.joinpath(*f"{raw_root}/{blob_path}".split("/"))
    blob.parent.mkdir(parents=True, exist_ok=True)
    blob.write_bytes(compressed)
    capture = RawCapture(
        article_id=f"{publisher}:{suffix}",
        publisher=publisher,
        canonical_url=canonical_url,
        published_at=datetime(2020, 1, 2, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=f"https://web.archive.org/web/20200103id_/{canonical_url}",
        ),
        retrieved_at=datetime(2026, 8, 30, tzinfo=timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=quality_score,
        raw_html=BlobReference(
            path=blob_path,
            sha256=digest,
            byte_count=len(html),
            stored_byte_count=len(compressed),
            content_encoding="gzip",
        ),
    )
    record_object = f"{raw_root}/records/aa/{suffix}.json"
    record = root.joinpath(*record_object.split("/"))
    record.parent.mkdir(parents=True, exist_ok=True)
    record.write_text(
        capture.model_dump_json(by_alias=True, exclude_none=True),
        encoding="utf-8",
    )
    return record_object


def _export(root: Path, records: list[str]):
    return export_batch(
        root=root,
        record_objects=records,
        raw_revision="a" * 40,
        raw_run_id="archive-test-run",
        raw_run_manifest=RAW_RUN_MANIFEST,
    )


def test_replays_complete_capture_with_exact_raw_provenance(tmp_path: Path):
    record = _record(tmp_path)
    rows = _export(tmp_path, [record])
    assert len(rows) == 1
    row = rows[0]
    assert row["formatVersion"] == "jojo-news-canonical-input/1"
    assert row["sourceId"] == "npr"
    assert row["recordObject"] == record
    assert row["rawHtmlObject"].startswith("raw/archive/v1/npr/")
    assert row["rawRevision"] == "a" * 40
    assert row["rawRunManifest"] == RAW_RUN_MANIFEST
    assert row["parserResult"]["formatVersion"] == "jojo-article/1"
    assert row["parserResult"]["quality"]["status"] == "complete"
    assert row["validation"]["qaPass"] is True
    assert row["validation"]["parserVersion"] == "npr-parser/0.1.59"


def test_excludes_incomplete_capture(tmp_path: Path):
    record = _record(tmp_path, html=b"<html><title>Only metadata</title></html>")
    statistics: dict[str, object] = {}
    assert export_batch(
        root=tmp_path,
        record_objects=[record],
        raw_revision="a" * 40,
        raw_run_id="archive-test-run",
        raw_run_manifest=RAW_RUN_MANIFEST,
        statistics=statistics,
    ) == []
    assert statistics == {
        "inputRecords": 1,
        "acceptedCandidates": 0,
        "duplicateCandidates": 0,
        "rejectedRecords": 1,
        "rejectionReasons": {
            "empty-body": 1,
            "extraction-unsupported": 1,
            "missing-headline": 1,
        },
        "rejectedExamples": [{
            "recordObject": record,
            "issues": ["empty-body", "extraction-unsupported", "missing-headline"],
        }],
        "articles": 0,
    }


def test_selects_best_capture_deterministically(tmp_path: Path):
    weak = _record(tmp_path, suffix="weak", quality_score=50, html=_html(repeats=4))
    strong = _record(tmp_path, suffix="strong", quality_score=100, html=_html(repeats=8))
    rows = _export(tmp_path, [weak, strong, weak])
    assert len(rows) == 1
    assert rows[0]["recordObject"] == strong


@pytest.mark.parametrize(
    ("url", "source_id"),
    [
        ("https://www.nikkei.com/article/DGXZTEST/", "nikkei-japan"),
        ("https://asia.nikkei.com/Business/Test", "nikkei"),
    ],
)
def test_splits_japanese_and_english_nikkei(tmp_path: Path, url: str, source_id: str):
    record = _record(
        tmp_path,
        publisher="nikkei",
        canonical_url=url,
        html=_html(headline="Nikkei archive report"),
    )
    rows = _export(tmp_path, [record])
    assert rows[0]["sourceId"] == source_id


def test_rejects_unsafe_record_and_raw_hash_mismatch(tmp_path: Path):
    with pytest.raises(ValueError, match="unsafe record object"):
        _export(tmp_path, ["raw/archive/v1/npr/../../secret.json"])

    record = _record(tmp_path)
    record_payload = json.loads(
        tmp_path.joinpath(*record.split("/")).read_text(encoding="utf-8")
    )
    record_payload["rawHtml"]["sha256"] = "0" * 64
    tmp_path.joinpath(*record.split("/")).write_text(
        json.dumps(record_payload), encoding="utf-8"
    )
    with pytest.raises(ValueError, match="Raw SHA-256 mismatch"):
        _export(tmp_path, [record])


def test_jsonl_output_is_deterministic_and_gzip_reproducible(tmp_path: Path):
    rows = _export(tmp_path, [_record(tmp_path)])
    first = tmp_path / "first.jsonl.gz"
    second = tmp_path / "second.jsonl.gz"
    write_jsonl(first, rows)
    write_jsonl(second, rows)
    assert first.read_bytes() == second.read_bytes()
    decoded = gzip.decompress(first.read_bytes()).decode("utf-8")
    assert json.loads(decoded)["formatVersion"] == "jojo-news-canonical-input/1"
