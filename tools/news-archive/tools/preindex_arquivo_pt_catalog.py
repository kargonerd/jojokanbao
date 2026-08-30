#!/usr/bin/env python3
"""Merge a bounded Arquivo.pt publisher/year prefix into capture candidates."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
from typing import Iterator

import httpx


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.raw_archive_capture import (
    arquivo_pt_prefix_cdx_url,
    preindex_arquivo_pt_prefix_candidates,
)


USER_AGENT = "jojo-news-archive-research/1.0 (+personal academic research)"


def _download_catalog(
    destination: Path,
    *,
    url: str,
    maximum_bytes: int,
    timeout: float,
    attempts: int,
) -> int:
    error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            written = 0
            with httpx.Client(
                headers={"User-Agent": USER_AGENT},
                follow_redirects=True,
                timeout=httpx.Timeout(timeout),
            ) as client:
                with client.stream("GET", url) as response:
                    response.raise_for_status()
                    content_type = response.headers.get(
                        "content-type", ""
                    ).casefold()
                    if not any(
                        marker in content_type
                        for marker in ("json", "text/plain", "octet-stream")
                    ):
                        raise ValueError(
                            "Arquivo.pt prefix response is not NDJSON: "
                            + content_type
                        )
                    with destination.open("wb") as handle:
                        for chunk in response.iter_bytes():
                            written += len(chunk)
                            if written > maximum_bytes:
                                raise ValueError(
                                    "Arquivo.pt prefix response exceeded "
                                    f"{maximum_bytes} bytes"
                                )
                            handle.write(chunk)
            return written
        except (httpx.HTTPError, OSError, ValueError) as exc:
            error = exc
            destination.unlink(missing_ok=True)
            if attempt < attempts:
                time.sleep(min(2 ** (attempt - 1), 8))
    assert error is not None
    raise error


def _catalog_rows(path: Path) -> Iterator[dict[str, object]]:
    with path.open("rb") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except (TypeError, ValueError, UnicodeDecodeError):
                continue
            if isinstance(row, dict):
                yield row


def _write_github_output(path: Path | None, result: dict[str, object]) -> None:
    if path is None:
        return
    with path.open("a", encoding="utf-8") as handle:
        for key in (
            "skipped",
            "bytesDownloaded",
            "rowsRead",
            "targetsMatched",
            "capturesUpdated",
            "candidatesSelected",
        ):
            value = result.get(key, 0)
            if isinstance(value, bool):
                value = str(value).lower()
            handle.write(f"{key}={value}\n")


def preindex(
    state_path: Path,
    *,
    publisher: str,
    year: int,
    limit: int,
    maximum_bytes: int,
    timeout: float,
    attempts: int,
) -> dict[str, object]:
    # v1 candidates were subsequently overwritten by the manifest reload in
    # capture_archive_batch.  v2 records that candidates were merged under
    # the persistence-safe manifest policy and intentionally reindexes a v1
    # checkpoint once.
    metadata_key = f"arquivo_pt-prefix-head-v2:{publisher}:{year}:{limit}"
    connection = sqlite3.connect(state_path, timeout=60)
    temporary_path: Path | None = None
    try:
        cached = connection.execute(
            "SELECT value FROM archive_metadata WHERE key=?",
            (metadata_key,),
        ).fetchone()
        if cached is not None:
            previous = json.loads(str(cached[0]))
            return {**previous, "skipped": True}

        state_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix="arquivo-pt-prefix-",
            suffix=".ndjson",
            dir=state_path.parent,
        )
        os.close(descriptor)
        temporary_path = Path(temporary_name)
        query_url = arquivo_pt_prefix_cdx_url(
            publisher=publisher,
            year=year,
            limit=limit,
        )
        byte_count = _download_catalog(
            temporary_path,
            url=query_url,
            maximum_bytes=maximum_bytes,
            timeout=timeout,
            attempts=attempts,
        )
        merged = preindex_arquivo_pt_prefix_candidates(
            connection,
            publisher=publisher,
            year=year,
            rows=_catalog_rows(temporary_path),
        )
        result: dict[str, object] = {
            "publisher": publisher,
            "year": year,
            "limit": limit,
            "bytesDownloaded": byte_count,
            **merged,
            "skipped": False,
        }
        connection.execute(
            """
            INSERT INTO archive_metadata(key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """,
            (
                metadata_key,
                json.dumps(
                    result,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                ),
            ),
        )
        connection.commit()
        return result
    finally:
        connection.close()
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Pre-index a bounded Arquivo.pt publisher/year prefix into an "
            "existing capture checkpoint without retaining the bulk catalog."
        )
    )
    parser.add_argument("--publisher", choices=("ft", "wsj"), required=True)
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=100_000)
    parser.add_argument("--maximum-bytes", type=int, default=75_000_000)
    parser.add_argument("--timeout", type=float, default=75.0)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--github-output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.limit < 1 or args.maximum_bytes < 1 or args.attempts < 1:
        raise SystemExit("--limit, --maximum-bytes and --attempts must be positive")
    result = preindex(
        args.state,
        publisher=args.publisher,
        year=args.year,
        limit=args.limit,
        maximum_bytes=args.maximum_bytes,
        timeout=args.timeout,
        attempts=args.attempts,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True)
    _write_github_output(args.github_output, result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
