from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.parser_validation_watchdog import (
    plan_validation_dispatch,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Plan missing per-year parser-validation jobs from B2 summaries."
        )
    )
    parser.add_argument("--state-root", type=Path, required=True)
    parser.add_argument("--active-titles", type=Path, required=True)
    parser.add_argument(
        "--available-source-shards",
        type=Path,
        help=(
            "Optional newline-delimited source-manifest shards confirmed "
            "readable from B2."
        ),
    )
    parser.add_argument(
        "--source-capacity-root",
        type=Path,
        help=(
            "Optional root containing <source-shard>/manifest-summary.json "
            "capacity sidecars."
        ),
    )
    parser.add_argument("--max-dispatch", type=int, required=True)
    parser.add_argument(
        "--publishers",
        nargs="+",
        help=(
            "Optional explicit publisher subset to schedule. The planner's "
            "default remains the full supported set."
        ),
    )
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    titles = (
        args.active_titles.read_text(encoding="utf-8").splitlines()
        if args.active_titles.is_file()
        else []
    )
    plan = plan_validation_dispatch(
        state_root=args.state_root,
        active_titles=titles,
        max_dispatch=args.max_dispatch,
        publishers=args.publishers,
        available_source_shards=(
            args.available_source_shards.read_text(encoding="utf-8").splitlines()
            if args.available_source_shards is not None
            and args.available_source_shards.is_file()
            else None
        ),
        source_year_capacities=_load_source_year_capacities(
            args.source_capacity_root
        ),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(args.output)
    print(
        json.dumps(
            {
                "targetCells": plan["targetCells"],
                "readyCells": plan["readyCells"],
                "activeCells": plan["activeCells"],
                "pendingCells": plan["pendingCells"],
                "dispatches": len(plan["tasks"]),
                "unresolved": [
                    row
                    for row in plan["cellProgress"]
                    if not row["ready"]
                ],
            },
            ensure_ascii=False,
        )
    )
    return 0


def _load_source_year_capacities(
    root: Path | None,
) -> dict[str, dict[int, int]] | None:
    if root is None or not root.is_dir():
        return None
    capacities: dict[str, dict[int, int]] = {}
    for path in sorted(root.rglob("*manifest-summary.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("formatVersion") != "jojo-capture-manifest-summary/1":
            raise ValueError(f"unsupported capacity summary: {path}")
        year_counts = payload.get("yearCounts")
        if not isinstance(year_counts, dict):
            raise ValueError(f"capacity summary has no yearCounts: {path}")
        shard = path.parent.relative_to(root).as_posix()
        publisher = shard.split("/", 1)[0]
        if payload.get("publisher") != publisher:
            raise ValueError(f"capacity summary publisher mismatch: {path}")
        shard_capacities = capacities.setdefault(shard, {})
        for year, count in year_counts.items():
            if str(year).isdigit() and int(count) >= 0:
                year_number = int(year)
                shard_capacities[year_number] = max(
                    shard_capacities.get(year_number, 0),
                    int(count),
                )
    return capacities


if __name__ == "__main__":
    raise SystemExit(main())
