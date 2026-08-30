from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
from typing import Iterable


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Merge archive manifests by canonical URL while preserving all "
            "distinct capture candidates."
        )
    )
    parser.add_argument("--input", action="append", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--publisher", required=True)
    return parser.parse_args()


def merge_archive_manifests(
    sources: list[Path],
    destination: Path,
    *,
    publisher: str,
) -> dict[str, object]:
    if not sources:
        raise ValueError("at least one input manifest is required")
    destination_resolved = destination.resolve()
    if any(source.resolve() == destination_resolved for source in sources):
        raise ValueError("output manifest must differ from every input")

    rows_by_url: dict[str, dict[str, object]] = {}
    input_rows = 0
    duplicate_rows = 0
    candidates_added = 0
    duplicate_candidates = 0
    for source in sources:
        if not source.exists():
            raise FileNotFoundError(source)
        for row in _read_jsonl(source):
            input_rows += 1
            row_publisher = str(
                row.get("publisher") or publisher
            ).strip().casefold()
            if row_publisher != publisher.casefold():
                raise ValueError(
                    f"manifest publisher {row_publisher!r} does not match "
                    f"{publisher!r}"
                )
            canonical_url = str(
                row.get("canonicalUrl")
                or row.get("canonical_url")
                or row.get("url")
                or ""
            ).strip()
            if not canonical_url:
                raise ValueError("manifest row has no canonical URL")
            existing = rows_by_url.get(canonical_url)
            if existing is None:
                stored = dict(row)
                stored["candidates"] = list(_candidates(row))
                rows_by_url[canonical_url] = stored
                candidates_added += len(stored["candidates"])
                continue

            duplicate_rows += 1
            existing_candidates = list(_candidates(existing))
            identities = {
                _candidate_identity(candidate)
                for candidate in existing_candidates
            }
            for candidate in _candidates(row):
                identity = _candidate_identity(candidate)
                if identity in identities:
                    duplicate_candidates += 1
                    continue
                identities.add(identity)
                existing_candidates.append(candidate)
                candidates_added += 1
            existing["candidates"] = existing_candidates
            _fill_missing_metadata(existing, row)

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    opener = gzip.open if destination.suffix == ".gz" else open
    with opener(temporary, "wt", encoding="utf-8") as handle:
        for canonical_url in sorted(rows_by_url):
            handle.write(
                json.dumps(
                    rows_by_url[canonical_url],
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                + "\n"
            )
    temporary.replace(destination)
    return {
        "publisher": publisher,
        "inputs": [str(source) for source in sources],
        "inputRows": input_rows,
        "outputRows": len(rows_by_url),
        "duplicateRows": duplicate_rows,
        "candidates": candidates_added,
        "duplicateCandidates": duplicate_candidates,
        "output": str(destination),
    }


def _read_jsonl(path: Path) -> Iterable[dict[str, object]]:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"invalid JSON on manifest line {line_number} of {path}"
                ) from exc
            if not isinstance(row, dict):
                raise ValueError(
                    f"manifest line {line_number} of {path} must be an object"
                )
            yield row


def _candidates(row: dict[str, object]) -> Iterable[dict[str, object]]:
    candidates = row.get("candidates")
    if not isinstance(candidates, list):
        return ()
    return (
        candidate
        for candidate in candidates
        if isinstance(candidate, dict)
    )


def _candidate_identity(candidate: dict[str, object]) -> tuple[str, ...]:
    return tuple(
        str(candidate.get(key) or "")
        for key in (
            "provider",
            "snapshotUrl",
            "sourceUrl",
            "digest",
            "warcFilename",
            "warcOffset",
            "warcLength",
        )
    )


def _fill_missing_metadata(
    destination: dict[str, object],
    source: dict[str, object],
) -> None:
    for key in (
        "publishedAt",
        "published_at",
        "catalog_date",
        "section",
    ):
        if not destination.get(key) and source.get(key):
            destination[key] = source[key]


def main() -> int:
    args = parse_args()
    result = merge_archive_manifests(
        args.input,
        args.output,
        publisher=args.publisher,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
