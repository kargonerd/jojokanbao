#!/usr/bin/env python3
"""Backfill image-only RMRB records from PeopleData search results.

The PeopleData advanced-search result page already distinguishes text records
from image-only records: text records have a summary paragraph, while an
image-only record has an empty summary and one ``img.rmrbCover`` element.  This
collector uses that page only; it does not open article detail pages (which can
trigger an additional CAPTCHA).

Authentication is supplied through ``JOJO_PEOPLEDATA_COOKIE`` and is never
written to disk or logs.  Results are resumable and staging-only.  Downloaded
images are stored below ``tmp/pdfs`` and accepted records are written to a
separate manual-decision JSONL so the human workbench immediately hides them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import sqlite3
import time
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urljoin, urlparse
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup, Tag

from fetch_rmrb_peopledata_directories import REFERER, USER_AGENT


WORKSPACE = Path(__file__).resolve().parents[2]
REVIEW_ROOT = WORKSPACE / "tmp" / "rmrb-peopledata-full-directory"
DEFAULT_MISSING_DB = REVIEW_ROOT / "merged-missing-workbench.sqlite3"
DEFAULT_STATE_DB = REVIEW_ROOT / "peopledata-image-backfill-state.sqlite3"
DEFAULT_DECISIONS = REVIEW_ROOT / "manual-review-decisions-peopledata-image-auto.jsonl"
DEFAULT_SUMMARY = REVIEW_ROOT / "peopledata-image-backfill-summary.json"
DEFAULT_IMAGE_ROOT = WORKSPACE / "tmp" / "pdfs" / "rmrb-peopledata-online-images"
VPN_ORIGIN = "https://webvpn.zju.edu.cn"
VPN_TARGET = "77726476706e69737468656265737421f4f6559d69206d5f6e048ce29b5a2e7b74a4"
VPN_RMRB_ROOT = f"{VPN_ORIGIN}/https/{VPN_TARGET}/rmrb"
SEARCH_BASE = f"{VPN_RMRB_ROOT}/s?type=2&qs="
AUTH_MARKERS = ("欢迎您", "退出")
IMAGE_MAGIC = (
    (b"\xff\xd8\xff", ".jpg"),
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
    (b"RIFF", ".webp"),
)


class AuthenticationError(RuntimeError):
    """The response is not an authenticated PeopleData page."""


class RateLimitError(RuntimeError):
    """PeopleData rejected automated access or asked for verification."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_title(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return "".join(character for character in text if character.isalnum())


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
    return f"{SEARCH_BASE}{encoded}&pageNo={page_no}&pageSize={page_size}"


def vpn_absolute(value: str, base_url: str) -> str:
    value = str(value or "").strip()
    if not value:
        return ""
    if value.startswith("http://") or value.startswith("https://"):
        return value
    if value.startswith(f"/https/{VPN_TARGET}/"):
        return VPN_ORIGIN + value
    if value.startswith("/rmrb/"):
        return f"{VPN_ORIGIN}/https/{VPN_TARGET}" + value
    if value.startswith("/pic/"):
        return f"{VPN_ORIGIN}/https/{VPN_TARGET}" + value
    return urljoin(base_url, value)


def authenticated_html(body: str) -> None:
    compact = re.sub(r"\s+", " ", body)
    if not all(marker in compact for marker in AUTH_MARKERS):
        raise AuthenticationError(
            "PeopleData response is not authenticated; set JOJO_PEOPLEDATA_COOKIE"
        )
    if "请输入验证码" in compact or "校验验证码" in compact:
        raise RateLimitError("PeopleData requested a CAPTCHA; stop and resume later")


def _page_from_heading(heading: Tag, compact_day: str) -> int | None:
    edition_pattern = re.compile(rf"/rmrb/{re.escape(compact_day)}/(\d+)(?:[/?#]|$)")
    for link in heading.find_all_next("a", limit=8):
        if link.find_parent("h3") not in (None, heading):
            break
        match = edition_pattern.search(str(link.get("href") or ""))
        if match:
            return int(match.group(1))
    return None


def _content_block_for_heading(heading: Tag) -> Tag | None:
    next_heading = heading.find_next("h3")
    block = heading.find_next(
        "div", class_=lambda value: value and "incon_text" in str(value).split()
    )
    if block is None:
        return None
    if next_heading is not None:
        # If the first content block occurs after the next result heading, it
        # belongs to that next result and must not be associated with this one.
        node: Tag | None = heading
        while node is not None and node is not block and node is not next_heading:
            node = node.find_next()
        if node is next_heading:
            return None
    return block


def parse_search_results(body: str, expected_day: str, base_url: str) -> tuple[int, list[dict[str, Any]]]:
    authenticated_html(body)
    soup = BeautifulSoup(body, "html.parser")
    plain = soup.get_text(" ", strip=True)
    total_match = re.search(r"var\s+totalRecords\s*=\s*(\d+)\s*;", body)
    if not total_match:
        total_match = re.search(r"全部时间\(\s*(\d+)\s*条\)", plain)
    if not total_match:
        count_match = re.search(r"共\s*\d+\s*页/共\s*(\d+)\s*条数据", plain)
        total_match = count_match
    if not total_match:
        raise RuntimeError(f"Cannot read PeopleData result count for {expected_day}")

    compact_day = expected_day.replace("-", "")
    records: list[dict[str, Any]] = []
    page_ordinals: defaultdict[int, int] = defaultdict(int)
    seen: set[str] = set()
    for heading in soup.find_all("h3"):
        detail = heading.find("a", href=re.compile(r"/rmrb/pd\.html\?"))
        if detail is None:
            continue
        href = vpn_absolute(str(detail.get("href") or ""), base_url)
        if not href or href in seen or compact_day not in href:
            continue
        title = detail.get_text(" ", strip=True)
        page = _page_from_heading(heading, compact_day)
        if not title or page is None:
            continue
        block = _content_block_for_heading(heading)
        summary = ""
        image_urls: list[str] = []
        if block is not None:
            paragraph = block.find("p")
            summary = paragraph.get_text(" ", strip=True) if paragraph else ""
            for image in block.select("img.rmrbCover"):
                source = vpn_absolute(str(image.get("src") or ""), base_url)
                if source and source not in image_urls:
                    image_urls.append(source)
        position_values = parse_qs(urlparse(href).query).get("position") or []
        try:
            # In a date-wide search this is the same all-day PeopleData
            # ordinal stored in the canonical directory. It disambiguates
            # repeated titles such as “图片” across one edition.
            ordinal = int(position_values[0])
        except (IndexError, TypeError, ValueError):
            ordinal = page_ordinals[page]
        page_ordinals[page] += 1
        seen.add(href)
        records.append(
            {
                "page": page,
                "ordinal": ordinal,
                "title": title,
                "normalizedTitle": normalize_title(title),
                "summary": summary,
                "detailUrl": href,
                "imageUrls": image_urls,
            }
        )
    return int(total_match.group(1)), records


def request(url: str, cookie: str, timeout: float, *, referer: str = REFERER) -> tuple[bytes, str]:
    req = Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Cookie": cookie,
            "Referer": referer,
            "User-Agent": USER_AGENT,
        },
    )
    with urlopen(req, timeout=timeout) as response:
        return response.read(), str(response.headers.get("Content-Type") or "")


def fetch_search_day(
    day: str,
    cookie: str,
    *,
    timeout: float,
    page_size: int,
    retries: int,
    cooldown: float,
) -> tuple[int, list[dict[str, Any]], str]:
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            first_url = search_url(day, 1, page_size)
            raw, _ = request(first_url, cookie, timeout)
            body = raw.decode("utf-8", errors="replace")
            total, records = parse_search_results(body, day, first_url)
            page_no = 2
            while len(records) < total:
                url = search_url(day, page_no, page_size)
                raw, _ = request(url, cookie, timeout)
                _, page_records = parse_search_results(raw.decode("utf-8", errors="replace"), day, url)
                known = {record["detailUrl"] for record in records}
                additions = [record for record in page_records if record["detailUrl"] not in known]
                if not additions:
                    break
                # Re-number the per-edition positions across pagination.
                counts: defaultdict[int, int] = defaultdict(int)
                for record in records:
                    counts[int(record["page"])] = max(counts[int(record["page"])], int(record["ordinal"]) + 1)
                for record in additions:
                    page = int(record["page"])
                    record["ordinal"] = counts[page]
                    counts[page] += 1
                records.extend(additions)
                page_no += 1
            return total, records, first_url
        except HTTPError as exc:
            last_error = exc
            if exc.code == 418:
                if attempt == retries:
                    raise RateLimitError("PeopleData returned HTTP 418") from exc
                time.sleep(cooldown * attempt)
            elif attempt < retries:
                time.sleep(min(3.0 * attempt, 30.0))
        except (URLError, TimeoutError, AuthenticationError, RateLimitError, RuntimeError) as exc:
            last_error = exc
            if isinstance(exc, (AuthenticationError, RateLimitError)):
                raise
            if attempt < retries:
                time.sleep(min(3.0 * attempt, 30.0))
    raise RuntimeError(f"Failed to fetch {day}: {last_error}")


def image_extension(data: bytes, content_type: str, url: str) -> str:
    for magic, extension in IMAGE_MAGIC:
        if data.startswith(magic):
            if extension == ".webp" and data[8:12] != b"WEBP":
                continue
            return extension
    guessed = mimetypes.guess_extension(content_type.split(";", 1)[0].strip())
    if guessed in {".jpg", ".jpeg", ".png", ".gif", ".webp"}:
        return ".jpg" if guessed == ".jpeg" else guessed
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".gif", ".webp"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    raise RuntimeError("downloaded payload is not a recognized image")


def download_image(
    url: str,
    destination_stem: Path,
    cookie: str,
    timeout: float,
    referer: str,
) -> tuple[Path, str, int]:
    data, content_type = request(url, cookie, timeout, referer=referer)
    if len(data) < 100:
        raise RuntimeError(f"image response is unexpectedly small ({len(data)} bytes)")
    extension = image_extension(data, content_type, url)
    digest = hashlib.sha256(data).hexdigest()
    destination = destination_stem.with_name(destination_stem.name + f"-{digest[:12]}{extension}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    temporary.write_bytes(data)
    os.replace(temporary, destination)
    return destination, digest, len(data)


def initialize_state(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS scan_dates (
            issue_date TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            result_count INTEGER,
            parsed_count INTEGER,
            pending_count INTEGER,
            image_count INTEGER,
            error TEXT,
            updated_at TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS article_results (
            issue_date TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            ordinal INTEGER NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            matched_title TEXT,
            detail_url TEXT,
            image_url TEXT,
            image_path TEXT,
            image_sha256 TEXT,
            image_bytes INTEGER,
            reason TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(issue_date, page_number, ordinal)
        ) WITHOUT ROWID;
        """
    )
    return connection


def load_handled_keys(
    root: Path,
) -> tuple[set[tuple[str, int, int]], set[tuple[str, int, int]]]:
    keys: set[tuple[str, int, int]] = set()
    title_placeholder_keys: set[tuple[str, int, int]] = set()
    for path in sorted(root.glob("manual-review-decisions-*.jsonl")):
        try:
            with path.open(encoding="utf-8-sig") as stream:
                for line in stream:
                    if not line.strip():
                        continue
                    row = json.loads(line)
                    decision = str(row.get("decision") or row.get("status") or "").lower()
                    if decision not in {"accept", "reject"}:
                        continue
                    key = (str(row["date"]), int(row["page"]), int(row["peopleDataOrdinal"]))
                    keys.add(key)
                    if (
                        decision == "accept"
                        and str(row.get("content") or "").strip() == "【图片】"
                        and str(row.get("reason") or "").strip()
                        == "标题为“图片”，按规则补入图片占位符"
                        and not list(row.get("evidence") or [])
                    ):
                        title_placeholder_keys.add(key)
        except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
            continue
    return keys, title_placeholder_keys


def pending_by_date(
    missing_db: Path,
    handled: set[tuple[str, int, int]],
    start_date: str | None,
    end_date: str | None,
) -> dict[str, list[dict[str, Any]]]:
    query = (
        "SELECT issue_date, page_number, ordinal, title FROM missing_articles "
        "WHERE (? IS NULL OR issue_date >= ?) AND (? IS NULL OR issue_date <= ?) "
        "ORDER BY issue_date, page_number, ordinal"
    )
    grouped: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    with sqlite3.connect(missing_db) as connection:
        for issue_date, page, ordinal, title in connection.execute(
            query, (start_date, start_date, end_date, end_date)
        ):
            key = (str(issue_date), int(page), int(ordinal))
            if key in handled:
                continue
            grouped[key[0]].append(
                {"date": key[0], "page": key[1], "ordinal": key[2], "title": str(title or "")}
            )
    return dict(grouped)


def select_result(row: dict[str, Any], records: Iterable[dict[str, Any]]) -> tuple[dict[str, Any] | None, str]:
    target = normalize_title(row["title"])
    matches = [
        record
        for record in records
        if int(record["page"]) == int(row["page"])
        and record["normalizedTitle"] == target
    ]
    if len(matches) == 1:
        return matches[0], "unique_exact_title"
    ordinal_matches = [record for record in matches if int(record["ordinal"]) == int(row["ordinal"])]
    if len(ordinal_matches) == 1:
        return ordinal_matches[0], "exact_title_and_ordinal"
    if matches:
        return None, "ambiguous_exact_title"
    return None, "title_not_found"


def relative_evidence(path: Path) -> str:
    try:
        return path.resolve().relative_to(WORKSPACE.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def write_decisions(state: sqlite3.Connection, path: Path) -> int:
    decisions: dict[tuple[str, int, int], dict[str, Any]] = {}
    if path.is_file():
        with path.open(encoding="utf-8-sig") as stream:
            for line in stream:
                if not line.strip():
                    continue
                row = json.loads(line)
                key = (str(row["date"]), int(row["page"]), int(row["peopleDataOrdinal"]))
                decisions[key] = row
    rows = state.execute(
        "SELECT * FROM article_results WHERE status = 'image_downloaded' "
        "ORDER BY issue_date, page_number, ordinal"
    ).fetchall()
    for row in rows:
        evidence = [str(row["image_path"])] if row["image_path"] else []
        decision = {
            "date": row["issue_date"],
            "page": int(row["page_number"]),
            "peopleDataOrdinal": int(row["ordinal"]),
            "title": row["title"],
            "decision": "accept",
            "content": "【图片】",
            "contentHtml": "【图片】",
            "reason": "人民数据搜索结果摘要为空且仅含一张文章图片；原图已自动下载。",
            "evidence": evidence,
            "peopleDataArticleUrl": row["detail_url"],
            "peopleDataImageUrl": row["image_url"],
            "imageSha256": row["image_sha256"],
            "imageBytes": int(row["image_bytes"] or 0),
            "reviewedAt": row["updated_at"],
            "scope": "staging-only",
            "sourceCorpusModified": False,
            "elasticsearchChanged": False,
            "automaticClass": "peopledata-search-image-only",
        }
        decisions[(decision["date"], decision["page"], decision["peopleDataOrdinal"])] = decision
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        for key in sorted(decisions):
            stream.write(json.dumps(decisions[key], ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(temporary, path)
    return len(decisions)


def write_summary(
    state: sqlite3.Connection,
    path: Path,
    *,
    missing_db: Path,
    decisions: Path,
    images: Path,
    pending_dates: int,
    pending_articles: int,
) -> dict[str, Any]:
    date_counts = dict(state.execute("SELECT status, COUNT(*) FROM scan_dates GROUP BY status"))
    article_counts = dict(state.execute("SELECT status, COUNT(*) FROM article_results GROUP BY status"))
    payload = {
        "updatedAt": utc_now(),
        "source": "PeopleData /rmrb/s advanced-search results",
        "missingDatabase": str(missing_db.resolve()),
        "decisionOutput": str(decisions.resolve()),
        "imageRoot": str(images.resolve()),
        "pendingDatesAtStart": pending_dates,
        "pendingArticlesAtStart": pending_articles,
        "dateStatuses": date_counts,
        "articleStatuses": article_counts,
        "downloadedImages": int(article_counts.get("image_downloaded", 0)),
        "sourceCorpusModified": False,
        "elasticsearchChanged": False,
    }
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    return payload


def upsert_article(
    state: sqlite3.Connection,
    row: dict[str, Any],
    status: str,
    *,
    match: dict[str, Any] | None = None,
    image_url: str | None = None,
    image_path: str | None = None,
    image_sha256: str | None = None,
    image_bytes: int | None = None,
    reason: str | None = None,
) -> None:
    state.execute(
        "INSERT OR REPLACE INTO article_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            row["date"], row["page"], row["ordinal"], row["title"], status,
            match.get("title") if match else None,
            match.get("detailUrl") if match else None,
            image_url, image_path, image_sha256, image_bytes, reason, utc_now(),
        ),
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--missing-db", type=Path, default=DEFAULT_MISSING_DB)
    parser.add_argument("--state-db", type=Path, default=DEFAULT_STATE_DB)
    parser.add_argument("--decisions", type=Path, default=DEFAULT_DECISIONS)
    parser.add_argument("--summary", type=Path, default=DEFAULT_SUMMARY)
    parser.add_argument("--image-root", type=Path, default=DEFAULT_IMAGE_ROOT)
    parser.add_argument("--start-date")
    parser.add_argument("--end-date")
    parser.add_argument("--max-dates", type=int)
    parser.add_argument("--page-size", type=int, default=200)
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--delay", type=float, default=0.6)
    parser.add_argument("--retries", type=int, default=5)
    parser.add_argument("--rate-limit-cooldown", type=float, default=120.0)
    parser.add_argument("--rescan", action="store_true")
    parser.add_argument("--plan-only", action="store_true")
    parser.add_argument(
        "--only-status",
        action="append",
        choices=(
            "ambiguous_exact_title",
            "image_download_error",
            "empty_without_image",
            "multiple_images",
            "title_not_found",
            "text_summary_present",
        ),
        help="Rescan only article keys currently recorded with this state; repeatable.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.missing_db.is_file():
        raise SystemExit(f"Missing workbench database: {args.missing_db}")

    handled, title_placeholders = load_handled_keys(args.decisions.parent)
    # Revisit the earlier title-only placeholders to download their real
    # PeopleData images. They remain hidden from the human workbench throughout.
    grouped = pending_by_date(
        args.missing_db,
        handled - title_placeholders,
        args.start_date,
        args.end_date,
    )
    pending_articles = sum(len(rows) for rows in grouped.values())
    if args.plan_only:
        print(
            json.dumps(
                {
                    "pendingArticles": pending_articles,
                    "pendingDates": len(grouped),
                    "firstDate": min(grouped) if grouped else None,
                    "lastDate": max(grouped) if grouped else None,
                    "handledKeys": len(handled),
                    "manualOrVerifiedHandledKeys": len(handled - title_placeholders),
                    "titlePlaceholderKeysToRecheck": len(title_placeholders),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    cookie = os.environ.get("JOJO_PEOPLEDATA_COOKIE", "").strip()
    if not cookie:
        raise SystemExit(
            "JOJO_PEOPLEDATA_COOKIE is required. Export the authenticated WebVPN Cookie header, "
            "then rerun; the value is never persisted."
        )
    state = initialize_state(args.state_db)
    if args.only_status:
        placeholders = ",".join("?" for _ in args.only_status)
        selected_keys = {
            (str(row[0]), int(row[1]), int(row[2]))
            for row in state.execute(
                f"SELECT issue_date, page_number, ordinal FROM article_results "
                f"WHERE status IN ({placeholders})",
                tuple(args.only_status),
            )
        }
        grouped = {
            day: [
                row
                for row in rows
                if (row["date"], int(row["page"]), int(row["ordinal"])) in selected_keys
            ]
            for day, rows in grouped.items()
        }
        grouped = {day: rows for day, rows in grouped.items() if rows}
        pending_articles = sum(len(rows) for rows in grouped.values())
    completed = {
        str(row[0])
        for row in state.execute("SELECT issue_date FROM scan_dates WHERE status = 'complete'")
    }
    days = [
        day
        for day in sorted(grouped)
        if args.rescan or args.only_status or day not in completed
    ]
    if args.max_dates is not None:
        days = days[: max(args.max_dates, 0)]
    print(
        f"pending_articles={pending_articles:,} pending_dates={len(grouped):,} "
        f"dates_to_scan={len(days):,}",
        flush=True,
    )

    try:
        for index, day in enumerate(days, 1):
            rows = grouped[day]
            try:
                total, records, source_url = fetch_search_day(
                    day,
                    cookie,
                    timeout=args.timeout,
                    page_size=args.page_size,
                    retries=args.retries,
                    cooldown=args.rate_limit_cooldown,
                )
                image_count = 0
                for row in rows:
                    match, match_reason = select_result(row, records)
                    if match is None:
                        upsert_article(state, row, match_reason, reason=match_reason)
                        continue
                    images = list(match.get("imageUrls") or [])
                    summary = str(match.get("summary") or "").strip()
                    if summary:
                        upsert_article(state, row, "text_summary_present", match=match, reason="search summary is not empty")
                        continue
                    if len(images) != 1:
                        status = "empty_without_image" if not images else "multiple_images"
                        upsert_article(state, row, status, match=match, reason=f"image_count={len(images)}")
                        continue
                    try:
                        stem = (
                            args.image_root
                            / day[:4]
                            / day[5:7]
                            / f"{day.replace('-', '')}-p{int(row['page']):02d}-o{int(row['ordinal']):04d}"
                        )
                        image_path, digest, byte_count = download_image(
                            images[0], stem, cookie, args.timeout, source_url
                        )
                    except (HTTPError, URLError, TimeoutError, RuntimeError, OSError) as exc:
                        upsert_article(
                            state, row, "image_download_error", match=match,
                            image_url=images[0], reason=str(exc),
                        )
                        continue
                    upsert_article(
                        state, row, "image_downloaded", match=match,
                        image_url=images[0], image_path=relative_evidence(image_path),
                        image_sha256=digest, image_bytes=byte_count,
                        reason=match_reason,
                    )
                    image_count += 1
                state.execute(
                    "INSERT OR REPLACE INTO scan_dates VALUES (?, 'complete', ?, ?, ?, ?, NULL, ?)",
                    (day, total, len(records), len(rows), image_count, utc_now()),
                )
                state.commit()
                staged = write_decisions(state, args.decisions)
                write_summary(
                    state, args.summary, missing_db=args.missing_db, decisions=args.decisions,
                    images=args.image_root, pending_dates=len(grouped), pending_articles=pending_articles,
                )
                print(
                    f"[{index:,}/{len(days):,}] {day}: results={len(records)}/{total} "
                    f"pending={len(rows)} images={image_count} staged_total={staged}",
                    flush=True,
                )
            except (AuthenticationError, RateLimitError) as exc:
                state.execute(
                    "INSERT OR REPLACE INTO scan_dates VALUES (?, 'blocked', NULL, NULL, ?, 0, ?, ?)",
                    (day, len(rows), str(exc), utc_now()),
                )
                state.commit()
                raise SystemExit(str(exc)) from exc
            except Exception as exc:  # keep the full queue resumable after a single bad date
                state.execute(
                    "INSERT OR REPLACE INTO scan_dates VALUES (?, 'failed', NULL, NULL, ?, 0, ?, ?)",
                    (day, len(rows), str(exc), utc_now()),
                )
                state.commit()
                print(f"[failed] {day}: {exc}", flush=True)
            time.sleep(max(args.delay, 0.0))
    finally:
        write_decisions(state, args.decisions)
        summary = write_summary(
            state, args.summary, missing_db=args.missing_db, decisions=args.decisions,
            images=args.image_root, pending_dates=len(grouped), pending_articles=pending_articles,
        )
        state.close()
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
