#!/usr/bin/env python3
"""Capture FT articles referenced by Folo's official FT podcast feed."""

from __future__ import annotations

import argparse
import concurrent.futures
import html
import json
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from bs4 import BeautifulSoup

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.news_models import CaptureCandidate, CaptureProvider
from jojo_olds_api.parser_validation import record_parser_validation
from jojo_olds_api.raw_archive_capture import (
    ManifestItem,
    capture_item,
    record_capture_result,
)
from tools.enrich_ft_validation_candidates import CachedResponseClient

FOLO_FT_NEWS_BRIEFING_FEED_ID = "62723356325837827"
_JINA_RATE_LOCK = threading.Lock()
_JINA_NEXT_REQUEST_AT = 0.0


def _wait_for_jina_rate_slot() -> None:
    global _JINA_NEXT_REQUEST_AT
    with _JINA_RATE_LOCK:
        delay = _JINA_NEXT_REQUEST_AT - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        _JINA_NEXT_REQUEST_AT = time.monotonic() + 3.5


@dataclass(frozen=True)
class AccessLink:
    canonical_url: str
    access_url: str
    headline: str


@dataclass(frozen=True)
class Target:
    canonical_url: str
    published_at: str | None
    section: str | None
    headline: str
    access_url: str


def _folo(*args: str) -> object:
    cached_cli = sorted(
        (
            Path.home()
            / "AppData"
            / "Local"
            / "npm-cache"
            / "_npx"
        ).glob("*/node_modules/.bin/folo.cmd"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if sys.platform == "win32" and cached_cli:
        command = [str(cached_cli[0]), *args, "--format", "json"]
    else:
        command = [
            "npx",
            "--yes",
            "folocli@latest",
            *args,
            "--format",
            "json",
        ]
    completed = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    payload = json.loads(completed.stdout)
    if not payload.get("ok"):
        raise RuntimeError(str(payload.get("error") or "Folo request failed"))
    return payload["data"]


def _canonical_ft_url(value: str) -> str | None:
    parsed = urlsplit(html.unescape(value))
    if (parsed.hostname or "").casefold() not in {"ft.com", "www.ft.com"}:
        return None
    if not parsed.path.startswith("/content/"):
        return None
    return urlunsplit(("https", "www.ft.com", parsed.path.rstrip("/"), "", ""))


def _episode_links(entry_id: str) -> list[AccessLink]:
    detail = _folo("entry", "get", entry_id)
    entry = detail["entries"]  # type: ignore[index]
    soup = BeautifulSoup(str(entry.get("content") or ""), "html.parser")
    links: list[AccessLink] = []
    for anchor in soup.find_all("a", href=True):
        access_url = html.unescape(str(anchor["href"]))
        canonical_url = _canonical_ft_url(access_url)
        if canonical_url is None or "accessToken=" not in access_url:
            continue
        headline = anchor.get_text(" ", strip=True)
        if headline:
            links.append(
                AccessLink(
                    canonical_url=canonical_url,
                    access_url=access_url,
                    headline=headline,
                )
            )
    return links


def collect_access_links(
    *,
    year: int,
    maximum_episodes: int,
) -> dict[str, AccessLink]:
    cursor: str | None = None
    episode_ids: list[str] = []
    while len(episode_ids) < maximum_episodes:
        args = [
            "timeline",
            "--feed",
            FOLO_FT_NEWS_BRIEFING_FEED_ID,
            "--limit",
            "20",
        ]
        if cursor:
            args.extend(["--cursor", cursor])
        page = _folo(*args)
        wrappers = page["entries"]  # type: ignore[index]
        if not wrappers:
            break
        reached_older_year = False
        for wrapper in wrappers:
            entry = wrapper["entries"]
            published_at = datetime.fromisoformat(
                str(entry["publishedAt"]).replace("Z", "+00:00")
            )
            if published_at.year == year:
                episode_ids.append(str(entry["id"]))
            elif published_at.year < year:
                reached_older_year = True
        if (
            len(episode_ids) >= maximum_episodes
            or reached_older_year
            or not page.get("hasNext")  # type: ignore[union-attr]
        ):
            break
        cursor = str(page["nextCursor"])  # type: ignore[index]

    links: dict[str, AccessLink] = {}
    selected_episode_ids = episode_ids[:maximum_episodes]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        for episode_links in executor.map(
            _episode_links,
            selected_episode_ids,
        ):
            for link in episode_links:
                links.setdefault(link.canonical_url, link)
    return links


def _capture(
    target: Target,
    *,
    output_dir: Path,
) -> dict[str, object] | None:
    reader_url = "https://r.jina.ai/" + target.access_url
    request = urllib.request.Request(
        reader_url,
        headers={
            "Accept": "text/html",
            "User-Agent": "jojo-ft-validation/1.0",
            "X-Return-Format": "html",
        },
    )
    for attempt in range(4):
        try:
            _wait_for_jina_rate_slot()
            with urllib.request.urlopen(request, timeout=45.0) as response:
                content = response.read(2_000_001)
                status = response.status
                content_type = response.headers.get(
                    "content-type", "text/html; charset=utf-8"
                )
            break
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == 3:
                return None
            time.sleep(10.0 * (attempt + 1))
        except Exception:
            return None
    else:
        return None
    if len(content) > 2_000_000:
        raise ValueError("Jina response exceeded maximum size")
    snapshot_url = "https://r.jina.ai/" + target.canonical_url
    candidate = CaptureCandidate(
        provider=CaptureProvider.OTHER,
        snapshot_url=snapshot_url,
        source_url=target.canonical_url,
        expected_headline=target.headline,
    )
    try:
        return capture_item(
            ManifestItem(
                publisher="ft",
                canonical_url=target.canonical_url,
                published_at=target.published_at,
                section=target.section,
                candidates=(candidate,),
            ),
            archive_client=CachedResponseClient(
                url=snapshot_url,
                status=status,
                content=content,
                final_url=target.canonical_url,
                content_type=content_type,
            ),
            output_dir=output_dir,
            maximum_html_bytes=2_000_000,
        )
    except Exception:
        return None


def capture(
    state_path: Path,
    *,
    output_dir: Path,
    year: int,
    maximum_episodes: int,
    workers: int,
    links_file: Path | None = None,
) -> dict[str, int]:
    if links_file is not None:
        links = {
            link.canonical_url: link
            for link in (
                AccessLink(**item)
                for item in json.loads(
                    links_file.read_text(encoding="utf-8")
                )
            )
        }
    else:
        links = collect_access_links(
            year=year,
            maximum_episodes=maximum_episodes,
        )
    connection = sqlite3.connect(state_path)
    try:
        targets = [
            Target(
                canonical_url=str(row[0]),
                published_at=str(row[1]) if row[1] else None,
                section=str(row[2]) if row[2] else None,
                headline=links[str(row[0])].headline,
                access_url=links[str(row[0])].access_url,
            )
            for row in connection.execute(
                """
                SELECT c.canonical_url, c.published_at, c.section
                FROM parser_validation_samples AS s
                JOIN captures AS c USING (canonical_url)
                LEFT JOIN parser_validation_results AS r
                  USING (canonical_url)
                WHERE r.canonical_url IS NULL
                  AND c.canonical_url IN (
                    SELECT value FROM json_each(?)
                  )
                ORDER BY s.sample_priority
                """,
                (json.dumps(list(links)),),
            )
        ]
        completed = 0
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=max(1, workers)
        ) as executor:
            for target, result in zip(
                targets,
                executor.map(
                    lambda item: _capture(item, output_dir=output_dir),
                    targets,
                ),
                strict=True,
            ):
                if result is None:
                    continue
                record_capture_result(connection, result)
                raw_capture = result.get("capture")
                if raw_capture is None:
                    continue
                record_parser_validation(
                    connection,
                    capture=raw_capture,
                    archive_root=output_dir,
                )
                connection.commit()
                completed += 1
        connection.commit()
        return {
            "episodes": min(maximum_episodes, len(links)),
            "links": len(links),
            "matched": len(targets),
            "completed": completed,
        }
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--max-episodes", type=int, default=60)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--links-file", type=Path)
    args = parser.parse_args()
    result = capture(
        args.state,
        output_dir=args.output_dir,
        year=args.year,
        maximum_episodes=max(1, args.max_episodes),
        workers=max(1, args.workers),
        links_file=args.links_file,
    )
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
