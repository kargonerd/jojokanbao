from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Plan or report a resumable raw-capture Actions batch."
    )
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--max-record-attempts", type=int, default=3)
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--stop-at-validation-target", action="store_true")
    return parser.parse_args()


def action_state(
    state_path: Path,
    *,
    maximum_record_attempts: int,
    stop_at_validation_target: bool = False,
) -> dict[str, object]:
    if maximum_record_attempts < 1:
        raise ValueError("maximum_record_attempts must be positive")
    if not state_path.exists():
        return {
            "stateExists": False,
            "capturesByStatus": {},
            "retryErrors": False,
            "actionable": 1,
            "validationReady": False,
            "parserValidation": {"years": []},
            "terminalUnresolved": 0,
            "shouldContinue": True,
        }
    connection = sqlite3.connect(
        f"file:{state_path.resolve().as_posix()}?mode=ro",
        uri=True,
        timeout=30,
    )
    try:
        counts = dict(
            connection.execute(
                "SELECT status, COUNT(*) FROM captures GROUP BY status"
            ).fetchall()
        )
        recoverable = connection.execute(
            """
            SELECT COUNT(*)
            FROM captures
            WHERE status='error' AND attempts < ?
            """,
            (maximum_record_attempts,),
        ).fetchone()[0]
        validation_replays = 0
        validation_capture_actionable: int | None = None
        validation_ready = False
        validation_target_reached = False
        validation_by_year: list[dict[str, object]] = []
        validation_tables = {
            str(row[0])
            for row in connection.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type='table'
                  AND name IN (
                    'parser_validation_config',
                    'parser_validation_samples',
                    'parser_validation_results'
                  )
                """
            ).fetchall()
        }
        if len(validation_tables) == 3:
            config_columns = {
                str(row[1])
                for row in connection.execute(
                    "PRAGMA table_info(parser_validation_config)"
                ).fetchall()
            }
            result_columns = {
                str(row[1])
                for row in connection.execute(
                    "PRAGMA table_info(parser_validation_results)"
                ).fetchall()
            }
            has_qa_revision = (
                "qa_revision" in config_columns
                and "qa_revision" in result_columns
            )
            qa_result_join = (
                "AND result.qa_revision=config.qa_revision"
                if has_qa_revision
                else ""
            )
            qa_active_select = (
                ", config.qa_revision" if has_qa_revision else ""
            )
            qa_active_group = qa_active_select
            qa_sample_join = (
                "AND result.qa_revision=active_years.qa_revision"
                if has_qa_revision
                else ""
            )
            validation_capture_actionable = int(
                connection.execute(
                    f"""
                    SELECT COUNT(*)
                    FROM parser_validation_samples AS sample
                    JOIN parser_validation_config AS config
                      ON config.sample_year=sample.sample_year
                    JOIN captures AS capture
                      ON capture.canonical_url=sample.canonical_url
                    LEFT JOIN parser_validation_results AS result
                      ON result.canonical_url=sample.canonical_url
                     AND result.parser_version=config.parser_version
                     {qa_result_join}
                    WHERE result.canonical_url IS NULL
                      AND (
                        capture.status IN ('pending', 'downloading')
                        OR (
                          capture.status='error'
                          AND capture.attempts < ?
                        )
                      )
                    """,
                    (maximum_record_attempts,),
                ).fetchone()[0]
            )
            unbound_expression = (
                "COALESCE(SUM(result.source_capture_sha256 IS NULL), 0)"
                if "source_capture_sha256" in result_columns
                else "0"
            )
            article_result_expression = (
                "NOT EXISTS ("
                "SELECT 1 FROM json_each(result.issues_json) "
                "WHERE value IN ("
                "'empty-nontext-content','nonarticle-desk',"
                "'publication-year-mismatch'"
                "))"
                if "issues_json" in result_columns
                else "1"
            )
            readiness_columns = {
                "canonical_url",
                "sample_year",
                "parser_version",
                "extraction_status",
                "qa_pass",
            }
            if readiness_columns.issubset(result_columns):
                readiness_rows = connection.execute(
                    f"""
                    SELECT
                        config.sample_year,
                        config.target_size,
                        config.parser_version,
                        COALESCE(SUM(
                            result.canonical_url IS NOT NULL
                            AND {article_result_expression}
                        ), 0) AS evaluated,
                        COALESCE(SUM(result.qa_pass), 0) AS qa_passed,
                        COALESCE(
                            SUM(
                                result.extraction_status='complete'
                                AND {article_result_expression}
                            ),
                            0
                        ) AS complete,
                        COALESCE(
                            SUM(result.extraction_status='error'),
                            0
                        ) AS parser_errors,
                        {unbound_expression} AS unbound_capture_inputs
                    FROM parser_validation_config AS config
                    LEFT JOIN parser_validation_results AS result
                      ON result.sample_year=config.sample_year
                     AND result.parser_version=config.parser_version
                     {qa_result_join}
                    GROUP BY
                        config.sample_year,
                        config.target_size,
                        config.parser_version
                        {qa_active_group}
                    ORDER BY config.sample_year
                    """
                ).fetchall()
                for (
                    sample_year,
                    target_size,
                    parser_version,
                    evaluated,
                    qa_passed,
                    complete,
                    parser_errors,
                    unbound_capture_inputs,
                ) in readiness_rows:
                    evaluated_int = int(evaluated)
                    target_int = int(target_size)
                    qa_passed_int = int(qa_passed)
                    complete_int = int(complete)
                    parser_errors_int = int(parser_errors)
                    unbound_int = int(unbound_capture_inputs)
                    validation_by_year.append(
                        {
                            "sampleYear": int(sample_year),
                            "target": target_int,
                            "parserVersion": str(parser_version),
                            "evaluated": evaluated_int,
                            "qaPassed": qa_passed_int,
                            "complete": complete_int,
                            "parserErrors": parser_errors_int,
                            "unboundCaptureInputs": unbound_int,
                            "qaPassRate": (
                                round(qa_passed_int / evaluated_int, 4)
                                if evaluated_int
                                else 0.0
                            ),
                            "completeRate": (
                                round(complete_int / evaluated_int, 4)
                                if evaluated_int
                                else 0.0
                            ),
                            "targetReached": (
                                qa_passed_int >= target_int
                                and unbound_int == 0
                            ),
                        }
                    )
                validation_ready = bool(readiness_rows) and all(
                    int(qa_passed) >= int(target_size)
                    and int(complete) >= int(target_size)
                    and int(parser_errors) == 0
                    and int(unbound_capture_inputs) == 0
                    for (
                        _sample_year,
                        target_size,
                        _parser_version,
                        evaluated,
                        qa_passed,
                        complete,
                        parser_errors,
                        unbound_capture_inputs,
                    ) in readiness_rows
                )
                validation_target_reached = bool(readiness_rows) and all(
                    int(qa_passed) >= int(target_size)
                    and int(unbound_capture_inputs) == 0
                    for (
                        _sample_year,
                        target_size,
                        _parser_version,
                        _evaluated,
                        qa_passed,
                        _complete,
                        _parser_errors,
                        unbound_capture_inputs,
                    ) in readiness_rows
                )
            validation_replays = int(
                connection.execute(
                    f"""
                    WITH active_years AS (
                        SELECT
                            config.sample_year,
                            config.target_size,
                            config.parser_version
                            {qa_active_select}
                        FROM parser_validation_config AS config
                        LEFT JOIN parser_validation_results AS result
                         ON result.sample_year=config.sample_year
                         AND result.parser_version=config.parser_version
                         {qa_result_join}
                        GROUP BY
                            config.sample_year,
                            config.target_size,
                            config.parser_version
                            {qa_active_group}
                        HAVING COUNT(result.canonical_url)
                             < config.target_size
                    )
                    SELECT COUNT(*)
                    FROM parser_validation_samples AS sample
                    JOIN active_years
                      ON active_years.sample_year=sample.sample_year
                    JOIN captures AS capture
                      ON capture.canonical_url=sample.canonical_url
                    LEFT JOIN parser_validation_results AS result
                     ON result.canonical_url=sample.canonical_url
                     AND result.parser_version=active_years.parser_version
                     {qa_sample_join}
                    WHERE result.canonical_url IS NULL
                      AND capture.status='complete'
                      AND capture.raw_path IS NOT NULL
                    """
                ).fetchone()[0]
            )
    finally:
        connection.close()
    pending = counts.get("pending", 0)
    downloading = counts.get("downloading", 0)
    unresolved = counts.get("error", 0)
    actionable = (
        validation_capture_actionable + validation_replays
        if validation_capture_actionable is not None
        else pending + downloading + recoverable
    )
    return {
        "stateExists": True,
        "capturesByStatus": counts,
        "retryErrors": pending == 0 and downloading == 0 and recoverable > 0,
        "actionable": actionable,
        "validationReplays": validation_replays,
        "validationReady": validation_ready,
        "validationTargetReached": validation_target_reached,
        "parserValidation": {"years": validation_by_year},
        "terminalUnresolved": max(0, unresolved - recoverable),
        "shouldContinue": (
            actionable > 0
            and not validation_ready
            and not (
                stop_at_validation_target
                and validation_target_reached
            )
        ),
    }


def write_github_output(path: Path, result: dict[str, object]) -> None:
    values = {
        "retry_errors": str(bool(result["retryErrors"])).lower(),
        "should_continue": str(bool(result["shouldContinue"])).lower(),
        "actionable": str(result["actionable"]),
        "terminal_unresolved": str(result["terminalUnresolved"]),
        "validation_replays": str(result.get("validationReplays", 0)),
        "validation_ready": str(
            bool(result.get("validationReady", False))
        ).lower(),
        "validation_target_reached": str(
            bool(result.get("validationTargetReached", False))
        ).lower(),
    }
    with path.open("a", encoding="utf-8") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


def main() -> int:
    args = parse_args()
    result = action_state(
        args.state,
        maximum_record_attempts=args.max_record_attempts,
        stop_at_validation_target=args.stop_at_validation_target,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    if args.github_output:
        write_github_output(args.github_output, result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
