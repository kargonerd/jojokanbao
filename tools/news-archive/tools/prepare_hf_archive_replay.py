from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_news_archive.migration.replay import prepare_replay_layout


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Rewrite an exact migration file set for HF parser replay and optionally "
            "materialize its final object layout using hard links where possible."
        )
    )
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--file-set", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--output-file-set", type=Path, required=True)
    parser.add_argument("--materialize", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = prepare_replay_layout(
        source_root=args.source_root,
        file_set_path=args.file_set,
        workspace=args.workspace,
        output_file_set=args.output_file_set,
        materialize=args.materialize,
    )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
