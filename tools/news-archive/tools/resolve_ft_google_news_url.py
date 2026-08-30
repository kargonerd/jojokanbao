#!/usr/bin/env python3
"""Resolve an FT headline to its canonical URL through Google News RSS."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from xml.etree import ElementTree

import httpx

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.wayback_manifest import _decode_google_news_url


def resolve(headline: str) -> list[str]:
    with httpx.Client(
        timeout=30.0,
        follow_redirects=True,
        headers={"User-Agent": "jojo-ft-validation/1.0"},
    ) as client:
        response = client.get(
            "https://news.google.com/rss/search",
            params={
                "q": f'"{headline}"',
                "hl": "en-US",
                "gl": "US",
                "ceid": "US:en",
            },
        )
        response.raise_for_status()
        root = ElementTree.fromstring(response.content)
        resolved: list[str] = []
        for item in root.findall("./channel/item"):
            source = item.find("source")
            source_name = (source.text or "") if source is not None else ""
            if source_name.casefold() != "financial times":
                continue
            decoded = _decode_google_news_url(
                client,
                item.findtext("link") or "",
            )
            if (
                decoded.startswith("https://www.ft.com/content/")
                and decoded not in resolved
            ):
                resolved.append(decoded)
        return resolved


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--headline", required=True)
    args = parser.parse_args()
    print(
        json.dumps(
            {
                "headline": args.headline,
                "canonicalUrls": resolve(args.headline),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
