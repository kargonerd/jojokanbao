#!/usr/bin/env python3
"""Recover HF Canonical missing RMRB articles from the trusted legacy JSONL.

The input queue is the current HF-derived missing index, so already-published
manual repairs are never reprocessed.  Recovery is date/page bounded,
one-to-one, and uses the same conservative matcher as the canonical merge.
Only non-empty, unambiguous JSONL bodies become accept decisions.
"""
from __future__ import annotations

import argparse
import gzip
import json
from collections import Counter
from pathlib import Path
from typing import Any, Iterator, TextIO

from merge_rmrb_peopledata_xlsx import (
    character_bag,
    choose,
    has_content,
    indexed_candidates,
    iter_jsonl_by_date,
    norm,
    page_number,
    primary_title,
    title_indexes,
    title_variants,
)


PUBLISHABLE_METHODS = {
    "exact_title",
    "exact_primary_title",
    "exact_title_variant",
    "exact_title_characters",
}


def open_text(path: Path) -> TextIO:
    if path.suffix.lower() == ".gz":
        return gzip.open(path, "rt", encoding="utf-8-sig")
    return path.open("r", encoding="utf-8-sig")


def iter_missing_by_date(path: Path) -> Iterator[tuple[str, list[dict[str, Any]]]]:
    current = ""
    rows: list[dict[str, Any]] = []
    with open_text(path) as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            date = str(row.get("date") or "")[:10]
            if current and date < current:
                raise RuntimeError(f"Missing index is not date ordered at line {line_number}: {date}")
            if current and date != current:
                yield current, rows
                rows = []
            current = date
            rows.append(row)
    if current:
        yield current, rows


def reciprocal_match_count(
    method: str,
    selected: dict[str, Any],
    missing_rows: list[dict[str, Any]],
) -> int:
    """Count missing catalog rows that can claim the selected source equally exactly."""
    source_title = selected.get("title")
    if method == "exact_title":
        keys = {norm(source_title)}
    elif method == "exact_primary_title":
        keys = {norm(primary_title(source_title))}
    elif method == "exact_title_variant":
        keys = title_variants(source_title)
    elif method == "exact_title_characters":
        source_bag = character_bag(primary_title(source_title))
        return sum(character_bag(row.get("title")) == source_bag for row in missing_rows)
    else:
        return 0
    return sum(norm(row.get("title")) in keys for row in missing_rows)


def recover(source: Path, missing: Path, output: Path, report_path: Path) -> dict[str, Any]:
    output.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    source_iter = iter_jsonl_by_date(source)
    source_date, source_rows = next(source_iter, (None, []))
    counters: Counter[str] = Counter()
    with output.open("w", encoding="utf-8", newline="\n") as decisions:
        for missing_date, missing_rows in iter_missing_by_date(missing):
            while source_date is not None and source_date < missing_date:
                source_date, source_rows = next(source_iter, (None, []))
            candidates = source_rows if source_date == missing_date else []
            by_page: dict[int | None, list[dict[str, Any]]] = {}
            for row in candidates:
                by_page.setdefault(page_number(row.get("page")), []).append(row)
            indexes = {page: title_indexes(rows) for page, rows in by_page.items()}
            missing_by_page: dict[int | None, list[dict[str, Any]]] = {}
            for row in missing_rows:
                missing_by_page.setdefault(page_number(row.get("page")), []).append(row)
            used: set[int] = set()
            for row in missing_rows:
                counters["missingInputRows"] += 1
                page = page_number(row.get("page"))
                canonical = {"page": page, "title": str(row.get("title") or "")}
                page_rows = by_page.get(page, [])
                pool = indexed_candidates(canonical, page_rows, used, indexes.get(page, {}))
                selected, method = choose(canonical, pool)
                if selected is None or not has_content(selected):
                    counters[f"unresolved_{method}"] += 1
                    continue
                if method not in PUBLISHABLE_METHODS:
                    counters[f"withheld_{method}"] += 1
                    continue
                if reciprocal_match_count(method, selected, missing_by_page.get(page, [])) != 1:
                    counters[f"withheld_nonreciprocal_{method}"] += 1
                    continue
                used.add(id(selected))
                content = str(selected.get("content") or "").strip()
                decision = {
                    "date": missing_date,
                    "page": int(page or 0),
                    "peopleDataOrdinal": int(row["ordinal"]),
                    "title": str(row.get("title") or "").strip(),
                    "decision": "accept",
                    "content": content,
                    "reason": "Recovered from trusted legacy JSONL without changing PeopleData catalog metadata",
                    "recoverySource": "jsonl",
                    "matchMethod": method,
                    "sourceTitle": str(selected.get("title") or "").strip(),
                }
                decisions.write(json.dumps(decision, ensure_ascii=False) + "\n")
                counters["recoveredRows"] += 1
                counters[f"recovered_{method}"] += 1
            counters["processedDates"] += 1
    report = {
        "formatVersion": "jojo-rmrb-jsonl-recovery/1",
        "source": str(source.resolve()),
        "missingIndex": str(missing.resolve()),
        "output": str(output.resolve()),
        "counters": dict(sorted(counters.items())),
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--jsonl", type=Path, required=True)
    result.add_argument("--missing-index", type=Path, required=True)
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--report", type=Path, required=True)
    return result


def main() -> None:
    args = parser().parse_args()
    print(json.dumps(recover(args.jsonl, args.missing_index, args.output, args.report), ensure_ascii=False))


if __name__ == "__main__":
    main()
