from __future__ import annotations

from datetime import datetime, timezone
import io
import json
from pathlib import Path
import sqlite3

import pyarrow as pa
import pyarrow.parquet as pq

from jojo_olds_api import ft_infini_direct_catalog as catalog
from jojo_olds_api.news_models import CaptureCandidate, CaptureProvider
from jojo_olds_api.raw_archive_capture import (
    initialize_capture_schema,
    load_capture_manifest,
)


def _state(tmp_path: Path) -> tuple[sqlite3.Connection, str]:
    canonical_url = (
        "https://www.ft.com/content/"
        "a604bc55-26a5-42ca-a707-e6537abe0c1d"
    )
    candidate = CaptureCandidate(
        provider=CaptureProvider.WAYBACK,
        snapshot_url=(
            "https://web.archive.org/web/20240329000000id_/"
            + canonical_url
        ),
        captured_at=datetime(2024, 3, 29, tzinfo=timezone.utc),
    )
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_text(
        json.dumps(
            {
                "publisher": "ft",
                "canonicalUrl": canonical_url,
                "publishedAt": "2024-03-28T00:00:00Z",
                "candidates": [
                    candidate.model_dump(
                        mode="json",
                        by_alias=True,
                        exclude_none=True,
                    )
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
    catalog.initialize_ft_infini_direct_schema(connection)
    return connection, canonical_url


def test_parquet_footer_row_count_uses_bounded_ranges():
    output = io.BytesIO()
    pq.write_table(pa.table({"value": [1, 2, 3]}), output)
    parquet_bytes = output.getvalue()

    class Response:
        def __init__(self, content: bytes):
            self.content = content

        def raise_for_status(self) -> None:
            return None

    class Client:
        def __init__(self):
            self.ranges: list[str] = []

        def get(self, _url: str, *, headers: dict[str, str]):
            requested = headers["Range"]
            self.ranges.append(requested)
            start, end = (
                int(value)
                for value in requested.removeprefix("bytes=").split("-")
            )
            return Response(parquet_bytes[start : end + 1])

    client = Client()
    count = catalog._read_parquet_row_count(
        client,
        "data/year=2024/month=03/part-test.parquet",
        len(parquet_bytes),
    )

    assert count == 3
    assert len(client.ranges) == 1
    assert client.ranges[0].endswith(
        f"-{len(parquet_bytes) - 1}"
    )


def test_public_dataset_requests_back_off_after_rate_limit(monkeypatch):
    class Response:
        def __init__(self, status_code: int, retry_after: str | None = None):
            self.status_code = status_code
            self.headers = (
                {"Retry-After": retry_after}
                if retry_after is not None
                else {}
            )

        def raise_for_status(self) -> None:
            if self.status_code >= 400:
                raise AssertionError(f"unexpected HTTP {self.status_code}")

    class Client:
        def __init__(self):
            self.responses = [Response(429, "0"), Response(200)]
            self.calls = 0

        def get(self, _url: str, **_kwargs):
            response = self.responses[self.calls]
            self.calls += 1
            return response

    sleeps: list[float] = []
    monkeypatch.setattr(catalog.time, "sleep", sleeps.append)
    client = Client()

    response = catalog._get_with_retries(
        client,
        "https://huggingface.co/test",
        attempts=3,
    )

    assert response.status_code == 200
    assert client.calls == 2
    assert sleeps == [0.5]


def test_year_catalog_skips_months_absent_from_partial_years():
    class Response:
        status_code = 404
        links: dict[str, object] = {}

        def raise_for_status(self) -> None:
            raise AssertionError("expected 404 month to be skipped")

    class Client:
        def __init__(self):
            self.requests = 0

        def get(self, *_args, **_kwargs):
            self.requests += 1
            return Response()

    client = Client()
    files = catalog._list_year_parquet_files(client, year=2016)

    assert files == []
    assert client.requests == 12


def test_scan_accepts_only_provenance_safe_ft_rows(monkeypatch):
    canonical_url = (
        "https://www.ft.com/content/"
        "a604bc55-26a5-42ca-a707-e6537abe0c1d"
    )
    table = pa.table(
        {
            "url": [
                canonical_url,
                "https://www.nickiswift.com/not-ft",
                "https://amp.ft.com/content/not-in-manifest",
                canonical_url + "?utm_source=test",
            ],
            "url_hostname": [
                "www.ft.com",
                "www.nickiswift.com",
                "amp.ft.com",
                "www.ft.com",
            ],
            "warc_filename": [
                "CC-NEWS-20240328120000-00001.warc.gz",
                "CC-NEWS-20240328120000-00002.warc.gz",
                "CC-NEWS-20240328120000-00003.warc.gz",
                "invalid.warc.gz",
            ],
            "publish_date": [
                "2024-03-28",
                "2024-03-28",
                "2024-03-28",
                "2024-03-28",
            ],
            "title": [
                "A complete Financial Times test article",
                "An unrelated entertainment article",
                "An FT article absent from the manifest",
                "A row with invalid WARC provenance",
            ],
            "text_length": [5000, 5000, 5000, 5000],
            "language": ["eng_Latn", "eng_Latn", "eng_Latn", "eng_Latn"],
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

    monkeypatch.setattr(fsspec, "open", lambda *_args, **_kwargs: OpenFile())
    monkeypatch.setattr(catalog.pq, "read_table", lambda *_args, **_kwargs: table)

    articles = catalog._scan_parquet_file(
        "data/year=2024/month=03/part-test.parquet",
        global_offset=10_000,
        year=2024,
        capture_urls={canonical_url},
    )

    assert len(articles) == 1
    assert articles[0]["canonicalUrl"] == canonical_url
    assert articles[0]["documentIndex"] == 10_000
    assert articles[0]["warcFilename"].startswith("CC-NEWS-")


def test_scan_skips_generic_ft_subscription_titles(monkeypatch):
    canonical_url = (
        "https://www.ft.com/content/"
        "a604bc55-26a5-42ca-a707-e6537abe0c1d"
    )
    table = pa.table(
        {
            "url": [canonical_url],
            "url_hostname": ["www.ft.com"],
            "warc_filename": ["CC-NEWS-20161228120000-00001.warc.gz"],
            "publish_date": ["2016-12-28"],
            "title": ["Subscribe to FT.com"],
            "text_length": [1200],
            "language": ["eng_Latn"],
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

    monkeypatch.setattr(fsspec, "open", lambda *_args, **_kwargs: OpenFile())
    monkeypatch.setattr(catalog.pq, "read_table", lambda *_args, **_kwargs: table)

    articles = catalog._scan_parquet_file(
        "data/year=2016/month=12/part-test.parquet",
        global_offset=10_000,
        year=2016,
        capture_urls={canonical_url},
    )

    assert articles == []


def test_scan_can_discover_new_ft_urls_without_manifest_filter(monkeypatch):
    canonical_url = (
        "https://www.ft.com/content/"
        "b604bc55-26a5-42ca-a707-e6537abe0c1d"
    )
    table = pa.table(
        {
            "url": [canonical_url],
            "url_hostname": ["www.ft.com"],
            "warc_filename": ["CC-NEWS-20160828120000-00001.warc.gz"],
            "publish_date": ["2016-08-28"],
            "title": ["A newly discovered Financial Times article"],
            "text_length": [5000],
            "language": ["eng_Latn"],
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

    monkeypatch.setattr(fsspec, "open", lambda *_args, **_kwargs: OpenFile())
    monkeypatch.setattr(catalog.pq, "read_table", lambda *_args, **_kwargs: table)

    articles = catalog._scan_parquet_file(
        "data/year=2016/month=08/part-test.parquet",
        global_offset=10_000,
        year=2016,
    )

    assert len(articles) == 1
    assert articles[0]["canonicalUrl"] == canonical_url


def test_merge_materializes_direct_article_absent_from_manifest(tmp_path: Path):
    connection, _canonical_url = _state(tmp_path)
    canonical_url = (
        "https://www.ft.com/content/"
        "b604bc55-26a5-42ca-a707-e6537abe0c1d"
    )
    catalog._store_scanned_articles(
        connection,
        year=2016,
        path="data/year=2016/month=08/part-test.parquet",
        articles=[
            {
                "canonicalUrl": canonical_url,
                "sourceUrl": canonical_url,
                "publishedAt": "2016-08-28",
                "expectedHeadline": "A newly discovered Financial Times article",
                "documentIndex": 12345,
                "textLength": 5000,
                "warcFilename": "CC-NEWS-20160828120000-00001.warc.gz",
                "parquetRowIndex": 3,
                "samplePriority": "0" * 64,
            }
        ],
    )

    assert catalog.merge_ft_infini_direct_candidates(
        connection,
        year=2016,
    ) == 1

    row = connection.execute(
        """
        SELECT publisher, published_at, status, candidates_json
        FROM captures
        WHERE canonical_url=?
        """,
        (canonical_url,),
    ).fetchone()
    assert row is not None
    publisher, published_at, status, candidates_json = row
    assert publisher == "ft"
    assert published_at == "2016-08-28T00:00:00+00:00"
    assert status == "pending"
    candidates = json.loads(candidates_json)
    assert candidates[0]["provider"] == "infini-news"
    assert candidates[0]["sourceUrl"] == canonical_url


def test_ft_subscription_headline_filter_covers_paywall_variants():
    assert catalog.is_ft_subscription_headline("Subscribe to FT.com")
    assert catalog.is_ft_subscription_headline(
        "Become an FT subscriber to read: Big Centamin investors"
    )
    assert catalog.is_ft_subscription_headline(
        "Subscribe to read: Catch up on our 5 best weekend reads"
    )
    assert catalog.is_ft_subscription_headline(
        "Purchase a Digital Trial subscription for"
    )
    assert catalog.is_ft_subscription_headline(
        "All the benefits of Premium Digital, plus:"
    )
    assert catalog.is_ft_subscription_headline(
        "All the benefits of Standard Digital, plus:"
    )
    assert catalog.is_ft_subscription_headline(
        "You must be a Premium Subscriber to read: Financial Times"
    )
    assert catalog.is_ft_subscription_headline("Register to read: Financial Times")
    assert not catalog.is_ft_subscription_headline(
        "FT subscribers weigh in on the budget"
    )


def test_offsets_candidates_and_retry_state_are_persisted(tmp_path: Path):
    connection, canonical_url = _state(tmp_path)
    files = [
        ("data/year=2024/month=01/part-b.parquet", 200),
        ("data/year=2024/month=01/part-a.parquet", 100),
    ]
    catalog._store_file_catalog(connection, year=2024, files=files)
    connection.executemany(
        """
        UPDATE ft_infini_parquet_files
        SET row_count=?
        WHERE source_year=2024 AND file_path=?
        """,
        [
            (11, files[0][0]),
            (7, files[1][0]),
        ],
    )
    catalog._assign_global_offsets(connection, year=2024)
    offsets = connection.execute(
        """
        SELECT file_path, global_offset
        FROM ft_infini_parquet_files
        ORDER BY file_path
        """
    ).fetchall()
    assert offsets == [
        (files[1][0], 0),
        (files[0][0], 7),
    ]

    catalog._store_scanned_articles(
        connection,
        year=2024,
        path=files[0][0],
        articles=[
            {
                "canonicalUrl": canonical_url,
                "sourceUrl": canonical_url,
                "publishedAt": "2024-03-28",
                "expectedHeadline": (
                    "A complete Financial Times test article"
                ),
                "documentIndex": 12345,
                "textLength": 5000,
                "warcFilename": (
                    "CC-NEWS-20240328120000-00001.warc.gz"
                ),
                "parquetRowIndex": 3,
                "samplePriority": "0" * 64,
            }
        ],
    )
    connection.execute(
        """
        UPDATE captures
        SET status='error', attempts=3, last_error='old route failed'
        WHERE canonical_url=?
        """,
        (canonical_url,),
    )
    merged = catalog.merge_ft_infini_direct_candidates(
        connection,
        year=2024,
    )

    candidates_json, status, attempts, last_error = connection.execute(
        """
        SELECT candidates_json, status, attempts, last_error
        FROM captures
        WHERE canonical_url=?
        """,
        (canonical_url,),
    ).fetchone()
    candidates = json.loads(candidates_json)
    assert merged == 1
    assert candidates[0]["provider"] == "infini-news"
    assert candidates[0]["sourceUrl"] == canonical_url
    assert candidates[0]["warcFilename"].startswith("CC-NEWS-")
    assert status == "pending"
    assert attempts == 0
    assert last_error is None

    connection.execute(
        """
        UPDATE captures
        SET status='error', attempts=3, last_error='direct route failed'
        WHERE canonical_url=?
        """,
        (canonical_url,),
    )
    connection.commit()
    load_capture_manifest(
        connection,
        manifest_path=tmp_path / "manifest.jsonl",
        publisher="ft",
    )
    candidates_json, status, attempts, last_error = connection.execute(
        """
        SELECT candidates_json, status, attempts, last_error
        FROM captures
        WHERE canonical_url=?
        """,
        (canonical_url,),
    ).fetchone()
    candidates = json.loads(candidates_json)
    assert candidates[0]["provider"] == "infini-news"
    assert status == "error"
    assert attempts == 3
    assert last_error == "direct route failed"
