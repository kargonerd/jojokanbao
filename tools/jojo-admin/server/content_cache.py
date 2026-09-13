"""Refresh mutable book metadata and verify the reader-facing CDN before success."""
from __future__ import annotations

from pathlib import Path
import gzip
import json
import os
import sys
import time
from urllib.parse import quote

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "content-pipeline"))
from jojo_format import _decode_jox, _transform_jox


def refresh_book_delivery(build_root: Path, run, on_log) -> dict:
    report = json.loads((build_root / "report.json").read_text(encoding="utf-8"))
    dataset_ids = {item["datasetId"] for item in report["itemsBuilt"]}
    manifests = sorted({item["manifestObject"] for item in report["itemsBuilt"]})
    indexes = sorted({key.split("/items/", 1)[0] + "/index.jox" for key in manifests})
    keys = [*manifests, *indexes, "catalog.jox"]
    origin = os.getenv("VITE_CONTENT_CDN_BASE", "https://blacknews.jojokanbao.cn/").rstrip("/")
    expected = {}
    for key in keys:
        source = build_root / ("delivery" if key in manifests else ".publish/merged") / key
        expected[key] = _decode_jox(source, key)

    on_log("文件已上传，正在刷新线上目录与阅读缓存")
    run(["node", "tools/archive-pdf/purge-cache.mjs", *[f"{origin}/{quote(key, safe='/')}" for key in keys]], on_log)

    def comparable(key, value):
        # Other books may be published concurrently; only compare our entries.
        if key == "catalog.jox":
            return {entry["datasetId"]: entry for entry in value["datasets"] if entry["datasetId"] in dataset_ids}
        return value

    pending = set(keys)
    deadline = time.monotonic() + 180
    with requests.Session() as session:
        while pending:
            for key in list(pending):
                try:
                    response = session.get(f"{origin}/{quote(key, safe='/')}", headers={"Cache-Control": "no-cache"}, timeout=15)
                    response.raise_for_status()
                    actual = json.loads(gzip.decompress(_transform_jox(response.content, key)))
                    if comparable(key, actual) == comparable(key, expected[key]):
                        pending.remove(key)
                except (requests.RequestException, ValueError, OSError, KeyError, TypeError):
                    pass
            if not pending:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError(f"文件已上传，但线上缓存尚未更新：{', '.join(sorted(pending))}；请重试同步")
            on_log(f"正在等待线上缓存更新，还剩 {len(pending)} 个目录或阅读文件")
            time.sleep(5)
    on_log("线上目录、书籍状态与阅读文件均已核对一致")
    return {"status": "verified", "origin": origin, "objects": len(keys)}
