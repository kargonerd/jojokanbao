"""Fetch PeopleData directory results for active RMRB repair pages.

Authentication is supplied only through the JOJO_PEOPLEDATA_COOKIE environment
variable. The cookie is never written to output or logs.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


WORKSPACE = Path(__file__).resolve().parents[2]
DEFAULT_QUEUE = WORKSPACE / "tmp" / "rmrb-peopledata-cache" / "collection-queue.json"
DEFAULT_OUTPUT = WORKSPACE / "tmp" / "rmrb-peopledata-cache" / "live-directory-results.jsonl"
ACTIVE_STATES = {"not_started", "partially_cached"}
BASE_URL = (
    "https://webvpn.zju.edu.cn/https/"
    "77726476706e69737468656265737421f4f6559d69206d5f6e048ce29b5a2e7b74a4/"
    "rmrb/s?type=2&qs="
)
REFERER = (
    "https://webvpn.zju.edu.cn/https/"
    "77726476706e69737468656265737421f4f6559d69206d5f6e048ce29b5a2e7b74a4/"
    "rmrb/19730804/1"
)
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/151.0.0.0 Safari/537.36"
)


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[dict[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a" or self._href is not None:
            return
        values = dict(attrs)
        self._href = values.get("href") or ""
        self._text = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "a" or self._href is None:
            return
        text = re.sub(r"\s+", " ", "".join(self._text)).strip()
        self.links.append({"href": html.unescape(self._href), "text": text})
        self._href = None
        self._text = []


def search_url(date: str, page: int) -> str:
    query = {
        "cds": [
            {
                "fld": "dataTime",
                "cdr": "AND",
                "hlt": "false",
                "vlr": "OR",
                "qtp": "DEF",
                "val": date.replace("-", ""),
            },
            {
                "fld": "pageNum",
                "cdr": "AND",
                "hlt": "false",
                "vlr": "AND",
                "qtp": "DEF",
                "val": str(page),
            },
        ],
        "obs": [{"fld": "dataTime", "drt": "DESC"}],
    }
    return BASE_URL + quote(json.dumps(query, ensure_ascii=False, separators=(",", ":")))


def fetch(url: str, cookie: str, timeout: float) -> str:
    request = Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Cookie": cookie,
            "Referer": REFERER,
            "User-Agent": USER_AGENT,
        },
    )
    with urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def parse_result(body: str, date: str, page: int) -> dict[str, Any]:
    plain = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", body))
    if "浙江大学" not in plain or "退出" not in plain:
        raise RuntimeError("PeopleData response is not authenticated")
    parser = LinkParser()
    parser.feed(body)
    compact_date = date.replace("-", "")
    article_pattern = re.compile(
        rf"/rmrb/{re.escape(compact_date)}/{page}/[^/?#]+_page(?:[?#].*)?$"
    )
    article_links: list[dict[str, str]] = []
    seen_hrefs: set[str] = set()
    for link in parser.links:
        href = link["href"]
        title = link["text"]
        if not title or href in seen_hrefs or not article_pattern.search(href):
            continue
        seen_hrefs.add(href)
        article_links.append({"title": title, "href": href})
    total_match = re.search(r"全部时间\(\s*(\d+)\s*条\)", plain)
    result_count = int(total_match.group(1)) if total_match else len(article_links)
    if result_count != len(article_links):
        raise RuntimeError(
            f"Result count mismatch for {date} p{page}: "
            f"page says {result_count}, parsed {len(article_links)}"
        )
    return {
        "date": date,
        "page": page,
        "titles": [item["title"] for item in article_links],
        "articleLinks": article_links,
        "resultCount": result_count,
        "source": "PeopleData /rmrb/s advanced-search directory",
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "detailState": "not_fetched" if article_links else "no_results_confirmed",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", type=Path, default=DEFAULT_QUEUE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--delay", type=float, default=0.15)
    parser.add_argument("--retries", type=int, default=3)
    args = parser.parse_args()
    cookie = os.environ.get("JOJO_PEOPLEDATA_COOKIE", "").strip()
    if not cookie:
        raise SystemExit("JOJO_PEOPLEDATA_COOKIE is required")
    queue = json.loads(args.queue.read_text(encoding="utf-8"))
    targets = [
        (str(item["date"]), int(item["page"]))
        for item in queue.get("pages") or []
        if isinstance(item, dict) and item.get("state") in ACTIVE_STATES
    ]
    results: list[dict[str, Any]] = []
    for index, (date, page) in enumerate(sorted(targets), 1):
        error: Exception | None = None
        for attempt in range(1, args.retries + 1):
            try:
                result = parse_result(fetch(search_url(date, page), cookie, args.timeout), date, page)
                results.append(result)
                print(
                    f"[{index:02d}/{len(targets)}] {date} p{page:02d}: "
                    f"{result['resultCount']} article(s)",
                    flush=True,
                )
                error = None
                break
            except (HTTPError, URLError, TimeoutError, RuntimeError) as exc:
                error = exc
                if attempt < args.retries:
                    time.sleep(attempt)
        if error is not None:
            raise SystemExit(f"Failed {date} p{page:02d}: {error}")
        time.sleep(args.delay)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in results),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "pages": len(results),
                "pagesWithResults": sum(bool(row["titles"]) for row in results),
                "noResultPages": sum(not row["titles"] for row in results),
                "articles": sum(len(row["titles"]) for row in results),
                "output": str(args.output.resolve()),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
