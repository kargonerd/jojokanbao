from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from jojo_news_archive.migration.legacy_b2 import (
    ArchivePhase,
    FILE_SET_FORMAT_VERSION,
    PHASE_FILENAMES,
    PHASE_ORDER,
)
from jojo_news_archive.migration.run_manifest import (
    RUN_FORMAT_VERSION,
    write_archive_run_manifest,
)


PREFIX = "news-archive/v1/bloomberg/2020-2020/legacy-wayback"
HF_PREFIX = "raw/archive/v1/bloomberg/2020-2020/legacy-wayback"


def _phase_manifests(root: Path, *, outside: bool = False) -> Path:
    root.mkdir(parents=True)
    relative_objects = {
        ArchivePhase.IMMUTABLE: "raw/records/aa/article.json",
        ArchivePhase.CATALOG: "catalog/manifest.jsonl.gz",
        ArchivePhase.CHECKPOINT: "state/capture.sqlite3.gz",
        ArchivePhase.COMPLETION: "state/summary.json",
    }
    for phase in PHASE_ORDER:
        prefix = (
            "raw/archive/v1/wsj/2020-2020/wayback"
            if outside and phase == ArchivePhase.COMPLETION
            else HF_PREFIX
        )
        object_name = f"{prefix}/{relative_objects[phase]}"
        content = f"{phase.value}\n".encode()
        payload = {
            "formatVersion": FILE_SET_FORMAT_VERSION,
            "files": [{
                "localPath": f"state/{phase.value}.json",
                "objectName": object_name,
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "required": True,
            }],
        }
        (root / PHASE_FILENAMES[phase]).write_text(
            json.dumps(payload), encoding="utf-8"
        )
    return root


def _revisions() -> dict[ArchivePhase, str]:
    return {phase: format(index + 1, "x") * 40 for index, phase in enumerate(PHASE_ORDER)}


def test_writes_durable_run_provenance_and_exact_file_set(tmp_path: Path):
    workspace = tmp_path / "workspace"
    output_file_set = tmp_path / "05-run.json"
    report = write_archive_run_manifest(
        root=workspace,
        manifest_dir=_phase_manifests(tmp_path / "phases"),
        legacy_b2_prefix=PREFIX,
        run_id="bloomberg-2020-canary-123",
        created_at="2026-08-31T04:00:00Z",
        phase_revisions=_revisions(),
        output_file_set=output_file_set,
    )

    assert report["files"] == 4
    assert report["bytes"] == sum(len(f"{phase.value}\n") for phase in PHASE_ORDER)
    manifest_path = workspace.joinpath(*str(report["manifest"]).split("/"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["formatVersion"] == RUN_FORMAT_VERSION
    assert manifest["migrationComplete"] is True
    assert manifest["hfPrefix"] == HF_PREFIX
    assert manifest["source"] == {
        "publisher": "bloomberg",
        "window": "2020-2020",
        "mode": "legacy-wayback",
    }
    assert manifest["sourceRevision"] == _revisions()[ArchivePhase.COMPLETION]
    assert [row["phase"] for row in manifest["phases"]] == [
        phase.value for phase in PHASE_ORDER
    ]
    assert all(
        str(row["fileSet"]).startswith(
            "raw/archive/runs/2026/08/31/bloomberg-2020-canary-123/file-sets/"
        )
        for row in manifest["phases"]
    )

    file_set = json.loads(output_file_set.read_text(encoding="utf-8"))
    assert file_set["formatVersion"] == FILE_SET_FORMAT_VERSION
    assert len(file_set["files"]) == 5
    by_object = {row["objectName"]: row for row in file_set["files"]}
    assert by_object[str(report["manifest"])]["sha256"] == hashlib.sha256(
        manifest_path.read_bytes()
    ).hexdigest()
    for phase in PHASE_ORDER:
        object_name = next(
            row["fileSet"] for row in manifest["phases"] if row["phase"] == phase.value
        )
        copied = workspace.joinpath(*str(object_name).split("/"))
        assert copied.read_bytes() == (tmp_path / "phases" / PHASE_FILENAMES[phase]).read_bytes()


@pytest.mark.parametrize(
    ("run_id", "prefix", "created_at"),
    [
        ("UPPERCASE", PREFIX, "2026-08-31T04:00:00Z"),
        ("valid", "news-archive/v2/validation-state/x", "2026-08-31T04:00:00Z"),
        ("valid", PREFIX, "2026-08-31T04:00:00"),
    ],
)
def test_rejects_unsafe_identity_values(
    tmp_path: Path, run_id: str, prefix: str, created_at: str
):
    with pytest.raises(ValueError):
        write_archive_run_manifest(
            root=tmp_path / "workspace",
            manifest_dir=_phase_manifests(tmp_path / "phases"),
            legacy_b2_prefix=prefix,
            run_id=run_id,
            created_at=created_at,
            phase_revisions=_revisions(),
            output_file_set=tmp_path / "run.json",
        )


def test_rejects_objects_outside_selected_batch_and_incomplete_revisions(
    tmp_path: Path,
):
    with pytest.raises(ValueError, match="outside selected batch"):
        write_archive_run_manifest(
            root=tmp_path / "workspace",
            manifest_dir=_phase_manifests(tmp_path / "phases", outside=True),
            legacy_b2_prefix=PREFIX,
            run_id="valid-run",
            created_at="2026-08-31T04:00:00Z",
            phase_revisions=_revisions(),
            output_file_set=tmp_path / "run.json",
        )

    revisions = _revisions()
    revisions.pop(ArchivePhase.CATALOG)
    with pytest.raises(ValueError, match="every archive phase"):
        write_archive_run_manifest(
            root=tmp_path / "workspace-two",
            manifest_dir=_phase_manifests(tmp_path / "phases-two"),
            legacy_b2_prefix=PREFIX,
            run_id="valid-run",
            created_at="2026-08-31T04:00:00Z",
            phase_revisions=revisions,
            output_file_set=tmp_path / "run-two.json",
        )


def test_rejects_run_without_a_completion_summary(tmp_path: Path):
    manifests = _phase_manifests(tmp_path / "phases")
    completion = manifests / PHASE_FILENAMES[ArchivePhase.COMPLETION]
    payload = json.loads(completion.read_text(encoding="utf-8"))
    payload["files"] = []
    completion.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ValueError, match="requires a completion summary"):
        write_archive_run_manifest(
            root=tmp_path / "workspace",
            manifest_dir=manifests,
            legacy_b2_prefix=PREFIX,
            run_id="valid-run",
            created_at="2026-08-31T04:00:00Z",
            phase_revisions=_revisions(),
            output_file_set=tmp_path / "run.json",
        )
