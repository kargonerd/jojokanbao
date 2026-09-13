"""Index a completed book publication from its immutable HF canonical revision."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import threading
from typing import Callable

from es_repair import KibanaConsoleClient, _load_root_env, repair_config
from es_sync import AppendOnlySync, HuggingFaceCanonical, book_documents, ensure_unified_mapping

_sync_lock = threading.Lock()


def index_status() -> dict:
    _load_root_env()
    config = repair_config()
    index = os.getenv("ES_SYNC_INDEX", "").strip() or os.getenv("ES_CONTENT_INDEX", "").strip()
    return {"configured": bool(index and all(config.get(key) for key in ("kibana_url", "username", "password"))), "index": index}


def sync_publication(build_root: Path, publication: dict, on_log: Callable[[str], None]) -> dict:
    """Only publish the items in this job. Retries reuse the exact HF commit."""
    repo = publication.get("repoId")
    revision = str(publication.get("revision") or str(publication.get("commit") or "").rsplit("/", 1)[-1])
    if not repo or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("请先完成 Hugging Face 发布，再同步 ES")
    report = json.loads((build_root / "report.json").read_text(encoding="utf-8"))
    expected = {item["itemId"] for item in report["itemsBuilt"]}
    source = HuggingFaceCanonical(repo, revision=revision)
    catalog = source.json("books/catalog.json")
    rows = []
    found = set()
    skipped = 0
    for collection in catalog.get("collections", []):
        for summary in collection.get("items", []):
            if summary.get("itemId") not in expected:
                continue
            key = "books/" + summary["downloadPath"]
            item = source.json_gz(key)
            if item.get("itemId") != summary["itemId"] or item.get("datasetId") != collection["datasetId"]:
                raise ValueError("HF 书籍身份与目录不匹配，停止 ES 同步")
            found.add(item["itemId"])
            if any(level.get("publicationStatus") == "draft" for level in (collection, summary, item)):
                skipped += 1
                continue
            rows.extend(book_documents(collection, item, canonical_object=key))
    if found != expected:
        raise ValueError("HF 提交缺少本次导入的书籍，停止 ES 同步")
    if not rows:
        return {"status": "skipped", "reason": "草稿不新增全文索引；检索范围随馆藏下架状态隐藏", "skippedBooks": skipped, "revision": revision, "created": 0}
    status = index_status()
    if not status["configured"]:
        raise ValueError("ES 尚未配置：请配置统一检索索引 ES_SYNC_INDEX 或 ES_CONTENT_INDEX 及现有 Kibana 连接")
    config = repair_config()
    config["index"] = status["index"]
    client = KibanaConsoleClient(config)
    # Serialize local publishers so simultaneous retries cannot both observe a missing ID.
    with _sync_lock:
        ensure_unified_mapping(client, status["index"])
        result = AppendOnlySync(client, status["index"]).run(rows, on_progress=lambda progress: on_log(
            f"已检查 {progress.examined} 章，新增 {progress.created}，已存在 {progress.unchanged}"
        ))
    if result.failed or result.conflicts:
        raise RuntimeError(f"ES 同步未完成：失败 {result.failed}，内容冲突 {result.conflicts}。重试不会重复新增；内容冲突请使用 ES 修复工具。")
    return {"status": "completed", "index": status["index"], "revision": revision, **result.as_dict()}
