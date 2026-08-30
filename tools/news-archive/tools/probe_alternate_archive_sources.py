#!/usr/bin/env python3
"""Probe read-only alternate archive coverage without retaining responses."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
import hashlib
from html import unescape
import json
from pathlib import Path
import re
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen


SOURCES = ("archive-today", "jina-reader", "ghostarchive")
MAXIMUM_BYTES = 2_000_000
USER_AGENT = (
    "JOJO academic archive coverage probe/1.0 "
    "(+https://github.com/kargonerd/jojokanbao/tree/master/tools/news-archive)"
)
BLOCK_MARKERS = (
    b"captcha",
    b"cloudflare ray id",
    b"checking your browser",
    b"just a moment",
    b"security verification",
    b"verify you are human",
)
JINA_SHELL_MARKERS = (
    b"sign in to continue reading",
    b"subscribe to continue reading",
    b"wsj subscription",
)
ARCHIVE_TODAY_HOSTS = {
    "archive.is",
    "archive.md",
    "archive.ph",
    "archive.today",
    "archive.vn",
}


@dataclass(frozen=True)
class ProbeResult:
    canonical_url: str
    source: str
    request_url: str
    status: int | None
    final_url: str | None
    response_bytes: int
    response_sha256: str | None
    blocked: bool
    available: bool
    evidence: str
    error: str | None


def source_url(source: str, canonical_url: str) -> str:
    if source == "archive-today":
        encoded = quote(canonical_url, safe=":/?=&")
        return f"https://archive.ph/newest/{encoded}"
    if source == "jina-reader":
        return "https://r.jina.ai/" + canonical_url
    if source == "ghostarchive":
        return "https://ghostarchive.org/search?" + urlencode(
            {"term": canonical_url}
        )
    raise ValueError(f"unsupported source: {source}")


def classify_response(
    source: str,
    canonical_url: str,
    *,
    status: int,
    final_url: str,
    content: bytes,
) -> tuple[bool, bool, str]:
    lowered = content.lower()
    blocked = any(marker in lowered for marker in BLOCK_MARKERS)
    if status != 200 or blocked:
        return blocked, False, "blocked-or-http-error"
    if source == "archive-today":
        final = urlsplit(final_url)
        snapshot = bool(
            (final.hostname or "").casefold() in ARCHIVE_TODAY_HOSTS
            and re.fullmatch(r"/[A-Za-z0-9]{5,}", final.path)
        )
        available = snapshot and len(content) >= 2_000
        return blocked, available, (
            "snapshot-replay" if available else "no-snapshot-redirect"
        )
    if source == "jina-reader":
        shell = any(marker in lowered for marker in JINA_SHELL_MARKERS)
        available = len(content) >= 2_000 and not shell
        return blocked, available, (
            "substantial-reader-output" if available else "reader-shell"
        )
    if source == "ghostarchive":
        decoded = unescape(content.decode("utf-8", errors="ignore"))
        archive_links = re.findall(
            r'href=["\'](?:https://ghostarchive\.org)?/archive/'
            r'[A-Za-z0-9]+["\']',
            decoded,
            flags=re.IGNORECASE,
        )
        canonical_visible = canonical_url.casefold() in decoded.casefold()
        available = bool(archive_links and canonical_visible)
        return blocked, available, (
            "matching-archive-link" if available else "no-matching-archive"
        )
    raise ValueError(f"unsupported source: {source}")


def probe(
    source: str,
    canonical_url: str,
    *,
    timeout: float,
) -> ProbeResult:
    request_url = source_url(source, canonical_url)
    request = Request(
        request_url,
        headers={
            "Accept": "text/html,text/plain;q=0.9,*/*;q=0.1",
            "User-Agent": USER_AGENT,
        },
    )
    status: int | None = None
    final_url: str | None = None
    content = b""
    error: str | None = None
    try:
        with urlopen(request, timeout=timeout) as response:
            status = int(response.status)
            final_url = str(response.url)
            content = response.read(MAXIMUM_BYTES + 1)
    except HTTPError as exc:
        status = int(exc.code)
        final_url = str(exc.url)
        content = exc.read(MAXIMUM_BYTES + 1)
        error = f"HTTPError:{exc.code}"
    except (TimeoutError, socket.timeout, URLError) as exc:
        error = f"{type(exc).__name__}:{exc.reason if isinstance(exc, URLError) else exc}"
    except Exception as exc:
        error = f"{type(exc).__name__}:{exc}"
    if len(content) > MAXIMUM_BYTES:
        content = content[:MAXIMUM_BYTES]
        error = (error + ";" if error else "") + "response-truncated"
    blocked, available, evidence = classify_response(
        source,
        canonical_url,
        status=status or 0,
        final_url=final_url or request_url,
        content=content,
    )
    return ProbeResult(
        canonical_url=canonical_url,
        source=source,
        request_url=request_url,
        status=status,
        final_url=final_url,
        response_bytes=len(content),
        response_sha256=(hashlib.sha256(content).hexdigest() if content else None),
        blocked=blocked,
        available=available,
        evidence=evidence,
        error=error,
    )


def load_urls(path: Path) -> list[str]:
    urls = [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if not urls or any(
        urlsplit(url).scheme not in {"http", "https"}
        or not urlsplit(url).netloc
        for url in urls
    ):
        raise ValueError("input must contain absolute HTTP(S) URLs")
    return list(dict.fromkeys(urls))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=25.0)
    args = parser.parse_args()
    urls = load_urls(args.input)
    tasks = [(source, url) for source in SOURCES for url in urls]
    results: list[ProbeResult] = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {
            executor.submit(
                probe,
                source,
                url,
                timeout=max(1.0, args.timeout),
            ): (source, url)
            for source, url in tasks
        }
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            print(json.dumps(asdict(result), sort_keys=True), flush=True)
    summary = {
        "event": "summary",
        "sampleSize": len(urls),
        "probes": len(results),
        "sources": {
            source: {
                "available": sum(
                    result.available
                    for result in results
                    if result.source == source
                ),
                "blocked": sum(
                    result.blocked
                    for result in results
                    if result.source == source
                ),
                "errors": sum(
                    result.error is not None
                    for result in results
                    if result.source == source
                ),
            }
            for source in SOURCES
        },
    }
    print(json.dumps(summary, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
