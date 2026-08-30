from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_news_archive.migration.legacy_b2 import (
    PHASE_ORDER,
    load_file_set,
    prepare_archive_batch,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Inventory a downloaded legacy B2 archive directory and write "
            "four exact HF upload manifests in safe publication order."
        )
    )
    parser.add_argument(
        "--root",
        type=Path,
        required=True,
        help=(
            "Local inventory root. Every localPath in the generated manifests "
            "is relative to this directory."
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory for 01-immutable.json through 04-completion.json.",
    )
    parser.add_argument(
        "--legacy-b2-prefix",
        default="",
        help=(
            "Optional B2 object prefix represented by --root, for example "
            "news-archive when the local files begin at v1/ and v2/."
        ),
    )
    return parser.parse_args()


def prepare(
    root: Path,
    output_dir: Path,
    *,
    legacy_b2_prefix: str = "",
) -> dict[str, object]:
    manifests = prepare_archive_batch(
        root,
        output_dir,
        legacy_b2_prefix=legacy_b2_prefix,
    )
    phases: list[dict[str, object]] = []
    total_files = 0
    total_bytes = 0
    for phase in PHASE_ORDER:
        entries = load_file_set(manifests[phase])
        file_count = len(entries)
        byte_count = sum(entry.size for entry in entries)
        total_files += file_count
        total_bytes += byte_count
        phases.append(
            {
                "phase": phase.value,
                "fileManifest": str(manifests[phase]),
                "files": file_count,
                "bytes": byte_count,
            }
        )
    return {"files": total_files, "bytes": total_bytes, "phases": phases}


def main() -> int:
    args = parse_args()
    report = prepare(
        args.root,
        args.output_dir,
        legacy_b2_prefix=args.legacy_b2_prefix,
    )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
