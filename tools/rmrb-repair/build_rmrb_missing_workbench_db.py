#!/usr/bin/env python3
"""Build the compact, date-ordered RMRB missing-content workbench index."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from collections import Counter
from pathlib import Path


WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = (
    WORKSPACE_ROOT
    / "tmp"
    / "rmrb-peopledata-full-directory"
    / "merged-peopledata-canonical.jsonl"
)
DEFAULT_OUTPUT = (
    WORKSPACE_ROOT
    / "tmp"
    / "rmrb-peopledata-full-directory"
    / "merged-missing-workbench.sqlite3"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def build(source: Path, output: Path) -> dict[str, object]:
    if not source.is_file():
        raise FileNotFoundError(source)

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".building")
    if temporary.exists():
        temporary.unlink()

    connection = sqlite3.connect(temporary)
    connection.executescript(
        """
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        PRAGMA temp_store = MEMORY;
        CREATE TABLE missing_articles (
            issue_date TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            ordinal INTEGER NOT NULL,
            title TEXT NOT NULL,
            href TEXT,
            match_method TEXT,
            content_source TEXT,
            PRIMARY KEY (issue_date, page_number, ordinal)
        ) WITHOUT ROWID;
        CREATE INDEX missing_articles_date_order
            ON missing_articles(issue_date, page_number, ordinal);
        CREATE INDEX missing_articles_title
            ON missing_articles(title);
        CREATE TABLE metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        ) WITHOUT ROWID;
        """
    )

    batch: list[tuple[object, ...]] = []
    scanned = 0
    inserted = 0
    years: Counter[str] = Counter()
    with source.open("rb") as stream:
        for scanned, raw_line in enumerate(stream, 1):
            # The canonical merger writes every empty body exactly as
            # `"content": ""`. Avoid decoding multi-kilobyte populated rows.
            if b'"content": ""' not in raw_line:
                continue
            row = json.loads(raw_line)
            if str(row.get("content") or "").strip():
                continue
            issue_date = str(row["date"])
            batch.append(
                (
                    issue_date,
                    int(row["page"]),
                    int(row["ordinal"]),
                    str(row.get("title") or ""),
                    row.get("href"),
                    row.get("matchMethod"),
                    row.get("contentSource"),
                )
            )
            years[issue_date[:4]] += 1
            if len(batch) >= 5000:
                connection.executemany(
                    "INSERT INTO missing_articles VALUES (?, ?, ?, ?, ?, ?, ?)", batch
                )
                inserted += len(batch)
                batch.clear()
            if scanned % 250_000 == 0:
                print(f"scanned={scanned:,} missing={inserted + len(batch):,}", flush=True)

    if batch:
        connection.executemany(
            "INSERT INTO missing_articles VALUES (?, ?, ?, ?, ?, ?, ?)", batch
        )
        inserted += len(batch)
    connection.executemany(
        "INSERT INTO metadata(key, value) VALUES (?, ?)",
        (
            ("source", str(source.resolve())),
            ("source_size", str(source.stat().st_size)),
            ("rows_scanned", str(scanned)),
            ("missing_count", str(inserted)),
            ("year_counts", json.dumps(dict(sorted(years.items())), ensure_ascii=False)),
        ),
    )
    connection.commit()
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    connection.close()
    if integrity != "ok":
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"SQLite integrity check failed: {integrity}")
    os.replace(temporary, output)
    return {
        "source": str(source.resolve()),
        "output": str(output.resolve()),
        "rowsScanned": scanned,
        "missingCount": inserted,
        "yearCounts": dict(sorted(years.items())),
        "integrity": integrity,
    }


def main() -> None:
    args = parse_args()
    print(json.dumps(build(args.source, args.output), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
