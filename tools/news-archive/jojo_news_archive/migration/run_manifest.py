"""Durable provenance for one published historical Raw migration batch."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
import hashlib
import json
from pathlib import Path, PurePosixPath
import re

from jojo_news_archive.migration.legacy_b2 import (
    ArchivePhase,
    FILE_SET_FORMAT_VERSION,
    PHASE_FILENAMES,
    PHASE_ORDER,
    archive_phase,
    load_file_set,
)


RUN_FORMAT_VERSION = "jojo-news-archive-raw-run/1"
_RUN_ID = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$")
_REVISION = re.compile(r"^[a-f0-9]{40}$")
_SOURCE_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_WINDOW = re.compile(r"^\d{4}-\d{4}$")


def _encoded(payload: object) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(content)
    temporary.replace(path)


def _source_prefix(legacy_b2_prefix: str) -> tuple[str, str, str, str]:
    normalized = legacy_b2_prefix.strip("/")
    pieces = normalized.split("/")
    if (
        len(pieces) != 5
        or pieces[:2] != ["news-archive", "v1"]
        or not _SOURCE_ID.fullmatch(pieces[2])
        or not _WINDOW.fullmatch(pieces[3])
        or not _SOURCE_ID.fullmatch(pieces[4])
    ):
        raise ValueError(
            "legacy B2 prefix must identify one v1 publisher/window/mode batch"
        )
    publisher, window, mode = pieces[2:]
    return normalized, publisher, window, mode


def _created_at(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("createdAt must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("createdAt must include a timezone")
    return parsed


def write_archive_run_manifest(
    *,
    root: Path,
    manifest_dir: Path,
    legacy_b2_prefix: str,
    run_id: str,
    created_at: str,
    phase_revisions: Mapping[ArchivePhase, str],
    output_file_set: Path,
) -> dict[str, object]:
    """Write one Raw run object and its exact single-file HF upload set."""

    if not _RUN_ID.fullmatch(run_id):
        raise ValueError("run id must be 1-128 lowercase URL-safe characters")
    timestamp = _created_at(created_at)
    legacy_prefix, publisher, window, mode = _source_prefix(legacy_b2_prefix)
    if set(phase_revisions) != set(PHASE_ORDER):
        raise ValueError("phase revisions must contain every archive phase exactly once")
    for phase in PHASE_ORDER:
        if not _REVISION.fullmatch(phase_revisions[phase]):
            raise ValueError(f"{phase.value} revision must be a 40-character SHA")

    hf_prefix = legacy_prefix.replace("news-archive/v1/", "raw/archive/v1/", 1)
    date_path = timestamp.date().isoformat().replace("-", "/")
    run_root = PurePosixPath(
        "raw", "archive", "runs", date_path, run_id
    ).as_posix()
    object_name = f"{run_root}/manifest.json"
    phases: list[dict[str, object]] = []
    run_files: list[dict[str, object]] = []
    object_names: set[str] = set()
    total_files = 0
    total_bytes = 0
    for phase in PHASE_ORDER:
        manifest_path = manifest_dir / PHASE_FILENAMES[phase]
        manifest_bytes = manifest_path.read_bytes()
        phase_manifest_object = f"{run_root}/file-sets/{PHASE_FILENAMES[phase]}"
        entries = load_file_set(manifest_path)
        if phase == ArchivePhase.COMPLETION and not entries:
            raise ValueError("archive Raw run requires a completion summary")
        for entry in entries:
            if archive_phase(entry.object_name) != phase:
                raise ValueError(
                    f"{phase.value} file set contains an object from the wrong phase: "
                    f"{entry.object_name}"
                )
            if not entry.object_name.startswith(f"{hf_prefix}/"):
                raise ValueError(
                    f"{phase.value} object is outside selected batch: {entry.object_name}"
                )
            if entry.object_name in object_names:
                raise ValueError(f"duplicate object across phase manifests: {entry.object_name}")
            object_names.add(entry.object_name)
        file_count = len(entries)
        byte_count = sum(entry.size for entry in entries)
        total_files += file_count
        total_bytes += byte_count
        phases.append(
            {
                "phase": phase.value,
                "revision": phase_revisions[phase],
                "fileSet": phase_manifest_object,
                "fileSetSha256": _sha256(manifest_bytes),
                "files": file_count,
                "bytes": byte_count,
            }
        )
        _atomic_write(
            root.resolve().joinpath(*phase_manifest_object.split("/")),
            manifest_bytes,
        )
        run_files.append(
            {
                "localPath": phase_manifest_object,
                "objectName": phase_manifest_object,
                "size": len(manifest_bytes),
                "sha256": _sha256(manifest_bytes),
                "required": True,
            }
        )
    if total_files == 0:
        raise ValueError("archive Raw run cannot reference an empty migration batch")

    payload: dict[str, object] = {
        "formatVersion": RUN_FORMAT_VERSION,
        "runId": run_id,
        "createdAt": timestamp.isoformat().replace("+00:00", "Z"),
        "migrationComplete": True,
        "legacyB2Prefix": legacy_prefix,
        "hfPrefix": hf_prefix,
        "source": {
            "publisher": publisher,
            "window": window,
            "mode": mode,
        },
        "sourceRevision": phase_revisions[ArchivePhase.COMPLETION],
        "phases": phases,
        "objects": {"files": total_files, "bytes": total_bytes},
    }
    body = _encoded(payload)
    target = root.resolve().joinpath(*object_name.split("/"))
    _atomic_write(target, body)
    run_files.append(
        {
            "localPath": object_name,
            "objectName": object_name,
            "size": len(body),
            "sha256": _sha256(body),
            "required": True,
        }
    )
    file_set = {
        "formatVersion": FILE_SET_FORMAT_VERSION,
        "files": sorted(run_files, key=lambda row: str(row["objectName"])),
    }
    _atomic_write(output_file_set.resolve(), _encoded(file_set))
    return {
        "manifest": object_name,
        "fileSet": str(output_file_set.resolve()),
        "files": total_files,
        "bytes": total_bytes,
        "runFiles": len(run_files),
        "sourceRevision": phase_revisions[ArchivePhase.COMPLETION],
    }
