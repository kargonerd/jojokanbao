"""Local-first review and incremental publication API for missing RMRB content."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import urllib.error
import urllib.parse
import urllib.request
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from flask import Blueprint, jsonify, request

from canonical_release import CanonicalRelease, MirroredReleaseJournal, release_id
from es_migrations import active_revision_heads
from es_repair import KibanaConsoleClient, repair_config
from es_sync import ensure_unified_mapping, newspaper_document, plain_text, stable_document_id
from publish_search_state import (
    load_remote_search_state,
    load_remote_json_object,
    publication_config,
    upload_remote_search_state,
    upload_remote_json_object,
    validate_publication_target,
)
from rmrb_review_publish import (
    CanonicalPatch,
    DeliveryPatch,
    canonical_article_id,
    parse_key,
    prepare_canonical_patch,
    prepare_delivery_patch,
    read_canonical_articles,
    read_canonical_item,
)
from rmrb_review_source import remove_from_review_cache, review_source_manager
from search_publication import (
    AppendOnlySearchPublisher,
    DesiredSearchDocument,
    publish_search_activation,
)


rmrb_review_blueprint = Blueprint("rmrb_review", __name__)

WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
REVIEW_ROOT = Path(
    os.environ.get(
        "RMRB_REVIEW_ROOT",
        WORKSPACE_ROOT / "tmp" / "rmrb-review",
    )
)
PEOPLE_DATA_BASE = (
    "https://webvpn.zju.edu.cn/https/"
    "77726476706e69737468656265737421f4f6559d69206d5f6e048ce29b5a2e7b74a4/rmrb"
)
PEOPLE_DATA_IMAGE_PREFIX = PEOPLE_DATA_BASE.removesuffix("/rmrb") + "/pic/"
REVIEW_DB = REVIEW_ROOT / "hf-missing-workbench.sqlite3"
WORKBENCH_DECISIONS = REVIEW_ROOT / "manual-review-decisions-workbench.jsonl"
SYNC_ROOT = REVIEW_ROOT / "sync"
SYNC_STATE = SYNC_ROOT / "review-sync-state.json"
PUBLISH_ROOT = SYNC_ROOT / "publish"
RELEASES_ROOT = SYNC_ROOT / "releases"
RELEASE_REMOTE_KEY = "runtime/publishing/newspaper-rmrb.json"
PENDING_PUBLICATION = REVIEW_ROOT / "manual-review-pending-publication.json"
COPY_MARKER_RE = re.compile(r"[（(]\s*人民数据库资料\s*[）)]")
IMAGE_DATA_RE = re.compile(r"^data:(image/(?:png|jpeg|webp|gif));base64,(.+)$", re.DOTALL)
IMAGE_SUFFIXES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
MAX_REVIEW_IMAGES = 10
MAX_REVIEW_IMAGE_BYTES = 15 * 1024 * 1024
DECISION_LOCK = threading.Lock()
SYNC_LOCK = threading.Lock()
SYNC_PROGRESS_LOCK = threading.Lock()
SYNC_PROGRESS: dict[str, object] = {
    "status": "idle",
    "phase": "idle",
    "message": "等待发布",
    "completed": 0,
    "total": 0,
    "percent": 0,
    "startedAt": None,
    "updatedAt": None,
    "finishedAt": None,
    "publishedChanges": 0,
}


def _set_sync_progress(**changes: object) -> None:
    with SYNC_PROGRESS_LOCK:
        SYNC_PROGRESS.update(changes)
        SYNC_PROGRESS["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")


def _sync_progress_snapshot() -> dict[str, object]:
    with SYNC_PROGRESS_LOCK:
        return dict(SYNC_PROGRESS)


def _key(row: dict[str, object]) -> tuple[str, int, int]:
    return (
        str(row.get("date")),
        int(row.get("page", -1)),
        int(row.get("peopleDataOrdinal", -1)),
    )


def _read_decision_file(path: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    with path.open(encoding="utf-8-sig") as stream:
        for line in stream:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def load_pending_decisions() -> dict[tuple[str, int, int], dict[str, object]]:
    """Load only unpublished local drafts; published history comes from HF."""
    decisions: dict[tuple[str, int, int], dict[str, object]] = {}
    if not WORKBENCH_DECISIONS.is_file():
        return decisions
    pending = set(_load_pending_publication())
    try:
        for row in _read_decision_file(WORKBENCH_DECISIONS):
            if not all(name in row for name in ("date", "page", "peopleDataOrdinal")):
                continue
            key = _key(row)
            if _publication_key(key) not in pending:
                continue
            decision = str(row.get("decision") or row.get("status") or "").lower()
            if decision in {"accept", "reject"}:
                decisions[key] = {**row, "decision": decision}
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        logging.exception("Unable to read RMRB workbench drafts %s", WORKBENCH_DECISIONS)
    return decisions


def _review_source_status(force: bool = False) -> dict[str, object]:
    review_source_manager.ensure_started(
        REVIEW_DB,
        _huggingface_repo(),
        _huggingface_token(),
        force=force,
    )
    return review_source_manager.snapshot(REVIEW_DB)


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(payload)
    os.replace(temporary, path)


def _huggingface_token() -> str:
    explicit = os.environ.get("HF_TOKEN", "").strip()
    if explicit:
        return explicit
    try:
        from huggingface_hub import get_token
    except ImportError:
        return ""
    return (get_token() or "").strip()


def _huggingface_repo() -> str:
    return (
        os.environ.get("RMRB_REVIEW_HF_REPO", "").strip()
        or os.environ.get("HF_DATASET_REPO", "").strip()
        or "luoxiaozhuang/marxism-dataset"
    )


def _b2_remote() -> str:
    return os.environ.get("RMRB_REVIEW_B2_REMOTE", "").strip() or os.environ.get(
        "JOJO_DELIVERY_REMOTE", "jojo-b2-s3:jojo-newspaper"
    ).rstrip("/")


def _load_sync_state() -> dict[str, object]:
    if not SYNC_STATE.is_file():
        return {"formatVersion": "jojo-rmrb-review-sync-state/1", "targets": {}}
    try:
        return json.loads(SYNC_STATE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logging.exception("Unable to read RMRB review sync state %s", SYNC_STATE)
        return {"formatVersion": "jojo-rmrb-review-sync-state/1", "targets": {}}


def _write_sync_state(state: dict[str, object]) -> None:
    _atomic_write(
        SYNC_STATE,
        (json.dumps(state, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    )


def _hf_revision() -> str:
    from huggingface_hub import HfApi

    return str(HfApi(token=_huggingface_token() or None).repo_info(
        repo_id=_huggingface_repo(),
        repo_type="dataset",
    ).sha)


def _hf_source_file(filename: str, revision: str | None = None) -> Path:
    from huggingface_hub import hf_hub_download

    return Path(hf_hub_download(
        repo_id=_huggingface_repo(),
        filename=filename,
        repo_type="dataset",
        token=_huggingface_token() or None,
        revision=revision or "main",
    ))


def _delivery_source_file(filename: str) -> Path:
    target = PUBLISH_ROOT / "delivery-source" / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    # Delivery manifests are mutable commit markers; always fetch the current
    # copy instead of trusting an earlier local review-sync run.
    _run_rclone_copyto(f"{_b2_remote()}/{filename}", str(target))
    return target


def _prepare_publication(
    decisions: dict[tuple[str, int, int], dict[str, object]],
    candidate_keys: set[tuple[str, int, int]] | None = None,
    issue_keys: set[tuple[str, int, int]] | None = None,
    source_revision: str | None = None,
) -> CanonicalPatch:
    return prepare_canonical_patch(
        decisions,
        lambda name: _hf_source_file(name, source_revision),
        PUBLISH_ROOT / "canonical",
        candidate_keys,
        issue_keys,
    )


def _prepare_delivery(
    decisions: dict[tuple[str, int, int], dict[str, object]],
    canonical: CanonicalPatch,
    candidate_keys: set[tuple[str, int, int]] | None = None,
) -> DeliveryPatch:
    return prepare_delivery_patch(
        decisions,
        canonical,
        _delivery_source_file,
        PUBLISH_ROOT / "delivery",
        candidate_keys,
    )


def _publication_key(key: tuple[str, int, int]) -> str:
    return "|".join((key[0], str(key[1]), str(key[2])))


def _load_pending_publication() -> dict[str, dict[str, object]]:
    if not PENDING_PUBLICATION.is_file():
        return {}
    try:
        payload = json.loads(PENDING_PUBLICATION.read_text(encoding="utf-8"))
        items = payload.get("items") if isinstance(payload, dict) else None
        return {
            str(key): dict(value)
            for key, value in (items or {}).items()
            if isinstance(value, dict)
        }
    except (OSError, json.JSONDecodeError, TypeError):
        logging.exception("Unable to read pending RMRB publication journal %s", PENDING_PUBLICATION)
        return {}


def _write_pending_publication(items: dict[str, dict[str, object]]) -> None:
    payload = {
        "formatVersion": "jojo-rmrb-pending-publication/1",
        "items": dict(sorted(items.items())),
    }
    _atomic_write(
        PENDING_PUBLICATION,
        (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    )


def _publication_payload_sha256(
    content: str,
    decision: str,
    images: list[dict[str, object]],
) -> str:
    payload = {
        "content": content,
        "decision": decision,
        "images": [str(image.get("sha256") or "") for image in images],
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _stage_publication(
    key: tuple[str, int, int],
    content: str,
    decision: str,
    images: list[dict[str, object]] | None = None,
) -> None:
    image_rows = images or []
    items = _load_pending_publication()
    name = _publication_key(key)
    items[name] = {
        "decision": decision,
        "contentSha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
        "payloadSha256": _publication_payload_sha256(content, decision, image_rows),
        "stagedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    _write_pending_publication(items)


def _valid_image_signature(media_type: str, value: bytes) -> bool:
    if media_type == "image/png":
        return value.startswith(b"\x89PNG\r\n\x1a\n")
    if media_type == "image/jpeg":
        return value.startswith(b"\xff\xd8\xff")
    if media_type == "image/gif":
        return value.startswith((b"GIF87a", b"GIF89a"))
    if media_type == "image/webp":
        return len(value) >= 12 and value[:4] == b"RIFF" and value[8:12] == b"WEBP"
    return False


def _download_people_data_image(source_url: str, index: int) -> tuple[str, bytes]:
    parsed = urllib.parse.urlsplit(source_url)
    if (
        parsed.scheme != "https"
        or parsed.netloc != "webvpn.zju.edu.cn"
        or not source_url.startswith(PEOPLE_DATA_IMAGE_PREFIX)
    ):
        raise ValueError(f"image {index} source URL is not a People Data image")
    request_value = urllib.request.Request(
        source_url,
        headers={
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            "Referer": f"{PEOPLE_DATA_BASE}/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
        },
    )
    try:
        with urllib.request.urlopen(request_value, timeout=30) as response:
            raw = response.read(MAX_REVIEW_IMAGE_BYTES + 1)
    except (OSError, urllib.error.URLError) as error:
        raise ValueError(f"image {index} could not be downloaded from People Data") from error
    if not raw or len(raw) > MAX_REVIEW_IMAGE_BYTES:
        raise ValueError(f"image {index} must be between 1 byte and 15 MB")
    for media_type in IMAGE_SUFFIXES:
        if _valid_image_signature(media_type, raw):
            return media_type, raw
    raise ValueError(f"image {index} downloaded content is not a supported image")


def _save_review_images(values: object) -> list[dict[str, object]]:
    if values in (None, []):
        return []
    if not isinstance(values, list) or len(values) > MAX_REVIEW_IMAGES:
        raise ValueError(f"images must be a list of at most {MAX_REVIEW_IMAGES} items")
    result: list[dict[str, object]] = []
    for index, value in enumerate(values, start=1):
        if not isinstance(value, dict):
            raise ValueError(f"image {index} is invalid")
        match = IMAGE_DATA_RE.fullmatch(str(value.get("dataUrl") or ""))
        source_url = str(value.get("sourceUrl") or "")
        if match:
            media_type, encoded = match.groups()
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as error:
                raise ValueError(f"image {index} contains invalid base64 data") from error
            if not raw or len(raw) > MAX_REVIEW_IMAGE_BYTES:
                raise ValueError(f"image {index} must be between 1 byte and 15 MB")
            if not _valid_image_signature(media_type, raw):
                raise ValueError(f"image {index} content does not match {media_type}")
        elif source_url:
            media_type, raw = _download_people_data_image(source_url, index)
        else:
            raise ValueError(
                f"image {index} must be a PNG, JPEG, WebP or GIF data URL or a People Data image"
            )
        digest = hashlib.sha256(raw).hexdigest()
        relative = Path("attachments") / f"{digest}{IMAGE_SUFFIXES[media_type]}"
        target = REVIEW_ROOT / relative
        if not target.is_file():
            _atomic_write(target, raw)
        result.append({
            "name": str(value.get("name") or f"clipboard-image-{index}"),
            "mediaType": media_type,
            "size": len(raw),
            "sha256": digest,
            "path": str(target.resolve()),
            **({"sourceUrl": source_url} if source_url else {}),
        })
    return result


def _sync_huggingface(
    canonical: CanonicalPatch,
    parent_commit: str | None = None,
    release_identifier: str | None = None,
) -> dict[str, object]:
    token = _huggingface_token()
    if not token:
        raise RuntimeError("Hugging Face 未登录且 HF_TOKEN 未配置")
    from huggingface_hub import CommitOperationAdd, HfApi

    repo_id = _huggingface_repo()
    operations = [
        CommitOperationAdd(path_in_repo=name, path_or_fileobj=str(path))
        for name, path in sorted(canonical.files.items())
    ]
    if not operations:
        return {
            "repoId": repo_id,
            "commit": parent_commit or _hf_revision(),
            "publishedArticles": 0,
            "publishedObjects": 0,
        }
    commit = HfApi(token=token).create_commit(
        repo_id=repo_id,
        repo_type="dataset",
        operations=operations,
        commit_message=(
            f"Publish RMRB {release_identifier} ({canonical.changed_article_count} articles)"
            if release_identifier
            else f"Publish {canonical.changed_article_count} reviewed RMRB articles"
        ),
        parent_commit=parent_commit,
    )
    return {
        "repoId": repo_id,
        "commit": str(commit.oid),
        "publishedArticles": canonical.changed_article_count,
        "publishedObjects": len(canonical.files),
    }


def _search_index() -> str:
    return (
        os.environ.get("ES_SYNC_INDEX", "").strip()
        or os.environ.get("ES_REPAIR_INDEX", "").strip()
    )


def _search_client(index: str) -> KibanaConsoleClient:
    config = repair_config()
    config["index"] = index
    return KibanaConsoleClient(config)


def _search_publication_config(index: str) -> dict[str, object]:
    config = publication_config()
    validate_publication_target(index, config)
    return config


def _rmrb_search_desired(
    canonical: CanonicalPatch,
    candidate_keys: set[tuple[str, int, int]],
    revision: str,
) -> list[DesiredSearchDocument]:
    publication_title = str(canonical.dataset.get("title") or "人民日报")
    result: list[DesiredSearchDocument] = []
    by_year: dict[str, list[tuple[str, int, int]]] = {}
    for key in candidate_keys:
        by_year.setdefault(key[0][:4], []).append(key)
    for year, keys in sorted(by_year.items()):
        canonical_object = f"newspapers/rmrb/data/articles/{year}.jsonl.gz"
        source = canonical.files.get(canonical_object) or _hf_source_file(
            canonical_object,
            revision,
        )
        rows = {
            (str(row.get("date")), int(row.get("page") or 0), int(row.get("ordinal") or 0)): row
            for row in read_canonical_articles(source)
        }
        for key in sorted(keys):
            base_id = stable_document_id("newspaper", "rmrb", key[0], key[1], key[2])
            row = rows.get(key)
            if row is None:
                raise ValueError(f"HF 年度分片中找不到搜索发布条目：{key}")
            indexed = newspaper_document(
                row,
                publication_id="rmrb",
                publication_title=publication_title,
                canonical_object=canonical_object,
            )
            result.append(DesiredSearchDocument(
                base_id=base_id,
                document=indexed.document if indexed else None,
            ))
    return result


def _decisions_from_canonical(
    candidate_keys: set[tuple[str, int, int]],
    revision: str,
) -> dict[tuple[str, int, int], dict[str, object]]:
    """Rebuild derived-stage inputs after Canonical already committed."""
    result: dict[tuple[str, int, int], dict[str, object]] = {}
    viewer_rows: dict[tuple[str, int, int], dict[str, object]] = {}
    for year in sorted({key[0][:4] for key in candidate_keys}):
        object_path = f"newspapers/rmrb/data/articles/{year}.jsonl.gz"
        for row in read_canonical_articles(_hf_source_file(object_path, revision)):
            key = (str(row.get("date")), int(row.get("page") or 0), int(row.get("ordinal") or 0))
            if key in candidate_keys:
                viewer_rows[key] = row
    by_day: dict[str, list[tuple[str, int, int]]] = {}
    for key in candidate_keys:
        by_day.setdefault(key[0], []).append(key)
    for day, keys in sorted(by_day.items()):
        object_path = f"newspapers/rmrb/items/{day[:4]}/{day[5:7]}/{day}.json.gz"
        item = read_canonical_item(_hf_source_file(object_path, revision))
        articles = {
            str(article.get("id")): article
            for article in (item.get("content") or {}).get("articles") or []
            if isinstance(article, dict)
        }
        assets = {
            str(asset.get("id")): asset
            for asset in item.get("assets") or []
            if isinstance(asset, dict)
        }
        for key in keys:
            article = articles.get(canonical_article_id(*key))
            if article is None:
                raise ValueError(f"HF commit {revision} 中找不到续跑条目：{key}")
            state = str(article.get("contentState") or "")
            viewer = viewer_rows.get(key)
            if viewer is None:
                raise ValueError(f"HF commit {revision} 的年度分片中找不到续跑条目：{key}")
            content = str(viewer.get("content") or "").strip()
            if state == "rejected":
                decision = "reject"
            elif state in {"available", "repaired", "image", "image-placeholder"} and content:
                decision = "accept"
            else:
                raise ValueError(f"HF commit {revision} 中的条目尚未形成可发布状态：{key}")
            images: list[dict[str, object]] = []
            for asset_id in article.get("assetRefs") or []:
                asset = assets.get(str(asset_id))
                if asset is None or str(asset.get("type")) != "image":
                    continue
                asset_path = str(asset.get("path") or "")
                if not asset_path:
                    raise ValueError(f"HF commit {revision} 的图片缺少 path：{asset_id}")
                source = _hf_source_file(f"newspapers/rmrb/{asset_path}", revision)
                images.append({
                    "path": str(source),
                    "sha256": str(asset.get("sha256") or ""),
                    "mediaType": str(asset.get("mediaType") or ""),
                })
            result[key] = {
                "date": key[0],
                "page": key[1],
                "peopleDataOrdinal": key[2],
                "title": str(article.get("title") or ""),
                "decision": decision,
                "content": content,
                "images": images,
                "reason": "从已提交 Canonical release 续跑",
            }
    return result


def _remote_release(config: dict[str, object] | None = None) -> dict[str, object] | None:
    value = load_remote_json_object(
        RELEASE_REMOTE_KEY,
        config or publication_config(),
        missing_ok=True,
    )
    return value if isinstance(value, dict) else None


def _upload_remote_release(value: dict[str, object], config: dict[str, object]) -> None:
    last_error: Exception | None = None
    for _attempt in range(3):
        try:
            upload_remote_json_object(RELEASE_REMOTE_KEY, value, config)
            return
        except Exception as error:
            last_error = error
    assert last_error is not None
    raise last_error


def _recoverable_release(value: dict[str, object] | None) -> bool:
    if not value or value.get("status") == "succeeded":
        return False
    stages = value.get("stages")
    canonical = stages.get("canonical") if isinstance(stages, dict) else None
    return isinstance(canonical, dict) and canonical.get("status") == "succeeded"


def _release_is_live(value: dict[str, object] | None, lease_seconds: int = 600) -> bool:
    if not value or value.get("status") != "running":
        return False
    try:
        updated = datetime.fromisoformat(str(value.get("updatedAt")))
    except ValueError:
        return False
    if updated.tzinfo is None:
        updated = updated.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - updated).total_seconds() < lease_seconds


def _run_rclone_copyto(source: Path | str, destination: str) -> None:
    executable = shutil.which("rclone.exe") or shutil.which("rclone")
    if not executable:
        raise RuntimeError("未安装 rclone")
    result = subprocess.run(
        [
            executable, "copyto", str(source), destination, "--checksum",
            "--retries", "5", "--low-level-retries", "10", "--s3-no-check-bucket",
        ],
        cwd=WORKSPACE_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=600,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "rclone 上传失败")


def _sync_b2(
    delivery: DeliveryPatch,
    progress: Callable[[int, int, str], None] | None = None,
) -> dict[str, object]:
    # Publish immutable fragments first, issue manifests second, and the
    # collection index last so readers never observe dangling references.
    def priority(name: str) -> tuple[int, str]:
        if name.endswith("/index.jox"):
            return 2, name
        if name.endswith("/manifest.jox"):
            return 1, name
        return 0, name

    files = sorted(delivery.files.items(), key=lambda item: priority(item[0]))
    for index, (name, path) in enumerate(files, start=1):
        if progress:
            progress(index - 1, len(files), name)
        _run_rclone_copyto(path, f"{_b2_remote()}/{name}")
        if progress:
            progress(index, len(files), name)
    return {
        "remote": _b2_remote(),
        "publishedArticles": delivery.changed_article_count,
        "publishedObjects": len(delivery.files),
    }


def _open_db() -> sqlite3.Connection:
    connection = sqlite3.connect(REVIEW_DB)
    connection.row_factory = sqlite3.Row
    return connection


def _prepare_handled_table(
    connection: sqlite3.Connection,
    decisions: dict[tuple[str, int, int], dict[str, object]],
) -> None:
    connection.execute(
        "CREATE TEMP TABLE handled_articles ("
        "issue_date TEXT NOT NULL, page_number INTEGER NOT NULL, ordinal INTEGER NOT NULL, "
        "decision TEXT NOT NULL, PRIMARY KEY(issue_date, page_number, ordinal)) WITHOUT ROWID"
    )
    connection.executemany(
        "INSERT INTO handled_articles VALUES (?, ?, ?, ?)",
        ((key[0], key[1], key[2], row["decision"]) for key, row in decisions.items()),
    )


def _missing_article(key: tuple[str, int, int]) -> dict[str, object] | None:
    if not REVIEW_DB.is_file():
        return None
    with closing(_open_db()) as connection:
        row = connection.execute(
            "SELECT issue_date AS date, page_number AS page, ordinal AS peopleDataOrdinal, "
            "title, href, match_method AS matchMethod, content_source AS contentSource "
            "FROM missing_articles WHERE issue_date = ? AND page_number = ? AND ordinal = ?",
            key,
        ).fetchone()
    return dict(row) if row else None


def _people_data_href(row: dict[str, object]) -> str | None:
    href = str(row.get("href") or "").strip()
    if href.startswith("https://"):
        return href
    if href.startswith("/https/"):
        return "https://webvpn.zju.edu.cn" + href
    day = str(row.get("date") or "")
    page = int(row.get("page") or 0)
    ordinal = int(row.get("peopleDataOrdinal", -1))
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) and page > 0 and ordinal >= 0:
        query = {
            "cds": [{
                "fld": "dataTime",
                "cdr": "AND",
                "hlt": "false",
                "vlr": "OR",
                "qtp": "DEF",
                "val": day.replace("-", ""),
            }],
            "obs": [{"fld": "dataTime", "drt": "DESC"}],
        }
        encoded = urllib.parse.quote(
            json.dumps(query, ensure_ascii=False, separators=(",", ":")),
            safe="",
        )
        return f"{PEOPLE_DATA_BASE}/pd.html?qs={encoded}&tr=A&pageNo=1&pageSize=200&position={ordinal}"
    return None


def _public_row(
    row: dict[str, object], decision: dict[str, object] | None
) -> dict[str, object]:
    day = str(row.get("date") or "")
    return {
        "date": day,
        "page": row.get("page"),
        "peopleDataOrdinal": row.get("peopleDataOrdinal"),
        "title": row.get("title"),
        "status": "missing",
        "rawRecoveryClass": "HF Canonical 正文缺失",
        "peopleDataHref": _people_data_href(row),
        "decision": decision,
    }


@rmrb_review_blueprint.get("/api/rmrb-review/queue")
def queue_api():
    source = _review_source_status()
    if not REVIEW_DB.is_file():
        return jsonify({
            "success": False,
            "error": str(source.get("message") or "正在从 HF 生成待复核队列"),
            "source": source,
        }), 503
    decisions = load_pending_decisions()
    pending_only = request.args.get("pendingOnly", "").lower() in {"1", "true", "yes"}
    query = request.args.get("q", "").strip().lower()
    year = request.args.get("year", "").strip()
    offset = max(int(request.args.get("offset", 0) or 0), 0)
    limit = min(max(int(request.args.get("limit", 40) or 40), 1), 200)
    where: list[str] = []
    parameters: list[object] = []
    if pending_only:
        where.append("handled.ordinal IS NULL")
    if query:
        where.append("(LOWER(article.title) LIKE ? OR article.issue_date LIKE ?)")
        parameters.extend((f"%{query}%", f"%{query}%"))
    if year:
        where.append("article.issue_date LIKE ?")
        parameters.append(f"{year}%")
    where_sql = " WHERE " + " AND ".join(where) if where else ""
    from_sql = (
        " FROM missing_articles article LEFT JOIN handled_articles handled "
        "ON handled.issue_date = article.issue_date "
        "AND handled.page_number = article.page_number AND handled.ordinal = article.ordinal"
    )
    with closing(_open_db()) as connection:
        _prepare_handled_table(connection, decisions)
        total = connection.execute(
            "SELECT COUNT(*)" + from_sql + where_sql, parameters
        ).fetchone()[0]
        rows = connection.execute(
            "SELECT article.issue_date AS date, article.page_number AS page, "
            "article.ordinal AS peopleDataOrdinal, article.title, article.href, "
            "article.match_method AS matchMethod, article.content_source AS contentSource, "
            "handled.decision AS priorDecision" + from_sql + where_sql +
            " ORDER BY article.issue_date, article.page_number, article.ordinal LIMIT ? OFFSET ?",
            (*parameters, limit, offset),
        ).fetchall()
    items = []
    for result in rows:
        source = dict(result)
        items.append(_public_row(source, decisions.get(_key(source))))
    return jsonify(
        {
            "success": True,
            "total": total,
            "offset": offset,
            "limit": limit,
            "sort": "date-ascending",
            "items": items,
        }
    )


@rmrb_review_blueprint.get("/api/rmrb-review/stats")
def stats_api():
    source = _review_source_status()
    if not REVIEW_DB.is_file():
        return jsonify({
            "success": False,
            "error": str(source.get("message") or "正在从 HF 生成待复核队列"),
            "source": source,
        }), 503
    decisions = load_pending_decisions()
    with closing(_open_db()) as connection:
        _prepare_handled_table(connection, decisions)
        total = connection.execute("SELECT COUNT(*) FROM missing_articles").fetchone()[0]
        handled = dict(
            connection.execute(
                "SELECT handled.decision, COUNT(*) FROM missing_articles article "
                "JOIN handled_articles handled ON handled.issue_date = article.issue_date "
                "AND handled.page_number = article.page_number AND handled.ordinal = article.ordinal "
                "GROUP BY handled.decision"
            ).fetchall()
        )
    counts = {
        "pending": total - sum(handled.values()),
        "pendingPublication": len(_load_pending_publication()),
    }
    return jsonify({"success": True, "total": total, "counts": counts})


@rmrb_review_blueprint.get("/api/rmrb-review/source")
def source_status_api():
    force = request.args.get("refresh", "").lower() in {"1", "true", "yes"}
    return jsonify({"success": True, **_review_source_status(force=force)})


@rmrb_review_blueprint.get("/api/rmrb-review/sync")
def sync_status_api():
    state = _load_sync_state()
    progress = _sync_progress_snapshot()
    es_config = repair_config()
    search_index = _search_index()
    search_ready = bool(
        search_index
        and all(es_config.get(key) for key in ("kibana_url", "username", "password", "space_id"))
    )
    try:
        _search_publication_config(search_index)
        activation_ready = bool(shutil.which("tccli"))
    except ValueError:
        activation_ready = False
    remote_release = None
    if activation_ready and progress.get("status") != "running":
        try:
            remote_release = _remote_release()
        except Exception:
            logging.exception("Unable to read remote Canonical release receipt")
    recoverable = _recoverable_release(remote_release) and not _release_is_live(remote_release)
    remote_desired = remote_release.get("desired") if recoverable and remote_release else {}
    remote_items = remote_desired.get("items") if isinstance(remote_desired, dict) else {}
    return jsonify(
        {
            "success": True,
            "configured": {
                "canonical": bool(_huggingface_token() and _huggingface_repo()),
                "delivery": bool(shutil.which("rclone.exe") or shutil.which("rclone")),
                "search": search_ready,
                "activation": activation_ready,
            },
            "state": state,
            "recoverableRelease": {
                "available": recoverable,
                "releaseId": remote_release.get("releaseId") if recoverable else None,
                "count": len(remote_items) if isinstance(remote_items, dict) else 0,
                "failedStage": remote_release.get("failedStage") if recoverable else None,
            },
            "progress": progress,
        }
    )


@rmrb_review_blueprint.post("/api/rmrb-review/sync")
def sync_api():
    if not SYNC_LOCK.acquire(blocking=False):
        return jsonify({"success": False, "error": "已有 Canonical 发布正在运行"}), 409
    started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    _set_sync_progress(
        status="running",
        phase="preparing",
        message="正在读取待发布修订",
        completed=0,
        total=0,
        percent=3,
        startedAt=started_at,
        finishedAt=None,
        publishedChanges=0,
    )
    try:
        local_pending = _load_pending_publication()
        index = _search_index()
        if not index:
            if not local_pending:
                _set_sync_progress(
                    status="idle", phase="idle", message="没有待发布修订",
                    finishedAt=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                )
                return jsonify({"success": False, "error": "没有本机待发布修订；ES 未配置，无法检查远端续跑任务"}), 409
            raise ValueError("ES_SYNC_INDEX 未配置")
        if not _huggingface_token():
            raise ValueError("Hugging Face 未登录且 HF_TOKEN 未配置")
        if not (shutil.which("rclone.exe") or shutil.which("rclone")):
            raise ValueError("未安装 rclone，无法发布 B2 Delivery")
        if not shutil.which("tccli"):
            raise ValueError("未安装 tccli，无法激活远端搜索状态")
        search_settings = _search_publication_config(index)
        remote_receipt = _remote_release(search_settings)
        if _release_is_live(remote_receipt):
            _set_sync_progress(
                status="idle", phase="idle", message="另一台工作站正在发布",
                finishedAt=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            )
            return jsonify({
                "success": False,
                "error": f"另一台工作站正在执行 {remote_receipt.get('releaseId')}，请稍后刷新",
            }), 409
        if _recoverable_release(remote_receipt):
            assert remote_receipt is not None
            desired_value = remote_receipt.get("desired")
            if not isinstance(desired_value, dict) or not isinstance(desired_value.get("items"), dict):
                raise ValueError("远端发布收据缺少 desired.items")
            desired = desired_value
            identifier = str(remote_receipt.get("releaseId") or "")
            if not identifier or release_id(desired) != identifier:
                raise ValueError("远端发布收据的 releaseId 校验失败")
            if desired.get("repo") != _huggingface_repo() or desired.get("delivery") != _b2_remote():
                raise ValueError("远端未完成发布的 HF/B2 目标与本机配置不一致")
            if desired.get("searchIndex") != index:
                raise ValueError("远端未完成发布的 ES 索引与本机配置不一致")
            item_values = desired["items"]
            pending_snapshot = {
                str(name): dict(value)
                for name, value in item_values.items()
                if isinstance(name, str) and isinstance(value, dict)
            }
            candidate_keys = {parse_key(name) for name in pending_snapshot}
            canonical_stage_state = remote_receipt["stages"]["canonical"]  # type: ignore[index]
            source_revision = str(canonical_stage_state["result"]["commit"])
            decisions = _decisions_from_canonical(candidate_keys, source_revision)
            _set_sync_progress(
                message=f"正在从 HF commit {source_revision[:12]} 续跑 {len(candidate_keys)} 条修订",
                percent=8,
            )
        else:
            decisions = load_pending_decisions()
            pending_snapshot = local_pending
            if not pending_snapshot:
                _set_sync_progress(
                    status="idle", phase="idle", message="没有待发布修订",
                    finishedAt=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                )
                return jsonify({"success": False, "error": "没有待发布或可续跑的修订"}), 409
            missing_decisions = sorted(set(pending_snapshot) - {
                _publication_key(key) for key in decisions
            })
            if missing_decisions:
                raise ValueError("待发布日志缺少本地修订内容：" + ", ".join(missing_decisions[:5]))
            desired = {
                "repo": _huggingface_repo(),
                "delivery": _b2_remote(),
                "searchIndex": index,
                "items": {
                    name: {
                        "decision": row.get("decision"),
                        "payloadSha256": row.get("payloadSha256") or row.get("contentSha256"),
                    }
                    for name, row in sorted(pending_snapshot.items())
                },
            }
            identifier = release_id(desired)
            candidate_keys = {parse_key(name) for name in pending_snapshot}
            source_revision = _hf_revision()
            _set_sync_progress(
                message=f"正在核对 {len(pending_snapshot)} 条修订与 HF Canonical",
                percent=8,
            )

        canonical = _prepare_publication(
            decisions,
            candidate_keys,
            candidate_keys,
            source_revision,
        )
        search_client = _search_client(index)
        ensure_unified_mapping(search_client, index)
        remote_search_state = load_remote_search_state(search_settings)
        delivery = _prepare_delivery(decisions, canonical, candidate_keys)
        search_desired = _rmrb_search_desired(canonical, candidate_keys, source_revision)
        _set_sync_progress(
            message="发布计划已验证，准备提交 HF Canonical",
            completed=0,
            total=len(canonical.files) + len(delivery.files) + len(search_desired),
            percent=10,
        )

        def canonical_stage(_state: dict[str, object]) -> dict[str, object]:
            detail = _sync_huggingface(canonical, source_revision, identifier)
            commit = str(detail.get("commit") or "")
            if not commit:
                raise RuntimeError("HF 未返回 Canonical commit")
            remove_from_review_cache(REVIEW_DB, candidate_keys, commit)
            review_source_manager.mark_published(commit)
            return detail

        def delivery_stage(_state: dict[str, object]) -> dict[str, object]:
            def report(completed: int, total: int, name: str) -> None:
                _set_sync_progress(
                    phase="delivery",
                    message=f"正在更新 B2 Delivery（{completed}/{total}）：{name.rsplit('/', 1)[-1]}",
                    completed=completed,
                    total=total,
                    percent=min(54, 33 + round(21 * completed / max(total, 1))),
                )

            return _sync_b2(delivery, report)

        def search_stage(state: dict[str, object]) -> dict[str, object]:
            commit = str(
                state["stages"]["canonical"]["result"]["commit"]  # type: ignore[index]
            )
            publisher = AppendOnlySearchPublisher(
                search_client,
                index,
                remote_search_state,
                fallback_heads=active_revision_heads(index),
            )
            return publisher.publish(
                search_desired,
                scope="newspaper:rmrb",
                canonical_revision=commit,
            )

        def activation_stage(state: dict[str, object]) -> dict[str, object]:
            publication = state["stages"]["search"]["result"]  # type: ignore[index]
            return publish_search_activation(
                publication,
                loader=lambda: load_remote_search_state(search_settings),
                uploader=lambda value: upload_remote_search_state(value, search_settings),
            )

        stage_labels = {
            "canonical": "HF Canonical",
            "delivery": "B2 Delivery",
            "search": "ES Search",
            "activation": "COS 搜索状态",
        }

        def report_stage(stage: str, message: str, percent: int) -> None:
            _set_sync_progress(
                phase=stage,
                message=f"{stage_labels[stage]}：{message}",
                percent=percent,
            )

        release = CanonicalRelease(
            MirroredReleaseJournal(
                RELEASES_ROOT / f"{identifier}.json",
                remote_loader=lambda: _remote_release(search_settings),
                remote_saver=lambda value: _upload_remote_release(value, search_settings),
            ),
            {
                "canonical": canonical_stage,
                "delivery": delivery_stage,
                "search": search_stage,
                "activation": activation_stage,
            },
            on_progress=report_stage,
        ).run(
            identifier=identifier,
            scope="newspaper:rmrb",
            desired=desired,
        )

        with DECISION_LOCK:
            latest_pending = _load_pending_publication()
            for name, snapshot in pending_snapshot.items():
                current = latest_pending.get(name)
                if current is None:
                    continue
                current_payload = current.get("payloadSha256") or current.get("contentSha256")
                snapshot_payload = snapshot.get("payloadSha256") or snapshot.get("contentSha256")
                if current_payload == snapshot_payload and current.get("decision") == snapshot.get("decision"):
                    latest_pending.pop(name, None)
            _write_pending_publication(latest_pending)

        state = {
            "formatVersion": "jojo-rmrb-review-sync-state/2",
            "lastRelease": {
                "releaseId": identifier,
                "status": release["status"],
                "finishedAt": release.get("finishedAt"),
                "canonicalCommit": release["stages"]["canonical"]["result"].get("commit"),
            },
        }
        _write_sync_state(state)
        results = {
            name: release["stages"][name].get("result")
            for name in ("canonical", "delivery", "search", "activation")
        }
        response = {
            "success": True,
            "releaseId": identifier,
            "stagedCount": len(pending_snapshot),
            "pendingPublication": len(_load_pending_publication()),
            "canonicalChanges": canonical.changed_article_count,
            "publishedChanges": len(pending_snapshot),
            "results": results,
        }
        _set_sync_progress(
            status="succeeded",
            phase="complete",
            message=f"已发布 {len(pending_snapshot)} 条修订；Canonical、Delivery 与搜索均已生效",
            percent=100,
            finishedAt=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            publishedChanges=len(pending_snapshot),
        )
        return jsonify(response)
    except Exception as error:
        logging.exception("Unable to prepare RMRB review publication")
        _set_sync_progress(
            status="failed",
            phase="failed",
            message=f"发布失败：{error}",
            finishedAt=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        )
        return jsonify({"success": False, "error": str(error)}), 502
    finally:
        SYNC_LOCK.release()


def _write_workbench_decisions(rows: dict[tuple[str, int, int], dict[str, object]]) -> None:
    WORKBENCH_DECISIONS.parent.mkdir(parents=True, exist_ok=True)
    temporary = WORKBENCH_DECISIONS.with_suffix(".jsonl.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        for row in sorted(rows.values(), key=_key):
            stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(temporary, WORKBENCH_DECISIONS)


@rmrb_review_blueprint.post("/api/rmrb-review/decision")
def decision_api():
    payload = request.get_json(silent=True) or {}
    decision = str(payload.get("decision") or "").strip().lower()
    if decision not in {"accept", "reject"}:
        return jsonify({"success": False, "error": "decision must be accept or reject"}), 400
    try:
        key = (
            str(payload["date"]),
            int(payload["page"]),
            int(payload["peopleDataOrdinal"]),
        )
    except (KeyError, TypeError, ValueError):
        return jsonify({"success": False, "error": "invalid article key"}), 400
    source = _missing_article(key)
    if source is None:
        return jsonify({"success": False, "error": "article is not in the missing-content queue"}), 404
    content = COPY_MARKER_RE.sub("", str(payload.get("content") or "")).strip()
    reason = str(payload.get("reason") or "").strip()
    try:
        images = _save_review_images(payload.get("images")) if decision == "accept" else []
    except ValueError as error:
        return jsonify({"success": False, "error": str(error)}), 400
    if decision == "accept" and not content and not images:
        return jsonify({"success": False, "error": "accept requires a transcription or image"}), 400
    if decision == "accept" and not content:
        content = "【图片】"
    if decision == "reject" and not reason:
        return jsonify({"success": False, "error": "reject requires a confirmed catalog-error reason"}), 400
    row: dict[str, object] = {
        "date": key[0],
        "page": key[1],
        "peopleDataOrdinal": key[2],
        "title": source.get("title"),
        "decision": decision,
        "content": content if decision == "accept" else "",
        "reason": reason or "人工复核确认",
        "images": images,
        "reviewedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "scope": "staging-only",
        "sourceCorpusModified": False,
        "elasticsearchChanged": False,
    }
    with DECISION_LOCK:
        existing = {
            _key(item): item
            for item in (_read_decision_file(WORKBENCH_DECISIONS) if WORKBENCH_DECISIONS.is_file() else [])
        }
        existing[key] = row
        _write_workbench_decisions(existing)
        _stage_publication(key, content, decision, images)
    return jsonify({"success": True, "decision": row})
