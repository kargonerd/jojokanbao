from __future__ import annotations

import argparse
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import sqlite3
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_news_archive.sources.registry import (
    archive_source_spec,
    article_deduplication_key,
)
from tools.audit_parser_validation_rotation import (
    _closing_connection,
    _materialize_state,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Prove that a completed holdout is disjoint from the union of "
            "every earlier parser-validation cohort."
        )
    )
    parser.add_argument(
        "--previous-state",
        action="append",
        default=[],
        metavar="LABEL=PATH",
        help="Repeat for every earlier cohort checkpoint.",
    )
    parser.add_argument("--current-state", type=Path, required=True)
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--expected-parser-version", required=True)
    parser.add_argument("--from-year", type=int, required=True)
    parser.add_argument("--to-year", type=int, required=True)
    parser.add_argument("--target-per-year", type=int, default=800)
    parser.add_argument("--require-complete", action="store_true")
    parser.add_argument(
        "--allow-empty-previous",
        action="store_true",
        help=(
            "Allow a first holdout cohort with no earlier state. The prior "
            "cohort union is treated as empty and still requires all current "
            "sample/parser gates."
        ),
    )
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def parse_previous_states(
    values: list[str],
    *,
    allow_empty: bool = False,
) -> tuple[tuple[str, Path], ...]:
    result: list[tuple[str, Path]] = []
    labels: set[str] = set()
    for value in values:
        label, separator, raw_path = value.partition("=")
        label = label.strip()
        raw_path = raw_path.strip()
        if not separator or not label or not raw_path:
            raise ValueError("previous state must use LABEL=PATH")
        if label in labels:
            raise ValueError(f"duplicate previous state label: {label}")
        labels.add(label)
        result.append((label, Path(raw_path)))
    if not result and not allow_empty:
        raise ValueError("at least one previous state is required")
    return tuple(result)


def audit_holdout(
    *,
    previous_states: tuple[tuple[str, Path], ...],
    current_state: Path,
    publisher: str,
    expected_parser_version: str,
    from_year: int,
    to_year: int,
    target_per_year: int = 800,
    require_complete: bool = False,
    allow_empty_previous: bool = False,
) -> dict[str, object]:
    if from_year > to_year:
        raise ValueError("from_year must not exceed to_year")
    if target_per_year < 1:
        raise ValueError("target_per_year must be positive")
    if not previous_states and not allow_empty_previous:
        raise ValueError("at least one previous state is required")

    issues: list[str] = []
    years: dict[str, object] = {}
    source_spec = archive_source_spec(publisher)

    def normalized(urls: set[str]) -> set[str]:
        return {
            article_deduplication_key(source_spec, url) or url
            for url in urls
        }

    with ExitStack() as stack:
        current_path = _materialize_state(current_state, stack=stack)
        current = stack.enter_context(_closing_connection(current_path))
        previous_connections = [
            (
                label,
                stack.enter_context(
                    _closing_connection(
                        _materialize_state(path, stack=stack),
                        require_exclusions=False,
                    )
                ),
            )
            for label, path in previous_states
        ]
        exclusions = {
            article_deduplication_key(source_spec, str(row[0]))
            or str(row[0]): str(row[1])
            for row in current.execute(
                "SELECT canonical_url, source_cohort "
                "FROM parser_validation_exclusions"
            )
        }
        for year in range(from_year, to_year + 1):
            previous_by_label: dict[str, set[str]] = {}
            previous_source_by_label: dict[str, str] = {}
            labels_by_url: dict[str, set[str]] = {}
            previous_versions: dict[str, str | None] = {}
            for label, connection in previous_connections:
                previous_urls = _accepted_cohort_urls(connection, year)
                previous_source = "accepted-results"
                if not previous_urls:
                    previous_urls = _retained_exclusion_cohort_urls(
                        connection,
                        label=label,
                        year=year,
                    )
                    if previous_urls:
                        previous_source = "retained-exclusions"
                previous_by_label[label] = normalized(previous_urls)
                previous_source_by_label[label] = previous_source
                config = connection.execute(
                    "SELECT parser_version FROM parser_validation_config "
                    "WHERE sample_year=?",
                    (year,),
                ).fetchone()
                previous_versions[label] = (
                    str(config[0]) if config is not None else None
                )
                for url in previous_by_label[label]:
                    labels_by_url.setdefault(url, set()).add(label)
            previous_union = set(labels_by_url)
            current_config = current.execute(
                "SELECT target_size, parser_version "
                "FROM parser_validation_config WHERE sample_year=?",
                (year,),
            ).fetchone()
            current_samples = normalized(
                {
                    str(row[0])
                    for row in current.execute(
                        "SELECT canonical_url FROM parser_validation_samples "
                        "WHERE sample_year=?",
                        (year,),
                    )
                }
            )
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
            cohort_overlap = previous_union & current_samples
            exclusion_overlap = current_samples & exclusions.keys()
            missing_exclusions = previous_union - exclusions.keys()
            wrong_labels = {
                url
                for url in previous_union - missing_exclusions
                if exclusions[url] not in labels_by_url[url]
            }

            # A source probe can be checkpointed as a previous cohort without
            # producing any accepted rows.  It contributes no URLs to the
            # zero-overlap union and must not block the first usable holdout.
            # Genuine prior rows are still checked for overlap and exclusions.
            if current_config is None:
                issues.append(f"{year}:missing-current-config")
            else:
                if int(current_config[0]) != target_per_year:
                    issues.append(f"{year}:target-size-mismatch")
                if str(current_config[1]) != expected_parser_version:
                    issues.append(f"{year}:parser-version-mismatch")
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
                "previousCohorts": {
                    label: {
                        "parserVersion": previous_versions[label],
                        "evaluated": len(urls),
                        "source": previous_source_by_label[label],
                    }
                    for label, urls in previous_by_label.items()
                },
                "previousUniqueEvaluated": len(previous_union),
                "previousUnionSha256": _url_fingerprint(previous_union),
                "currentParserVersion": (
                    str(current_config[1])
                    if current_config is not None
                    else None
                ),
                "currentPlanned": len(current_samples),
                "currentEvaluated": current_evaluated,
                "currentSampleSha256": _url_fingerprint(current_samples),
                "priorCohortOverlap": len(cohort_overlap),
                "exclusionOverlap": len(exclusion_overlap),
                "missingPriorExclusions": len(missing_exclusions),
                "wrongExclusionCohortLabels": len(wrong_labels),
            }

    return {
        "formatVersion": "jojo-parser-validation-holdout-audit/1",
        "publisher": publisher,
        "expectedParserVersion": expected_parser_version,
        "targetPerYear": target_per_year,
        "requireComplete": require_complete,
        "passed": not issues,
        "issues": issues,
        "years": years,
    }


def _accepted_cohort_urls(
    connection: sqlite3.Connection,
    year: int,
) -> set[str]:
    config = connection.execute(
        "SELECT target_size FROM parser_validation_config WHERE sample_year=?",
        (year,),
    ).fetchone()
    if config is None:
        return set()
    return {
        str(row[0])
        for row in connection.execute(
            """
            SELECT sample.canonical_url
            FROM parser_validation_samples AS sample
            JOIN parser_validation_results AS result
              ON result.canonical_url=sample.canonical_url
             AND result.sample_year=sample.sample_year
            WHERE sample.sample_year=? AND result.qa_pass=1
            ORDER BY sample.sample_priority
            LIMIT ?
            """,
            (year, int(config[0])),
        )
    }


def _retained_exclusion_cohort_urls(
    connection: sqlite3.Connection,
    *,
    label: str,
    year: int,
) -> set[str]:
    """Recover a compacted cohort whose evaluated URLs remain as exclusions."""

    tables = {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    if not {"captures", "parser_validation_exclusions"}.issubset(tables):
        return set()
    start = f"{year:04d}-01-01"
    end = f"{year + 1:04d}-01-01"
    return {
        str(row[0])
        for row in connection.execute(
            """
            SELECT exclusion.canonical_url
            FROM parser_validation_exclusions AS exclusion
            JOIN captures AS capture
              ON capture.canonical_url=exclusion.canonical_url
            WHERE exclusion.source_cohort=?
              AND capture.published_at >= ?
              AND capture.published_at < ?
            """,
            (label, start, end),
        )
    }


def _url_fingerprint(urls: set[str]) -> str:
    digest = hashlib.sha256()
    for url in sorted(urls):
        digest.update(url.encode())
        digest.update(b"\n")
    return digest.hexdigest()


def main() -> int:
    args = parse_args()
    try:
        result = audit_holdout(
            previous_states=parse_previous_states(
                args.previous_state,
                allow_empty=args.allow_empty_previous,
            ),
            current_state=args.current_state,
            publisher=args.publisher,
            expected_parser_version=args.expected_parser_version,
            from_year=args.from_year,
            to_year=args.to_year,
            target_per_year=args.target_per_year,
            require_complete=args.require_complete,
            allow_empty_previous=args.allow_empty_previous,
        )
    except (OSError, sqlite3.Error, ValueError) as exc:
        result = {
            "formatVersion": "jojo-parser-validation-holdout-audit/1",
            "passed": False,
            "issues": [f"{type(exc).__name__}:{exc}"],
        }
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0 if result.get("passed") is True else 2


if __name__ == "__main__":
    raise SystemExit(main())
