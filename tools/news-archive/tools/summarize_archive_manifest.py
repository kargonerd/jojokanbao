from __future__ import annotations

import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
import re
from typing import Iterable


FORMAT_VERSION = "jojo-capture-manifest-summary/1"
PUBLICATION_YEAR_RE = re.compile(r"^((?:19|20)\d{2})-")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Write a small, manifest-bound per-year capacity summary for "
            "parser-validation scheduling."
        )
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def summarize_archive_manifest(
    manifest: Path,
    *,
    publisher: str,
) -> dict[str, object]:
    normalized_publisher = publisher.strip().casefold()
    if not normalized_publisher:
        raise ValueError("publisher must not be empty")
    digest = hashlib.sha256()
    with manifest.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)

    rows = 0
    candidates = 0
    missing_publication_date = 0
    invalid_publication_date = 0
    years: Counter[str] = Counter()
    for line_number, row in _read_rows(manifest):
        row_publisher = str(
            row.get("publisher") or normalized_publisher
        ).strip().casefold()
        if row_publisher != normalized_publisher:
            raise ValueError(
                f"manifest line {line_number} publisher {row_publisher!r} "
                f"does not match {normalized_publisher!r}"
            )
        canonical_url = str(
            row.get("canonicalUrl")
            or row.get("canonical_url")
            or row.get("url")
            or ""
        ).strip()
        if not canonical_url:
            raise ValueError(
                f"manifest line {line_number} has no canonical URL"
            )
        rows += 1
        row_candidates = row.get("candidates")
        if isinstance(row_candidates, list):
            candidates += sum(
                isinstance(candidate, dict)
                for candidate in row_candidates
            )
        raw_published = str(
            row.get("publishedAt") or row.get("published_at") or ""
        ).strip()
        if not raw_published:
            missing_publication_date += 1
            continue
        match = PUBLICATION_YEAR_RE.match(raw_published)
        if match is None:
            invalid_publication_date += 1
            continue
        years[match.group(1)] += 1

    return {
        "formatVersion": FORMAT_VERSION,
        "publisher": normalized_publisher,
        "manifestSha256": digest.hexdigest(),
        "manifestBytes": manifest.stat().st_size,
        "articles": rows,
        "candidates": candidates,
        "yearCounts": dict(sorted(years.items())),
        "missingPublicationDate": missing_publication_date,
        "invalidPublicationDate": invalid_publication_date,
    }


def write_manifest_summary(
    summary: dict[str, object],
    output: Path,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(output)


def _read_rows(path: Path) -> Iterable[tuple[int, dict[str, object]]]:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"invalid JSON on manifest line {line_number}"
                ) from exc
            if not isinstance(row, dict):
                raise ValueError(
                    f"manifest line {line_number} must be an object"
                )
            yield line_number, row


def main() -> int:
    args = parse_args()
    result = summarize_archive_manifest(
        args.manifest,
        publisher=args.publisher,
    )
    write_manifest_summary(result, args.output)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
