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
from tempfile import TemporaryDirectory
from typing import Any, Callable

from es_repair import _load_root_env


ROOT = Path(__file__).resolve().parents[3]
DELIVERY_REMOTE = os.getenv("JOJO_DELIVERY_REMOTE", "jojo-b2-s3:jojo-newspaper")
RCLONE_COPY_FLAGS = ["--checksum", "--transfers", "16", "--checkers", "32"]
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


def _huggingface_private() -> bool:
    return os.getenv("HF_DATASET_PRIVATE", "false").strip().lower() in {"1", "true", "yes", "on"}


def publication_status() -> dict[str, Any]:
    _load_root_env()
    return {
        "b2": {
            "configured": bool(shutil.which("rclone")),
            "deliveryRemote": os.getenv("JOJO_DELIVERY_REMOTE", DELIVERY_REMOTE),
        },
        "huggingface": {
            "configured": bool(_huggingface_token() and os.getenv("HF_DATASET_REPO")),
            "repoId": os.getenv("HF_DATASET_REPO", ""),
            "private": _huggingface_private(),
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
    return {"datasets": len(dataset_ids), "deliveryRemote": delivery_remote}


def _hf_slug(title: str, fallback: str) -> str:
    value = re.sub(r"[^\w\u3400-\u9fff-]+", "-", title).strip()
    value = re.sub(r"\s+", "-", value).strip(" .-")
    return value[:100] or fallback


def _hf_component(value: Any) -> str:
    """Only accept one portable path component, including on Windows staging."""
    if not isinstance(value, str) or not value or value in {".", ".."} or re.search(r'[\\/:<>"|?*\x00-\x1f]', value):
        raise RuntimeError(f"无效的 Hugging Face 路径段：{value!r}")
    if value != value.rstrip(" ."):
        raise RuntimeError(f"无效的 Hugging Face 路径段：{value!r}")
    return value


def _hf_collections(catalog: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Validate ownership before deriving any upload or deletion paths."""
    if catalog.get("formatVersion") != "marxism-catalog/1" or not isinstance(catalog.get("collections"), list):
        raise RuntimeError("Hugging Face 书籍 catalog 格式无效，停止发布")
    result: dict[str, dict[str, Any]] = {}
    paths: set[str] = set()
    for collection in catalog["collections"]:
        dataset_id = _hf_component(collection["datasetId"])
        path = collection["path"]
        if not isinstance(path, str) or not path.startswith("collections/"):
            raise RuntimeError("Hugging Face 书籍目录必须位于 books/collections/")
        _hf_component(path.removeprefix("collections/"))
        if dataset_id in result or path.casefold() in paths:
            raise RuntimeError("Hugging Face 书籍 catalog 含重复 ID 或目录")
        paths.add(path.casefold())
        item_keys: set[str] = set()
        if not collection.get("items"):
            raise RuntimeError(f"书籍 {dataset_id} 没有可发布的 Item")
        for item in collection["items"]:
            key = _hf_component(item["itemKey"])
            if key.casefold() in item_keys or item.get("itemId") != f"{dataset_id}:{key}":
                raise RuntimeError(f"书籍 {dataset_id} 的 Item ID 无效或重复")
            item_keys.add(key.casefold())
            for field, suffix in (("downloadPath", ".json.gz"), ("tocPath", ".toc.json"), ("pagePath", ".md")):
                if item.get(field) != f"{path}/items/{key}{suffix}":
                    raise RuntimeError(f"书籍 {dataset_id} 的 {field} 路径无效")
        result[dataset_id] = collection
    return result


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
    if not source.is_dir():
        raise RuntimeError("没有可发布的书籍构建目录")
    resolved_target = target.resolve()
    if not resolved_target.is_relative_to(build_root.resolve()) or resolved_target == build_root.resolve():
        raise RuntimeError("Hugging Face staging 目录越出构建目录")
    source_files = sorted(
        path for path in source.rglob("*")
        if path.is_file() and ".cache" not in path.relative_to(source).parts
    )
    fingerprint_files = [*source_files, *(
        path for path in (build_root / "report.json", build_root / "search" / "documents.jsonl.gz")
        if path.is_file()
    )]
    fingerprint = hashlib.sha256(("books-scoped-v4\n" + "\n".join(
        f"{path.relative_to(build_root).as_posix()}:{path.stat().st_size}:{path.stat().st_mtime_ns}"
        for path in fingerprint_files
    )).encode("utf-8")).hexdigest()
    state_path = build_root / ".publish" / "huggingface-state.json"
    if target.exists() and state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            cached_files = {
                path.relative_to(target).as_posix(): path.stat().st_size
                for path in target.rglob("*") if path.is_file()
            }
            if state.get("fingerprint") == fingerprint and state.get("files") == cached_files:
                return target, state["stats"]
        except (OSError, ValueError, KeyError):
            pass

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
        dataset_id = _hf_component(dataset.get("datasetId") or source_dataset.name)
        title = str(dataset.get("title") or dataset_id)
        slug = _hf_slug(title, dataset_id)
        if slug.casefold() in used_slugs:
            slug = f"{slug}-{dataset_id[-6:]}"
        _hf_component(slug)
        if slug.casefold() in used_slugs:
            raise RuntimeError(f"书籍目录重名：{slug}")
        used_slugs.add(slug.casefold())
        collection_directory = target / "collections" / slug
        items_directory = collection_directory / "items"
        items_directory.mkdir(parents=True, exist_ok=True)
        dataset["itemPath"] = "items/{itemKey}.json.gz"
        dataset["items"] = [
            {**summary, "path": f"items/{_hf_component(summary['itemKey'])}.json.gz"}
            for summary in dataset.get("items") or []
        ]
        (collection_directory / "dataset.json").write_text(
            json.dumps(dataset, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        copied += 1
        collection_items: list[dict[str, Any]] = []
        for summary in sorted(dataset.get("items") or [], key=lambda item: (item.get("order") or 0, item.get("title") or "")):
            item_key = _hf_component(summary["itemKey"])
            item_source = source_dataset / "data" / f"{item_key}.json.gz"
            if not item_source.is_file():
                raise RuntimeError(f"书籍构建不完整，缺少 Item：{item_source}")
            with gzip.open(item_source, "rt", encoding="utf-8") as stream:
                item = json.load(stream)
            if item.get("datasetId") != dataset_id or item.get("itemId") != f"{dataset_id}:{item_key}":
                raise RuntimeError(f"书籍 Item 身份与目录不符：{item_source}")
            for asset in item.get("assets") or []:
                asset_path = str(asset.get("path") or "")
                if not asset_path.startswith("assets/"):
                    raise RuntimeError(f"无效的书籍媒体路径：{asset_path}")
                _hf_component(asset_path.removeprefix("assets/"))
                if not (source_dataset / asset_path).is_file():
                    raise RuntimeError(f"书籍构建不完整，缺少媒体：{asset_path}")
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
    if not _hf_collections(catalog):
        raise RuntimeError("没有可发布的书籍，停止发布")
    (target / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    search_documents = build_root / "search" / "documents.jsonl.gz"
    if search_documents.exists():
        (target / "data").mkdir(exist_ok=True)
        shutil.copy2(search_documents, target / "data" / "search-documents.jsonl.gz")
        copied += 1
    (target / "README.md").write_text(_hf_books_readme(catalog), encoding="utf-8")
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
        json.dumps({"fingerprint": fingerprint, "stats": stats, "files": {
            path.relative_to(target).as_posix(): path.stat().st_size
            for path in target.rglob("*") if path.is_file()
        }}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return target, stats


def _hf_books_readme(catalog: dict[str, Any]) -> str:
    collections = catalog["collections"]
    return "\n".join([
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
    ])


def _hf_book_files(api: Any, repo_id: str, revision: str) -> set[str]:
    from huggingface_hub.errors import EntryNotFoundError

    try:
        # list_repo_tree is paginated; repo_info.siblings can be truncated on
        # this shared repository. Never enumerate raw/ or newspapers/ here.
        return {
            row.path for row in api.list_repo_tree(
                repo_id=repo_id, repo_type="dataset", revision=revision,
                path_in_repo="books", recursive=True,
            ) if getattr(row, "size", None) is not None
        }
    except EntryNotFoundError:
        # A failed later pagination request must not turn existing books into
        # an empty repository. Confirm absence using a non-recursive root tree.
        if any(row.path == "books" for row in api.list_repo_tree(
            repo_id=repo_id, repo_type="dataset", revision=revision, recursive=False,
        )):
            raise
        return set()


def _hf_book_commit_plan(
    api: Any, repo_id: str, revision: str, snapshot: Path, build_root: Path, metadata: Path,
) -> tuple[dict[str, Path], list[str], set[str]]:
    """Merge complete book builds, owning only their catalogued collections."""
    local_catalog = json.loads((snapshot / "catalog.json").read_text(encoding="utf-8"))
    local = _hf_collections(local_catalog)
    if not local:
        raise RuntimeError("没有可发布的书籍，停止发布")
    remote_files = _hf_book_files(api, repo_id, revision)

    def download(key: str) -> Path:
        return Path(api.hf_hub_download(
            repo_id=repo_id, repo_type="dataset", revision=revision, filename=key,
        ))

    remote: dict[str, dict[str, Any]] = {}
    if "books/catalog.json" in remote_files:
        remote = _hf_collections(json.loads(download("books/catalog.json").read_text(encoding="utf-8")))
    elif remote_files:
        raise RuntimeError("远端 books/ 已有文件但缺少 catalog.json，停止发布以免覆盖未知数据")

    report_path = build_root / "report.json"
    report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else {}
    if set(report.get("supersededDatasetIds") or []) & remote.keys():
        raise RuntimeError("此次构建包含跨书目合并，请先单独对账迁移旧书目；普通发布不删除其他 Dataset")

    uploads: dict[str, Path] = {}
    owned_prefixes: set[str] = set()
    merged = dict(remote)
    for dataset_id, collection in local.items():
        previous = remote.get(dataset_id)
        if previous:
            missing_items = {item["itemKey"] for item in previous["items"]} - {
                item["itemKey"] for item in collection["items"]
            }
            if missing_items:
                raise RuntimeError(f"书籍 {dataset_id} 构建缺卷：{sorted(missing_items)}；请导入整套书后重试")
        source_prefix = collection["path"]
        # Keep an existing Dataset's stable directory even if its title changed.
        destination = previous["path"] if previous else source_prefix
        prefix = f"books/{destination}/"
        if not previous and any(key.casefold().startswith(prefix.casefold()) for key in remote_files):
            raise RuntimeError(f"书籍目录已被占用：{prefix}")
        if previous:
            owned_prefixes.add(prefix)
        mapped_items = [
            {**item, **{
                field: destination + item[field][len(source_prefix):]
                for field in ("downloadPath", "tocPath", "pagePath")
            }} for item in collection["items"]
        ]
        merged[dataset_id] = {**collection, "path": destination, "items": mapped_items}
        for path in sorted((snapshot / source_prefix).rglob("*")):
            if path.is_file():
                relative = path.relative_to(snapshot / source_prefix)
                for part in relative.parts:
                    _hf_component(part)
                uploads[prefix + relative.as_posix()] = path
        for item in mapped_items:
            for field in ("downloadPath", "tocPath", "pagePath"):
                if f"books/{item[field]}" not in uploads:
                    raise RuntimeError(f"书籍快照不完整：{item[field]}")
        if prefix + "dataset.json" not in uploads or prefix + "README.md" not in uploads:
            raise RuntimeError(f"书籍快照缺少元数据：{dataset_id}")

    collections = sorted(merged.values(), key=lambda row: str(row["title"]))
    catalog = {
        **local_catalog, "collections": collections, "collectionCount": len(collections),
        "itemCount": sum(len(row["items"]) for row in collections),
    }
    _hf_collections(catalog)  # Also detects collisions with untouched books.
    metadata.mkdir(parents=True, exist_ok=True)
    (metadata / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    (metadata / "README.md").write_text(_hf_books_readme(catalog), encoding="utf-8")
    uploads["books/catalog.json"] = metadata / "catalog.json"
    uploads["books/README.md"] = metadata / "README.md"
    uploads["books/ASSETS.md"] = snapshot / "ASSETS.md"

    search_key = "books/data/search-documents.jsonl.gz"
    local_search = snapshot / "data" / "search-documents.jsonl.gz"
    if not local_search.is_file():
        raise RuntimeError("构建缺少书籍搜索数据，停止发布")
    sources: list[tuple[Path, dict[str, dict[str, Any]], bool]] = []
    if remote.keys() - local.keys():
        if search_key not in remote_files:
            raise RuntimeError("远端书籍搜索数据缺失，无法安全合并增量发布")
        sources.append((download(search_key), remote, True))
    sources.append((local_search, local, False))
    merged_search = metadata / "search-documents.jsonl.gz"
    with gzip.open(merged_search, "wt", encoding="utf-8") as output:
        for source, owners, is_remote in sources:
            item_ids = {item["itemId"]: dataset_id for dataset_id, row in owners.items() for item in row["items"]}
            with gzip.open(source, "rt", encoding="utf-8") as stream:
                for line in stream:
                    if not line.strip():
                        continue
                    document = json.loads(line)
                    dataset_id = document.get("datasetId")
                    if dataset_id not in owners or item_ids.get(document.get("itemId")) != dataset_id:
                        raise RuntimeError("书籍搜索数据与 catalog 身份不符，停止发布")
                    if not is_remote or dataset_id not in local:
                        output.write(json.dumps(document, ensure_ascii=False) + "\n")
    uploads[search_key] = merged_search
    # Literal file operations, never glob patterns or a whole books/ deletion.
    stale = sorted(key for key in remote_files if key not in uploads and any(
        key.startswith(prefix) for prefix in owned_prefixes
    ))
    expected = (remote_files - set(stale)) | uploads.keys()
    return uploads, stale, expected


def publish_huggingface(build_root: Path, on_log: Callable[[str], None]) -> dict[str, Any]:
    _load_root_env()
    # The current proxy accepts Xet payloads but can stall final shard
    # registration indefinitely. Prefer the resumable LFS bridge by default;
    # operators can opt back into Xet with HF_HUB_DISABLE_XET=0.
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    # High-performance mode remains opt-in when an operator enables Xet.
    os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "0")
    os.environ.setdefault("HF_XET_FIXED_UPLOAD_CONCURRENCY", "2")
    os.environ.setdefault("HF_XET_CLIENT_RETRY_MAX_DURATION", "1200s")
    os.environ.setdefault("HF_XET_CLIENT_READ_TIMEOUT", "600s")
    token = _huggingface_token()
    repo_id = os.getenv("HF_DATASET_REPO", "")
    if not token or not repo_id:
        raise RuntimeError("请先执行 huggingface-cli login，并设置 HF_DATASET_REPO")
    from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi

    snapshot, snapshot_stats = _prepare_huggingface_snapshot(build_root, on_log)
    api = HfApi(token=token)
    private = _huggingface_private()
    api.create_repo(repo_id=repo_id, repo_type="dataset", private=private, exist_ok=True)
    info = api.repo_info(repo_id=repo_id, repo_type="dataset")
    if bool(info.private) != private:
        expected = "私有" if private else "公开"
        raise RuntimeError(f"Hugging Face Dataset {repo_id} 不是预期的{expected}仓库，停止发布")
    if not isinstance(info.sha, str) or not info.sha:
        raise RuntimeError("无法确定 Hugging Face 父提交，停止发布；请先初始化仓库")
    # Each attempt gets isolated merged metadata; concurrent publishes must not
    # rewrite files another request is still uploading.
    with TemporaryDirectory(prefix="hf-commit-", dir=build_root / ".publish") as temp:
        uploads, stale_files, expected_files = _hf_book_commit_plan(
            api, repo_id, info.sha, snapshot, build_root, Path(temp),
        )
        if any(not key.startswith("books/") for key in (*uploads, *stale_files)):
            raise RuntimeError("Hugging Face 发布路径越出 books/，停止发布")
        on_log(f"发布 Hugging Face books/：{len(uploads)} 个文件，清理本次书目内 {len(stale_files)} 个旧文件；保留其他目录")
        # A single parent-guarded commit exposes catalog, search, payloads and
        # exact deletions together. Conflicts never retry with stale metadata.
        commit = api.create_commit(
            repo_id=repo_id, repo_type="dataset", revision="main", parent_commit=info.sha,
            operations=[
                *(CommitOperationDelete(path_in_repo=key, is_folder=False) for key in stale_files),
                *(CommitOperationAdd(path_in_repo=key, path_or_fileobj=path) for key, path in sorted(uploads.items())),
            ],
            commit_message="Publish JOJO books without changing other datasets",
            num_threads=max(1, int(os.getenv("HF_UPLOAD_WORKERS", "4"))),
        )
    remote_files = _hf_book_files(api, repo_id, commit.oid)
    missing_files = sorted(expected_files - remote_files)
    if missing_files or set(stale_files) & remote_files:
        raise RuntimeError(f"Hugging Face books/ 提交校验失败，缺少文件：{missing_files[:3]}")
    return {
        "repoId": repo_id,
        "private": private,
        "remoteFiles": len(remote_files),
        "deletedFiles": len(stale_files),
        "scope": "books/",
        "commit": f"https://huggingface.co/datasets/{repo_id}/commit/{commit.oid}",
        **snapshot_stats,
    }
