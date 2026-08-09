"""Publication adapters for canonical JOJO content builds."""
from __future__ import annotations

import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
from typing import Any, Callable, Iterable

from es_repair import KibanaConsoleClient, _load_root_env


ROOT = Path(__file__).resolve().parents[3]
RAW_REMOTE = os.getenv("JOJO_RAW_REMOTE", "jojo-b2:jojo-news-raw")
DELIVERY_REMOTE = os.getenv("JOJO_DELIVERY_REMOTE", "jojo-b2-s3:jojo-newspaper")
RCLONE_COPY_FLAGS = ["--checksum", "--transfers", "16", "--checkers", "32"]


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
        for dataset_id in dataset_ids:
            key = f"content/{dataset_id}/index.jox"
            _try_copy_remote(f"{delivery_remote}/{key}", remote_metadata / key, on_log)
    _run([
        "pnpm", "--filter", "@jojo/content-pipeline", "merge-delivery",
        "--local", str(build_root / "delivery"),
        "--remote", str(remote_metadata),
        "--output", str(merged_metadata),
    ], on_log)

    _run(["rclone", "copy", str(build_root / "raw"), f"{raw_remote}/raw", *RCLONE_COPY_FLAGS], on_log)
    _run(["rclone", "copy", str(build_root / "canonical"), f"{raw_remote}/canonical", *RCLONE_COPY_FLAGS], on_log)
    _run([
        "rclone", "copy", str(build_root / "delivery" / "content"), f"{delivery_remote}/content",
        "--exclude", "**/manifest.jox", "--exclude", "**/index.jox", *RCLONE_COPY_FLAGS,
    ], on_log)
    _run([
        "rclone", "copy", str(build_root / "delivery" / "content"), f"{delivery_remote}/content",
        "--include", "**/manifest.jox", "--exclude", "*", *RCLONE_COPY_FLAGS,
    ], on_log)
    if (merged_metadata / "content").exists():
        _run(["rclone", "copy", str(merged_metadata / "content"), f"{delivery_remote}/content", *RCLONE_COPY_FLAGS], on_log)
    # B2's S3 compatibility endpoint may treat copyto(bucket/root-object) as a
    # bucket-creation attempt. Copy the parent with an exact root filter instead.
    _run([
        "rclone", "copy", str(merged_metadata), delivery_remote,
        "--filter", "+ /catalog.jox", "--filter", "- **", *RCLONE_COPY_FLAGS,
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
    fingerprint = hashlib.sha256("\n".join(
        f"{path.relative_to(source).as_posix()}:{path.stat().st_size}:{path.stat().st_mtime_ns}"
        for path in source_files
    ).encode("utf-8")).hexdigest()
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

    asset_groups: dict[str, list[Path]] = {}
    copied = 0
    for path in source_files:
        relative = path.relative_to(source)
        if len(relative.parts) >= 3 and relative.parts[1] == "assets":
            asset_groups.setdefault(relative.parts[0], []).append(path)
            continue
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
        copied += 1

    bundled_assets = 0
    for dataset_id, paths in sorted(asset_groups.items()):
        archive = target / dataset_id / "assets.tar"
        archive.parent.mkdir(parents=True, exist_ok=True)
        on_log(f"打包 {dataset_id} 的 {len(paths)} 个媒体文件")
        with tarfile.open(archive, "w") as bundle:
            for path in sorted(paths):
                bundle.add(path, arcname=f"assets/{path.name}", recursive=False)
        bundled_assets += len(paths)
    (target / "ASSETS.md").write_text(
        "# Media bundles\n\n"
        "Each Dataset keeps canonical JSON files directly browseable. When a Dataset has "
        "media, `assets.tar` contains the `assets/` paths referenced by its Item files. "
        "The browser delivery copy remains on B2/CDN.\n",
        encoding="utf-8",
    )
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
