#!/usr/bin/env python3
"""Add every unrepresented legacy JSONL body without regressing Canonical rows.

The first PeopleData publication used permissive fuzzy matches.  Rebuilding it
with safer matching is useful for audit, but publishing that rebuild directly
would turn previously available rows back into ``missing``.  This migration is
therefore deliberately monotonic:

* keep every baseline directory row and its current body;
* overlay reviewed, exact JSONL recoveries on their PeopleData keys; and
* append any remaining JSONL body on the same date/page as ``sourceOnly``.

The report accounts for every non-empty JSONL row.  A non-zero orphan count is
fatal, so a trusted source body cannot silently disappear again.
"""
from __future__ import annotations

import argparse
from collections import Counter
from collections.abc import Iterator
import json
from pathlib import Path
from typing import Any, TextIO


ArticleKey = tuple[str, int, int]


def page_number(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def article_key(row: dict[str, Any]) -> ArticleKey:
    return (
        str(row.get("date") or "")[:10],
        page_number(row.get("page")),
        int(row.get("ordinal", row.get("peopleDataOrdinal", 0))),
    )


def iter_by_date(path: Path) -> Iterator[tuple[str, list[dict[str, Any]]]]:
    current_date: str | None = None
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8-sig") as stream:
        for line in stream:
            if not line.strip():
                continue
            row = json.loads(line)
            day = str(row.get("date") or "")[:10]
            if not day:
                raise ValueError(f"Row without date in {path}")
            if current_date is None:
                current_date = day
            elif day < current_date:
                raise ValueError(f"Input is not sorted by date: {path}: {day} < {current_date}")
            if day != current_date:
                yield current_date, rows
                current_date, rows = day, []
            rows.append(row)
    if current_date is not None:
        yield current_date, rows


def load_recoveries(path: Path) -> dict[ArticleKey, dict[str, Any]]:
    result: dict[ArticleKey, dict[str, Any]] = {}
    with path.open(encoding="utf-8-sig") as stream:
        for line in stream:
            if not line.strip():
                continue
            row = json.loads(line)
            if str(row.get("decision") or "").lower() != "accept":
                continue
            content = str(row.get("content") or "").strip()
            if not content:
                raise ValueError(f"Accepted recovery has no body: {article_key(row)}")
            key = article_key(row)
            if key in result and result[key]["content"] != content:
                raise ValueError(f"Conflicting recovery bodies for {key}")
            result[key] = row
    return result


def write_day(
    output: TextIO,
    source_only_output: TextIO | None,
    day: str,
    baseline_rows: list[dict[str, Any]],
    jsonl_rows: list[dict[str, Any]],
    recoveries: dict[ArticleKey, dict[str, Any]],
    counters: Counter[str],
) -> None:
    represented: Counter[tuple[int, str]] = Counter()
    next_ordinal = max((int(row.get("ordinal") or 0) for row in baseline_rows), default=-1) + 1

    for source_row in baseline_rows:
        row = dict(source_row)
        recovery = recoveries.get(article_key(row))
        if recovery is not None:
            row.update({
                "content": str(recovery["content"]).strip(),
                "contentSource": "jsonl",
                "matchMethod": str(recovery.get("matchMethod") or "reviewed_jsonl_recovery"),
            })
            counters["recoveryRowsApplied"] += 1
        body = str(row.get("content") or "").strip()
        if body:
            represented[(page_number(row.get("page")), body)] += 1
            counters["baselineAvailableRows"] += 1
        else:
            counters["baselineMissingRows"] += 1
        output.write(json.dumps(row, ensure_ascii=False) + "\n")

    for source_row in jsonl_rows:
        body = str(source_row.get("content") or "").strip()
        if not body:
            counters["jsonlEmptyRows"] += 1
            continue
        counters["jsonlContentRows"] += 1
        signature = (page_number(source_row.get("page")), body)
        if represented[signature]:
            represented[signature] -= 1
            counters["jsonlAlreadyRepresentedRows"] += 1
            continue
        preserved = {
            "date": day,
            "page": signature[0],
            "ordinal": next_ordinal,
            "title": str(source_row.get("title") or "").strip(),
            "href": None,
            "content": body,
            "contentSource": "jsonl",
            "matchMethod": "jsonl_source_preserved",
            "sourceOnly": True,
        }
        output.write(json.dumps(preserved, ensure_ascii=False) + "\n")
        if source_only_output is not None:
            source_only_output.write(json.dumps(preserved, ensure_ascii=False) + "\n")
        next_ordinal += 1
        counters["jsonlPreservedSourceOnlyRows"] += 1


def build(
    baseline: Path,
    jsonl_source: Path,
    recoveries_path: Path,
    output: Path,
    report_path: Path,
    source_only_path: Path | None = None,
) -> dict[str, Any]:
    recoveries = load_recoveries(recoveries_path)
    baseline_iter = iter(iter_by_date(baseline))
    jsonl_iter = iter(iter_by_date(jsonl_source))
    baseline_date, baseline_rows = next(baseline_iter, (None, []))
    jsonl_date, jsonl_rows = next(jsonl_iter, (None, []))
    counters: Counter[str] = Counter()
    output.parent.mkdir(parents=True, exist_ok=True)

    if source_only_path is not None:
        source_only_path.parent.mkdir(parents=True, exist_ok=True)
    source_only_stream = (
        source_only_path.open("w", encoding="utf-8", newline="\n")
        if source_only_path is not None
        else None
    )
    try:
        stream = output.open("w", encoding="utf-8", newline="\n")
        with stream:
            while baseline_date is not None or jsonl_date is not None:
                dates = [day for day in (baseline_date, jsonl_date) if day is not None]
                day = min(dates)
                current_baseline = baseline_rows if baseline_date == day else []
                current_jsonl = jsonl_rows if jsonl_date == day else []
                write_day(
                    stream,
                    source_only_stream,
                    day,
                    current_baseline,
                    current_jsonl,
                    recoveries,
                    counters,
                )
                counters["datesWritten"] += 1
                if baseline_date == day:
                    baseline_date, baseline_rows = next(baseline_iter, (None, []))
                if jsonl_date == day:
                    jsonl_date, jsonl_rows = next(jsonl_iter, (None, []))
    finally:
        if source_only_stream is not None:
            source_only_stream.close()

    counters["recoveryRowsUnapplied"] = len(recoveries) - counters["recoveryRowsApplied"]
    counters["jsonlAccountedContentRows"] = (
        counters["jsonlAlreadyRepresentedRows"] + counters["jsonlPreservedSourceOnlyRows"]
    )
    counters["jsonlOrphanedContentRows"] = (
        counters["jsonlContentRows"] - counters["jsonlAccountedContentRows"]
    )
    safe = (
        counters["jsonlOrphanedContentRows"] == 0
        and counters["recoveryRowsUnapplied"] == 0
    )
    report = {
        "formatVersion": "jojo-rmrb-monotonic-union-report/1",
        "baseline": str(baseline.resolve()),
        "jsonl": str(jsonl_source.resolve()),
        "recoveries": str(recoveries_path.resolve()),
        "output": str(output.resolve()),
        "sourceOnly": str(source_only_path.resolve()) if source_only_path is not None else None,
        "safeToPublish": safe,
        "counters": dict(sorted(counters.items())),
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if not safe:
        raise RuntimeError(
            "Monotonic union is unsafe: "
            f"jsonlOrphans={counters['jsonlOrphanedContentRows']}, "
            f"unappliedRecoveries={counters['recoveryRowsUnapplied']}"
        )
    return report


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--baseline", required=True, type=Path)
    result.add_argument("--jsonl", required=True, type=Path)
    result.add_argument("--recoveries", required=True, type=Path)
    result.add_argument("--output", required=True, type=Path)
    result.add_argument("--source-only", type=Path)
    result.add_argument("--report", required=True, type=Path)
    return result


def main() -> None:
    args = parser().parse_args()
    report = build(
        args.baseline,
        args.jsonl,
        args.recoveries,
        args.output,
        args.report,
        args.source_only,
    )
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
