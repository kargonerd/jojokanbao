from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest

from tools.merge_archive_manifests import merge_archive_manifests


def _write(path: Path, rows: list[dict[str, object]]) -> None:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "wt", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


def _read(path: Path) -> list[dict[str, object]]:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle]


def test_merge_manifests_unions_urls_and_candidates(tmp_path: Path) -> None:
    current = tmp_path / "current.jsonl.gz"
    legacy = tmp_path / "legacy.jsonl.gz"
    output = tmp_path / "merged.jsonl.gz"
    shared_url = "https://www.wsj.com/articles/shared-11552935102"
    _write(
        current,
        [
            {
                "formatVersion": "jojo-capture-manifest/1",
                "publisher": "wsj",
                "canonicalUrl": shared_url,
                "publishedAt": "2019-03-18T00:00:00Z",
                "candidates": [
                    {
                        "provider": "wayback",
                        "snapshotUrl": "https://web.archive.org/one",
                        "digest": "ONE",
                    }
                ],
            },
            {
                "publisher": "wsj",
                "canonicalUrl": "https://www.wsj.com/articles/current-only",
                "publishedAt": "2019-04-01T00:00:00Z",
                "candidates": [],
            },
        ],
    )
    _write(
        legacy,
        [
            {
                "publisher": "wsj",
                "canonicalUrl": shared_url,
                "section": "Business",
                "candidates": [
                    {
                        "provider": "wayback",
                        "snapshotUrl": "https://web.archive.org/one",
                        "digest": "ONE",
                    },
                    {
                        "provider": "wayback",
                        "snapshotUrl": "https://web.archive.org/two",
                        "digest": "TWO",
                    },
                ],
            },
            {
                "publisher": "wsj",
                "canonicalUrl": "https://www.wsj.com/articles/legacy-only",
                "publishedAt": "2019-05-01T00:00:00Z",
                "candidates": [
                    {
                        "provider": "wayback",
                        "snapshotUrl": "https://web.archive.org/three",
                        "digest": "THREE",
                    }
                ],
            },
        ],
    )

    result = merge_archive_manifests(
        [current, legacy],
        output,
        publisher="wsj",
    )
    rows = _read(output)
    by_url = {row["canonicalUrl"]: row for row in rows}

    assert result["inputRows"] == 4
    assert result["outputRows"] == 3
    assert result["duplicateRows"] == 1
    assert result["duplicateCandidates"] == 1
    assert list(by_url) == sorted(by_url)
    assert [
        candidate["digest"]
        for candidate in by_url[shared_url]["candidates"]
    ] == ["ONE", "TWO"]
    assert by_url[shared_url]["section"] == "Business"


def test_merge_manifests_rejects_wrong_publisher(tmp_path: Path) -> None:
    source = tmp_path / "source.jsonl"
    _write(
        source,
        [
            {
                "publisher": "nyt",
                "canonicalUrl": "https://www.nytimes.com/example",
                "candidates": [],
            }
        ],
    )

    with pytest.raises(ValueError, match="does not match"):
        merge_archive_manifests(
            [source],
            tmp_path / "output.jsonl.gz",
            publisher="wsj",
        )
