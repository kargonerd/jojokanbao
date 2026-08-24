from __future__ import annotations

import gzip
import json

import pytest

from download_hf_snapshot import _candidate_dates, _candidate_object, _canonical_objects, _run_window_dates


def test_candidate_object_is_resolved_beside_source_manifest() -> None:
    manifest = {"objects": [{"path": "candidates.jsonl.gz"}]}
    assert _candidate_object("raw/news/ap/2026/08/23/run/manifest.json", manifest) == (
        "raw/news/ap/2026/08/23/run/candidates.jsonl.gz"
    )


def test_candidate_object_rejects_parent_traversal() -> None:
    manifest = {"objects": [{"path": "../candidates.jsonl.gz"}]}
    with pytest.raises(ValueError, match="Unsafe Raw object path"):
        _candidate_object("raw/news/ap/2026/08/23/run/manifest.json", manifest)


def test_candidate_dates_drive_only_matching_canonical_shards(tmp_path) -> None:
    candidates = tmp_path / "candidates.jsonl.gz"
    with gzip.open(candidates, "wt", encoding="utf-8") as output:
        output.write(json.dumps({"publishedAt": "2026-08-22T23:59:00Z"}) + "\n")
        output.write(json.dumps({"publishedAt": "2026-08-23T08:00:00Z"}) + "\n")
        output.write(json.dumps({"publishedAt": "not-a-date"}) + "\n")

    dates = _candidate_dates(candidates)
    assert dates == {"2026-08-22", "2026-08-23"}
    assert _canonical_objects("ap", dates) == {
        "canonical/news/ap/dataset.json",
        "canonical/news/ap/articles/2026/08/2026-08-22.jsonl.gz",
        "canonical/news/ap/articles/2026/08/2026-08-23.jsonl.gz",
    }


def test_run_window_dates_include_the_timezone_boundary_shard() -> None:
    assert _run_window_dates({
        "startedAt": "2026-08-24T00:05:00Z",
        "completedAt": "2026-08-24T00:45:00Z",
        "windowHours": 24,
    }) == {"2026-08-22", "2026-08-23", "2026-08-24"}
