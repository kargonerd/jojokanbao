"""Deterministic capture-record selection from a verified HF file set."""

from __future__ import annotations

import hashlib
from pathlib import Path

from jojo_news_archive.migration.legacy_b2 import (
    ArchivePhase,
    archive_phase,
    load_file_set,
)


_RECORD_MARKER = "/raw/records/"


def write_record_list(
    *,
    file_set_path: Path,
    output: Path,
    limit: int | None = None,
    seed: str = "jojo-archive-canary-v1",
) -> tuple[str, ...]:
    if limit is not None and limit < 1:
        raise ValueError("record limit must be a positive integer")
    if not seed:
        raise ValueError("record selection seed must be non-empty")
    entries = load_file_set(file_set_path)
    records = sorted(
        entry.object_name
        for entry in entries
        if archive_phase(entry.object_name) == ArchivePhase.IMMUTABLE
        and _RECORD_MARKER in entry.object_name
        and entry.object_name.endswith(".json")
    )
    if not records:
        raise ValueError("HF file set contains no historical capture records")
    if limit is not None and len(records) > limit:
        records = sorted(
            records,
            key=lambda value: (
                hashlib.sha256(f"{seed}\0{value}".encode()).digest(),
                value,
            ),
        )[:limit]
        records.sort()
    body = "".join(f"{record}\n" for record in records).encode("utf-8")
    destination = output.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_bytes(body)
    temporary.replace(destination)
    return tuple(records)
