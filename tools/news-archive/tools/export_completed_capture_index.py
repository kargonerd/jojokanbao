from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.source_capture_import import (
    export_completed_capture_index,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Export a compact SQLite index of durable completed raw captures."
        )
    )
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.state.exists():
        raise SystemExit(f"capture state not found: {args.state}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(args.output.name + ".tmp")
    temporary.unlink(missing_ok=True)
    source_uri = f"{args.state.resolve().as_uri()}?mode=ro"
    source = sqlite3.connect(source_uri, uri=True, timeout=60)
    destination = sqlite3.connect(temporary, timeout=60)
    try:
        result = export_completed_capture_index(
            source_connection=source,
            destination_connection=destination,
        )
    finally:
        source.close()
        destination.close()
    os.replace(temporary, args.output)
    result["output"] = str(args.output)
    result["bytes"] = args.output.stat().st_size
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
