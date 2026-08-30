from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
import sqlite3

import pytest

from jojo_olds_api.hf_layout import (
    ArchivePhase,
    FILE_SET_FORMAT_VERSION,
    HfArchiveFile,
    archive_phase,
    file_set,
    inventory_archive_directory,
    legacy_b2_object_for_hf,
    map_legacy_b2_object,
    parse_file_set,
    validate_phase_order,
    verify_file_entries,
)


def _write(path: Path, content: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def _entry(root: Path, local_path: str, object_name: str) -> HfArchiveFile:
    path = root.joinpath(*local_path.split("/"))
    content = path.read_bytes()
    return HfArchiveFile(
        local_path=local_path,
        object_name=object_name,
        size=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
    )


def test_maps_only_the_two_approved_legacy_namespaces():
    assert map_legacy_b2_object(
        "news-archive/v1/bloomberg/2016-2026/sitemap-wayback/"
        "raw/objects/html/ab/abcdef.html.gz"
    ) == (
        "raw/archive/v1/bloomberg/2016-2026/sitemap-wayback/"
        "raw/objects/html/ab/abcdef.html.gz"
    )
    assert map_legacy_b2_object(
        "news-archive/v2/validation-state/holdout-v250/nyt/2021/"
        "state/capture.sqlite3.gz"
    ) == (
        "raw/archive/v2/validation-state/holdout-v250/nyt/2021/"
        "state/capture.sqlite3.gz"
    )

    with pytest.raises(ValueError, match="outside the migration allowlist"):
        map_legacy_b2_object("research-archives/bloomberg/2020/state/archive.sqlite3.gz")
    with pytest.raises(ValueError, match="outside the migration allowlist"):
        map_legacy_b2_object("news-archive/v2/runs/example/state/summary.json")
    with pytest.raises(ValueError, match="unsafe"):
        map_legacy_b2_object("news-archive/v1/../research-archives/file")


def test_mapping_is_reversible_and_rejects_unapproved_v2_raw():
    object_name = (
        "raw/archive/v2/validation-state/validation-800/ap/2016/"
        "catalog/manifest.jsonl.gz"
    )
    legacy = legacy_b2_object_for_hf(object_name)
    assert legacy == (
        "news-archive/v2/validation-state/validation-800/ap/2016/"
        "catalog/manifest.jsonl.gz"
    )
    assert map_legacy_b2_object(legacy) == object_name

    with pytest.raises(ValueError, match="unsupported HF v2 validation subtree"):
        map_legacy_b2_object(
            "news-archive/v2/validation-state/holdout-v1/ap/2016/"
            "raw/objects/html/aa/a.html.gz"
        )


@pytest.mark.parametrize("cohort", ["validation", "validation-v17", "holdout-v248", "holdout-v9999"])
def test_all_safe_v2_cohort_names_use_the_same_layout(cohort: str):
    prefix = f"raw/archive/v2/validation-state/{cohort}/nyt/2012"
    assert archive_phase(f"{prefix}/catalog/manifest.jsonl.gz") == ArchivePhase.CATALOG
    assert archive_phase(f"{prefix}/state/capture.sqlite3.gz") == ArchivePhase.CHECKPOINT
    assert archive_phase(f"{prefix}/state/content-audit.json") == ArchivePhase.CHECKPOINT
    assert archive_phase(f"{prefix}/state/summary.json") == ArchivePhase.COMPLETION


def test_completion_sidecars_are_published_after_other_state():
    prefix = "raw/archive/v1/ap/2010-2026/sitemap-wayback"
    assert archive_phase(f"{prefix}/raw/records/aa/a.json") == ArchivePhase.IMMUTABLE
    assert archive_phase(f"{prefix}/catalog/manifest.jsonl.gz") == ArchivePhase.CATALOG
    assert archive_phase(f"{prefix}/state/capture.sqlite3.gz") == ArchivePhase.CHECKPOINT
    assert archive_phase(f"{prefix}/state/wayback-yahoo-summary.json") == ArchivePhase.COMPLETION


def test_file_set_has_exact_shared_contract_and_required_defaults_true(tmp_path: Path):
    local = _write(
        tmp_path / "news-archive/v1/ap/2016-2016/wayback/raw/records/aa/a.json",
        b"{}\n",
    )
    entry = _entry(
        tmp_path,
        local.relative_to(tmp_path).as_posix(),
        "raw/archive/v1/ap/2016-2016/wayback/raw/records/aa/a.json",
    )
    payload = file_set([entry])
    assert list(payload) == ["formatVersion", "files"]
    assert payload["formatVersion"] == FILE_SET_FORMAT_VERSION
    assert list(payload["files"][0]) == [
        "localPath",
        "objectName",
        "size",
        "sha256",
        "required",
    ]
    assert payload["files"][0]["required"] is True

    without_required = json.loads(json.dumps(payload))
    del without_required["files"][0]["required"]
    assert parse_file_set(without_required)[0].required is True


def test_directory_inventory_is_relative_sorted_and_hashed(tmp_path: Path):
    first = _write(
        tmp_path / "v1/ap/2016-2016/wayback/state/summary.json",
        b'{"complete":true}\n',
    )
    second = _write(
        tmp_path / "v1/ap/2016-2016/wayback/catalog/manifest.jsonl.gz",
        gzip.compress(b'{"url":"https://example.com"}\n', mtime=0),
    )
    entries = inventory_archive_directory(
        tmp_path,
        legacy_b2_prefix="news-archive",
    )
    assert [entry.object_name for entry in entries] == sorted(
        entry.object_name for entry in entries
    )
    by_local = {entry.local_path: entry for entry in entries}
    assert by_local[first.relative_to(tmp_path).as_posix()].size == first.stat().st_size
    assert by_local[second.relative_to(tmp_path).as_posix()].sha256 == hashlib.sha256(
        second.read_bytes()
    ).hexdigest()


def test_inventory_rejects_a_single_non_allowlisted_file(tmp_path: Path):
    _write(tmp_path / "research-archives/bloomberg/2020/raw.html", b"legacy")
    with pytest.raises(ValueError, match="outside the migration allowlist"):
        inventory_archive_directory(tmp_path)


def test_phase_order_rejects_skips_duplicates_and_reordering():
    assert validate_phase_order(
        [ArchivePhase.IMMUTABLE, ArchivePhase.CATALOG, ArchivePhase.CHECKPOINT]
    ) == (
        ArchivePhase.IMMUTABLE,
        ArchivePhase.CATALOG,
        ArchivePhase.CHECKPOINT,
    )
    with pytest.raises(ValueError, match="must be published in order"):
        validate_phase_order([ArchivePhase.IMMUTABLE, ArchivePhase.CHECKPOINT])
    with pytest.raises(ValueError, match="must be published in order"):
        validate_phase_order([ArchivePhase.CATALOG, ArchivePhase.IMMUTABLE])


def test_verifier_detects_size_hash_and_required_missing_file(tmp_path: Path):
    path = _write(
        tmp_path / "record.json",
        b'{"rawHtml":{"path":"objects/html/aa/a.html.gz"}}\n',
    )
    entry = _entry(
        tmp_path,
        "record.json",
        "raw/archive/v1/ap/2016-2016/wayback/raw/records/aa/a.json",
    )
    wrong_size = HfArchiveFile(**{**entry.__dict__, "size": entry.size + 1})
    with pytest.raises(ValueError, match="size mismatch"):
        verify_file_entries(tmp_path, [wrong_size])
    wrong_hash = HfArchiveFile(**{**entry.__dict__, "sha256": "0" * 64})
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        verify_file_entries(tmp_path, [wrong_hash])

    path.unlink()
    with pytest.raises(ValueError, match="required HF upload file is missing"):
        verify_file_entries(tmp_path, [entry])


def test_verifier_rejects_record_with_missing_raw_object(tmp_path: Path):
    _write(
        tmp_path / "record.json",
        b'{"rawHtml":{"path":"objects/html/aa/missing.html.gz"}}\n',
    )
    entry = _entry(
        tmp_path,
        "record.json",
        "raw/archive/v1/ap/2016-2016/wayback/raw/records/aa/a.json",
    )
    with pytest.raises(ValueError, match="references missing object"):
        verify_file_entries(tmp_path, [entry])
