from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_news_archive.migration.staging import stage_archive_batch


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Plan or stage one bounded legacy B2 batch. The remote is read-only; "
            "this command never writes to or deletes from B2."
        )
    )
    parser.add_argument("--legacy-b2-prefix", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--manifest-dir", type=Path, required=True)
    parser.add_argument("--max-files", type=int, default=2_500)
    parser.add_argument("--max-bytes", type=int, default=250_000_000)
    parser.add_argument("--transfers", type=int, default=16)
    parser.add_argument(
        "--available-file-manifest",
        action="append",
        type=Path,
        default=[],
        help="Previously verified v1 file set used to resolve v2 SQLite Raw references.",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Perform the bounded B2-to-local copy after the inventory gate.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = stage_archive_batch(
        legacy_b2_prefix=args.legacy_b2_prefix,
        output_dir=args.output_dir,
        manifest_dir=args.manifest_dir,
        max_files=args.max_files,
        max_bytes=args.max_bytes,
        transfers=args.transfers,
        available_file_manifests=tuple(args.available_file_manifest),
        execute=args.execute,
    )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
