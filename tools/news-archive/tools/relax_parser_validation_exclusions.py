from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.parser_validation import initialize_parser_validation_schema


def relax_exclusions_if_under_target(
    connection: sqlite3.Connection,
    *,
    sample_year: int,
    target: int,
) -> dict[str, object]:
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS archive_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    selected_before = int(
        connection.execute(
            """
            SELECT COUNT(*)
            FROM parser_validation_samples
            WHERE sample_year=?
            """,
            (sample_year,),
        ).fetchone()[0]
    )
    exclusions = int(
        connection.execute(
            "SELECT COUNT(*) FROM parser_validation_exclusions"
        ).fetchone()[0]
    )
    relaxed = selected_before < target and exclusions > 0
    now = datetime.now(timezone.utc).isoformat()
    audit = {
        "formatVersion": "jojo-parser-validation-overlap-fallback/1",
        "sampleYear": sample_year,
        "target": target,
        "selectedBefore": selected_before,
        "exclusionsRelaxed": exclusions if relaxed else 0,
        "overlapAllowed": relaxed,
        "recordedAt": now,
    }
    if relaxed:
        with connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS
                    parser_validation_relaxed_exclusions (
                        sample_year INTEGER NOT NULL,
                        canonical_url TEXT NOT NULL,
                        source_cohort TEXT NOT NULL,
                        PRIMARY KEY(sample_year, canonical_url)
                    )
                """
            )
            connection.execute(
                """
                DELETE FROM parser_validation_relaxed_exclusions
                WHERE sample_year=?
                """,
                (sample_year,),
            )
            connection.execute(
                """
                INSERT INTO parser_validation_relaxed_exclusions(
                    sample_year, canonical_url, source_cohort
                )
                SELECT ?, canonical_url, source_cohort
                FROM parser_validation_exclusions
                """,
                (sample_year,),
            )
            connection.execute("DELETE FROM parser_validation_exclusions")
            connection.execute(
                """
                INSERT INTO archive_metadata(key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value
                """,
                (
                    f"parser_validation_overlap_fallback:{sample_year}",
                    json.dumps(audit, ensure_ascii=False, sort_keys=True),
                ),
            )
    return audit


def finalize_overlap_audit(
    connection: sqlite3.Connection,
    *,
    sample_year: int,
) -> dict[str, object]:
    key = f"parser_validation_overlap_fallback:{sample_year}"
    row = connection.execute(
        "SELECT value FROM archive_metadata WHERE key=?",
        (key,),
    ).fetchone()
    if row is None:
        return {
            "formatVersion": "jojo-parser-validation-overlap-fallback/1",
            "sampleYear": sample_year,
            "overlapAllowed": False,
            "finalized": False,
        }
    audit = json.loads(str(row[0]))
    table_exists = connection.execute(
        """
        SELECT 1 FROM sqlite_master
        WHERE type='table'
          AND name='parser_validation_relaxed_exclusions'
        """
    ).fetchone()
    selected_after = int(
        connection.execute(
            """
            SELECT COUNT(*) FROM parser_validation_samples
            WHERE sample_year=?
            """,
            (sample_year,),
        ).fetchone()[0]
    )
    reused = 0
    if table_exists is not None:
        reused = int(
            connection.execute(
                """
                SELECT COUNT(*)
                FROM parser_validation_samples AS sample
                JOIN parser_validation_relaxed_exclusions AS relaxed
                  ON relaxed.canonical_url=sample.canonical_url
                 AND relaxed.sample_year=sample.sample_year
                WHERE sample.sample_year=?
                """,
                (sample_year,),
            ).fetchone()[0]
        )
    audit.update(
        {
            "selectedAfter": selected_after,
            "reusedSamples": reused,
            "finalized": True,
            "finalizedAt": datetime.now(timezone.utc).isoformat(),
        }
    )
    with connection:
        connection.execute(
            "UPDATE archive_metadata SET value=? WHERE key=?",
            (json.dumps(audit, ensure_ascii=False, sort_keys=True), key),
        )
    return audit


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Allow seeded overlap when disjoint parser-QA candidates cannot "
            "reach the requested yearly target."
        )
    )
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--target", type=int, required=True)
    parser.add_argument("--marker", type=Path, required=True)
    parser.add_argument("--finalize", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    connection = sqlite3.connect(args.state, timeout=60)
    try:
        if args.finalize:
            result = finalize_overlap_audit(
                connection,
                sample_year=args.year,
            )
        else:
            result = relax_exclusions_if_under_target(
                connection,
                sample_year=args.year,
                target=args.target,
            )
    finally:
        connection.close()
    if result["overlapAllowed"] and not args.finalize:
        args.marker.parent.mkdir(parents=True, exist_ok=True)
        args.marker.write_text("overlap fallback enabled\n", encoding="utf-8")
    elif not args.finalize and args.marker.exists():
        args.marker.unlink()
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
