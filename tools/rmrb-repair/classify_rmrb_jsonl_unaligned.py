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
import unicodedata
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
NORMALIZED_SERIAL_MARKERS = {norm("连载")}


def candidate_has_empty_difference(value: Any, reference: Any) -> bool:
    """Mirror the workbench's ``∅`` marker for a shorter candidate title."""
    source = list(str(value or ""))
    other = list(str(reference or ""))
    if source == other:
        return False
    prefix = 0
    while (
        prefix < len(source)
        and prefix < len(other)
        and source[prefix] == other[prefix]
    ):
        prefix += 1
    suffix = 0
    while (
        suffix < len(source) - prefix
        and suffix < len(other) - prefix
        and source[len(source) - suffix - 1] == other[len(other) - suffix - 1]
    ):
        suffix += 1
    return not source[prefix : len(source) - suffix]


def content_heading_after_section(row: dict[str, Any]) -> str:
    """Return the first article heading after a repeated section label.

    The legacy JSONL sometimes stores a recurring section label as its catalog
    title and repeats that label twice at the start of the body.  The first
    distinct line after those repeated labels is the actual article heading.
    Requiring two leading copies keeps ordinary articles, whose title is only
    repeated once before the prose, out of this repair rule.
    """
    section = norm(primary_title(row.get("title")))
    if not section:
        return ""
    lines = [
        line.strip()
        for line in str(row.get("content") or "").splitlines()
        if line.strip()
    ]
    repeated_labels = 0
    for line in lines:
        if norm(line) == section:
            repeated_labels += 1
            continue
        if repeated_labels >= 2:
            return line
        return ""
    return ""


def content_heading_after_leading_title(row: dict[str, Any]) -> str:
    """Return the line after one or more leading copies of the source title.

    Unlike ``content_heading_after_section``, this permissive variant is only
    used where a unique same-issue, same-page PeopleData title confirms the
    derived heading.  That external confirmation prevents an ordinary first
    paragraph from being treated as a catalog title.
    """
    section = norm(primary_title(row.get("title")))
    if not section:
        return ""
    lines = [
        line.strip()
        for line in str(row.get("content") or "").splitlines()
        if line.strip()
    ]
    if not lines or norm(lines[0]) != section:
        return ""
    for line in lines[1:]:
        if norm(line) != section:
            return line
    return ""


def leading_content_heading_candidates(
    row: dict[str, Any], *, limit: int = 8
) -> list[str]:
    """Collect plausible catalog headings from the opening body lines.

    Serialised pieces can place a marker, series title, and byline before the
    installment title.  Candidate lines are only hints: the resolver still
    requires exactly one matching PeopleData title on the same issue and page.
    """
    source_title = norm(primary_title(row.get("title")))
    lines = [
        line.strip()
        for line in str(row.get("content") or "").splitlines()
        if line.strip()
    ][:limit]
    result: list[str] = []
    seen: set[str] = set()
    preferred = content_heading_after_leading_title(row)
    raw_candidates = [preferred] if preferred else []
    if lines and norm(lines[0]) in NORMALIZED_SERIAL_MARKERS:
        source_index = next(
            (
                index
                for index, line in enumerate(lines[1:4], 1)
                if norm(line) == source_title
            ),
            None,
        )
        if source_index is not None:
            raw_candidates.extend(lines[source_index + 1 : source_index + 4])
    for line in raw_candidates:
        normalized = norm(line)
        if len(normalized) < 4 or normalized == source_title or normalized in seen:
            continue
        seen.add(normalized)
        result.append(line)
    return result


def normalized_primary_title(row: dict[str, Any]) -> str:
    title = norm(primary_title(row.get("title")))
    if title in NORMALIZED_GENERIC_IMAGE_TITLES:
        caption = norm(primary_title(row.get("content")))
        if caption and caption not in NORMALIZED_GENERIC_IMAGE_TITLES:
            return caption
        return ""
    if heading := content_heading_after_section(row):
        return norm(heading)
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


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def exact_issue_page_title_key(row: dict[str, Any]) -> tuple[str, int, str] | None:
    issue_date = str(row.get("date") or "")[:10]
    page = page_number(row.get("page"))
    title = normalized_primary_title(row)
    if not issue_date or page is None or not title:
        return None
    return issue_date, int(page), title


def whitespace_insensitive_title(row: dict[str, Any]) -> str:
    title = unicodedata.normalize("NFKC", primary_title(row.get("title"))).casefold()
    return "".join(title.split())


def exact_issue_whitespace_title_key(row: dict[str, Any]) -> tuple[str, str] | None:
    issue_date = str(row.get("date") or "")[:10]
    title = whitespace_insensitive_title(row)
    if not issue_date or not title:
        return None
    return issue_date, title


def canonicalize_exact_group_pair(
    source: dict[str, Any], candidate: dict[str, Any]
) -> dict[str, Any]:
    return {
        "date": str(candidate.get("date") or "")[:10],
        "page": int(page_number(candidate.get("page")) or 0),
        "ordinal": int(candidate["ordinal"]),
        "title": str(candidate.get("title") or "").strip(),
        "href": candidate.get("href"),
        "content": str(source.get("content") or "").strip(),
        "contentSource": "jsonl",
        "matchMethod": "exact_title_ordered_group",
        "sourceTitle": str(source.get("title") or "").strip(),
        "sourceOrdinal": int(source.get("preservedOrdinal", source.get("ordinal", 0))),
    }


def resolve_exact_same_page_groups(
    source_rows: list[dict[str, Any]],
    missing_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Pair equal-sized duplicate-title groups by their relative page order.

    A single title can legitimately occur more than once on one page (for
    example two bank notices).  The original one-row matcher deliberately
    withheld those groups as ambiguous.  If the still-missing PeopleData group
    and the unaligned JSONL group have the same date, page, normalized title,
    and cardinality, their relative order is sufficient to preserve both
    distinct bodies without borrowing a candidate from another date.
    """
    source_groups: dict[tuple[str, int, str], list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    missing_groups: dict[tuple[str, int, str], list[dict[str, Any]]] = defaultdict(list)
    for index, row in enumerate(source_rows):
        if key := exact_issue_page_title_key(row):
            source_groups[key].append((index, row))
    for row in missing_rows:
        if key := exact_issue_page_title_key(row):
            missing_groups[key].append(row)

    resolved_indexes: set[int] = set()
    resolved: list[dict[str, Any]] = []
    for key, sources in source_groups.items():
        candidates = missing_groups.get(key, [])
        if not candidates or len(sources) != len(candidates):
            continue
        ordered_sources = sorted(
            sources,
            key=lambda item: int(
                item[1].get("preservedOrdinal", item[1].get("ordinal", item[0]))
            ),
        )
        ordered_candidates = sorted(candidates, key=lambda row: int(row["ordinal"]))
        for (index, source), candidate in zip(ordered_sources, ordered_candidates):
            if candidate_has_empty_difference(
                candidate.get("title"), source.get("title")
            ):
                continue
            resolved_indexes.add(index)
            canonical = canonicalize_exact_group_pair(source, candidate)
            if derived_title := content_heading_after_section(source):
                canonical["matchMethod"] = "repeated_section_heading_same_page"
                canonical["derivedSourceTitle"] = derived_title
            resolved.append(canonical)

    remaining = [row for index, row in enumerate(source_rows) if index not in resolved_indexes]
    resolved.sort(key=lambda row: (row["date"], row["page"], row["ordinal"]))
    return remaining, resolved


def resolve_whitespace_only_same_date_groups(
    source_rows: list[dict[str, Any]],
    missing_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Resolve same-date catalog matches whose titles differ only in spacing."""
    source_groups: dict[tuple[str, str], list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    missing_groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for index, row in enumerate(source_rows):
        if key := exact_issue_whitespace_title_key(row):
            source_groups[key].append((index, row))
    for row in missing_rows:
        if key := exact_issue_whitespace_title_key(row):
            missing_groups[key].append(row)

    resolved_indexes: set[int] = set()
    resolved: list[dict[str, Any]] = []
    for key, sources in source_groups.items():
        candidates = missing_groups.get(key, [])
        if not candidates or len(sources) != len(candidates):
            continue
        ordered_sources = sorted(
            sources,
            key=lambda item: int(
                item[1].get("preservedOrdinal", item[1].get("ordinal", item[0]))
            ),
        )
        ordered_candidates = sorted(candidates, key=lambda row: int(row["ordinal"]))
        for (index, source), candidate in zip(ordered_sources, ordered_candidates):
            if candidate_has_empty_difference(
                candidate.get("title"), source.get("title")
            ):
                continue
            resolved_indexes.add(index)
            canonical = canonicalize_exact_group_pair(source, candidate)
            canonical["matchMethod"] = "exact_title_whitespace_same_date"
            resolved.append(canonical)

    remaining = [row for index, row in enumerate(source_rows) if index not in resolved_indexes]
    resolved.sort(key=lambda row: (row["date"], row["page"], row["ordinal"]))
    return remaining, resolved


def resolve_same_page_title_typo_groups(
    source_rows: list[dict[str, Any]],
    missing_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Bind a unique same-page catalog typo while keeping the JSONL title."""
    missing_by_issue_page: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for candidate in missing_rows:
        key = (
            str(candidate.get("date") or "")[:10],
            int(page_number(candidate.get("page")) or 0),
        )
        missing_by_issue_page[key].append(candidate)

    proposals: dict[
        tuple[str, int, int], list[tuple[int, dict[str, Any], dict[str, Any]]]
    ] = defaultdict(list)
    for index, source in enumerate(source_rows):
        issue_date = str(source.get("date") or "")[:10]
        page = int(page_number(source.get("page")) or 0)
        source_title = normalized_primary_title(source)
        if len(source_title) < 4:
            continue
        candidates = [
            candidate
            for candidate in missing_by_issue_page.get((issue_date, page), [])
            if is_single_character_edit(
                source_title, norm(primary_title(candidate.get("title")))
            )
            and not candidate_has_empty_difference(
                candidate.get("title"), source.get("title")
            )
        ]
        if len(candidates) != 1:
            continue
        candidate = candidates[0]
        candidate_key = (issue_date, page, int(candidate.get("ordinal", -1)))
        proposals[candidate_key].append((index, source, candidate))

    resolved_indexes: set[int] = set()
    resolved: list[dict[str, Any]] = []
    for claims in proposals.values():
        if len(claims) != 1:
            continue
        index, source, candidate = claims[0]
        resolved_indexes.add(index)
        canonical = canonicalize_exact_group_pair(source, candidate)
        canonical["title"] = primary_title(source.get("title")).strip()
        canonical["matchMethod"] = "same_page_title_typo_jsonl"
        canonical["peopleDataTitle"] = str(candidate.get("title") or "").strip()
        resolved.append(canonical)

    remaining = [row for index, row in enumerate(source_rows) if index not in resolved_indexes]
    resolved.sort(key=lambda row: (row["date"], row["page"], row["ordinal"]))
    return remaining, resolved


def resolve_generic_section_heading_groups(
    source_rows: list[dict[str, Any]],
    missing_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Match recurring section labels using the first real heading in the body."""
    missing_by_issue_page: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for candidate in missing_rows:
        issue_page = (
            str(candidate.get("date") or "")[:10],
            int(page_number(candidate.get("page")) or 0),
        )
        missing_by_issue_page[issue_page].append(candidate)

    resolved_indexes: set[int] = set()
    resolved_candidate_keys: set[tuple[str, int, int]] = set()
    resolved: list[dict[str, Any]] = []
    for index, source in enumerate(source_rows):
        headings = [
            (line, norm(line)) for line in leading_content_heading_candidates(source)
        ]
        if not headings:
            continue
        issue_date = str(source.get("date") or "")[:10]
        page = int(page_number(source.get("page")) or 0)
        matches: dict[tuple[str, int, int], tuple[dict[str, Any], str]] = {}
        for candidate in missing_by_issue_page.get((issue_date, page), []):
            candidate_key = (
                issue_date,
                int(page_number(candidate.get("page")) or 0),
                int(candidate.get("ordinal", -1)),
            )
            if candidate_key in resolved_candidate_keys or candidate_has_empty_difference(
                candidate.get("title"), source.get("title")
            ):
                continue
            candidate_title = norm(primary_title(candidate.get("title")))
            derived_title = next(
                (
                    line
                    for line, heading in headings
                    if candidate_title.startswith(heading)
                ),
                "",
            )
            if derived_title:
                matches[candidate_key] = (candidate, derived_title)
        if len(matches) != 1:
            continue
        candidate_key, (candidate, derived_title) = next(iter(matches.items()))
        resolved_candidate_keys.add(candidate_key)
        resolved_indexes.add(index)
        canonical = canonicalize_exact_group_pair(source, candidate)
        canonical["matchMethod"] = "generic_section_heading_same_date"
        canonical["derivedSourceTitle"] = derived_title
        resolved.append(canonical)

    remaining = [row for index, row in enumerate(source_rows) if index not in resolved_indexes]
    resolved.sort(key=lambda row: (row["date"], row["page"], row["ordinal"]))
    return remaining, resolved


def without_resolved_candidates(
    missing_rows: list[dict[str, Any]], resolved: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    keys = {
        (row["date"], int(row["page"]), int(row["ordinal"])) for row in resolved
    }
    return [
        row
        for row in missing_rows
        if (
            str(row.get("date") or "")[:10],
            int(page_number(row.get("page")) or 0),
            int(row.get("ordinal", -1)),
        )
        not in keys
    ]


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
    # Policy: on the same issue and page, a one-character catalog difference
    # does not outweigh the complete JSONL record.  Keep the JSONL title and do
    # not expose the PeopleData typo candidate for human review.
    suspected_typos: list[dict[str, Any]] = []
    nearby_exact = exact_nearby_matches(
        issue_date, page, exact_locations.get(source_title, [])
    )
    nearby_exact = [
        candidate
        for candidate in nearby_exact
        if not candidate_has_empty_difference(
            candidate.get("title"), row.get("title")
        )
    ]
    signals = []
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
    parser.add_argument("--peopledata-unmatched", type=Path)
    parser.add_argument("--auto-merged", type=Path)
    args = parser.parse_args()

    rows = load_unaligned(args.jsonl_unaligned)
    input_count = len(rows)
    auto_merged: list[dict[str, Any]] = []
    if args.peopledata_unmatched:
        missing_rows = load_jsonl(args.peopledata_unmatched)
        rows, same_page_merged = resolve_exact_same_page_groups(rows, missing_rows)
        missing_rows = without_resolved_candidates(missing_rows, same_page_merged)
        rows, whitespace_merged = resolve_whitespace_only_same_date_groups(
            rows, missing_rows
        )
        missing_rows = without_resolved_candidates(missing_rows, whitespace_merged)
        rows, same_page_typo_merged = resolve_same_page_title_typo_groups(
            rows, missing_rows
        )
        missing_rows = without_resolved_candidates(missing_rows, same_page_typo_merged)
        rows, section_heading_merged = resolve_generic_section_heading_groups(
            rows, missing_rows
        )
        auto_merged = (
            same_page_merged
            + whitespace_merged
            + same_page_typo_merged
            + section_heading_merged
        )
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

    accepted: list[dict[str, Any]] = list(auto_merged)
    review: list[dict[str, Any]] = []
    counters: Counter[str] = Counter()
    counters["inputRows"] = input_count
    counters["autoMergedExactGroupRows"] = len(auto_merged)
    counters["autoMergedSamePageRows"] = len(same_page_merged) if args.peopledata_unmatched else 0
    counters["autoMergedWhitespaceSameDateRows"] = (
        len(whitespace_merged) if args.peopledata_unmatched else 0
    )
    counters["autoMergedSamePageTypoRows"] = (
        len(same_page_typo_merged) if args.peopledata_unmatched else 0
    )
    counters["autoMergedGenericSectionHeadingRows"] = (
        len(section_heading_merged) if args.peopledata_unmatched else 0
    )
    counters["acceptedJsonlCanonicalRows"] = len(auto_merged)
    for row in rows:
        classified = classify_row(row, exact_locations, page_titles)
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
    if args.auto_merged:
        write_jsonl(args.auto_merged, auto_merged)
    safe = accepted_count + review_count == input_count
    report = {
        "formatVersion": "jojo-rmrb-jsonl-unaligned-classification/1",
        "directory": str(args.directory.resolve()),
        "jsonlUnaligned": str(args.jsonl_unaligned.resolve()),
        "accepted": str(args.accepted.resolve()),
        "review": str(args.review.resolve()),
        "peopleDataUnmatched": (
            str(args.peopledata_unmatched.resolve()) if args.peopledata_unmatched else None
        ),
        "autoMerged": str(args.auto_merged.resolve()) if args.auto_merged else None,
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
