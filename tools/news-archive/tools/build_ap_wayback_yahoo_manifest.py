from __future__ import annotations

import argparse
import calendar
from collections import Counter
import json
from pathlib import Path
import sys
import time

import httpx


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))


from jojo_olds_api.ap_legacy_catalog import (
    build_ap_partner_manifest_rows,
    write_ap_manifest_rows,
)
from jojo_olds_api.news_models import CaptureProvider


WAYBACK_CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx"
RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build an AP supplemental manifest from Yahoo-hosted AP wire "
            "pages indexed by publication month in Wayback."
        )
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--from-year", type=int, required=True)
    parser.add_argument("--to-year", type=int, required=True)
    parser.add_argument("--limit", type=int, default=100_000)
    parser.add_argument("--maximum-candidates", type=int, default=3)
    parser.add_argument("--attempts", type=int, default=5)
    parser.add_argument("--min-request-interval", type=float, default=1.0)
    parser.add_argument("--timeout", type=float, default=180.0)
    return parser.parse_args()


def fetch_yahoo_month(
    client: httpx.Client,
    *,
    year: int,
    month: int,
    limit: int,
    attempts: int,
) -> tuple[list[dict[str, object]], int]:
    if not 1900 <= year <= 2100 or not 1 <= month <= 12:
        raise ValueError("invalid Yahoo/AP publication month")
    if limit < 1 or attempts < 1:
        raise ValueError("limit and attempts must be positive")
    month_prefix = f"{year:04d}{month:02d}"

    def fetch_prefix(prefix: str) -> tuple[list[dict[str, object]], int]:
        params = [
            ("url", f"news.yahoo.com/s/ap/{prefix}*"),
            ("output", "json"),
            (
                "fl",
                "timestamp,original,statuscode,mimetype,digest,length",
            ),
            ("filter", "statuscode:200"),
            ("filter", "mimetype:text/html"),
            ("collapse", "urlkey"),
            ("limit", str(limit)),
        ]
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                response = client.get(WAYBACK_CDX_ENDPOINT, params=params)
                if response.status_code in RETRYABLE_STATUS_CODES:
                    raise RuntimeError(
                        f"retryable Wayback CDX HTTP {response.status_code}"
                    )
                response.raise_for_status()
                payload = response.json()
                if payload == []:
                    return [], attempt
                if not isinstance(payload, list) or not payload:
                    raise ValueError("Wayback CDX payload is not a table")
                header = payload[0]
                if not isinstance(header, list):
                    raise ValueError("Wayback CDX header is invalid")
                fields = [str(value) for value in header]
                rows: list[dict[str, object]] = []
                for raw_row in payload[1:]:
                    if (
                        not isinstance(raw_row, list)
                        or len(raw_row) != len(fields)
                    ):
                        raise ValueError(
                            "Wayback CDX row does not match header"
                        )
                    rows.append(dict(zip(fields, raw_row, strict=True)))
                return rows, attempt
            except (httpx.HTTPError, RuntimeError, ValueError) as exc:
                last_error = exc
                if attempt < attempts:
                    time.sleep(min(30, 2 ** (attempt - 1)))
        assert last_error is not None
        raise RuntimeError(
            f"Wayback Yahoo/AP prefix {prefix} failed after "
            f"{attempts} attempts"
        ) from last_error

    try:
        return fetch_prefix(month_prefix)
    except RuntimeError:
        # Large CDX month queries occasionally return a JSON error object even
        # after retries. Daily prefixes are disjoint and substantially smaller,
        # so use them as a fail-closed fallback instead of discarding all prior
        # months in the catalog run.
        rows: list[dict[str, object]] = []
        attempts_used = attempts
        for day in range(1, calendar.monthrange(year, month)[1] + 1):
            try:
                day_rows, day_attempts = fetch_prefix(
                    f"{month_prefix}{day:02d}"
                )
            except RuntimeError as day_error:
                raise RuntimeError(
                    f"Wayback Yahoo/AP month {month_prefix} failed in both "
                    "monthly and daily query modes"
                ) from day_error
            rows.extend(day_rows)
            attempts_used += day_attempts
        return rows, attempts_used


def main() -> int:
    args = parse_args()
    if args.from_year > args.to_year:
        raise SystemExit("--from-year must not be after --to-year")
    if args.limit < 1 or args.maximum_candidates < 1 or args.attempts < 1:
        raise SystemExit(
            "--limit, --maximum-candidates, and --attempts must be positive"
        )
    if args.min_request_interval < 0 or args.timeout <= 0:
        raise SystemExit(
            "--min-request-interval must not be negative and --timeout must "
            "be positive"
        )

    all_rows: list[dict[str, object]] = []
    attempts_by_month: dict[str, int] = {}
    rows_by_month: dict[str, int] = {}
    truncated_months: list[str] = []
    with httpx.Client(
        timeout=args.timeout,
        follow_redirects=True,
        headers={
            "User-Agent": (
                "JOJO-News-Archive-Research/0.1 "
                "(authorized nonprofit academic archive)"
            )
        },
    ) as client:
        previous_request_at = 0.0
        for year in range(args.from_year, args.to_year + 1):
            for month in range(1, 13):
                delay = args.min_request_interval - (
                    time.monotonic() - previous_request_at
                )
                if delay > 0:
                    time.sleep(delay)
                rows, attempts_used = fetch_yahoo_month(
                    client,
                    year=year,
                    month=month,
                    limit=args.limit,
                    attempts=args.attempts,
                )
                previous_request_at = time.monotonic()
                key = f"{year:04d}-{month:02d}"
                rows_by_month[key] = len(rows)
                attempts_by_month[key] = attempts_used
                if len(rows) >= args.limit:
                    truncated_months.append(key)
                all_rows.extend(rows)
                print(
                    json.dumps(
                        {
                            "event": "ap-wayback-yahoo-month",
                            "month": key,
                            "rows": len(rows),
                            "attempts": attempts_used,
                        }
                    ),
                    flush=True,
                )

    manifest_rows, metrics = build_ap_partner_manifest_rows(
        all_rows,
        from_year=args.from_year,
        to_year=args.to_year,
        maximum_candidates=args.maximum_candidates,
        provider=CaptureProvider.WAYBACK,
    )
    write_ap_manifest_rows(manifest_rows, args.output)
    articles_by_year = Counter(
        str(row.get("publishedAt") or "")[:4]
        for row in manifest_rows
    )
    summary = {
        **metrics,
        "articlesByYear": dict(sorted(articles_by_year.items())),
        "rowsByMonth": rows_by_month,
        "attemptsByMonth": attempts_by_month,
        "truncatedMonths": truncated_months,
        "truncated": bool(truncated_months),
        "output": str(args.output),
    }
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 2 if truncated_months else 0


if __name__ == "__main__":
    raise SystemExit(main())
