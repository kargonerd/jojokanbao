"""Resumably fetch the full PeopleData RMRB directory, one newspaper day at a time.

Only directory metadata is collected: date, edition, title, and article URL.
Authentication comes from JOJO_PEOPLEDATA_COOKIE and is never persisted.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote

from fetch_rmrb_peopledata_directories import BASE_URL, LinkParser, fetch


WORKSPACE = Path(__file__).resolve().parents[2]
DEFAULT_AUDIT = (
    WORKSPACE / "tmp" / "rmrb-current-reaudit" / "jsonl-audit-current-after-peopledata.json"
)
DEFAULT_OUTPUT = (
    WORKSPACE / "tmp" / "rmrb-peopledata-full-directory" / "daily-directory.jsonl"
)
DEFAULT_PROGRESS = (
    WORKSPACE / "tmp" / "rmrb-peopledata-full-directory" / "progress.json"
)
DETAIL_HREF = re.compile(r"/rmrb/pd\.html\?.*\bposition=\d+", re.IGNORECASE)
EDITION_HREF = re.compile(r"/rmrb/(\d{8})/(\d+)(?:[/?#].*)?$")
POSITION = re.compile(r"[?&]position=(\d+)")


def parse_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def date_range(start: date, end: date) -> list[str]:
    return [
        (start + timedelta(days=offset)).isoformat()
        for offset in range((end - start).days + 1)
    ]


def search_url(day: str, page_no: int = 1, page_size: int = 200) -> str:
    query = {
        "cds": [
            {
                "fld": "dataTime",
                "cdr": "AND",
                "hlt": "false",
                "vlr": "OR",
                "qtp": "DEF",
                "val": day.replace("-", ""),
            }
        ],
        "obs": [{"fld": "dataTime", "drt": "DESC"}],
    }
    encoded = quote(json.dumps(query, ensure_ascii=False, separators=(",", ":")))
    return f"{BASE_URL}{encoded}&pageNo={page_no}&pageSize={page_size}"


def detail_url(day: str, position: int, page_no: int = 1, page_size: int = 200) -> str:
    url = search_url(day, page_no, page_size)
    url = url.replace("/rmrb/s?type=2&qs=", "/rmrb/pd.html?qs=", 1)
    url = url.replace("&pageNo=", "&tr=A&pageNo=", 1)
    return f"{url}&position={position}"


def parse_detail_article(body: str, expected_day: str, href: str) -> dict[str, Any]:
    plain = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", body))
    if "浙江大学" not in plain or "退出" not in plain:
        raise RuntimeError("PeopleData detail response is not authenticated")
    year, month, day = (int(part) for part in expected_day.split("-"))
    pattern = re.compile(
        r"浏览本版\s+(?P<header>.+?)\s+【人民日报\s+"
        rf"{year}年0?{month}月0?{day}日\s+第\s*(?P<page>\d+)\s*版"
    )
    matched = pattern.search(plain)
    if not matched:
        raise RuntimeError(f"Cannot parse PeopleData detail metadata for {expected_day}")
    title = re.sub(r"\s*【作者：.*?】\s*$", "", matched.group("header")).strip()
    if not title:
        raise RuntimeError(f"PeopleData detail title is empty for {expected_day}")
    return {"page": int(matched.group("page")), "title": title, "href": href}


def parse_search_page(body: str, expected_day: str) -> tuple[int, list[dict[str, Any]]]:
    plain = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", body))
    if "浙江大学" not in plain or "退出" not in plain:
        raise RuntimeError("PeopleData response is not authenticated")
    total_match = re.search(r"var\s+totalRecords\s*=\s*(\d+)\s*;", body)
    if not total_match:
        total_match = re.search(r"全部时间\(\s*(\d+)\s*条\)", plain)
    if not total_match:
        raise RuntimeError(f"Cannot read result count for {expected_day}")
    total = int(total_match.group(1))
    parser = LinkParser()
    parser.feed(body)
    compact_day = expected_day.replace("-", "")
    articles: list[dict[str, Any]] = []
    seen_hrefs: set[str] = set()
    for index, link in enumerate(parser.links):
        href = link["href"]
        title = link["text"]
        if (
            not title
            or href in seen_hrefs
            or not DETAIL_HREF.search(href)
            or compact_day not in href
        ):
            continue
        edition_match = None
        for following in parser.links[index + 1 : index + 4]:
            candidate = EDITION_HREF.search(following["href"])
            if candidate and candidate.group(1) == compact_day:
                edition_match = candidate
                break
        if edition_match is None:
            continue
        seen_hrefs.add(href)
        articles.append(
            {
                "page": int(edition_match.group(2)),
                "title": title,
                "href": href,
            }
        )
    return total, articles


def fetch_day(
    day: str,
    cookie: str,
    *,
    timeout: float,
    page_size: int,
    retries: int,
    delay: float,
    rate_limit_cooldown: float,
) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            first_body = fetch(search_url(day, 1, page_size), cookie, timeout)
            total, articles = parse_search_page(first_body, day)
            detail_recovered = 0
            # A small number of PeopleData result rows have an empty title
            # anchor or are omitted from the search-result DOM even though the
            # detail endpoint exists. Recover those deterministic positions
            # directly before treating the day as a count mismatch.
            if len(articles) < total and total <= page_size:
                parsed_positions = {
                    int(matched.group(1))
                    for article in articles
                    if (matched := POSITION.search(str(article.get("href") or "")))
                }
                for position in range(total):
                    if position in parsed_positions:
                        continue
                    href = detail_url(day, position, 1, page_size)
                    detail_body = fetch(href, cookie, timeout)
                    recovered = parse_detail_article(detail_body, day, href)
                    articles.append(recovered)
                    parsed_positions.add(position)
                    detail_recovered += 1
            page_no = 2
            while len(articles) < total:
                body = fetch(search_url(day, page_no, page_size), cookie, timeout)
                repeated_total, page_articles = parse_search_page(body, day)
                if repeated_total != total or not page_articles:
                    raise RuntimeError(
                        f"Pagination mismatch for {day}: total={total}, parsed={len(articles)}"
                    )
                known = {item["href"] for item in articles}
                articles.extend(item for item in page_articles if item["href"] not in known)
                page_no += 1
            if len(articles) != total:
                raise RuntimeError(f"Count mismatch for {day}: total={total}, parsed={len(articles)}")
            page_counts = Counter(str(item["page"]) for item in articles)
            result = {
                "date": day,
                "resultCount": total,
                "editionCount": len(page_counts),
                "pageCounts": dict(sorted(page_counts.items(), key=lambda item: int(item[0]))),
                "articles": articles,
                "source": "PeopleData /rmrb/s advanced-search directory",
                "detailRecoveredCount": detail_recovered,
                "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            time.sleep(delay)
            return result
        except HTTPError as exc:
            last_error = exc
            if attempt < retries:
                if exc.code == 418:
                    cooldown = min(rate_limit_cooldown * attempt, 15 * 60)
                    print(
                        f"[rate-limited] {day}: waiting {cooldown:.0f}s "
                        f"before retry {attempt + 1}/{retries}",
                        flush=True,
                    )
                    time.sleep(cooldown)
                else:
                    time.sleep(min(attempt * 3.0, 30.0))
        except (URLError, TimeoutError, RuntimeError) as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(min(attempt * 3.0, 30.0))
    raise RuntimeError(f"Failed {day}: {last_error}")


def load_completed(path: Path) -> dict[str, dict[str, Any]]:
    completed: dict[str, dict[str, Any]] = {}
    if not path.is_file():
        return completed
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid checkpoint line {path}:{line_number}") from exc
        completed[str(row["date"])] = row
    return completed


def write_progress(
    path: Path,
    *,
    start: str,
    end: str,
    total_dates: int,
    completed: dict[str, dict[str, Any]],
    failed: list[dict[str, str]],
) -> None:
    result_counts = [int(row.get("resultCount") or 0) for row in completed.values()]
    payload = {
        "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dateRange": {"start": start, "end": end},
        "totalDates": total_dates,
        "completedDates": len(completed),
        "remainingDates": total_dates - len(completed),
        "datesWithResults": sum(count > 0 for count in result_counts),
        "datesWithoutResults": sum(count == 0 for count in result_counts),
        "directoryArticles": sum(result_counts),
        "failed": failed[-100:],
    }
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-report", type=Path, default=DEFAULT_AUDIT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--progress", type=Path, default=DEFAULT_PROGRESS)
    parser.add_argument("--start-date")
    parser.add_argument("--end-date")
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--page-size", type=int, default=200)
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--delay", type=float, default=1.0)
    parser.add_argument("--retries", type=int, default=8)
    parser.add_argument("--rate-limit-cooldown", type=float, default=120.0)
    parser.add_argument("--max-dates", type=int)
    args = parser.parse_args()
    if args.workers < 1 or args.workers > 8:
        raise SystemExit("--workers must be between 1 and 8")
    cookie = os.environ.get("JOJO_PEOPLEDATA_COOKIE", "").strip()
    if not cookie:
        raise SystemExit("JOJO_PEOPLEDATA_COOKIE is required")
    audit = json.loads(args.audit_report.read_text(encoding="utf-8"))
    start_text = args.start_date or audit["summary"]["firstDate"]
    end_text = args.end_date or audit["summary"]["lastDate"]
    targets = date_range(parse_date(start_text), parse_date(end_text))
    completed = load_completed(args.output)
    pending = [day for day in targets if day not in completed]
    if args.max_dates is not None:
        pending = pending[: args.max_dates]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.progress.parent.mkdir(parents=True, exist_ok=True)
    write_lock = threading.Lock()
    failed: list[dict[str, str]] = []

    def collect(day: str) -> tuple[str, dict[str, Any] | None, str | None]:
        try:
            return day, fetch_day(
                day,
                cookie,
                timeout=args.timeout,
                page_size=args.page_size,
                retries=args.retries,
                delay=args.delay,
                rate_limit_cooldown=args.rate_limit_cooldown,
            ), None
        except RuntimeError as exc:
            return day, None, str(exc)

    with args.output.open("a", encoding="utf-8") as output_handle:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            for index, (day, result, error) in enumerate(executor.map(collect, pending), 1):
                with write_lock:
                    if result is not None:
                        output_handle.write(json.dumps(result, ensure_ascii=False) + "\n")
                        output_handle.flush()
                        completed[day] = result
                        print(
                            f"[{len(completed):05d}/{len(targets):05d}] {day}: "
                            f"{result['resultCount']} articles, {result['editionCount']} editions",
                            flush=True,
                        )
                    else:
                        failed.append({"date": day, "error": error or "unknown error"})
                        print(f"[failed] {day}: {error}", flush=True)
                    if index % 10 == 0 or index == len(pending):
                        write_progress(
                            args.progress,
                            start=start_text,
                            end=end_text,
                            total_dates=len(targets),
                            completed=completed,
                            failed=failed,
                        )
    if failed:
        raise SystemExit(f"Completed with {len(failed)} failed date(s); rerun to retry")


if __name__ == "__main__":
    main()
