from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.source_capture_import import (
    import_selected_source_captures,
)
from jojo_olds_api.parser_validation import DEFAULT_SEED


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Seed a yearly parser-validation state from completed captures "
            "in its source archive shard."
        )
    )
    parser.add_argument("--source-state", type=Path, required=True)
    parser.add_argument("--target-state", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--target-per-year", type=int, default=500)
    parser.add_argument("--reserve-per-year", type=int)
    parser.add_argument("--max-record-attempts", type=int, default=3)
    parser.add_argument("--seed", default=DEFAULT_SEED)
    parser.add_argument(
        "--reuse-target-plan",
        action="store_true",
        help=(
            "Reuse an already prepared target manifest and sampling plan. "
            "This avoids reloading a large manifest for each additional "
            "completed-capture index."
        ),
    )
    parser.add_argument("--files-from", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.source_state.exists():
        raise SystemExit(f"source state not found: {args.source_state}")
    args.target_state.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(args.source_state, timeout=60)
    target = sqlite3.connect(args.target_state, timeout=60)
    try:
        result = import_selected_source_captures(
            source_connection=source,
            target_connection=target,
            manifest_path=args.manifest,
            publisher=args.publisher,
            sample_year=args.year,
            target_per_year=args.target_per_year,
            reserve_per_year=args.reserve_per_year,
            maximum_record_attempts=args.max_record_attempts,
            seed=args.seed,
            reuse_target_plan=args.reuse_target_plan,
        )
    finally:
        source.close()
        target.close()
    args.files_from.parent.mkdir(parents=True, exist_ok=True)
    args.files_from.write_text(
        "".join(f"{path}\n" for path in result.pop("rawPaths")),
        encoding="utf-8",
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
