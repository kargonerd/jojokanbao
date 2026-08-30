from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
import re
import sys
from typing import Iterable


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.archive_sources import (
    archive_source_spec,
    normalize_article_url,
)
from jojo_olds_api.wayback_manifest import infer_published_at


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Filter an existing archive manifest to one publication window "
            "without rediscovering its source catalog."
        )
    )
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--from-year", type=int, required=True)
    parser.add_argument("--to-year", type=int, required=True)
    return parser.parse_args()


def filter_archive_manifest(
    source: Path,
    destination: Path,
    *,
    publisher: str,
    from_year: int,
    to_year: int,
) -> dict[str, int | str]:
    if from_year > to_year:
        raise ValueError("from_year must not exceed to_year")
    if source.resolve() == destination.resolve():
        raise ValueError("input and output manifests must be different")
    if not source.exists():
        raise FileNotFoundError(source)

    start = f"{from_year:04d}-01-01"
    end = f"{to_year + 1:04d}-01-01"
    seen = 0
    selected = 0
    selected_before_collapse = 0
    missing_publication_date = 0
    corrected_publication_date = 0
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    opener = gzip.open if destination.suffix == ".gz" else open
    caixin_rows: dict[str, dict[str, object]] = {}
    source_spec = archive_source_spec(publisher)
    with opener(temporary, "wt", encoding="utf-8") as handle:
        for row in _read_jsonl(source):
            seen += 1
            row_publisher = str(
                row.get("publisher") or publisher
            ).strip().casefold()
            if row_publisher != publisher.casefold():
                raise ValueError(
                    "manifest publisher "
                    f"{row_publisher!r} does not match {publisher!r}"
                )
            canonical_url = str(
                row.get("canonical_url")
                or row.get("canonicalUrl")
                or row.get("url")
                or ""
            ).strip()
            manifest_published_at = str(
                row.get("published_at")
                or row.get("publishedAt")
                or row.get("catalog_date")
                or ""
            ).strip()
            inferred_published_at = infer_published_at(canonical_url)
            published_at = str(
                inferred_published_at
                if (
                    publisher.casefold() in {"reuters", "wsj"}
                    and inferred_published_at is not None
                )
                else manifest_published_at or inferred_published_at or ""
            ).strip()
            if not published_at:
                missing_publication_date += 1
                continue
            if not start <= published_at < end:
                continue
            selected_before_collapse += 1
            if published_at != manifest_published_at:
                row = dict(row)
                if "published_at" in row:
                    row["published_at"] = published_at
                elif "catalog_date" in row:
                    row["catalog_date"] = published_at
                else:
                    row["publishedAt"] = published_at
                corrected_publication_date += 1
            if publisher.casefold() == "caixin":
                normalized_url = normalize_article_url(
                    source_spec,
                    canonical_url,
                )
                if normalized_url is None:
                    continue
                row = dict(row)
                row.pop("canonical_url", None)
                row.pop("url", None)
                row["canonicalUrl"] = normalized_url
                existing = caixin_rows.get(normalized_url)
                if existing is None:
                    row["candidates"] = _sorted_caixin_candidates(
                        _candidates(row)
                    )
                    caixin_rows[normalized_url] = row
                else:
                    existing["candidates"] = _sorted_caixin_candidates(
                        [
                            *_candidates(existing),
                            *_candidates(row),
                        ]
                    )
                continue
            handle.write(
                json.dumps(
                    row,
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                + "\n"
            )
            selected += 1
        if publisher.casefold() == "caixin":
            for canonical_url in sorted(caixin_rows):
                handle.write(
                    json.dumps(
                        caixin_rows[canonical_url],
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    + "\n"
                )
            selected = len(caixin_rows)
    if selected == 0:
        temporary.unlink(missing_ok=True)
        raise ValueError(
            f"manifest has no {publisher} rows from {from_year} to {to_year}"
        )
    temporary.replace(destination)
    return {
        "publisher": publisher,
        "fromYear": from_year,
        "toYear": to_year,
        "rowsSeen": seen,
        "rowsSelected": selected,
        "rowsCollapsed": selected_before_collapse - selected,
        "rowsMissingPublicationDate": missing_publication_date,
        "rowsPublicationDateCorrected": corrected_publication_date,
        "output": str(destination),
    }


def _candidates(row: dict[str, object]) -> list[dict[str, object]]:
    values = row.get("candidates")
    if not isinstance(values, list):
        return []
    return [value for value in values if isinstance(value, dict)]


def _sorted_caixin_candidates(
    candidates: list[dict[str, object]],
) -> list[dict[str, object]]:
    unique: dict[tuple[str, ...], dict[str, object]] = {}
    for candidate in candidates:
        identity = tuple(
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
        unique.setdefault(identity, candidate)

    def priority(candidate: dict[str, object]) -> int:
        source = str(
            candidate.get("snapshotUrl")
            or candidate.get("sourceUrl")
            or ""
        ).casefold()
        if re.search(r"_all\.html(?:[?#/]|$)", source):
            return 0
        if re.search(r"_\d+\.html(?:[?#/]|$)", source):
            return 2
        return 1

    return sorted(unique.values(), key=priority)


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
                    f"invalid JSON on manifest line {line_number}"
                ) from exc
            if not isinstance(row, dict):
                raise ValueError(
                    f"manifest line {line_number} must be an object"
                )
            yield row


def main() -> int:
    args = parse_args()
    result = filter_archive_manifest(
        args.input,
        args.output,
        publisher=args.publisher,
        from_year=args.from_year,
        to_year=args.to_year,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
