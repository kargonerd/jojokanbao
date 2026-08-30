from __future__ import annotations

import gzip
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile


def write_capture_checkpoint(
    state_path: Path,
    destination: Path,
) -> dict[str, object]:
    if not state_path.is_file():
        raise FileNotFoundError(f"capture state does not exist: {state_path}")
    destination.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(
        prefix="jojo-capture-checkpoint-",
        dir=destination.parent,
    ) as temporary_directory:
        snapshot = Path(temporary_directory) / "capture.sqlite3"
        source = sqlite3.connect(state_path, timeout=60)
        target = sqlite3.connect(snapshot, timeout=60)
        try:
            source.backup(target, pages=1_024, sleep=0.05)
        finally:
            target.close()
            source.close()

        temporary_gzip = destination.with_suffix(destination.suffix + ".tmp")
        try:
            with snapshot.open("rb") as source_file:
                with temporary_gzip.open("wb") as destination_file:
                    with gzip.GzipFile(
                        filename="",
                        mode="wb",
                        compresslevel=9,
                        fileobj=destination_file,
                        mtime=0,
                    ) as compressed:
                        shutil.copyfileobj(
                            source_file,
                            compressed,
                            length=1024 * 1024,
                        )
            os.replace(temporary_gzip, destination)
        finally:
            temporary_gzip.unlink(missing_ok=True)

    result = {
        "state": str(state_path),
        "checkpoint": str(destination),
        "sqliteBytes": state_path.stat().st_size,
        "storedBytes": destination.stat().st_size,
    }
    return result


def checkpoint_json(
    state_path: Path,
    destination: Path,
) -> str:
    return json.dumps(
        write_capture_checkpoint(state_path, destination),
        ensure_ascii=False,
        separators=(",", ":"),
    )
