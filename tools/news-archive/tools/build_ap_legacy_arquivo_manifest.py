from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import json
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit, urlunsplit

import httpx


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))


from jojo_olds_api.ap_legacy_catalog import (
    ARQUIVO_PT_REPLAY_ENDPOINT,
    ap_google_hosted_page_metadata,
    ap_huff_wire_page_metadata,
    ap_hosted_page_metadata,
    build_ap_hosted_manifest_rows,
    build_ap_partner_manifest_rows,
    normalize_ap_partner_url,
    write_ap_manifest_rows,
)
from jojo_olds_api.archive_sources import (
    ap_hosted_publication_datetime,
    archive_source_spec,
    normalize_article_url,
)


ARQUIVO_PT_CDX_ENDPOINT = "https://arquivo.pt/wayback/cdx"
HOSTED_AP_PATTERN = "hosted.ap.org/dynamic/stories/*"
GOOGLE_HOSTED_AP_PATTERN = "www.google.com/hostednews/ap/article/*"
YAHOO_AP_PATTERNS = (
    "news.yahoo.com/s/ap/*",
    "news.yahoo.com/s/ap_*",
)
HUFF_AP_PATTERN = "www.huffingtonpost.com/huff-wires/*"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build an AP legacy supplemental manifest from Arquivo.pt's "
            "Hosted AP captures."
        )
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--from-year", type=int, required=True)
    parser.add_argument("--to-year", type=int, required=True)
    parser.add_argument("--capture-from-year", type=int, required=True)
    parser.add_argument("--capture-to-year", type=int, required=True)
    parser.add_argument("--limit", type=int, default=100_000)
    parser.add_argument("--maximum-candidates", type=int, default=3)
    parser.add_argument("--attempts", type=int, default=5)
    parser.add_argument(
        "--recover-missing-ctime",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--recovery-workers", type=int, default=4)
    parser.add_argument(
        "--include-google-hosted",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--include-yahoo",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--include-huff-wires",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    return parser.parse_args()


def fetch_rows(
    client: httpx.Client,
    *,
    capture_from_year: int,
    capture_to_year: int,
    limit: int,
    attempts: int,
    pattern: str = HOSTED_AP_PATTERN,
) -> tuple[list[dict[str, object]], int]:
    if limit < 1 or attempts < 1:
        raise ValueError("limit and attempts must be positive")
    params = [
        ("url", pattern),
        ("output", "json"),
        ("filter", "status:200"),
        ("filter", "mime:text/html"),
        ("from", str(capture_from_year)),
        ("to", str(capture_to_year)),
        ("limit", str(limit)),
    ]
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        rows: list[dict[str, object]] = []
        try:
            with client.stream(
                "GET",
                ARQUIVO_PT_CDX_ENDPOINT,
                params=params,
            ) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    if not line.strip():
                        continue
                    row = json.loads(line)
                    if isinstance(row, dict):
                        rows.append(row)
            return rows, attempt
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt < attempts:
                time.sleep(min(2 ** (attempt - 1), 8))
    assert last_error is not None
    raise last_error


def recover_missing_ctime_rows(
    rows: list[dict[str, object]],
    client: httpx.Client,
    *,
    workers: int,
    attempts: int,
) -> tuple[list[dict[str, object]], dict[str, int]]:
    if workers < 1 or attempts < 1:
        raise ValueError("workers and attempts must be positive")
    spec = archive_source_spec("ap")
    pending: dict[str, list[tuple[int, str, str]]] = {}
    for index, row in enumerate(rows):
        original_url = str(row.get("url") or row.get("original") or "").strip()
        if ap_hosted_publication_datetime(original_url) is not None:
            continue
        timestamp = str(row.get("timestamp") or "").strip()
        if re.fullmatch(r"\d{14}", timestamp) is None:
            continue
        probe_url = _canonical_url_with_ctime(
            original_url,
            datetime(2000, 1, 1),
        )
        if normalize_article_url(spec, probe_url) is None:
            continue
        digest = str(row.get("digest") or "").strip()
        identity = digest or f"{timestamp}:{original_url}"
        pending.setdefault(identity, []).append((index, timestamp, original_url))

    def recover_group(
        item: tuple[str, list[tuple[int, str, str]]],
    ) -> tuple[str, tuple[datetime, str] | None]:
        identity, occurrences = item
        _, timestamp, original_url = occurrences[0]
        replay_url = f"{ARQUIVO_PT_REPLAY_ENDPOINT}/{timestamp}/{original_url}"
        for attempt in range(1, attempts + 1):
            try:
                response = client.get(replay_url)
                response.raise_for_status()
                if len(response.content) > 5_000_000:
                    return identity, None
                metadata = ap_hosted_page_metadata(response.content)
                if metadata is not None:
                    return identity, metadata
            except httpx.HTTPError:
                pass
            if attempt < attempts:
                time.sleep(min(2 ** (attempt - 1), 4))
        return identity, None

    recovered: dict[str, tuple[datetime, str]] = {}
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(recover_group, item): item[0]
            for item in pending.items()
        }
        for future in as_completed(futures):
            identity, metadata = future.result()
            if metadata is not None:
                recovered[identity] = metadata

    result = [dict(row) for row in rows]
    recovered_rows = 0
    for identity, occurrences in pending.items():
        metadata = recovered.get(identity)
        if metadata is None:
            continue
        published_at, headline = metadata
        for index, _, original_url in occurrences:
            result[index]["canonicalUrl"] = _canonical_url_with_ctime(
                original_url,
                published_at,
            )
            result[index]["expectedHeadline"] = headline
            recovered_rows += 1
    return result, {
        "missingCtimeRows": sum(len(values) for values in pending.values()),
        "recoveryGroups": len(pending),
        "recoveredGroups": len(recovered),
        "recoveredRows": recovered_rows,
        "recoveryFailures": len(pending) - len(recovered),
    }


def recover_google_hosted_rows(
    rows: list[dict[str, object]],
    client: httpx.Client,
    *,
    workers: int,
    attempts: int,
) -> tuple[list[dict[str, object]], dict[str, int]]:
    """Validate Google Hosted News pages and recover AP publication data."""
    if workers < 1 or attempts < 1:
        raise ValueError("workers and attempts must be positive")
    pending: dict[str, list[tuple[int, str, str]]] = {}
    rejected_urls = 0
    for index, row in enumerate(rows):
        original_url = str(row.get("url") or row.get("original") or "").strip()
        canonical_url = normalize_ap_partner_url(original_url)
        timestamp = str(row.get("timestamp") or "").strip()
        if canonical_url is None or re.fullmatch(r"\d{14}", timestamp) is None:
            rejected_urls += 1
            continue
        digest = str(row.get("digest") or "").strip()
        identity = digest or f"{timestamp}:{canonical_url}"
        pending.setdefault(identity, []).append((index, timestamp, original_url))

    def recover_group(
        item: tuple[str, list[tuple[int, str, str]]],
    ) -> tuple[str, tuple[datetime, str] | None]:
        identity, occurrences = item
        _, timestamp, original_url = occurrences[0]
        replay_url = f"{ARQUIVO_PT_REPLAY_ENDPOINT}/{timestamp}/{original_url}"
        for attempt in range(1, attempts + 1):
            try:
                response = client.get(replay_url)
                response.raise_for_status()
                if len(response.content) > 5_000_000:
                    return identity, None
                metadata = ap_google_hosted_page_metadata(response.content)
                if metadata is not None:
                    return identity, metadata
            except httpx.HTTPError:
                pass
            if attempt < attempts:
                time.sleep(min(2 ** (attempt - 1), 4))
        return identity, None

    recovered: dict[str, tuple[datetime, str]] = {}
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(recover_group, item): item[0]
            for item in pending.items()
        }
        for future in as_completed(futures):
            identity, metadata = future.result()
            if metadata is not None:
                recovered[identity] = metadata

    result = [dict(row) for row in rows]
    recovered_rows = 0
    for identity, occurrences in pending.items():
        metadata = recovered.get(identity)
        if metadata is None:
            continue
        published_at, headline = metadata
        for index, _, original_url in occurrences:
            result[index]["canonicalUrl"] = normalize_ap_partner_url(original_url)
            result[index]["publishedAt"] = published_at.isoformat()
            result[index]["expectedHeadline"] = headline
            result[index]["partnerValidated"] = "google-hosted-ap"
            recovered_rows += 1
    return result, {
        "googleRows": len(rows),
        "googleRejectedUrls": rejected_urls,
        "googleRecoveryGroups": len(pending),
        "googleRecoveredGroups": len(recovered),
        "googleRecoveredRows": recovered_rows,
        "googleRecoveryFailures": len(pending) - len(recovered),
    }


def recover_huff_wire_rows(
    rows: list[dict[str, object]],
    client: httpx.Client,
    *,
    workers: int,
    attempts: int,
) -> tuple[list[dict[str, object]], dict[str, int]]:
    """Validate HuffPost AP-wire pages and recover precise metadata."""
    if workers < 1 or attempts < 1:
        raise ValueError("workers and attempts must be positive")
    pending: dict[str, list[tuple[int, str, str]]] = {}
    rejected_urls = 0
    for index, row in enumerate(rows):
        original_url = str(row.get("url") or row.get("original") or "").strip()
        canonical_url = normalize_ap_partner_url(original_url)
        timestamp = str(row.get("timestamp") or "").strip()
        if canonical_url is None or re.fullmatch(r"\d{14}", timestamp) is None:
            rejected_urls += 1
            continue
        digest = str(row.get("digest") or "").strip()
        identity = digest or f"{timestamp}:{canonical_url}"
        pending.setdefault(identity, []).append((index, timestamp, original_url))

    def recover_group(
        item: tuple[str, list[tuple[int, str, str]]],
    ) -> tuple[str, tuple[datetime, str] | None]:
        identity, occurrences = item
        _, timestamp, original_url = occurrences[0]
        replay_url = f"{ARQUIVO_PT_REPLAY_ENDPOINT}/{timestamp}/{original_url}"
        for attempt in range(1, attempts + 1):
            try:
                response = client.get(replay_url)
                response.raise_for_status()
                if len(response.content) > 5_000_000:
                    return identity, None
                metadata = ap_huff_wire_page_metadata(response.content)
                if metadata is not None:
                    return identity, metadata
            except httpx.HTTPError:
                pass
            if attempt < attempts:
                time.sleep(min(2 ** (attempt - 1), 4))
        return identity, None

    recovered: dict[str, tuple[datetime, str]] = {}
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(recover_group, item): item[0]
            for item in pending.items()
        }
        for future in as_completed(futures):
            identity, metadata = future.result()
            if metadata is not None:
                recovered[identity] = metadata

    result = [dict(row) for row in rows]
    recovered_rows = 0
    for identity, occurrences in pending.items():
        metadata = recovered.get(identity)
        if metadata is None:
            continue
        published_at, headline = metadata
        for index, _, original_url in occurrences:
            result[index]["canonicalUrl"] = normalize_ap_partner_url(original_url)
            result[index]["publishedAt"] = published_at.isoformat()
            result[index]["expectedHeadline"] = headline
            result[index]["partnerValidated"] = "huffpost-ap-wire"
            recovered_rows += 1
    return result, {
        "huffRows": len(rows),
        "huffRejectedUrls": rejected_urls,
        "huffRecoveryGroups": len(pending),
        "huffRecoveredGroups": len(recovered),
        "huffRecoveredRows": recovered_rows,
        "huffRecoveryFailures": len(pending) - len(recovered),
    }


def _canonical_url_with_ctime(
    original_url: str,
    published_at: datetime,
) -> str:
    parsed = urlsplit(original_url)
    return urlunsplit(
        (
            parsed.scheme or "https",
            parsed.netloc,
            parsed.path,
            "CTIME=" + published_at.strftime("%Y-%m-%d-%H-%M-%S"),
            "",
        )
    )


def main() -> int:
    args = parse_args()
    with httpx.Client(
        timeout=180,
        follow_redirects=True,
        headers={
            "User-Agent": (
                "JOJO-News-Archive-Research/0.1 "
                "(authorized nonprofit academic archive)"
            )
        },
    ) as client:
        rows, attempts_used = fetch_rows(
            client,
            capture_from_year=args.capture_from_year,
            capture_to_year=args.capture_to_year,
            limit=args.limit,
            attempts=args.attempts,
        )
        recovery_metrics = {
            "missingCtimeRows": 0,
            "recoveryGroups": 0,
            "recoveredGroups": 0,
            "recoveredRows": 0,
            "recoveryFailures": 0,
        }
        if args.recover_missing_ctime:
            rows, recovery_metrics = recover_missing_ctime_rows(
                rows,
                client,
                workers=args.recovery_workers,
                attempts=args.attempts,
            )
        partner_rows: list[dict[str, object]] = []
        partner_attempts: dict[str, int] = {}
        google_rows_count = 0
        huff_rows_count = 0
        yahoo_truncated = False
        google_metrics = {
            "googleRows": 0,
            "googleRejectedUrls": 0,
            "googleRecoveryGroups": 0,
            "googleRecoveredGroups": 0,
            "googleRecoveredRows": 0,
            "googleRecoveryFailures": 0,
        }
        huff_metrics = {
            "huffRows": 0,
            "huffRejectedUrls": 0,
            "huffRecoveryGroups": 0,
            "huffRecoveredGroups": 0,
            "huffRecoveredRows": 0,
            "huffRecoveryFailures": 0,
        }
        if args.include_google_hosted:
            google_rows, google_attempts = fetch_rows(
                client,
                capture_from_year=args.capture_from_year,
                capture_to_year=args.capture_to_year,
                limit=args.limit,
                attempts=args.attempts,
                pattern=GOOGLE_HOSTED_AP_PATTERN,
            )
            google_rows, google_metrics = recover_google_hosted_rows(
                google_rows,
                client,
                workers=args.recovery_workers,
                attempts=args.attempts,
            )
            google_rows_count = len(google_rows)
            partner_rows.extend(google_rows)
            partner_attempts["google"] = google_attempts
        if args.include_huff_wires:
            huff_rows, huff_attempts = fetch_rows(
                client,
                capture_from_year=args.capture_from_year,
                capture_to_year=args.capture_to_year,
                limit=args.limit,
                attempts=args.attempts,
                pattern=HUFF_AP_PATTERN,
            )
            huff_rows, huff_metrics = recover_huff_wire_rows(
                huff_rows,
                client,
                workers=args.recovery_workers,
                attempts=args.attempts,
            )
            huff_rows_count = len(huff_rows)
            partner_rows.extend(huff_rows)
            partner_attempts["huff"] = huff_attempts
        if args.include_yahoo:
            for yahoo_index, yahoo_pattern in enumerate(YAHOO_AP_PATTERNS):
                yahoo_rows, yahoo_attempts = fetch_rows(
                    client,
                    capture_from_year=args.capture_from_year,
                    capture_to_year=args.capture_to_year,
                    limit=args.limit,
                    attempts=args.attempts,
                    pattern=yahoo_pattern,
                )
                partner_rows.extend(yahoo_rows)
                partner_attempts[f"yahoo{yahoo_index + 1}"] = yahoo_attempts
                yahoo_truncated = yahoo_truncated or len(yahoo_rows) >= args.limit
    hosted_manifest, metrics = build_ap_hosted_manifest_rows(
        rows,
        from_year=args.from_year,
        to_year=args.to_year,
        maximum_candidates=args.maximum_candidates,
    )
    partner_manifest, partner_metrics = build_ap_partner_manifest_rows(
        partner_rows,
        from_year=args.from_year,
        to_year=args.to_year,
        maximum_candidates=args.maximum_candidates,
    )
    combined = {
        str(row["canonicalUrl"]): row
        for row in hosted_manifest + partner_manifest
    }
    write_ap_manifest_rows(
        (combined[key] for key in sorted(combined)),
        args.output,
    )
    print(
        json.dumps(
            {
                **{
                    f"hosted{key[0].upper()}{key[1:]}": value
                    for key, value in metrics.items()
                },
                **{
                    f"partner{key[0].upper()}{key[1:]}": value
                    for key, value in partner_metrics.items()
                },
                **recovery_metrics,
                **google_metrics,
                **huff_metrics,
                "articles": len(combined),
                "attemptsUsed": attempts_used,
                "partnerAttemptsUsed": partner_attempts,
                "limit": args.limit,
                "truncated": (
                    len(rows) >= args.limit
                    or any(
                        value >= args.limit
                        for value in (
                            google_rows_count,
                            huff_rows_count,
                        )
                    )
                    or yahoo_truncated
                ),
                "output": str(args.output),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
