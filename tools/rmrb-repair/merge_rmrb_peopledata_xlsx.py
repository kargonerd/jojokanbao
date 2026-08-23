"""Merge the PeopleData directory with the existing JSONL and annual XLSX text.

PeopleData is the canonical source for date/page/ordinal/title/href.  Existing
JSONL content is preferred when it matches (it may contain manual repairs), and
the annual XLSX is used to fill the remaining records.  The command only writes
staging artifacts; it never replaces the corpus or Elasticsearch data.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import unicodedata
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterator


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PAGE_RE = re.compile(r"\d+")
YEAR_RE = re.compile(r"(\d{4})年")
KNOWN_PAGE_CODES = {101: 1, 111: 11, 202: 2, 505: 5, 606: 6, 909: 9, 1212: 12}


def norm(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return "".join(ch for ch in text if ch.isalnum())


def page_number(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, float) and value.is_integer():
        parsed = int(value)
    else:
        match = PAGE_RE.search(str(value or ""))
        parsed = int(match.group()) if match else None
    return KNOWN_PAGE_CODES.get(parsed, parsed)


def xlsx_paths(root: Path) -> list[tuple[int, Path]]:
    result: list[tuple[int, Path]] = []
    for path in root.glob("*.xlsx"):
        match = YEAR_RE.search(path.name)
        if match:
            result.append((int(match.group(1)), path))
    return sorted(result)


def iter_jsonl_by_date(path: Path) -> Iterator[tuple[str, list[dict[str, Any]]]]:
    current = ""
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            row = json.loads(line)
            date = str(row.get("date") or "")[:10]
            if not DATE_RE.fullmatch(date):
                continue
            if current and date < current:
                raise RuntimeError(f"JSONL is not date ordered at line {line_number}: {date}")
            if current and date != current:
                yield current, rows
                rows = []
            current = date
            rows.append(row)
    if current:
        yield current, rows


def iter_xlsx_by_date(root: Path) -> Iterator[tuple[str, list[dict[str, Any]]]]:
    try:
        from openpyxl import load_workbook
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("openpyxl is required") from exc
    current = ""
    rows: list[dict[str, Any]] = []
    for year, path in xlsx_paths(root):
        workbook = load_workbook(path, read_only=True, data_only=True)
        try:
            sheet = workbook.active
            headers = tuple(str(v or "").strip() for v in next(sheet.iter_rows(min_row=1, max_row=1, values_only=True)))
            if headers[:5] != ("年份", "日期", "报纸版次", "标题", "文本内容"):
                raise RuntimeError(f"Unexpected headers in {path}: {headers}")
            for row_number, raw in enumerate(sheet.iter_rows(min_row=2, values_only=True), 2):
                year_value, date_raw, page_raw, title_raw, content_raw = (tuple(raw) + (None,) * 5)[:5]
                # The annual exports use both ``YYYY-MM-DD`` and
                # ``YYYY/MM/DD`` depending on the year.
                date = str(date_raw or "")[:10].replace("/", "-")
                if year_value is None or not DATE_RE.fullmatch(date):
                    continue
                if not date.startswith(f"{year:04d}-"):
                    raise RuntimeError(f"Out-of-year row {path}:{row_number}: {date}")
                if current and date < current:
                    raise RuntimeError(f"XLSX is not date ordered at {path}:{row_number}: {date}")
                if current and date != current:
                    yield current, rows
                    rows = []
                current = date
                rows.append({
                    "date": date,
                    "page": page_number(page_raw),
                    "title": str(title_raw or "").strip(),
                    "content": str(content_raw or "").strip(),
                    "source": f"{path}:{row_number}",
                })
        finally:
            workbook.close()
    if current:
        yield current, rows


def choose(canonical: dict[str, Any], candidates: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, str]:
    if not candidates:
        return None, "none"
    ctitle = norm(canonical["title"])
    same_page = [row for row in candidates if row.get("page") == canonical.get("page")]
    pool = same_page or candidates
    exact = [row for row in pool if ctitle and norm(row.get("title")) == ctitle]
    # The annual exports sometimes repeat the same article block.  Collapse
    # exact duplicates by title + body prefix, retaining the fullest body.
    collapsed: dict[tuple[str, str], dict[str, Any]] = {}
    for row in exact:
        key = (norm(row.get("title")), norm(row.get("content"))[:400])
        prior = collapsed.get(key)
        if prior is None or len(str(row.get("content") or "")) > len(str(prior.get("content") or "")):
            collapsed[key] = row
    exact = list(collapsed.values())
    if len(exact) == 1:
        return exact[0], "exact_title"
    scored: list[tuple[float, dict[str, Any]]] = []
    for row in pool:
        title = norm(row.get("title"))
        if not title or not ctitle:
            continue
        if len(ctitle) >= 6 and (ctitle in title or title in ctitle):
            score = 0.99
        else:
            score = SequenceMatcher(None, ctitle, title, autojunk=False).ratio()
        threshold = 0.90 if min(len(ctitle), len(title)) >= 12 else 0.96
        if score >= threshold:
            scored.append((score, row))
    scored.sort(key=lambda item: item[0], reverse=True)
    if scored and (len(scored) == 1 or scored[0][0] - scored[1][0] >= 0.03):
        return scored[0][1], "fuzzy_title"
    return None, "ambiguous"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--jsonl", type=Path, required=True)
    parser.add_argument("--xlsx-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--unmatched", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.unmatched.parent.mkdir(parents=True, exist_ok=True)

    directory = sqlite3.connect(f"file:{args.directory}?mode=ro", uri=True)
    dates = [row[0] for row in directory.execute("SELECT issue_date FROM issues WHERE result_count > 0 ORDER BY issue_date")]
    json_iter = iter_jsonl_by_date(args.jsonl)
    xlsx_iter = iter_xlsx_by_date(args.xlsx_root)
    json_date, json_rows = next(json_iter, (None, []))
    xlsx_date, xlsx_rows = next(xlsx_iter, (None, []))
    counters = Counter()
    with args.output.open("w", encoding="utf-8") as out, args.unmatched.open("w", encoding="utf-8") as missing:
        for index, date in enumerate(dates, 1):
            while json_date is not None and json_date < date:
                counters["jsonOnlyRows"] += len(json_rows)
                json_date, json_rows = next(json_iter, (None, []))
            while xlsx_date is not None and xlsx_date < date:
                counters["xlsxOnlyRows"] += len(xlsx_rows)
                xlsx_date, xlsx_rows = next(xlsx_iter, (None, []))
            local = json_rows if json_date == date else []
            xrows = xlsx_rows if xlsx_date == date else []
            local_by_page: dict[int | None, list[dict[str, Any]]] = {}
            xlsx_by_page: dict[int | None, list[dict[str, Any]]] = {}
            for row in local:
                local_by_page.setdefault(page_number(row.get("page")), []).append(row)
            for row in xrows:
                xlsx_by_page.setdefault(row.get("page"), []).append(row)
            for ordinal, page, title, href in directory.execute(
                "SELECT ordinal, page_number, title, href FROM articles WHERE issue_date = ? ORDER BY ordinal", (date,)
            ):
                canonical = {"date": date, "page": page, "ordinal": ordinal, "title": title, "href": href}
                local_match, local_method = choose(canonical, local_by_page.get(page, []))
                # Older annual exports omit the page column entirely; in that
                # case the date/title still provide a valid match.
                xlsx_candidates = list(xlsx_by_page.get(page, []))
                if not xlsx_candidates:
                    xlsx_candidates = list(xlsx_by_page.get(None, []))
                xlsx_match, xlsx_method = choose(canonical, xlsx_candidates)
                selected = local_match or xlsx_match
                source = "jsonl" if local_match else ("xlsx" if xlsx_match else None)
                method = local_method if local_match else xlsx_method
                if selected:
                    content = str(selected.get("content") or "").strip()
                    if content:
                        counters[f"matched_{source}_{method}"] += 1
                    else:
                        counters["emptyMatchedContent"] += 1
                else:
                    counters["missingContent"] += 1
                    missing.write(json.dumps(canonical, ensure_ascii=False) + "\n")
                    content = ""
                record = {**canonical, "content": content, "contentSource": source, "matchMethod": method}
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
            counters["directoryDates"] += 1
            if json_date == date:
                json_date, json_rows = next(json_iter, (None, []))
            if xlsx_date == date:
                xlsx_date, xlsx_rows = next(xlsx_iter, (None, []))
            if index % 100 == 0:
                print(f"processed {index}/{len(dates)} dates", flush=True)
    report = {
        "scope": {"start": dates[0] if dates else None, "end": dates[-1] if dates else None},
        "directory": str(args.directory.resolve()),
        "jsonl": str(args.jsonl.resolve()),
        "xlsxRoot": str(args.xlsx_root.resolve()),
        "output": str(args.output.resolve()),
        "unmatched": str(args.unmatched.resolve()),
        "counters": dict(sorted(counters.items())),
    }
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
