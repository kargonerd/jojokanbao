from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest

from tools.filter_archive_manifest import filter_archive_manifest


def test_filter_manifest_keeps_only_requested_publication_year(
    tmp_path: Path,
):
    source = tmp_path / "source.jsonl.gz"
    destination = tmp_path / "filtered.jsonl.gz"
    rows = [
        {
            "publisher": "nyt",
            "canonicalUrl": (
                "https://www.nytimes.com/2025/12/31/world/old.html"
            ),
            "publishedAt": "2025-12-31T23:00:00Z",
            "candidates": [{"provider": "live-origin", "snapshotUrl": "a"}],
        },
        {
            "publisher": "nyt",
            "canonicalUrl": (
                "https://www.nytimes.com/2026/01/02/world/kept.html"
            ),
            "publishedAt": "2026-01-02T10:00:00Z",
            "candidates": [{"provider": "live-origin", "snapshotUrl": "b"}],
        },
        {
            "publisher": "nyt",
            "canonicalUrl": (
                "https://www.nytimes.com/2027/01/01/world/future.html"
            ),
            "publishedAt": "2027-01-01T00:00:00Z",
            "candidates": [{"provider": "live-origin", "snapshotUrl": "c"}],
        },
    ]
    with gzip.open(source, "wt", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")

    result = filter_archive_manifest(
        source,
        destination,
        publisher="nyt",
        from_year=2026,
        to_year=2026,
    )
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        selected = [json.loads(line) for line in handle]

    assert result["rowsSeen"] == 3
    assert result["rowsSelected"] == 1
    assert selected == [rows[1]]


def test_filter_manifest_infers_date_and_rejects_wrong_publisher(
    tmp_path: Path,
):
    inferred = tmp_path / "inferred.jsonl"
    inferred.write_text(
        json.dumps(
            {
                "canonical_url": (
                    "https://www.nytimes.com/2026/06/03/world/example.html"
                ),
                "candidates": [],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    result = filter_archive_manifest(
        inferred,
        tmp_path / "inferred-output.jsonl",
        publisher="nyt",
        from_year=2026,
        to_year=2026,
    )
    assert result["rowsSelected"] == 1

    wrong = tmp_path / "wrong.jsonl"
    wrong.write_text(
        json.dumps(
            {
                "publisher": "wsj",
                "canonical_url": (
                    "https://www.nytimes.com/2026/06/03/world/example.html"
                ),
                "published_at": "2026-06-03T00:00:00Z",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="does not match"):
        filter_archive_manifest(
            wrong,
            tmp_path / "wrong-output.jsonl",
            publisher="nyt",
            from_year=2026,
            to_year=2026,
        )


def test_filter_manifest_corrects_stale_wsj_capture_dates(
    tmp_path: Path,
):
    source = tmp_path / "stale-wsj.jsonl"
    destination = tmp_path / "wsj-2020.jsonl"
    rows = [
        {
            "publisher": "wsj",
            "canonicalUrl": (
                "https://www.wsj.com/articles/"
                "afghans-mourn-for-bombing-victims-1416846693"
            ),
            "publishedAt": "2020-11-13T04:30:06+00:00",
            "candidates": [],
        },
        {
            "publisher": "wsj",
            "canonicalUrl": (
                "https://www.wsj.com/articles/"
                "accenture-looks-to-boost-ai-capabilities-through-"
                "mergers-11592818200"
            ),
            "publishedAt": "2019-06-22T14:00:00+00:00",
            "candidates": [],
        },
        {
            "publisher": "wsj",
            "canonicalUrl": (
                "https://www.wsj.com/articles/"
                "abbott-beats-forecasts-on-strong-covid-19-testing-"
                "business-151594900170"
            ),
            "publishedAt": "2020-07-17T14:00:00+00:00",
            "candidates": [],
        },
    ]
    source.write_text(
        "".join(json.dumps(row) + "\n" for row in rows),
        encoding="utf-8",
    )

    result = filter_archive_manifest(
        source,
        destination,
        publisher="wsj",
        from_year=2020,
        to_year=2020,
    )
    selected = [
        json.loads(line)
        for line in destination.read_text(encoding="utf-8").splitlines()
    ]

    assert result["rowsSeen"] == 3
    assert result["rowsSelected"] == 2
    assert result["rowsPublicationDateCorrected"] == 2
    assert {row["canonicalUrl"] for row in selected} == {
        rows[1]["canonicalUrl"],
        rows[2]["canonicalUrl"],
    }
    assert all(row["publishedAt"].startswith("2020-") for row in selected)
