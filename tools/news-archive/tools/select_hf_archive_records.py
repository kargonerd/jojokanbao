from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_news_archive.migration.records import write_record_list


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Select deterministic historical capture records from an exact HF file set."
    )
    parser.add_argument("--file-set", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--seed", default="jojo-archive-canary-v1")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    records = write_record_list(
        file_set_path=args.file_set,
        output=args.output,
        limit=args.limit,
        seed=args.seed,
    )
    print(
        json.dumps(
            {"output": str(args.output.resolve()), "records": len(records)},
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
