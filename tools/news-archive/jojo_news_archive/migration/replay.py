"""Prepare the final HF object layout used by historical parser replay."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil

from jojo_news_archive.migration.legacy_b2 import (
    FILE_SET_FORMAT_VERSION,
    HfArchiveFile,
    load_file_set,
)


def _safe_local(root: Path, relative: str) -> Path:
    resolved_root = root.resolve()
    target = resolved_root.joinpath(*relative.split("/")).resolve()
    if target != resolved_root and resolved_root not in target.parents:
        raise ValueError(f"file-set path escapes its root: {relative}")
    return target


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify(path: Path, entry: HfArchiveFile) -> None:
    if not path.is_file():
        raise ValueError(f"replay source is missing: {entry.local_path}")
    if path.stat().st_size != entry.size or _sha256(path) != entry.sha256:
        raise ValueError(f"replay source does not match its file set: {entry.local_path}")


def prepare_replay_layout(
    *,
    source_root: Path,
    file_set_path: Path,
    workspace: Path,
    output_file_set: Path,
    materialize: bool,
) -> dict[str, object]:
    """Map verified legacy local paths to their exact HF object paths."""

    entries = load_file_set(file_set_path)
    if not entries:
        raise ValueError("cannot prepare replay layout from an empty file set")
    replay_rows: list[dict[str, object]] = []
    linked = 0
    copied = 0
    existing = 0
    for entry in entries:
        source = _safe_local(source_root, entry.local_path)
        _verify(source, entry)
        target = _safe_local(workspace, entry.object_name)
        if materialize:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                # A repeated local canary normally finds the hard link created
                # by its previous attempt. The source was just re-verified, so
                # hashing the same inode a second time only amplifies Windows
                # antivirus and small-file overhead.
                if not os.path.samefile(source, target):
                    _verify(target, HfArchiveFile(
                        local_path=entry.object_name,
                        object_name=entry.object_name,
                        size=entry.size,
                        sha256=entry.sha256,
                        required=entry.required,
                    ))
                existing += 1
            else:
                try:
                    os.link(source, target)
                    linked += 1
                except OSError:
                    shutil.copy2(source, target)
                    copied += 1
        replay_rows.append(
            {
                "localPath": entry.object_name,
                "objectName": entry.object_name,
                "size": entry.size,
                "sha256": entry.sha256,
                "required": entry.required,
            }
        )
    payload = {"formatVersion": FILE_SET_FORMAT_VERSION, "files": replay_rows}
    body = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    destination = output_file_set.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_bytes(body)
    temporary.replace(destination)
    return {
        "fileSet": str(destination),
        "files": len(entries),
        "bytes": sum(entry.size for entry in entries),
        "materialized": materialize,
        "linked": linked,
        "copied": copied,
        "existing": existing,
    }
