from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Plan or report a resumable Bloomberg GitHub Actions batch."
    )
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--max-record-attempts", type=int, default=3)
    parser.add_argument("--github-output", type=Path)
    return parser.parse_args()


def action_state(
    state_path: Path,
    *,
    maximum_record_attempts: int,
) -> dict[str, object]:
    if maximum_record_attempts < 1:
        raise ValueError("maximum_record_attempts must be positive")
    if not state_path.exists():
        return {
            "stateExists": False,
            "articlesByStatus": {},
            "retryErrors": False,
            "actionable": 1,
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
                "SELECT status, COUNT(*) FROM articles GROUP BY status"
            ).fetchall()
        )
        recoverable = connection.execute(
            """
            SELECT COUNT(*)
            FROM articles
            WHERE status IN ('error', 'partial') AND attempts < ?
            """,
            (maximum_record_attempts,),
        ).fetchone()[0]
    finally:
        connection.close()

    pending = counts.get("pending", 0)
    downloading = counts.get("downloading", 0)
    unresolved = counts.get("error", 0) + counts.get("partial", 0)
    actionable = pending + downloading + recoverable
    return {
        "stateExists": True,
        "articlesByStatus": counts,
        "retryErrors": pending == 0 and downloading == 0 and recoverable > 0,
        "actionable": actionable,
        "terminalUnresolved": max(0, unresolved - recoverable),
        "shouldContinue": actionable > 0,
    }


def write_github_output(path: Path, result: dict[str, object]) -> None:
    values = {
        "retry_errors": str(bool(result["retryErrors"])).lower(),
        "should_continue": str(bool(result["shouldContinue"])).lower(),
        "actionable": str(result["actionable"]),
        "terminal_unresolved": str(result["terminalUnresolved"]),
    }
    with path.open("a", encoding="utf-8") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


def main() -> int:
    args = parse_args()
    result = action_state(
        args.state,
        maximum_record_attempts=args.max_record_attempts,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    if args.github_output:
        write_github_output(args.github_output, result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
