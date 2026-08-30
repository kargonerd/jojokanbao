from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path


FORMAT_VERSION = "jojo-source-catalog-status/1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Write an atomic source-catalog completion sidecar."
    )
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--from-year", type=int, required=True)
    parser.add_argument("--to-year", type=int, required=True)
    parser.add_argument("--manifest-mode", required=True)
    parser.add_argument("--complete", type=_boolean, required=True)
    parser.add_argument("--capture-ready", type=_boolean, required=True)
    parser.add_argument("--should-continue", type=_boolean, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def write_source_catalog_status(
    output: Path,
    *,
    publisher: str,
    from_year: int,
    to_year: int,
    manifest_mode: str,
    complete: bool,
    capture_ready: bool,
    should_continue: bool,
    updated_at: datetime | None = None,
) -> dict[str, object]:
    if from_year > to_year:
        raise ValueError("from_year must not exceed to_year")
    payload = {
        "formatVersion": FORMAT_VERSION,
        "publisher": publisher,
        "fromYear": from_year,
        "toYear": to_year,
        "manifestMode": manifest_mode,
        "complete": complete,
        "captureReady": capture_ready,
        "shouldContinue": should_continue,
        "updatedAt": (updated_at or datetime.now(timezone.utc)).isoformat(),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(output)
    return payload


def _boolean(value: str) -> bool:
    normalized = value.strip().casefold()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    raise argparse.ArgumentTypeError("expected true or false")


def main() -> int:
    args = parse_args()
    payload = write_source_catalog_status(
        args.output,
        publisher=args.publisher,
        from_year=args.from_year,
        to_year=args.to_year,
        manifest_mode=args.manifest_mode,
        complete=args.complete,
        capture_ready=args.capture_ready,
        should_continue=args.should_continue,
    )
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
