"""Verify newly published issue manifests and Jox PDF byte ranges through the CDN."""
import argparse
import gzip
import json
import re
import time
from pathlib import Path
from urllib.parse import urljoin

import requests
from delivery import INDEX
from jojo_format import _available_dates, _transform_jox


def verify_report(rows, origin, session):
    def metadata(key):
        response = session.get(urljoin(origin, key), headers={"Cache-Control": "no-cache"}, timeout=30)
        response.raise_for_status()
        return json.loads(gzip.decompress(_transform_jox(response.content, key)))

    index = metadata(INDEX)
    available = _available_dates(index["availability"]["pdf"])
    for row in rows:
        manifest = metadata(row["manifest"])
        pdf = next(a for a in manifest["assets"] if a.get("role") == "issue-pdf")
        key = row["manifest"].removesuffix("manifest.jox") + pdf["object"]
        if key != row["asset"] or row["date"] not in available:
            raise RuntimeError(f"CDN still serves stale metadata for {row['date']}")
        with session.get(urljoin(origin, key), params={"v": pdf["sha256"]},
                         headers={"Range": "bytes=0-63"}, timeout=30, stream=True) as response:
            if response.status_code != 206:
                raise RuntimeError(f"Jox PDF Range returned {response.status_code}: {key}")
            if response.headers.get("Content-Range") != f"bytes 0-63/{pdf['size']}":
                raise RuntimeError(f"Invalid PDF Content-Range: {key}")
            raw = response.content
            if len(raw) != 64 or not _transform_jox(raw, key).startswith(b"%PDF-"):
                raise RuntimeError(f"Invalid Jox PDF header: {key}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--origin", default="https://blacknews.jojokanbao.cn/")
    parser.add_argument("--attempts", type=int, default=18)
    args = parser.parse_args()
    rows = [row for row in json.loads(args.report.read_text()) if row.get("published")]
    if not rows:
        return
    with requests.Session() as session:
        for attempt in range(args.attempts):
            try:
                verify_report(rows, args.origin.rstrip("/") + "/", session)
                print(f"Verified {len(rows)} issue manifests and Jox PDF ranges.")
                return
            except (requests.RequestException, ValueError, KeyError, StopIteration, RuntimeError) as error:
                if attempt + 1 == args.attempts:
                    raise
                print(f"CDN verification retry: {error}", flush=True)
                time.sleep(10)


if __name__ == "__main__":
    main()
