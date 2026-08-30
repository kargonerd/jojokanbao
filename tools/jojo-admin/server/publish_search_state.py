"""Publish the complete ES exclusion state as one plain COS JSON object."""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from es_migrations import MIGRATIONS_DIR, write_search_state
from es_repair import repair_config


DEFAULT_KEY = "runtime/search/search-state.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--index",
        action="append",
        default=[],
        help="ES index; repeat for every index served by the SCF",
    )
    parser.add_argument("--bucket", default=os.getenv("SEARCH_STATE_COS_BUCKET", ""))
    parser.add_argument(
        "--region",
        default=os.getenv("SEARCH_STATE_COS_REGION", "ap-beijing"),
    )
    parser.add_argument("--key", default=os.getenv("SEARCH_STATE_COS_KEY", DEFAULT_KEY))
    parser.add_argument("--profile", default="", help="optional TCCLI profile")
    parser.add_argument("--migrations-dir", type=Path, default=MIGRATIONS_DIR)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    indices = [value.strip() for value in args.index if value.strip()]
    if not indices:
        indices = [repair_config()["index"]]
    with tempfile.TemporaryDirectory(prefix="jojo-search-state-") as temp:
        state_path = Path(temp) / "search-state.json"
        payload = write_search_state(state_path, indices, args.migrations_dir)
        count = sum(len(values) for values in payload["excludedIds"].values())
        if args.dry_run:
            print(state_path.read_text(encoding="utf-8"), end="")
            print(f"dry-run: indices={','.join(indices)}, excluded={count}")
            return 0

        if not args.bucket:
            parser.error("缺少 --bucket 或 SEARCH_STATE_COS_BUCKET")
        tccli = shutil.which("tccli")
        if not tccli:
            parser.error("未找到 tccli；请先安装并执行 tccli auth login")
        command = [
            tccli,
            "cos",
            "upload",
            "--bucket",
            args.bucket,
            "--region",
            args.region,
            "--local_path",
            str(state_path),
            "--cos_key",
            args.key.lstrip("/"),
            "--content_type",
            "application/json; charset=utf-8",
        ]
        if args.profile:
            command.extend(["--profile", args.profile])
        subprocess.run(command, check=True)
        print(
            f"published cos://{args.bucket}/{args.key.lstrip('/')} "
            f"(indices={','.join(indices)}, excluded={count})"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
