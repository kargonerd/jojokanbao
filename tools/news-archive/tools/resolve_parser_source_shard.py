from __future__ import annotations

import argparse
from pathlib import Path
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.parser_source_shards import parser_source_manifest_shard


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--year", required=True, type=int)
    args = parser.parse_args()
    print(parser_source_manifest_shard(args.publisher, args.year))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
