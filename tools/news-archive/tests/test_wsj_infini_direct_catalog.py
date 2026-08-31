from __future__ import annotations

import gzip
import json
import sqlite3
from pathlib import Path

import pyarrow as pa

from jojo_news_archive.sources.wsj.discovery import infini_direct as catalog
from jojo_news_archive.sources.registry import archive_source_spec
from jojo_news_archive.discovery.wayback import (
    discovery_summary,
    export_capture_manifest,
    initialize_discovery_schema,
)
from jojo_news_archive.sources.wsj.discovery.infini import initialize_wsj_infini_schema


NEWS_ARCHIVE_ROOT = Path(__file__).resolve().parents[1]
BUILD_TOOL = NEWS_ARCHIVE_ROOT / "tools" / "build_wayback_manifest.py"


def test_scan_accepts_only_strict_wsj_origin_rows(monkeypatch):
    valid_url = (
        "http://www.wsj.com/articles/"
        "is-indias-war-on-cash-paying-off-1483518944"
    )
    table = pa.table(
        {
            "url": [
                valid_url,
                valid_url,
                "https://example.com/articles/not-wsj-1483518944",
                "https://www.wsj.com/articles/too-short-1483518944",
                "https://www.wsj.com/articles/wrong-year-1515054944",
                "https://www.wsj.com/video/not-an-article",
            ],
            "url_hostname": [
                "www.wsj.com",
                "online.wsj.com",
                "example.com",
                "www.wsj.com",
                "www.wsj.com",
                "www.wsj.com",
            ],
            "warc_filename": [
                "CC-NEWS-20170104084927-00052.warc.gz"
            ]
            * 6,
            "publish_date": [
                "2017-01-04",
                "2017-01-04",
                "2017-01-04",
                "2017-01-04",
                "2017-01-04",
                "2017-01-04",
            ],
            "title": [
                "Is India’s War on Cash Paying Off?",
                "Metadata hostname does not match source URL",
                "An unrelated source article headline",
                "A valid looking but short article",
                "A URL timestamp from another year",
                "A rejected WSJ video page title",
            ],
            "text_length": [1_449, 900, 900, 999, 1_900, 1_900],
            "language": ["eng_Latn"] * 6,
        }
    )

    class OpenFile:
        def open(self):
            return self

        def __enter__(self):
            return object()

        def __exit__(self, *_args):
            return None

    import fsspec
    import pyarrow.parquet as pq

    monkeypatch.setattr(fsspec, "open", lambda *_args, **_kwargs: OpenFile())
    monkeypatch.setattr(pq, "read_table", lambda *_args, **_kwargs: table)

    rows = catalog._scan_parquet_file(
        "data/year=2017/month=01/part-test.parquet",
        year=2017,
    )

    assert len(rows) == 1
    assert rows[0]["canonicalUrl"] == valid_url.replace("http://", "https://")
    assert rows[0]["publishedAt"] == "2017-01-04"
    assert rows[0]["textLength"] == 1_449


def test_direct_catalog_is_bounded_resumable_and_merges_urls(monkeypatch):
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=archive_source_spec("wsj"),
        from_year=2017,
        to_year=2017,
        collapse="urlkey",
    )
    initialize_wsj_infini_schema(
        connection,
        from_year=2017,
        to_year=2017,
    )
    files = [
        ("data/year=2017/month=01/part-a.parquet", 100),
        ("data/year=2017/month=01/part-b.parquet", 200),
    ]
    monkeypatch.setattr(
        catalog,
        "_list_year_parquet_files",
        lambda *_args, **_kwargs: files,
    )

    def scan(path: str, *, year: int):
        suffix = "a" if path.endswith("a.parquet") else "b"
        return [
            {
                "canonicalUrl": f"https://www.wsj.com/articles/test-{suffix}-1483518944",
                "sourceUrl": f"http://www.wsj.com/articles/test-{suffix}-1483518944",
                "publishedAt": "2017-01-04",
                "expectedHeadline": f"A complete WSJ test article {suffix}",
                "documentIndex": 3 if suffix == "a" else 103,
                "textLength": 500,
                "warcFilename": "CC-NEWS-20170104084927-00052.warc.gz",
                "parquetRowIndex": 3,
            }
        ]

    monkeypatch.setattr(catalog, "_scan_parquet_file", scan)

    first = catalog.process_wsj_infini_direct_catalog(
        connection,
        from_year=2017,
        to_year=2017,
        http_client=object(),
        maximum_files=1,
        workers=1,
        target_articles=2,
    )
    second = catalog.process_wsj_infini_direct_catalog(
        connection,
        from_year=2017,
        to_year=2017,
        http_client=object(),
        maximum_files=1,
        workers=1,
        target_articles=2,
    )

    assert first["listedFiles"] == 2
    assert first["attemptedFiles"] == 1
    assert first["articles"] == 1
    assert first["shouldContinue"] is True
    assert second["listedFiles"] == 0
    assert second["attemptedFiles"] == 1
    assert second["articles"] == 2
    assert second["shouldContinue"] is False
    assert connection.execute(
        "SELECT COUNT(*) FROM wsj_infini_articles"
    ).fetchone()[0] == 2
    summary = catalog.wsj_infini_direct_summary(connection)
    assert summary is not None
    assert summary["years"]["2017"]["status"] == "complete"
    assert summary["years"]["2017"]["articles"] == 2
    combined = discovery_summary(connection)
    assert combined["wsjInfiniDirect"] == summary
    assert combined["shouldContinue"] is True


def test_build_tool_processes_direct_and_query_catalogs_in_each_run():
    tool = BUILD_TOOL.read_text(encoding="utf-8")

    assert "maximum_files=max(1, args.max_pages or 5) * 10" in tool
    assert tool.count("workers=8") == 1
    assert "workers=4" in tool
    assert "maximum=max(1, args.max_pages or 5) * 100" in tool
    assert '"status": "deferred-for-direct-catalog"' not in tool


def test_completed_direct_catalog_backfills_dataset_rows_and_exports_candidates(
    monkeypatch,
    tmp_path: Path,
):
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=archive_source_spec("wsj"),
        from_year=2017,
        to_year=2017,
        collapse="urlkey",
    )
    initialize_wsj_infini_schema(
        connection,
        from_year=2017,
        to_year=2017,
    )
    catalog.initialize_wsj_infini_direct_schema(
        connection,
        from_year=2017,
        to_year=2017,
    )
    files = [
        ("data/year=2017/month=01/part-a.parquet", 10_000),
        ("data/year=2017/month=01/part-b.parquet", 20_000),
    ]
    catalog._store_file_catalog(connection, year=2017, files=files)
    first_url = "https://www.wsj.com/articles/first-story-1483518944"
    second_url = "https://www.wsj.com/articles/second-story-1483518945"
    catalog._store_scanned_articles(
        connection,
        year=2017,
        path=files[0][0],
        articles=[
            {
                "canonicalUrl": first_url,
                "sourceUrl": first_url,
                "publishedAt": "2017-01-04",
                "expectedHeadline": "A complete first WSJ test article",
                "textLength": 1_500,
                "warcFilename": "CC-NEWS-20170104084927-00052.warc.gz",
                "parquetRowIndex": 3,
            }
        ],
    )
    catalog._store_scanned_articles(
        connection,
        year=2017,
        path=files[1][0],
        articles=[
            {
                "canonicalUrl": second_url,
                "sourceUrl": second_url,
                "publishedAt": "2017-01-04",
                "expectedHeadline": "A complete second WSJ test article",
                "textLength": 600,
                "warcFilename": "CC-NEWS-20170104084927-00053.warc.gz",
                "parquetRowIndex": 4,
            }
        ],
    )
    connection.execute(
        "UPDATE wsj_infini_direct_years SET status='complete'"
    )
    monkeypatch.setattr(
        catalog,
        "_read_parquet_row_count",
        lambda _client, path, _size: 10 if path.endswith("a.parquet") else 20,
    )

    result = catalog.process_wsj_infini_direct_catalog(
        connection,
        from_year=2017,
        to_year=2017,
        http_client=object(),
    )

    assert result["metadata"] == {
        "year": 2017,
        "attemptedFiles": 2,
        "completedFiles": 2,
        "unresolvedFiles": 0,
        "indexedArticles": 2,
        "errors": [],
    }
    assert result["shouldContinue"] is False
    assert connection.execute(
        """
        SELECT canonical_url, document_index
        FROM wsj_infini_direct_articles
        ORDER BY canonical_url
        """
    ).fetchall() == [(first_url, 3), (second_url, 14)]

    destination = tmp_path / "manifest.jsonl.gz"
    export_capture_manifest(
        connection,
        spec=archive_source_spec("wsj"),
        destination=destination,
        from_year=2017,
        to_year=2017,
        capture_minimum_per_year=1,
    )
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        rows = {row["canonicalUrl"]: row for row in map(json.loads, handle)}
    direct = rows[first_url]["candidates"][0]
    assert direct["provider"] == "infini-news"
    assert "config=year_2017" in direct["snapshotUrl"]
    assert "offset=3" in direct["snapshotUrl"]
    assert direct["warcFilename"].endswith("00052.warc.gz")
    assert all(
        candidate["provider"] != "infini-news"
        for candidate in rows[second_url]["candidates"]
    )
    summary = catalog.wsj_infini_direct_summary(connection)
    assert summary is not None
    assert summary["years"]["2017"]["eligibleArticles"] == 1
    assert (
        summary["years"]["2017"]["eligibleArticlesWithDocumentIndex"]
        == 1
    )
