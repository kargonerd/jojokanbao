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
from jojo_olds_api.archive_sources import (
    archive_source_spec,
    normalize_article_url,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Exclude every URL selected by an earlier parser-QA cohort."
    )
    parser.add_argument("--source-state", type=Path, required=True)
    parser.add_argument("--target-state", type=Path, required=True)
    parser.add_argument("--source-cohort", default="validation-v1")
    parser.add_argument("--publisher")
    parser.add_argument(
        "--sample-year",
        type=int,
        help="Only import evaluated URLs assigned to this publication year.",
    )
    parser.add_argument(
        "--accepted-target-only",
        action="store_true",
        help=(
            "Import only the QA-passing, priority-ranked formal cohort up "
            "to its configured target instead of every attempted result."
        ),
    )
    parser.add_argument(
        "--exclude-inherited",
        action="store_true",
        help=(
            "Do not transitively import the source state's exclusions. Use "
            "when every earlier cohort checkpoint is imported directly."
        ),
    )
    parser.add_argument(
        "--reset-target-exclusions",
        action="store_true",
        help="Clear the target exclusion table before this direct rebuild.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.source_state.exists():
        raise SystemExit(f"source state not found: {args.source_state}")
    args.target_state.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(args.source_state, timeout=60)
    target = sqlite3.connect(args.target_state, timeout=60)
    try:
        initialize_parser_validation_schema(target)
        results_table = source.execute(
            """
            SELECT 1 FROM sqlite_master
            WHERE type='table' AND name='parser_validation_results'
            """
        ).fetchone()
        samples_table = source.execute(
            """
            SELECT 1 FROM sqlite_master
            WHERE type='table' AND name='parser_validation_samples'
            """
        ).fetchone()
        if results_table is not None:
            source_table = "parser_validation_results"
        elif samples_table is not None:
            # Compatibility fallback for a plan-only legacy checkpoint.
            source_table = "parser_validation_samples"
        else:
            raise SystemExit("source state has no parser validation URL table")
        if args.accepted_target_only:
            if source_table != "parser_validation_results":
                raise SystemExit(
                    "accepted-target-only requires parser_validation_results"
                )
            if args.sample_year is None:
                raise SystemExit(
                    "accepted-target-only requires --sample-year"
                )
            config_table = source.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' "
                "AND name='parser_validation_config'"
            ).fetchone()
            config = (
                source.execute(
                    "SELECT target_size FROM parser_validation_config "
                    "WHERE sample_year=?",
                    (args.sample_year,),
                ).fetchone()
                if config_table is not None
                else None
            )
            if config is None:
                result_columns = {
                    str(row[1])
                    for row in source.execute(
                        "PRAGMA table_info(parser_validation_results)"
                    )
                }
                if {"sample_year", "qa_pass"}.issubset(result_columns):
                    relevant_results = int(
                        source.execute(
                            "SELECT COUNT(*) FROM parser_validation_results "
                            "WHERE sample_year=? AND qa_pass=1",
                            (args.sample_year,),
                        ).fetchone()[0]
                    )
                    if relevant_results == 0:
                        print(
                            json.dumps(
                                {
                                    "formatVersion": (
                                        "jojo-parser-validation-exclusions/1"
                                    ),
                                    "sourceCohort": args.source_cohort,
                                    "sampleYear": args.sample_year,
                                    "acceptedTargetOnly": True,
                                    "skippedPlaceholder": True,
                                    "reason": "no-config-and-no-accepted-results",
                                },
                                ensure_ascii=False,
                                sort_keys=True,
                            )
                        )
                        return 0
                raise SystemExit(
                    "accepted-target-only requires parser validation config"
                )
            evaluated_urls = [
                str(row[0])
                for row in source.execute(
                    """
                    SELECT result.canonical_url
                    FROM parser_validation_results AS result
                    JOIN parser_validation_samples AS sample
                      ON sample.canonical_url=result.canonical_url
                     AND sample.sample_year=result.sample_year
                    WHERE sample.sample_year=? AND result.qa_pass=1
                    ORDER BY sample.sample_priority
                    LIMIT ?
                    """,
                    (args.sample_year, int(config[0])),
                )
            ]
        else:
            where_clause = ""
            parameters: tuple[object, ...] = ()
            if args.sample_year is not None:
                where_clause = " WHERE sample_year=?"
                parameters = (args.sample_year,)
            evaluated_urls = [
                str(row[0])
                for row in source.execute(
                    f"SELECT DISTINCT canonical_url FROM {source_table}"
                    f"{where_clause}",
                    parameters,
                )
            ]
        exclusions_table = source.execute(
            """
            SELECT 1 FROM sqlite_master
            WHERE type='table' AND name='parser_validation_exclusions'
            """
        ).fetchone()
        inherited_exclusions = (
            [
                (str(row[0]), str(row[1]))
                for row in source.execute(
                    "SELECT canonical_url, source_cohort "
                    "FROM parser_validation_exclusions"
                )
            ]
            if exclusions_table is not None and not args.exclude_inherited
            else []
        )
        # A saved validation state is a transitive cohort boundary. Its own
        # exclusions identify samples evaluated by still earlier cohorts and
        # must remain excluded when rotating again. They are safe to inherit
        # across a year-filtered import because the target sample can only
        # overlap exclusions whose canonical URL is present in that year.
        evaluated_entries = [
            (url, args.source_cohort) for url in evaluated_urls
        ]
        inherited_entries = inherited_exclusions
        if args.publisher:
            spec = archive_source_spec(args.publisher)
            evaluated_entries = sorted(
                {
                    (normalize_article_url(spec, url) or url, source_cohort)
                    for url, source_cohort in evaluated_entries
                }
            )
            inherited_entries = sorted(
                {
                    (normalize_article_url(spec, url) or url, source_cohort)
                    for url, source_cohort in inherited_entries
                }
            )
        unique_urls = {
            url for url, _source_cohort in evaluated_entries + inherited_entries
        }
        now = datetime.now(timezone.utc).isoformat()
        with target:
            # Defer the destructive rebuild until the source has proved it is
            # a real cohort. An empty v2 placeholder must not erase exclusions
            # already imported from a valid legacy checkpoint.
            if args.reset_target_exclusions:
                target.execute("DELETE FROM parser_validation_exclusions")
            # Transitive exclusions already identify the cohort that first
            # evaluated each URL. Preserve that provenance and never let a
            # later checkpoint relabel an older cohort's samples as its own.
            target.executemany(
                """
                INSERT INTO parser_validation_exclusions(
                    canonical_url, source_cohort, excluded_at
                )
                VALUES (?, ?, ?)
                ON CONFLICT(canonical_url) DO NOTHING
                """,
                (
                    (url, source_cohort, now)
                    for url, source_cohort in inherited_entries
                ),
            )
            # URLs evaluated by this source checkpoint are authoritative for
            # its cohort label. This also repairs stale inherited labels when
            # the corresponding cohort checkpoint is imported directly.
            target.executemany(
                """
                INSERT INTO parser_validation_exclusions(
                    canonical_url, source_cohort, excluded_at
                )
                VALUES (?, ?, ?)
                ON CONFLICT(canonical_url) DO UPDATE SET
                    source_cohort=excluded.source_cohort,
                    excluded_at=excluded.excluded_at
                """,
                (
                    (url, source_cohort, now)
                    for url, source_cohort in evaluated_entries
                ),
            )
        if args.publisher:
            normalized_exclusions = {
                normalize_article_url(spec, str(row[0])) or str(row[0])
                for row in target.execute(
                    "SELECT canonical_url FROM parser_validation_exclusions"
                )
            }
            overlap_urls = [
                str(row[0])
                for row in target.execute(
                    "SELECT canonical_url FROM parser_validation_samples"
                )
                if (
                    normalize_article_url(spec, str(row[0])) or str(row[0])
                )
                in normalized_exclusions
            ]
        else:
            overlap_urls = [
                str(row[0])
                for row in target.execute(
                    """
                    SELECT sample.canonical_url
                    FROM parser_validation_samples AS sample
                    JOIN parser_validation_exclusions AS exclusion
                      USING(canonical_url)
                    """
                )
            ]
        overlap = len(overlap_urls)
        if overlap_urls:
            with target:
                target.executemany(
                    """
                    DELETE FROM parser_validation_results
                    WHERE canonical_url=?
                    """,
                    ((url,) for url in overlap_urls),
                )
                target.executemany(
                    """
                    DELETE FROM parser_validation_samples
                    WHERE canonical_url=?
                    """,
                    ((url,) for url in overlap_urls),
                )
        if args.publisher:
            remaining_overlap = sum(
                1
                for row in target.execute(
                    "SELECT canonical_url FROM parser_validation_samples"
                )
                if (
                    normalize_article_url(spec, str(row[0])) or str(row[0])
                )
                in normalized_exclusions
            )
        else:
            remaining_overlap = int(
                target.execute(
                    """
                    SELECT COUNT(*)
                    FROM parser_validation_samples AS sample
                    JOIN parser_validation_exclusions AS exclusion
                      USING(canonical_url)
                    """
                ).fetchone()[0]
            )
        result = {
            "formatVersion": "jojo-parser-validation-exclusions/1",
            "sourceCohort": args.source_cohort,
            "sourceTable": source_table,
            "sampleYear": args.sample_year,
            "acceptedTargetOnly": args.accepted_target_only,
            "inheritedExclusionsIncluded": not args.exclude_inherited,
            "targetExclusionsReset": args.reset_target_exclusions,
            "sourceSamples": len(unique_urls),
            "evaluatedSourceSamples": len(set(evaluated_urls)),
            "inheritedSourceExclusions": len(
                {url for url, _source_cohort in inherited_entries}
            ),
            "excluded": int(
                target.execute(
                    "SELECT COUNT(*) FROM parser_validation_exclusions"
                ).fetchone()[0]
            ),
            "removedSampleOverlap": overlap,
            "sampleOverlap": remaining_overlap,
        }
    finally:
        source.close()
        target.close()
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if remaining_overlap == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
