#!/usr/bin/env python3
"""Classify unmatched RMRB JSONL bodies without forcing directory matches.

The trusted JSONL corpus remains publishable unless a nearby PeopleData title
indicates a likely title/date/page conflict.  This tool is deliberately
conservative: a suspected typo is exactly one normalized character edit on the
same issue and page.  Otherwise it checks exact normalized titles on another
page of the same issue, on the adjacent dates, and on the same day of the
adjacent months.
"""

from __future__ import annotations

import argparse
import calendar
import json
import sqlite3
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable

from merge_rmrb_peopledata_xlsx import (
    GENERIC_IMAGE_TITLES,
    is_single_character_edit,
    norm,
    page_number,
    primary_title,
)


NORMALIZED_GENERIC_IMAGE_TITLES = {norm(value) for value in GENERIC_IMAGE_TITLES}


def normalized_primary_title(row: dict[str, Any]) -> str:
    title = norm(primary_title(row.get("title")))
    if title in NORMALIZED_GENERIC_IMAGE_TITLES:
        caption = norm(primary_title(row.get("content")))
        if caption and caption not in NORMALIZED_GENERIC_IMAGE_TITLES:
            return caption
        return ""
    return title


def adjacent_month_dates(value: str) -> set[str]:
    parsed = date.fromisoformat(value)
    result: set[str] = set()
    for offset in (-1, 1):
        month_index = parsed.year * 12 + parsed.month - 1 + offset
        year, zero_based_month = divmod(month_index, 12)
        month = zero_based_month + 1
        if parsed.day <= calendar.monthrange(year, month)[1]:
            result.add(date(year, month, parsed.day).isoformat())
    return result


def adjacent_dates(value: str) -> set[str]:
    parsed = date.fromisoformat(value)
    return {
        (parsed - timedelta(days=1)).isoformat(),
        (parsed + timedelta(days=1)).isoformat(),
    }


def load_unaligned(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            issue_date = str(row.get("date") or "")[:10]
            page = page_number(row.get("page"))
            title = norm(primary_title(row.get("title")))
            content = str(row.get("content") or "").strip()
            if not issue_date or page is None or not title or not content:
                raise ValueError(f"Invalid unaligned row at {path}:{line_number}")
            date.fromisoformat(issue_date)
            rows.append(row)
    return rows


def load_directory_evidence(
    directory_path: Path,
    source_titles: set[str],
    source_issue_pages: set[tuple[str, int]],
) -> tuple[
    dict[str, list[dict[str, Any]]],
    dict[tuple[str, int], list[dict[str, Any]]],
]:
    exact_locations: dict[str, list[dict[str, Any]]] = defaultdict(list)
    page_titles: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    connection = sqlite3.connect(f"file:{directory_path}?mode=ro", uri=True)
    try:
        for issue_date, page, ordinal, title in connection.execute(
            "SELECT issue_date, page_number, ordinal, title FROM articles"
        ):
            normalized = norm(primary_title(title))
            if not normalized:
                continue
            evidence = {
                "date": str(issue_date),
                "page": int(page),
                "ordinal": int(ordinal),
                "title": str(title),
                "normalizedTitle": normalized,
            }
            if normalized in source_titles:
                exact_locations[normalized].append(evidence)
            if (str(issue_date), int(page)) in source_issue_pages:
                page_titles[(str(issue_date), int(page))].append(evidence)
    finally:
        connection.close()
    return dict(exact_locations), dict(page_titles)


def typo_candidates(
    source_title: str, candidates: Iterable[dict[str, Any]]
) -> list[dict[str, Any]]:
    if len(source_title) < 4:
        return []
    result = []
    for candidate in candidates:
        candidate_title = str(candidate["normalizedTitle"])
        if len(candidate_title) < 4:
            continue
        if is_single_character_edit(source_title, candidate_title):
            result.append({**candidate, "editDistance": 1})
    return result


def exact_nearby_matches(
    issue_date: str,
    page: int,
    locations: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    adjacent_day_values = adjacent_dates(issue_date)
    adjacent_month_values = adjacent_month_dates(issue_date)
    result: list[dict[str, Any]] = []
    for location in locations:
        candidate_date = str(location["date"])
        candidate_page = int(location["page"])
        kind: str | None = None
        if candidate_date == issue_date and candidate_page != page:
            kind = "same_date_other_page"
        elif candidate_date in adjacent_day_values:
            kind = "adjacent_date"
        elif candidate_date in adjacent_month_values:
            kind = "adjacent_month_same_day"
        if kind:
            result.append({**location, "kind": kind})
    return result


def classify_row(
    row: dict[str, Any],
    exact_locations: dict[str, list[dict[str, Any]]],
    page_titles: dict[tuple[str, int], list[dict[str, Any]]],
) -> dict[str, Any]:
    issue_date = str(row.get("date") or "")[:10]
    page = int(page_number(row.get("page")) or 0)
    source_title = normalized_primary_title(row)
    suspected_typos = typo_candidates(
        source_title, page_titles.get((issue_date, page), [])
    )
    nearby_exact = exact_nearby_matches(
        issue_date, page, exact_locations.get(source_title, [])
    )
    signals = []
    if suspected_typos:
        signals.append("suspected_title_typo")
    signals.extend(sorted({str(match["kind"]) for match in nearby_exact}))
    accepted = not signals
    return {
        **row,
        "reconciliationDecision": (
            "accept_jsonl_canonical" if accepted else "review_nearby_conflict"
        ),
        "reconciliationSignals": signals,
        "suspectedTypoCandidates": suspected_typos,
        "nearbyExactMatches": nearby_exact,
    }


def canonicalize_accepted_jsonl(row: dict[str, Any]) -> dict[str, Any]:
    """Convert an accepted audit row into an ordinary Canonical article."""
    page = page_number(row.get("page"))
    ordinal = row.get("preservedOrdinal", row.get("ordinal"))
    if page is None or ordinal is None:
        raise ValueError("Accepted JSONL row is missing page or preserved ordinal")
    return {
        "date": str(row.get("date") or "")[:10],
        "page": int(page),
        "ordinal": int(ordinal),
        "title": str(row.get("title") or "").strip(),
        "href": None,
        "content": str(row.get("content") or "").strip(),
        "contentSource": "jsonl",
        "matchMethod": "jsonl_directory_omission",
    }


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--jsonl-unaligned", required=True, type=Path)
    parser.add_argument("--accepted", required=True, type=Path)
    parser.add_argument("--review", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()

    rows = load_unaligned(args.jsonl_unaligned)
    source_titles = {
        title for row in rows if (title := normalized_primary_title(row))
    }
    source_issue_pages = {
        (str(row.get("date") or "")[:10], int(page_number(row.get("page")) or 0))
        for row in rows
    }
    exact_locations, page_titles = load_directory_evidence(
        args.directory, source_titles, source_issue_pages
    )

    accepted: list[dict[str, Any]] = []
    review: list[dict[str, Any]] = []
    counters: Counter[str] = Counter()
    for row in rows:
        classified = classify_row(row, exact_locations, page_titles)
        counters["inputRows"] += 1
        signals = classified["reconciliationSignals"]
        if "suspected_title_typo" in signals:
            counters["suspectedTitleTypoRows"] += 1
        for signal in set(signals):
            counters[f"signal_{signal}"] += 1
        if classified["reconciliationDecision"] == "accept_jsonl_canonical":
            accepted.append(canonicalize_accepted_jsonl(classified))
            counters["acceptedJsonlCanonicalRows"] += 1
        else:
            review.append(classified)
            counters["reviewRows"] += 1

    accepted_count = write_jsonl(args.accepted, accepted)
    review_count = write_jsonl(args.review, review)
    safe = accepted_count + review_count == len(rows)
    report = {
        "formatVersion": "jojo-rmrb-jsonl-unaligned-classification/1",
        "directory": str(args.directory.resolve()),
        "jsonlUnaligned": str(args.jsonl_unaligned.resolve()),
        "accepted": str(args.accepted.resolve()),
        "review": str(args.review.resolve()),
        "safe": safe,
        "counters": dict(counters),
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False), flush=True)
    if not safe:
        raise RuntimeError("Unaligned classification accounting failed")


if __name__ == "__main__":
    main()
