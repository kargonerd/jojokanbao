from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.source_catalog_watchdog import (
    plan_source_catalog_dispatch,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Plan missing or incomplete source-catalog workflows."
    )
    parser.add_argument("--status-root", type=Path, required=True)
    parser.add_argument("--active-titles", type=Path, required=True)
    parser.add_argument("--available-source-shards", type=Path)
    parser.add_argument("--max-dispatch", type=int, required=True)
    parser.add_argument("--max-active-catalogs", type=int, default=1)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    plan = plan_source_catalog_dispatch(
        status_root=args.status_root,
        active_titles=(
            args.active_titles.read_text(encoding="utf-8").splitlines()
            if args.active_titles.is_file()
            else []
        ),
        available_source_shards=(
            args.available_source_shards.read_text(
                encoding="utf-8"
            ).splitlines()
            if args.available_source_shards is not None
            and args.available_source_shards.is_file()
            else None
        ),
        max_dispatch=args.max_dispatch,
        max_active_catalogs=args.max_active_catalogs,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(args.output)
    print(
        json.dumps(
            {
                "targetCatalogs": plan["targetCatalogs"],
                "completeCatalogs": plan["completeCatalogs"],
                "activeCatalogs": plan["activeCatalogs"],
                "pendingCatalogs": plan["pendingCatalogs"],
                "dispatches": len(plan["tasks"]),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
