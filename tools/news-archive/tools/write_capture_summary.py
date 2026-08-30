from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.raw_archive_capture import capture_summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Write a current, read-only raw-capture summary."
    )
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--archive-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    state = args.state.resolve()
    connection = sqlite3.connect(
        f"file:{state.as_posix()}?mode=ro",
        uri=True,
        timeout=30,
    )
    try:
        summary = capture_summary(connection, output_dir=args.archive_root)
    finally:
        connection.close()

    destination = args.output
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(destination)
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
