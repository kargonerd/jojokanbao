from __future__ import annotations

import gzip
from pathlib import Path
import sqlite3

from jojo_olds_api.capture_checkpoint import write_capture_checkpoint


def test_capture_checkpoint_includes_committed_wal_rows(tmp_path: Path):
    state = tmp_path / "capture.sqlite3"
    writer = sqlite3.connect(state)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("CREATE TABLE captures(url TEXT PRIMARY KEY, status TEXT)")
    writer.execute(
        "INSERT INTO captures(url, status) VALUES (?, ?)",
        ("https://example.com/article", "complete"),
    )
    writer.commit()

    compressed = tmp_path / "capture.sqlite3.gz"
    result = write_capture_checkpoint(state, compressed)
    restored = tmp_path / "restored.sqlite3"
    with gzip.open(compressed, "rb") as source:
        restored.write_bytes(source.read())
    connection = sqlite3.connect(restored)
    try:
        row = connection.execute(
            "SELECT url, status FROM captures"
        ).fetchone()
    finally:
        connection.close()
        writer.close()

    assert row == ("https://example.com/article", "complete")
    assert result["checkpoint"] == str(compressed)
    assert result["storedBytes"] == compressed.stat().st_size
