from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path

import pytest

from tools.summarize_archive_manifest import summarize_archive_manifest


def _write_manifest(path: Path, rows: list[dict[str, object]]) -> None:
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


def test_summary_counts_only_explicit_publication_years(tmp_path: Path):
    manifest = tmp_path / "manifest.jsonl.gz"
    rows = [
        {
            "publisher": "caixin",
            "canonicalUrl": "https://example.test/2010/a",
            "publishedAt": "2010-01-08T00:00:00+00:00",
            "candidates": [{"provider": "wayback"}],
        },
        {
            "publisher": "caixin",
            "canonicalUrl": "https://example.test/2010/b",
            "publishedAt": "2010-06-01T00:00:00Z",
            "candidates": [
                {"provider": "wayback"},
                {"provider": "common-crawl"},
            ],
        },
        {
            "publisher": "caixin",
            "canonicalUrl": "https://example.test/missing",
            "candidates": [],
        },
        {
            "publisher": "caixin",
            "canonicalUrl": "https://example.test/invalid",
            "publishedAt": "not-a-date",
        },
    ]
    _write_manifest(manifest, rows)

    summary = summarize_archive_manifest(manifest, publisher="caixin")

    assert summary == {
        "formatVersion": "jojo-capture-manifest-summary/1",
        "publisher": "caixin",
        "manifestSha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
        "manifestBytes": manifest.stat().st_size,
        "articles": 4,
        "candidates": 3,
        "yearCounts": {"2010": 2},
        "missingPublicationDate": 1,
        "invalidPublicationDate": 1,
    }


def test_summary_rejects_cross_publisher_rows(tmp_path: Path):
    manifest = tmp_path / "manifest.jsonl.gz"
    _write_manifest(
        manifest,
        [
            {
                "publisher": "scmp",
                "canonicalUrl": "https://example.test/article/1",
                "publishedAt": "2012-01-01T00:00:00Z",
            }
        ],
    )

    with pytest.raises(ValueError, match="does not match"):
        summarize_archive_manifest(manifest, publisher="caixin")
