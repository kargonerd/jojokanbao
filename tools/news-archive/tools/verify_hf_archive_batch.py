from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.hf_layout import verify_archive_batch


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Verify an exact four-phase HF archive batch before upload: "
            "inventory, hashes, gzip streams, SQLite integrity, and Raw references."
        )
    )
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument(
        "--manifest-dir",
        type=Path,
        required=True,
        help="Directory produced by prepare_hf_archive_batch.py.",
    )
    parser.add_argument(
        "--legacy-b2-prefix",
        default="",
        help="Optional B2 object prefix represented by --root.",
    )
    parser.add_argument(
        "--available-file-manifest",
        action="append",
        type=Path,
        default=[],
        help=(
            "Previously verified/uploaded file manifest whose object names may "
            "satisfy references from this batch. Repeat for multiple phases."
        ),
    )
    return parser.parse_args()


def verify(
    root: Path,
    manifest_dir: Path,
    *,
    legacy_b2_prefix: str = "",
    available_file_manifests: tuple[Path, ...] = (),
) -> dict[str, object]:
    return verify_archive_batch(
        root,
        manifest_dir,
        legacy_b2_prefix=legacy_b2_prefix,
        available_file_manifests=available_file_manifests,
    )


def main() -> int:
    args = parse_args()
    report = verify(
        args.root,
        args.manifest_dir,
        legacy_b2_prefix=args.legacy_b2_prefix,
        available_file_manifests=tuple(args.available_file_manifest),
    )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
