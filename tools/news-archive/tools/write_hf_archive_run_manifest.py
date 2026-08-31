from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_news_archive.migration.legacy_b2 import ArchivePhase
from jojo_news_archive.migration.run_manifest import write_archive_run_manifest


def _phase_revision(value: str) -> tuple[ArchivePhase, str]:
    phase_value, separator, revision = value.partition("=")
    if not separator:
        raise argparse.ArgumentTypeError("phase revisions use PHASE=SHA")
    try:
        phase = ArchivePhase(phase_value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"unsupported archive phase: {phase_value}") from error
    return phase, revision


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Write durable provenance for one uploaded historical Raw batch."
    )
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--manifest-dir", type=Path, required=True)
    parser.add_argument("--legacy-b2-prefix", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--created-at", required=True)
    parser.add_argument(
        "--phase-revision",
        type=_phase_revision,
        action="append",
        required=True,
        help="Uploaded phase commit in PHASE=SHA form; repeat for all four phases.",
    )
    parser.add_argument("--output-file-set", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    phase_revisions: dict[ArchivePhase, str] = {}
    for phase, revision in args.phase_revision:
        if phase in phase_revisions:
            raise ValueError(f"duplicate phase revision: {phase.value}")
        phase_revisions[phase] = revision
    report = write_archive_run_manifest(
        root=args.root,
        manifest_dir=args.manifest_dir,
        legacy_b2_prefix=args.legacy_b2_prefix,
        run_id=args.run_id,
        created_at=args.created_at,
        phase_revisions=phase_revisions,
        output_file_set=args.output_file_set,
    )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
