from __future__ import annotations

import argparse
import csv
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import json
import os
from pathlib import Path
import statistics
import time
from typing import Iterable
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


USER_AGENT = "JOJO-RSSHub-Coverage/1.0 (+https://jojokanbao.cn)"
MAX_RESPONSE_BYTES = 8_000_000
LONG_DESCRIPTION_CHARS = 1_000


@dataclass(frozen=True)
class Publisher:
    key: str
    name: str
    region: str
    path: str
    requested_limit: int
    note: str


# These routes were selected because they expose publication times and represent a broad
# publisher landing page. A route is kept in the catalog when it currently fails so that a
# future recovery is visible instead of being silently omitted from the denominator.
PUBLISHERS = (
    Publisher("bloomberg", "Bloomberg", "US / Global", "/bloomberg/markets", 100, "Markets route"),
    Publisher("ap", "Associated Press", "US / Global", "/apnews/mobile", 100, "AP mobile latest feed"),
    Publisher("bbc", "BBC News", "UK / Global", "/bbc", 100, "Top stories"),
    Publisher("aljazeera", "Al Jazeera English", "Middle East / Global", "/aljazeera/english/news", 100, "English news"),
    Publisher("npr", "NPR", "US", "/npr/1001", 100, "News channel 1001"),
    Publisher("dw", "DW", "Germany / Global", "/dw/rss/rss-en-all", 100, "All English news"),
    Publisher("cnbc", "CNBC", "US / Global", "/cnbc/rss", 100, "Top news"),
    Publisher("washingtonpost", "The Washington Post", "US / Global", "/washingtonpost/app/world", 100, "World section"),
    Publisher("cbc", "CBC News", "Canada", "/cbc/topics", 100, "All topics"),
    Publisher("rfi", "RFI", "France / Global", "/rfi", 100, "Generic news route"),
    Publisher("nikkei_asia", "Nikkei Asia", "Japan / Asia", "/nikkei/asia", 100, "Latest news"),
    Publisher("korea_herald", "The Korea Herald", "South Korea / Asia", "/koreaherald", 100, "Latest news"),
    Publisher("cna", "中央通讯社", "Taiwan / Asia", "/cna/aall", 100, "全部新闻"),
    Publisher("tass", "TASS", "Russia / Global", "/tass/world", 100, "World section; state-run source"),
    Publisher("people", "人民网", "Mainland China", "/people", 100, "Headlines; state-run source"),
    Publisher("nyt", "The New York Times", "US / Global", "/nytimes/rss/HomePage", 100, "Home page feed enhancement"),
    Publisher("wsj", "The Wall Street Journal", "US / Global", "/wsj/en-us", 100, "US edition"),
    Publisher("reuters", "Reuters", "UK / Global", "/reuters/world", 100, "World section"),
    Publisher("zaobao", "联合早报", "Singapore / Greater China", "/zaobao/realtime", 100, "即时新闻"),
    Publisher("caixin", "财新", "Mainland China", "/caixin/latest", 100, "最新文章，不带订阅 Cookie"),
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_instance(value: str) -> str:
    candidate = value.strip()
    if not urllib.parse.urlsplit(candidate).scheme:
        candidate = f"https://{candidate}"
    parsed = urllib.parse.urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"Invalid RSSHub instance URL: {value}")
    if parsed.query or parsed.fragment:
        raise ValueError("RSSHub instance must not contain a query or fragment")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def build_url(instance: str, publisher: Publisher, access_key: str | None) -> str:
    url = f"{normalize_instance(instance)}/{publisher.path.lstrip('/')}?limit={publisher.requested_limit}"
    if not access_key:
        return url
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query.append(("key", access_key))
    return urllib.parse.urlunsplit((*parsed[:3], urllib.parse.urlencode(query), parsed.fragment))


def request(url: str, timeout: float) -> tuple[bytes, dict]:
    started = time.perf_counter()
    request_object = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        },
    )
    try:
        with urllib.request.urlopen(request_object, timeout=timeout) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            truncated = len(body) > MAX_RESPONSE_BYTES
            return body[:MAX_RESPONSE_BYTES], {
                "http_status": response.status,
                "content_type": response.headers.get("content-type"),
                "bytes_read": min(len(body), MAX_RESPONSE_BYTES),
                "body_truncated": truncated,
                "elapsed_ms": round((time.perf_counter() - started) * 1_000),
            }
    except urllib.error.HTTPError as exc:
        exc.read(64_000)
        return b"", {
            "http_status": exc.code,
            "content_type": exc.headers.get("content-type"),
            "bytes_read": 0,
            "body_truncated": False,
            "elapsed_ms": round((time.perf_counter() - started) * 1_000),
            "error": f"HTTP {exc.code}: {exc.reason}",
        }


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def element_text(node: ET.Element) -> str | None:
    value = "".join(node.itertext()).strip()
    return value or None


def child_text(node: ET.Element, names: Iterable[str]) -> str | None:
    wanted = {name.lower() for name in names}
    for child in node:
        if local_name(child.tag) in wanted:
            value = element_text(child)
            if value:
                return value
    return None


def entry_link(node: ET.Element) -> str | None:
    for child in node:
        if local_name(child.tag) != "link":
            continue
        if child.get("href"):
            return child.get("href")
        if value := element_text(child):
            return value
    return None


def parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_feed(body: bytes) -> list[dict]:
    root = ET.fromstring(body)
    kind = local_name(root.tag)
    if kind not in {"rss", "rdf", "feed"}:
        raise ValueError(f"expected RSS/Atom root, got <{kind}>")
    entry_name = "entry" if kind == "feed" else "item"
    entries = []
    for node in root.iter():
        if local_name(node.tag) != entry_name:
            continue
        published = parse_datetime(child_text(node, ("pubdate", "date", "published", "updated")))
        entries.append(
            {
                "title": child_text(node, ("title",)),
                "url": entry_link(node),
                "published_utc": published.isoformat() if published else None,
                "published": published,
                "description_chars": len(child_text(node, ("description", "encoded", "content", "summary")) or ""),
            }
        )
    return entries


def summarize_entries(entries: list[dict], now: datetime, zone: ZoneInfo, requested_limit: int) -> dict:
    today = now.astimezone(zone).date()
    yesterday = today - timedelta(days=1)
    buckets = {"today": 0, "yesterday": 0, "older": 0, "future": 0, "undated": 0}
    urls: set[str] = set()
    description_lengths = []
    freshest: datetime | None = None

    for entry in entries:
        if entry["url"]:
            urls.add(entry["url"])
        description_lengths.append(entry["description_chars"])
        published = entry.pop("published")
        if published is None:
            buckets["undated"] += 1
            continue
        freshest = max(freshest, published) if freshest else published
        local_date = published.astimezone(zone).date()
        if local_date == today:
            buckets["today"] += 1
        elif local_date == yesterday:
            buckets["yesterday"] += 1
        elif local_date > today:
            buckets["future"] += 1
        else:
            buckets["older"] += 1

    nonempty = sum(length > 0 for length in description_lengths)
    long_descriptions = sum(length >= LONG_DESCRIPTION_CHARS for length in description_lengths)
    return {
        "item_count": len(entries),
        "unique_url_count": len(urls),
        "today_count": buckets["today"],
        "yesterday_count": buckets["yesterday"],
        "recent_count": buckets["today"] + buckets["yesterday"],
        "older_count": buckets["older"],
        "future_count": buckets["future"],
        "undated_count": buckets["undated"],
        "description_nonempty_rate": round(nonempty / len(entries), 3) if entries else None,
        "long_description_rate": round(long_descriptions / len(entries), 3) if entries else None,
        "median_description_chars": round(statistics.median(description_lengths)) if entries else None,
        "freshest_published_at": freshest.isoformat() if freshest else None,
        "feed_window_saturated": len(entries) >= requested_limit,
    }


def probe_publisher(
    instance: str,
    publisher: Publisher,
    access_key: str | None,
    timeout: float,
    retries: int,
    now: datetime,
    zone: ZoneInfo,
) -> dict:
    url = build_url(instance, publisher, access_key)
    base = asdict(publisher)
    last_result: dict = {}
    for attempt in range(retries + 1):
        try:
            body, transport = request(url, timeout)
            last_result = {**base, **transport, "attempts": attempt + 1}
            if transport["http_status"] != 200:
                last_result["status"] = "http_error"
            elif transport["body_truncated"]:
                last_result.update(status="response_too_large", error="response exceeded safety limit")
            elif "html" in (transport.get("content_type") or "").lower():
                last_result.update(status="html_instead_of_feed", error="server returned HTML")
            else:
                entries = parse_feed(body)
                last_result.update(status="ok", **summarize_entries(entries, now, zone, publisher.requested_limit))
                return last_result
        except (ET.ParseError, ValueError) as exc:
            last_result = {**base, "status": "invalid_feed", "error": f"{type(exc).__name__}: {exc}", "attempts": attempt + 1}
        except Exception as exc:
            last_result = {**base, "status": "request_error", "error": f"{type(exc).__name__}: {exc}", "attempts": attempt + 1}
        if attempt < retries:
            time.sleep(3 * (attempt + 1))
    return last_result


def build_report(instance: str, results: list[dict], now: datetime, timezone_name: str) -> dict:
    available = [result for result in results if result["status"] == "ok"]
    with_today = [result for result in available if result.get("today_count", 0) > 0]
    with_recent = [result for result in available if result.get("recent_count", 0) > 0]
    total_today = sum(result.get("today_count", 0) for result in available)
    total_yesterday = sum(result.get("yesterday_count", 0) for result in available)
    denominator = len(results)
    local_now = now.astimezone(ZoneInfo(timezone_name))
    return {
        "schema_version": 1,
        "generated_at": now.isoformat(),
        "instance": normalize_instance(instance),
        "timezone": timezone_name,
        "local_today": local_now.date().isoformat(),
        "local_yesterday": (local_now.date() - timedelta(days=1)).isoformat(),
        "interpretation": (
            "Counts are the dated items returned by each configured RSSHub feed window. "
            "They are not a denominator-based estimate of all articles published by the newsroom. "
            "Descriptions, including long descriptions, are not proof of full article text."
        ),
        "summary": {
            "publisher_count": denominator,
            "available_publisher_count": len(available),
            "available_publisher_rate": round(len(available) / denominator, 3) if denominator else None,
            "publishers_with_today_items": len(with_today),
            "today_publisher_rate": round(len(with_today) / denominator, 3) if denominator else None,
            "publishers_with_today_or_yesterday_items": len(with_recent),
            "recent_publisher_rate": round(len(with_recent) / denominator, 3) if denominator else None,
            "returned_today_items": total_today,
            "returned_yesterday_items": total_yesterday,
            "returned_recent_items": total_today + total_yesterday,
        },
        "publishers": results,
    }


def percent(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def render_markdown(report: dict) -> str:
    summary = report["summary"]
    lines = [
        "# RSSHub media coverage report",
        "",
        f"- Instance: `{report['instance']}`",
        f"- Generated: `{report['generated_at']}`",
        f"- Calendar: `{report['timezone']}`; today `{report['local_today']}`, yesterday `{report['local_yesterday']}`",
        f"- Valid feeds: **{summary['available_publisher_count']}/{summary['publisher_count']} ({percent(summary['available_publisher_rate'])})**",
        f"- Publishers returning today's items: **{summary['publishers_with_today_items']}/{summary['publisher_count']} ({percent(summary['today_publisher_rate'])})**",
        f"- Returned dated items: **{summary['returned_today_items']} today + {summary['returned_yesterday_items']} yesterday**",
        "",
        "> Coverage here means the RSSHub feed window returned dated items. It does not prove complete newsroom output or full text.",
        "",
        "| Publisher | Result | HTTP | Today | Yesterday | Feed items | Description | Long description | Requested limit reached |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for result in report["publishers"]:
        ok = result["status"] == "ok"
        lines.append(
            "| {name} | {status} | {http} | {today} | {yesterday} | {items} | {description} | {long_description} | {saturated} |".format(
                name=result["name"].replace("|", "\\|"),
                status=result["status"],
                http=result.get("http_status", "—"),
                today=result.get("today_count", "—"),
                yesterday=result.get("yesterday_count", "—"),
                items=result.get("item_count", "—"),
                description=percent(result.get("description_nonempty_rate")) if ok else "—",
                long_description=percent(result.get("long_description_rate")) if ok else "—",
                saturated="yes" if result.get("feed_window_saturated") else "no" if ok else "—",
            )
        )
    failures = [result for result in report["publishers"] if result["status"] != "ok"]
    if failures:
        lines.extend(("", "## Failures", ""))
        for result in failures:
            lines.append(f"- **{result['name']}**: `{result['status']}` — {result.get('error', 'no detail')}")
    lines.extend(("", "## Interpretation", "", report["interpretation"], ""))
    return "\n".join(lines)


def write_outputs(report: dict, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "coverage.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output_dir / "summary.md").write_text(render_markdown(report), encoding="utf-8")
    fields = (
        "key", "name", "region", "status", "http_status", "today_count", "yesterday_count", "recent_count",
        "item_count", "unique_url_count", "undated_count", "description_nonempty_rate", "long_description_rate",
        "median_description_chars", "freshest_published_at", "feed_window_saturated", "elapsed_ms", "attempts", "error",
    )
    with (output_dir / "coverage.csv").open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(report["publishers"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure dated news returned by selected RSSHub publisher routes.")
    parser.add_argument("--instance", default="https://jojokanbao-rsshub.onrender.com")
    parser.add_argument("--access-key-env", default="JOJOKANBAO_RSSHUB_ACCESS_KEY")
    parser.add_argument("--timezone", default="Asia/Shanghai")
    parser.add_argument("--timeout", type=float, default=90.0)
    parser.add_argument("--retries", type=int, default=1)
    parser.add_argument("--request-delay", type=float, default=1.0)
    parser.add_argument("--publisher", action="append", choices=[publisher.key for publisher in PUBLISHERS])
    parser.add_argument("--output-dir", type=Path, default=Path("rsshub-coverage-report"))
    args = parser.parse_args()

    if args.timeout <= 0 or args.retries < 0 or args.request_delay < 0:
        parser.error("timeout must be positive; retries and request-delay must be non-negative")
    try:
        zone = ZoneInfo(args.timezone)
        instance = normalize_instance(args.instance)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        parser.error(str(exc))
    access_key = os.environ.get(args.access_key_env)
    if not access_key:
        parser.error(f"environment variable is unset or empty: {args.access_key_env}")

    selected = set(args.publisher or ())
    publishers = [publisher for publisher in PUBLISHERS if not selected or publisher.key in selected]
    now = utc_now()
    results = []
    for index, publisher in enumerate(publishers):
        if index and args.request_delay:
            time.sleep(args.request_delay)
        result = probe_publisher(instance, publisher, access_key, args.timeout, args.retries, now, zone)
        results.append(result)
        print(
            f"{publisher.key}: {result['status']} http={result.get('http_status', '-')} "
            f"today={result.get('today_count', '-')} yesterday={result.get('yesterday_count', '-')} "
            f"items={result.get('item_count', '-')} elapsed_ms={result.get('elapsed_ms', '-')}",
            flush=True,
        )

    report = build_report(instance, results, now, args.timezone)
    write_outputs(report, args.output_dir)
    summary = report["summary"]
    print(
        f"TOTAL valid={summary['available_publisher_count']}/{summary['publisher_count']} "
        f"today_publishers={summary['publishers_with_today_items']}/{summary['publisher_count']} "
        f"today_items={summary['returned_today_items']} yesterday_items={summary['returned_yesterday_items']}"
    )
    print(f"Report: {args.output_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
