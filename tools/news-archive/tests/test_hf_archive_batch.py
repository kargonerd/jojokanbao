from __future__ import annotations

import gzip
import json
from pathlib import Path
import shutil
import sqlite3

import pytest

from jojo_olds_api.hf_layout import (
    ArchivePhase,
    PHASE_FILENAMES,
    load_file_set,
    prepare_archive_batch,
    verify_archive_batch,
)


def _write(path: Path, content: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def _gzip(path: Path, content: bytes) -> Path:
    return _write(path, gzip.compress(content, mtime=0))


def _sqlite_gzip(path: Path, raw_path: str, record_path: str) -> Path:
    sqlite_path = path.with_suffix("")
    sqlite_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(sqlite_path)
    connection.execute(
        "CREATE TABLE captures(raw_path TEXT, record_path TEXT)"
    )
    connection.execute(
        "INSERT INTO captures VALUES (?, ?)",
        (raw_path, record_path),
    )
    connection.commit()
    connection.close()
    content = sqlite_path.read_bytes()
    sqlite_path.unlink()
    return _gzip(path, content)


def _complete_inventory(root: Path) -> dict[str, Path]:
    v1 = root / "news-archive/v1/nyt/2010-2026/sitemap-wayback"
    raw_reference = "objects/html/aa/article.html.gz"
    record_reference = "records/bb/article.json"
    raw = _gzip(v1 / "raw" / raw_reference, b"<html>article</html>")
    record = _write(
        v1 / "raw" / record_reference,
        (
            json.dumps(
                {
                    "rawHtml": {"path": raw_reference},
                    "dependentResources": [],
                }
            )
            + "\n"
        ).encode("utf-8"),
    )
    catalog = _gzip(v1 / "catalog/manifest.jsonl.gz", b'{"url":"x"}\n')
    checkpoint = _sqlite_gzip(
        v1 / "state/capture.sqlite3.gz", raw_reference, record_reference
    )
    completion = _write(v1 / "state/summary.json", b'{"complete":true}\n')

    # Exercise multiple historical cohort name families. Both checkpoints
    # intentionally reference the one canonical v1 Raw corpus.
    for cohort, year in (("validation", 2012), ("holdout-v250", 2021)):
        v2 = root / f"news-archive/v2/validation-state/{cohort}/nyt/{year}"
        _gzip(v2 / "catalog/manifest.jsonl.gz", b'{"url":"x"}\n')
        _write(v2 / "state/content-audit.json", b'{"hardAnomalies":[]}\n')
        _sqlite_gzip(v2 / "state/capture.sqlite3.gz", raw_reference, record_reference)
        _write(v2 / "state/summary.json", b'{"complete":true}\n')
    return {
        "raw": raw,
        "record": record,
        "catalog": catalog,
        "checkpoint": checkpoint,
        "completion": completion,
    }


def test_prepare_and_verify_complete_v1_and_all_v2_cohorts(tmp_path: Path):
    archive = tmp_path / "download"
    paths = _complete_inventory(archive)
    manifests = tmp_path / "manifests"
    generated = prepare_archive_batch(archive, manifests)

    assert list(generated) == list(ArchivePhase)
    immutable = load_file_set(generated[ArchivePhase.IMMUTABLE])
    assert {entry.local_path for entry in immutable} == {
        paths["raw"].relative_to(archive).as_posix(),
        paths["record"].relative_to(archive).as_posix(),
    }
    assert all(entry.required for entry in immutable)
    assert all(
        entry.object_name.startswith("raw/archive/")
        for phase in ArchivePhase
        for entry in load_file_set(generated[phase])
    )

    report = verify_archive_batch(archive, manifests)
    assert report["files"] == 13
    assert report["phases"]["immutable"]["references"] == 1
    assert report["phases"]["checkpoint"]["sqliteFiles"] == 3
    assert report["phases"]["checkpoint"]["references"] == 6


def test_prepare_is_idempotent_even_when_manifests_are_inside_root(tmp_path: Path):
    archive = tmp_path / "download"
    _complete_inventory(archive)
    manifests = archive / "news-archive/v1/nyt/2010-2026/sitemap-wayback/manifests"
    # This location is intentionally not a valid archive subtree. The four
    # generated files are explicitly excluded from repeated inventories.
    generated = prepare_archive_batch(archive, manifests)
    before = {phase: path.stat().st_mtime_ns for phase, path in generated.items()}
    repeated = prepare_archive_batch(archive, manifests)
    after = {phase: path.stat().st_mtime_ns for phase, path in repeated.items()}
    assert before == after
    verify_archive_batch(archive, manifests)


def test_batch_verifier_detects_deleted_and_mutated_files(tmp_path: Path):
    archive = tmp_path / "download"
    paths = _complete_inventory(archive)
    manifests = tmp_path / "manifests"
    prepare_archive_batch(archive, manifests)

    paths["catalog"].unlink()
    with pytest.raises(ValueError, match="do not exactly cover directory inventory"):
        verify_archive_batch(archive, manifests)

    _complete_inventory(archive)
    prepare_archive_batch(archive, manifests)
    paths["completion"].write_text('{"complete":false}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="size/hash inventory"):
        verify_archive_batch(archive, manifests)


def test_batch_verifier_rejects_corrupt_gzip_and_sqlite(tmp_path: Path):
    archive = tmp_path / "download"
    paths = _complete_inventory(archive)
    manifests = tmp_path / "manifests"

    paths["catalog"].write_bytes(b"not gzip")
    prepare_archive_batch(archive, manifests)
    with pytest.raises(ValueError, match="invalid gzip"):
        verify_archive_batch(archive, manifests)

    _complete_inventory(archive)
    paths["checkpoint"].write_bytes(gzip.compress(b"not sqlite", mtime=0))
    prepare_archive_batch(archive, manifests)
    with pytest.raises(ValueError, match="invalid SQLite checkpoint"):
        verify_archive_batch(archive, manifests)


def test_batch_verifier_rejects_object_in_wrong_stage_manifest(tmp_path: Path):
    archive = tmp_path / "download"
    _complete_inventory(archive)
    manifests = tmp_path / "manifests"
    generated = prepare_archive_batch(archive, manifests)
    immutable_path = generated[ArchivePhase.IMMUTABLE]
    catalog_path = generated[ArchivePhase.CATALOG]
    immutable = json.loads(immutable_path.read_text(encoding="utf-8"))
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    immutable["files"].append(catalog["files"].pop())
    immutable_path.write_text(json.dumps(immutable), encoding="utf-8")
    catalog_path.write_text(json.dumps(catalog), encoding="utf-8")

    with pytest.raises(ValueError, match="wrong phase"):
        verify_archive_batch(archive, manifests)


def test_every_expected_phase_manifest_exists_for_empty_phases(tmp_path: Path):
    archive = tmp_path / "download"
    _write(
        archive / "news-archive/v1/npr/2014-2014/official-archive/state/summary.json",
        b'{"complete":true}\n',
    )
    manifests = tmp_path / "manifests"
    prepare_archive_batch(archive, manifests)
    for phase in ArchivePhase:
        path = manifests / PHASE_FILENAMES[phase]
        assert path.is_file()
        entries = load_file_set(path)
        assert len(entries) == (1 if phase == ArchivePhase.COMPLETION else 0)
    verify_archive_batch(archive, manifests)


def test_v2_only_batch_can_reference_a_previously_verified_v1_manifest(
    tmp_path: Path,
):
    complete = tmp_path / "complete"
    _complete_inventory(complete)
    complete_manifests = tmp_path / "complete-manifests"
    generated = prepare_archive_batch(complete, complete_manifests)

    v2_only = tmp_path / "v2-only"
    source = (
        complete
        / "news-archive/v2/validation-state/holdout-v250/nyt/2021"
    )
    target = (
        v2_only
        / "news-archive/v2/validation-state/holdout-v250/nyt/2021"
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target)
    v2_manifests = tmp_path / "v2-manifests"
    prepare_archive_batch(v2_only, v2_manifests)

    with pytest.raises(ValueError, match="references missing Raw path"):
        verify_archive_batch(v2_only, v2_manifests)

    report = verify_archive_batch(
        v2_only,
        v2_manifests,
        available_file_manifests=(generated[ArchivePhase.IMMUTABLE],),
    )
    assert report["availableReferenceObjects"] == 2


def test_available_manifest_cannot_hide_a_conflicting_local_object(tmp_path: Path):
    archive = tmp_path / "download"
    _complete_inventory(archive)
    manifests = tmp_path / "manifests"
    generated = prepare_archive_batch(archive, manifests)
    available = json.loads(
        generated[ArchivePhase.IMMUTABLE].read_text(encoding="utf-8")
    )
    available["files"][0]["sha256"] = "0" * 64
    conflict = tmp_path / "conflict.json"
    conflict.write_text(json.dumps(available), encoding="utf-8")

    with pytest.raises(ValueError, match="conflicts with the local batch"):
        verify_archive_batch(
            archive,
            manifests,
            available_file_manifests=(conflict,),
        )
