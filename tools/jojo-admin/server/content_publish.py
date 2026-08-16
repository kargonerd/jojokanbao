"""Publication adapters for canonical JOJO content builds."""
from __future__ import annotations

import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
from typing import Any, Callable, Iterable

from es_repair import KibanaConsoleClient, _load_root_env


ROOT = Path(__file__).resolve().parents[3]
RAW_REMOTE = os.getenv("JOJO_RAW_REMOTE", "jojo-b2:jojo-news-raw")
DELIVERY_REMOTE = os.getenv("JOJO_DELIVERY_REMOTE", "jojo-b2-s3:jojo-newspaper")
RCLONE_COPY_FLAGS = ["--checksum", "--transfers", "16", "--checkers", "32"]
RAW_COPY_FLAGS = [
    *RCLONE_COPY_FLAGS,
    "--b2-upload-cutoff", "50Mi",
    "--b2-chunk-size", "16Mi",
    "--b2-upload-concurrency", "8",
]
DELIVERY_COPY_FLAGS = [*RCLONE_COPY_FLAGS, "--s3-no-check-bucket"]


def _huggingface_token() -> str:
    explicit = os.getenv("HF_TOKEN", "").strip()
    if explicit:
        return explicit
    try:
        from huggingface_hub import get_token
    except ImportError:
        return ""
    return (get_token() or "").strip()


def publication_status() -> dict[str, Any]:
    _load_root_env()
    return {
        "b2": {
            "configured": bool(shutil.which("rclone")),
            "rawRemote": os.getenv("JOJO_RAW_REMOTE", RAW_REMOTE),
            "deliveryRemote": os.getenv("JOJO_DELIVERY_REMOTE", DELIVERY_REMOTE),
        },
        "elasticsearch": {
            "configured": all(os.getenv(key) for key in (
                "KIBANA_URL", "ELASTICSEARCH_USERNAME", "ELASTICSEARCH_PASSWORD"
            )),
            "index": os.getenv("ES_CONTENT_INDEX", "jojo-content-v1"),
        },
        "huggingface": {
            "configured": bool(_huggingface_token() and os.getenv("HF_DATASET_REPO")),
            "repoId": os.getenv("HF_DATASET_REPO", ""),
            "private": True,
        },
    }


def _run(command: list[str], on_log: Callable[[str], None]) -> None:
    if command[0] == "pnpm":
        command[0] = shutil.which("pnpm.cmd") or shutil.which("pnpm") or command[0]
    elif command[0] == "rclone":
        command[0] = shutil.which("rclone.exe") or shutil.which("rclone") or command[0]
    on_log("$ " + " ".join(command))
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert process.stdout is not None
    for line in process.stdout:
        on_log(line.rstrip())
    if process.wait() != 0:
        raise RuntimeError(f"命令执行失败（{process.returncode}）：{command[0]}")


def _try_copy_remote(remote: str, local: Path, on_log: Callable[[str], None]) -> bool:
    local.parent.mkdir(parents=True, exist_ok=True)
    command = ["rclone", "copyto", remote, str(local), "--retries", "2"]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode == 0:
        return True
    on_log(f"远端对象不存在，按首次发布处理：{remote}")
    return False


def publish_b2(build_root: Path, on_log: Callable[[str], None]) -> dict[str, Any]:
    if not shutil.which("rclone"):
        raise RuntimeError("未安装 rclone")
    raw_remote = os.getenv("JOJO_RAW_REMOTE", RAW_REMOTE).rstrip("/")
    delivery_remote = os.getenv("JOJO_DELIVERY_REMOTE", DELIVERY_REMOTE).rstrip("/")
    report = json.loads((build_root / "report.json").read_text(encoding="utf-8"))
    dataset_ids = sorted({item["datasetId"] for item in report["itemsBuilt"]})
    superseded_dataset_ids = sorted(set(report.get("supersededDatasetIds", [])))
    dataset_index_keys = sorted({
        item["manifestObject"].split("/items/", 1)[0] + "/index.jox"
        for item in report["itemsBuilt"]
    })
    remote_metadata = build_root / ".publish" / "remote"
    merged_metadata = build_root / ".publish" / "merged"
    if merged_metadata.exists():
        shutil.rmtree(merged_metadata)
    has_remote_catalog = _try_copy_remote(
        f"{delivery_remote}/catalog.jox",
        remote_metadata / "catalog.jox",
        on_log,
    )
    # A catalog is the delivery commit marker. If it is absent this is a first
    # publish, so probing every Dataset index only adds one failed B2 round trip
    # per Dataset and cannot discover a valid previous release.
    if has_remote_catalog:
        for key in dataset_index_keys:
            _try_copy_remote(f"{delivery_remote}/{key}", remote_metadata / key, on_log)
    merge_command = [
        "pnpm", "--filter", "@jojo/content-pipeline", "merge-delivery",
        "--local", str(build_root / "delivery"),
        "--remote", str(remote_metadata),
        "--output", str(merged_metadata),
    ]
    for dataset_id in superseded_dataset_ids:
        merge_command.extend(["--remove-dataset", dataset_id])
    _run(merge_command, on_log)

    _run(["rclone", "copy", str(build_root / "raw"), f"{raw_remote}/raw", *RAW_COPY_FLAGS], on_log)
    _run(["rclone", "copy", str(build_root / "canonical"), f"{raw_remote}/canonical", *RCLONE_COPY_FLAGS], on_log)
    _run([
        "rclone", "copy", str(build_root / "delivery" / "content"), f"{delivery_remote}/content",
        "--exclude", "**/manifest.jox", "--exclude", "**/index.jox", *DELIVERY_COPY_FLAGS,
    ], on_log)
    _run([
        "rclone", "copy", str(build_root / "delivery" / "content"), f"{delivery_remote}/content",
        "--filter", "+ **/manifest.jox", "--filter", "- **", *DELIVERY_COPY_FLAGS,
    ], on_log)
    if (merged_metadata / "content").exists():
        _run(["rclone", "copy", str(merged_metadata / "content"), f"{delivery_remote}/content", *DELIVERY_COPY_FLAGS], on_log)
    # B2's S3 compatibility endpoint may treat copyto(bucket/root-object) as a
    # bucket-creation attempt. Copy the parent with an exact root filter instead.
    _run([
        "rclone", "copy", str(merged_metadata), delivery_remote,
        "--filter", "+ /catalog.jox", "--filter", "- **", *DELIVERY_COPY_FLAGS,
    ], on_log)
    return {"datasets": len(dataset_ids), "rawRemote": raw_remote, "deliveryRemote": delivery_remote}


CONTENT_MAPPING = {
    "dynamic": "strict",
    "properties": {
        "formatVersion": {"type": "keyword"},
        "@timestamp": {"type": "date"},
        "documentId": {"type": "keyword"},
        "releaseId": {"type": "keyword"},
        "datasetId": {"type": "keyword"},
        "datasetFilterKey": {"type": "keyword"},
        "datasetTitle": {"type": "text", "fields": {"keyword": {"type": "keyword"}}},
        "itemId": {"type": "keyword"},
        "itemFilterKey": {"type": "keyword"},
        "itemTitle": {"type": "text", "fields": {"keyword": {"type": "keyword"}}},
        "itemType": {"type": "keyword"},
        "revision": {"type": "integer"},
        "targetId": {"type": "keyword"},
        "targetType": {"type": "keyword"},
        "targetTitle": {"type": "text", "fields": {"keyword": {"type": "keyword"}}},
        "chunkId": {"type": "keyword"},
        "order": {"type": "integer"},
        "text": {"type": "text"},
        "authors": {"type": "keyword"},
        "publishedDate": {"type": "date", "ignore_malformed": True},
        "manifestObject": {"type": "keyword", "index": False},
        "fragmentObject": {"type": "keyword", "index": False},
    },
}


def _documents(file_path: Path) -> Iterable[dict[str, Any]]:
    with gzip.open(file_path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def publish_elasticsearch(build_root: Path, on_log: Callable[[str], None]) -> dict[str, Any]:
    _load_root_env()
    index = os.getenv("ES_CONTENT_INDEX", "jojo-content-v1")
    config = None
    client = KibanaConsoleClient(config)
    # Tencent ES Serverless does not implement HEAD /{index}; an existing data
    # stream therefore looks like a 404. _count is supported by both regular
    # Elasticsearch and Serverless and is sufficient for the existence check.
    status, payload = client.request("GET", f"{index}/_count")
    if status == 404:
        status, payload = client.request("PUT", index, {"mappings": CONTENT_MAPPING})
        if status >= 400:
            detail = str(payload)
            if "Serverless index does not support" in detail:
                raise RuntimeError(
                    "腾讯云 ES Serverless 不允许通过 Elasticsearch PUT 创建索引；"
                    "请先在 Serverless 控制台创建索引，并将 ES_CONTENT_INDEX 指向该索引"
                )
            raise RuntimeError(f"创建 ES 索引失败：{payload}")
        on_log(f"已创建 Elasticsearch 索引 {index}")
    elif status >= 400:
        raise RuntimeError(f"检查 ES 索引失败：{payload}")

    report = json.loads((build_root / "report.json").read_text(encoding="utf-8"))
    indexed_at = report.get("generatedAt")
    release_id = "r" + hashlib.sha256(str(indexed_at).encode("utf-8")).hexdigest()[:20]
    dataset_ids = sorted({item["datasetId"] for item in report["itemsBuilt"]})
    append_only = False
    if dataset_ids:
        status, payload = client.request(
            "POST",
            f"{index}/_delete_by_query?refresh=true&conflicts=proceed",
            {"query": {"terms": {"datasetId": dataset_ids}}},
        )
        if status >= 400 and "Serverless index does not support" in str(payload):
            existing = _count_release_documents(client, index, release_id)
            expected = int(report.get("searchDocuments", 0))
            if existing == expected and expected:
                on_log(f"Serverless release {release_id} 已完整存在，跳过重复上传")
                return {"index": index, "releaseId": release_id, "indexed": 0, "total": existing}
            if existing:
                raise RuntimeError(
                    f"Serverless release {release_id} 只存在 {existing}/{expected} 个文档；"
                    "追加写索引无法清理半成品，请为本次 Dataset 版本创建新索引后再发布"
                )
            append_only = True
            on_log("检测到 Serverless 追加写索引；已确认当前 Dataset 尚未发布")
        elif status >= 400:
            raise RuntimeError(f"清理 Dataset 旧搜索片段失败：{payload}")
        if not append_only:
            on_log(f"已清理 {len(dataset_ids)} 个 Dataset 的旧搜索片段")

    indexed = 0
    batch: list[str] = []
    for document in _documents(build_root / "search" / "documents.jsonl.gz"):
        if indexed_at:
            document["@timestamp"] = indexed_at
        document["releaseId"] = release_id
        document["datasetFilterKey"] = _filter_key(document["datasetId"])
        document["itemFilterKey"] = _filter_key(document["itemId"])
        operation = "create" if append_only else "index"
        document_id = f"{release_id}:{document['documentId']}" if append_only else document["documentId"]
        batch.append(json.dumps({operation: {"_index": index, "_id": document_id}}, ensure_ascii=False))
        batch.append(json.dumps(document, ensure_ascii=False, separators=(",", ":")))
        if len(batch) >= 1000:
            indexed += _send_bulk(client, batch)
            on_log(f"Elasticsearch 已写入 {indexed} 个检索片段")
            batch = []
    if batch:
        indexed += _send_bulk(client, batch)
    client.request("POST", f"{index}/_refresh")
    status, count_payload = client.request("GET", f"{index}/_count")
    if status >= 400:
        raise RuntimeError(f"读取 ES 文档数失败：{count_payload}")
    return {
        "index": index,
        "releaseId": release_id,
        "indexed": indexed,
        "total": count_payload.get("count", 0),
    }


def _send_bulk(client: KibanaConsoleClient, lines: list[str]) -> int:
    status, payload = client.request_raw("POST", "_bulk", "\n".join(lines) + "\n")
    if status >= 400 or payload.get("errors"):
        failures = [item for item in payload.get("items", []) if next(iter(item.values())).get("error")]
        raise RuntimeError(f"ES bulk 写入失败：{failures[:3] or payload}")
    return len(lines) // 2


def _filter_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _hf_slug(title: str, fallback: str) -> str:
    value = re.sub(r"[^\w\u3400-\u9fff-]+", "-", title).strip()
    value = re.sub(r"\s+", "-", value).strip(" .-")
    return value[:100] or fallback


def _markdown_text(value: Any) -> str:
    return str(value or "").replace("|", "\\|").replace("\r", " ").replace("\n", " ").strip()


def _toc_markdown(nodes: list[dict[str, Any]], depth: int = 0) -> list[str]:
    lines: list[str] = []
    for node in nodes:
        lines.append(f"{'  ' * depth}- {_markdown_text(node.get('title') or '未命名目录项')}")
        lines.extend(_toc_markdown(node.get("children") or [], depth + 1))
    return lines


def _prepare_huggingface_snapshot(
    build_root: Path,
    on_log: Callable[[str], None],
) -> tuple[Path, dict[str, int]]:
    """Bundle media per Dataset so one HF publish does not issue ~10k API calls."""
    source = build_root / "huggingface"
    target = build_root / ".publish" / "huggingface"
    source_files = sorted(
        path for path in source.rglob("*")
        if path.is_file() and ".cache" not in path.relative_to(source).parts
    )
    fingerprint = hashlib.sha256(("human-readable-v3\n" + "\n".join(
        f"{path.relative_to(source).as_posix()}:{path.stat().st_size}:{path.stat().st_mtime_ns}"
        for path in source_files
    )).encode("utf-8")).hexdigest()
    state_path = build_root / ".publish" / "huggingface-state.json"
    if target.exists() and state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            if state.get("fingerprint") == fingerprint:
                return target, state["stats"]
        except (OSError, ValueError, KeyError):
            pass

    resolved_target = target.resolve()
    if not resolved_target.is_relative_to(build_root.resolve()):
        raise RuntimeError("Hugging Face staging 目录越出构建目录")
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)

    report_path = build_root / "report.json"
    generated_at = None
    if report_path.exists():
        try:
            generated_at = json.loads(report_path.read_text(encoding="utf-8")).get("generatedAt")
        except (OSError, ValueError):
            pass
    collections: list[dict[str, Any]] = []
    used_slugs: set[str] = set()
    copied = 0
    bundled_assets = 0
    for source_dataset in sorted(path for path in source.iterdir() if path.is_dir() and (path / "dataset.json").exists()):
        dataset = json.loads((source_dataset / "dataset.json").read_text(encoding="utf-8"))
        dataset_id = str(dataset.get("datasetId") or source_dataset.name)
        title = str(dataset.get("title") or dataset_id)
        slug = _hf_slug(title, dataset_id)
        if slug in used_slugs:
            slug = f"{slug}-{dataset_id[-6:]}"
        used_slugs.add(slug)
        collection_directory = target / "collections" / slug
        items_directory = collection_directory / "items"
        items_directory.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_dataset / "dataset.json", collection_directory / "dataset.json")
        copied += 1
        collection_items: list[dict[str, Any]] = []
        for summary in sorted(dataset.get("items") or [], key=lambda item: (item.get("order") or 0, item.get("title") or "")):
            item_key = str(summary.get("itemKey") or "full-book")
            item_source = source_dataset / "data" / f"{item_key}.json.gz"
            if not item_source.exists():
                continue
            with gzip.open(item_source, "rt", encoding="utf-8") as stream:
                item = json.load(stream)
            item_download = items_directory / f"{item_key}.json.gz"
            shutil.copy2(item_source, item_download)
            chapters = item.get("content", {}).get("chapters") or []
            toc = item.get("content", {}).get("toc") or []
            metadata = item.get("metadata") or {}
            toc_document = {
                "formatVersion": "marxism-toc/1",
                "datasetId": dataset_id,
                "datasetTitle": title,
                "itemId": item.get("itemId"),
                "itemTitle": item.get("title"),
                "type": item.get("type"),
                "language": item.get("language"),
                "metadata": metadata,
                "chapterCount": len(chapters),
                "assetCount": len(item.get("assets") or []),
                "annotationCount": len(item.get("annotations") or []),
                "toc": toc,
                "chapters": [
                    {"id": chapter.get("id"), "order": chapter.get("order"), "title": chapter.get("title")}
                    for chapter in chapters
                ],
                "download": f"{item_key}.json.gz",
            }
            (items_directory / f"{item_key}.toc.json").write_text(
                json.dumps(toc_document, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            authors = "、".join(str(author) for author in metadata.get("authors") or []) or "未注明"
            item_page = [
                f"# {_markdown_text(item.get('title'))}", "",
                f"- 作者：{_markdown_text(authors)}",
                f"- 出版社：{_markdown_text(metadata.get('publisher') or '未注明')}",
                f"- 章节数：{len(chapters)}",
                f"- 图片/媒体：{len(item.get('assets') or [])}",
                f"- 注释：{len(item.get('annotations') or [])}",
                f"- [查看结构化目录]({item_key}.toc.json)",
                f"- [下载完整 Canonical Item]({item_key}.json.gz)", "", "## 目录", "",
                *(_toc_markdown(toc) or [f"- {_markdown_text(chapter.get('title'))}" for chapter in chapters]), "",
            ]
            (items_directory / f"{item_key}.md").write_text("\n".join(item_page), encoding="utf-8")
            copied += 3
            collection_items.append({
                "itemId": item.get("itemId"),
                "itemKey": item_key,
                "title": item.get("title"),
                "type": item.get("type"),
                "order": summary.get("order"),
                "chapterCount": len(chapters),
                "tocPath": f"collections/{slug}/items/{item_key}.toc.json",
                "pagePath": f"collections/{slug}/items/{item_key}.md",
                "downloadPath": f"collections/{slug}/items/{item_key}.json.gz",
            })
        asset_paths = sorted(path for path in (source_dataset / "assets").glob("*") if path.is_file())
        if asset_paths:
            archive = collection_directory / "assets.tar"
            on_log(f"打包《{title}》的 {len(asset_paths)} 个媒体文件")
            with tarfile.open(archive, "w") as bundle:
                for path in asset_paths:
                    bundle.add(path, arcname=f"assets/{path.name}", recursive=False)
            bundled_assets += len(asset_paths)
        collection_readme = [
            f"# {_markdown_text(title)}", "", _markdown_text(dataset.get("description")), "",
            f"- 类型：`{dataset.get('type')}`",
            f"- 语言：`{dataset.get('language')}`",
            f"- 卷册/Item：{len(collection_items)}", "", "## 卷册", "",
            "| 名称 | 章节 | 在线目录 | 完整下载 |", "|---|---:|---|---|",
            *[
                f"| {_markdown_text(item['title'])} | {item['chapterCount']} | "
                f"[查看](items/{item['itemKey']}.md) | [JSON.GZ](items/{item['itemKey']}.json.gz) |"
                for item in collection_items
            ], "",
        ]
        if asset_paths:
            collection_readme.extend(["媒体文件集中保存在 [assets.tar](assets.tar)。", ""])
        (collection_directory / "README.md").write_text("\n".join(collection_readme), encoding="utf-8")
        copied += 1
        collections.append({
            "datasetId": dataset_id,
            "title": title,
            "type": dataset.get("type"),
            "language": dataset.get("language"),
            "description": dataset.get("description"),
            "path": f"collections/{slug}",
            "items": collection_items,
        })
    collections.sort(key=lambda collection: str(collection["title"]))
    catalog = {
        "formatVersion": "marxism-catalog/1",
        "title": "Marxism Dataset",
        "generatedAt": generated_at,
        "collectionCount": len(collections),
        "itemCount": sum(len(collection["items"]) for collection in collections),
        "collections": collections,
    }
    (target / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    search_documents = build_root / "search" / "documents.jsonl.gz"
    if search_documents.exists():
        (target / "data").mkdir(exist_ok=True)
        shutil.copy2(search_documents, target / "data" / "search-documents.jsonl.gz")
        copied += 1
    root_readme = [
        "---", "pretty_name: Marxism Dataset", "language:", "- zh", "task_categories:",
        "- text-retrieval", "configs:", "- config_name: default", "  data_files:",
        "  - split: train", "    path: data/search-documents.jsonl.gz", "---", "",
        "# Marxism Dataset", "",
        "马克思主义经典著作、文集、传记与相关研究资料的中文数字馆藏。", "",
        "- 首页目录面向读者，可按书名进入并查看卷册和完整目录。",
        "- `catalog.json` 面向程序和 Agent，提供稳定 ID 与可下载路径。",
        "- `data/search-documents.jsonl.gz` 可由 Hugging Face Dataset Viewer 浏览并用于检索。",
        "- 每个 Item 的 `.json.gz` 是完整 JOJO Canonical 数据，可用于重建搜索索引。", "",
        f"当前包含 **{len(collections)}** 个书目 Dataset、**{catalog['itemCount']}** 个 Item。", "",
        "## 馆藏目录", "", "| 书目 | 类型 | 卷册 |", "|---|---|---:|",
        *[
            f"| [{_markdown_text(collection['title'])}]({collection['path']}/README.md) | "
            f"{collection['type']} | {len(collection['items'])} |"
            for collection in collections
        ], "",
    ]
    (target / "README.md").write_text("\n".join(root_readme), encoding="utf-8")
    (target / "ASSETS.md").write_text(
        "# 媒体归档\n\n每个书目目录中的 `assets.tar` 保存该书全部媒体。解包后仍为 "
        "`assets/<sha256>.<ext>`，与 Canonical Item 的 `assets[].path` 一致。浏览器在线读取的 "
        "Jox 媒体继续由 B2/CDN 提供。\n",
        encoding="utf-8",
    )
    copied += 3
    stats = {
        "sourceFiles": len(source_files),
        "metadataFiles": copied,
        "bundledAssets": bundled_assets,
        "uploadFiles": sum(1 for path in target.rglob("*") if path.is_file()),
    }
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(
        json.dumps({"fingerprint": fingerprint, "stats": stats}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return target, stats


def _count_release_documents(
    client: KibanaConsoleClient,
    index: str,
    release_id: str,
) -> int:
    """Count a release before writing to an immutable Serverless index."""
    status, payload = client.request(
        "POST",
        f"{index}/_count",
        {"query": {"term": {"releaseId": release_id}}},
    )
    if status >= 400:
        raise RuntimeError(f"查询 Dataset 旧搜索片段失败：{payload}")
    return int(payload.get("count", 0))


def publish_huggingface(build_root: Path, on_log: Callable[[str], None]) -> dict[str, Any]:
    _load_root_env()
    token = _huggingface_token()
    repo_id = os.getenv("HF_DATASET_REPO", "")
    if not token or not repo_id:
        raise RuntimeError("请先执行 huggingface-cli login，并设置 HF_DATASET_REPO")
    from huggingface_hub import HfApi

    api = HfApi(token=token)
    api.create_repo(repo_id=repo_id, repo_type="dataset", private=True, exist_ok=True)
    on_log(f"开始上传私有 Hugging Face Dataset：{repo_id}")
    snapshot, snapshot_stats = _prepare_huggingface_snapshot(build_root, on_log)
    workers = max(1, int(os.getenv("HF_UPLOAD_WORKERS", "4")))
    api.upload_large_folder(
        folder_path=str(snapshot),
        repo_id=repo_id,
        repo_type="dataset",
        private=True,
        num_workers=workers,
    )
    info = api.repo_info(repo_id=repo_id, repo_type="dataset")
    if not info.private:
        raise RuntimeError(f"Hugging Face Dataset {repo_id} 不是私有仓库，停止发布")
    expected_files = {
        path.relative_to(snapshot).as_posix()
        for path in snapshot.rglob("*")
        if path.is_file() and ".cache" not in path.relative_to(snapshot).parts
    }
    remote_files = set(api.list_repo_files(repo_id=repo_id, repo_type="dataset"))
    stale_files = sorted(remote_files - expected_files - {".gitattributes"})
    if stale_files:
        on_log(f"清理 Hugging Face 中 {len(stale_files)} 个旧快照文件")
        api.delete_files(
            repo_id=repo_id,
            repo_type="dataset",
            delete_patterns=stale_files,
            commit_message="Remove superseded JOJO canonical files",
        )
        info = api.repo_info(repo_id=repo_id, repo_type="dataset")
        remote_files = set(api.list_repo_files(repo_id=repo_id, repo_type="dataset"))
    missing_files = sorted(expected_files - remote_files)
    if missing_files:
        raise RuntimeError(f"Hugging Face 上传缺少 {len(missing_files)} 个文件：{missing_files[:3]}")
    return {
        "repoId": repo_id,
        "private": True,
        "remoteFiles": len(remote_files),
        "commit": f"https://huggingface.co/datasets/{repo_id}/commit/{info.sha}",
        **snapshot_stats,
    }
