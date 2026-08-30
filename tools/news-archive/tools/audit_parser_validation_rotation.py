from __future__ import annotations

import argparse
from contextlib import ExitStack
import gzip
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile

from jojo_news_archive.archive_sources import (
    archive_source_spec,
    article_deduplication_key,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Prove that a parser-version change produced a fresh, "
            "zero-overlap validation cohort."
        )
    )
    parser.add_argument("--previous-state", type=Path, required=True)
    parser.add_argument("--current-state", type=Path, required=True)
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--expected-parser-version", required=True)
    parser.add_argument("--from-year", type=int, required=True)
    parser.add_argument("--to-year", type=int, required=True)
    parser.add_argument("--target-per-year", type=int, default=800)
    parser.add_argument(
        "--require-complete",
        action="store_true",
        help=(
            "Also require the current cohort to have evaluated at least the "
            "configured per-year target. Without this flag the audit only "
            "proves rotation setup and zero overlap."
        ),
    )
    parser.add_argument(
        "--expected-previous-source-cohort",
        help=(
            "Expected source_cohort label for the previous state, such as "
            "holdout-v2. By default, require the parser-version rotation "
            "label <publisher>:<year>:<previous-parser-version>."
        ),
    )
    return parser.parse_args()


def _materialize_state(
    source: Path,
    *,
    stack: ExitStack,
) -> Path:
    if not source.exists():
        raise ValueError(f"state not found: {source}")
    if source.suffix.casefold() != ".gz":
        return source
    temporary = Path(stack.enter_context(tempfile.TemporaryDirectory()))
    output = temporary / source.stem
    with gzip.open(source, "rb") as compressed, output.open("wb") as raw:
        shutil.copyfileobj(compressed, raw)
    return output


def _connect_read_only(
    path: Path,
    *,
    require_exclusions: bool = True,
) -> sqlite3.Connection:
    connection = sqlite3.connect(
        f"file:{path.resolve().as_posix()}?mode=ro",
        uri=True,
        timeout=60,
    )
    required = {
        "parser_validation_config",
        "parser_validation_samples",
        "parser_validation_results",
    }
    if require_exclusions:
        required.add("parser_validation_exclusions")
    actual = {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    missing = sorted(required - actual)
    if missing:
        connection.close()
        raise ValueError(f"state is missing tables: {', '.join(missing)}")
    return connection


def audit_rotation(
    *,
    previous_state: Path,
    current_state: Path,
    publisher: str,
    expected_parser_version: str,
    from_year: int,
    to_year: int,
    target_per_year: int = 800,
    expected_previous_source_cohort: str | None = None,
    require_complete: bool = False,
) -> dict[str, object]:
    if from_year > to_year:
        raise ValueError("from_year must not exceed to_year")
    if target_per_year < 1:
        raise ValueError("target_per_year must be positive")

    issues: list[str] = []
    years: dict[str, object] = {}
    with ExitStack() as stack:
        previous_path = _materialize_state(previous_state, stack=stack)
        current_path = _materialize_state(current_state, stack=stack)
        previous = stack.enter_context(
            _closing_connection(previous_path, require_exclusions=False)
        )
        current = stack.enter_context(_closing_connection(current_path))

        source_spec = archive_source_spec(publisher)

        def identity(url: object) -> str:
            value = str(url)
            return article_deduplication_key(source_spec, value) or value

        all_exclusions: dict[str, set[str]] = {}
        for canonical_url, source_cohort in current.execute(
                "SELECT canonical_url, source_cohort "
                "FROM parser_validation_exclusions"
        ):
            all_exclusions.setdefault(identity(canonical_url), set()).add(
                str(source_cohort)
            )
        for year in range(from_year, to_year + 1):
            previous_config = previous.execute(
                "SELECT target_size, parser_version "
                "FROM parser_validation_config WHERE sample_year=?",
                (year,),
            ).fetchone()
            current_config = current.execute(
                "SELECT target_size, parser_version "
                "FROM parser_validation_config WHERE sample_year=?",
                (year,),
            ).fetchone()
            previous_evaluated = {
                identity(row[0])
                for row in previous.execute(
                    """
                    SELECT sample.canonical_url
                    FROM parser_validation_samples AS sample
                    WHERE sample.sample_year=?
                      AND EXISTS (
                        SELECT 1
                        FROM parser_validation_results AS result
                        WHERE result.canonical_url=sample.canonical_url
                          AND result.sample_year=sample.sample_year
                      )
                    """,
                    (year,),
                )
            }
            current_samples = {
                identity(row[0])
                for row in current.execute(
                    "SELECT canonical_url FROM parser_validation_samples "
                    "WHERE sample_year=?",
                    (year,),
                )
            }
            current_evaluated = int(
                current.execute(
                    """
                    SELECT COUNT(*)
                    FROM parser_validation_samples AS sample
                    JOIN parser_validation_results AS result
                      ON result.canonical_url=sample.canonical_url
                     AND result.sample_year=sample.sample_year
                    WHERE sample.sample_year=?
                      AND result.parser_version=?
                    """,
                    (year, expected_parser_version),
                ).fetchone()[0]
            )
            cohort_overlap = previous_evaluated & current_samples
            excluded_identities = set(all_exclusions)
            exclusion_overlap = current_samples & excluded_identities
            missing_exclusions = previous_evaluated - excluded_identities
            wrong_labels: list[str] = []

            previous_version = (
                str(previous_config[1]) if previous_config is not None else ""
            )
            expected_label = expected_previous_source_cohort or (
                f"{publisher}:{year}:{previous_version}"
            )
            for article_identity in sorted(
                previous_evaluated - missing_exclusions
            ):
                if expected_label not in all_exclusions[article_identity]:
                    wrong_labels.append(article_identity)

            if previous_config is None:
                issues.append(f"{year}:missing-previous-config")
            if current_config is None:
                issues.append(f"{year}:missing-current-config")
            else:
                if int(current_config[0]) != target_per_year:
                    issues.append(f"{year}:target-size-mismatch")
                if str(current_config[1]) != expected_parser_version:
                    issues.append(f"{year}:parser-version-mismatch")
            if not previous_evaluated:
                issues.append(f"{year}:no-previous-evaluated-samples")
            if not current_samples:
                issues.append(f"{year}:no-current-samples")
            if require_complete and current_evaluated < target_per_year:
                issues.append(f"{year}:current-evaluated-below-target")
            if cohort_overlap:
                issues.append(f"{year}:prior-cohort-overlap")
            if exclusion_overlap:
                issues.append(f"{year}:exclusion-overlap")
            if missing_exclusions:
                issues.append(f"{year}:missing-prior-exclusions")
            if wrong_labels:
                issues.append(f"{year}:wrong-exclusion-cohort-label")

            years[str(year)] = {
                "previousParserVersion": previous_version or None,
                "previousEvaluated": len(previous_evaluated),
                "currentParserVersion": (
                    str(current_config[1]) if current_config is not None else None
                ),
                "currentPlanned": len(current_samples),
                "currentEvaluated": current_evaluated,
                "priorCohortOverlap": len(cohort_overlap),
                "exclusionOverlap": len(exclusion_overlap),
                "missingPriorExclusions": len(missing_exclusions),
                "wrongExclusionCohortLabels": len(wrong_labels),
            }

    return {
        "formatVersion": "jojo-parser-validation-rotation-audit/2",
        "publisher": publisher,
        "expectedParserVersion": expected_parser_version,
        "expectedPreviousSourceCohort": expected_previous_source_cohort,
        "targetPerYear": target_per_year,
        "requireComplete": require_complete,
        "passed": not issues,
        "issues": issues,
        "years": years,
    }


class _closing_connection:
    def __init__(self, path: Path, *, require_exclusions: bool = True):
        self.path = path
        self.require_exclusions = require_exclusions
        self.connection: sqlite3.Connection | None = None

    def __enter__(self) -> sqlite3.Connection:
        self.connection = _connect_read_only(
            self.path,
            require_exclusions=self.require_exclusions,
        )
        return self.connection

    def __exit__(self, *args: object) -> None:
        if self.connection is not None:
            self.connection.close()


def main() -> int:
    args = parse_args()
    try:
        result = audit_rotation(
            previous_state=args.previous_state,
            current_state=args.current_state,
            publisher=args.publisher,
            expected_parser_version=args.expected_parser_version,
            from_year=args.from_year,
            to_year=args.to_year,
            target_per_year=args.target_per_year,
            expected_previous_source_cohort=(
                args.expected_previous_source_cohort
            ),
            require_complete=args.require_complete,
        )
    except (OSError, sqlite3.Error, ValueError) as exc:
        result = {
            "formatVersion": "jojo-parser-validation-rotation-audit/2",
            "passed": False,
            "issues": [f"{type(exc).__name__}:{exc}"],
        }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result.get("passed") is True else 2


if __name__ == "__main__":
    raise SystemExit(main())
