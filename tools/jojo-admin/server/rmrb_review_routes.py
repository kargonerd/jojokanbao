"""Local-first review and incremental publication API for missing RMRB content."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import urllib.parse
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from flask import Blueprint, jsonify, request

from rmrb_review_publish import (
    CanonicalPatch,
    DeliveryPatch,
    accepted_hashes,
    parse_key,
    prepare_canonical_patch,
    prepare_delivery_patch,
)
from rmrb_review_source import remove_from_review_cache, review_source_manager


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
REVIEW_DB = REVIEW_ROOT / "hf-missing-workbench.sqlite3"
WORKBENCH_DECISIONS = REVIEW_ROOT / "manual-review-decisions-workbench.jsonl"
SYNC_ROOT = REVIEW_ROOT / "sync"
SYNC_STATE = SYNC_ROOT / "review-sync-state.json"
PUBLISH_ROOT = SYNC_ROOT / "publish"
PUBLICATION_STATE = SYNC_ROOT / "publication-state.json"
PENDING_PUBLICATION = REVIEW_ROOT / "manual-review-pending-publication.json"
COPY_MARKER_RE = re.compile(r"[（(]\s*人民数据库资料\s*[）)]")
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


def _hf_source_file(filename: str) -> Path:
    from huggingface_hub import hf_hub_download

    return Path(hf_hub_download(
        repo_id=_huggingface_repo(),
        filename=filename,
        repo_type="dataset",
        token=_huggingface_token() or None,
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
) -> CanonicalPatch:
    return prepare_canonical_patch(
        decisions,
        _hf_source_file,
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


def _load_publication_state() -> dict[str, object]:
    if not PUBLICATION_STATE.is_file():
        return {"formatVersion": "jojo-rmrb-review-publication-state/1", "targets": {}}
    try:
        return json.loads(PUBLICATION_STATE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logging.exception("Unable to read RMRB publication state %s", PUBLICATION_STATE)
        return {"formatVersion": "jojo-rmrb-review-publication-state/1", "targets": {}}


def _write_publication_state(state: dict[str, object]) -> None:
    _atomic_write(
        PUBLICATION_STATE,
        (json.dumps(state, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"),
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


def _stage_publication(key: tuple[str, int, int], content: str, decision: str) -> None:
    items = _load_pending_publication()
    name = _publication_key(key)
    items[name] = {
        "decision": decision,
        "contentSha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
        "targets": ["huggingface", "b2"],
        "stagedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    _write_pending_publication(items)


def _sync_huggingface(canonical: CanonicalPatch) -> dict[str, object]:
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
            "commit": None,
            "publishedArticles": 0,
            "publishedObjects": 0,
        }
    commit = HfApi(token=token).create_commit(
        repo_id=repo_id,
        repo_type="dataset",
        operations=operations,
        commit_message=f"Publish {canonical.changed_article_count} reviewed RMRB articles",
    )
    return {
        "repoId": repo_id,
        "commit": str(commit.oid),
        "publishedArticles": canonical.changed_article_count,
        "publishedObjects": len(canonical.files),
    }


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
    return jsonify(
        {
            "success": True,
            "configured": {
                "huggingface": bool(_huggingface_token() and _huggingface_repo()),
                "b2": bool(shutil.which("rclone.exe") or shutil.which("rclone")),
            },
            "state": state,
            "progress": _sync_progress_snapshot(),
        }
    )


@rmrb_review_blueprint.post("/api/rmrb-review/sync")
def sync_api():
    payload = request.get_json(silent=True) or {}
    requested = payload.get("targets") or []
    if not isinstance(requested, list):
        return jsonify({"success": False, "error": "targets must be a list"}), 400
    targets = list(dict.fromkeys(str(item).strip().lower() for item in requested))
    allowed = {"huggingface", "b2"}
    if not targets or any(item not in allowed for item in targets):
        return jsonify({"success": False, "error": "select huggingface and/or b2"}), 400
    if not SYNC_LOCK.acquire(blocking=False):
        return jsonify({"success": False, "error": "another review sync is running"}), 409
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
        decisions = load_pending_decisions()
        desired = accepted_hashes(decisions)
        desired_sha256 = hashlib.sha256(
            json.dumps(desired, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        published_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        publication_state = _load_publication_state()
        publication_targets = publication_state.setdefault("targets", {})
        assert isinstance(publication_targets, dict)
        pending_snapshot = _load_pending_publication()
        _set_sync_progress(
            message=f"正在核对 {len(pending_snapshot)} 条修订与 HF 正式数据",
            percent=8,
        )
        hf_names = {
            name for name, row in pending_snapshot.items()
            if "huggingface" in (row.get("targets") or []) and "huggingface" in targets
        }
        b2_names = {
            name for name, row in pending_snapshot.items()
            if "b2" in (row.get("targets") or []) and "b2" in targets
        }
        canonical = _prepare_publication(
            decisions,
            {parse_key(name) for name in hf_names | b2_names},
            {parse_key(name) for name in b2_names},
        )
        if "b2" in targets and canonical.changed_keys and "huggingface" not in targets:
            _set_sync_progress(
                status="failed",
                phase="failed",
                message="B2 依赖的 HF 正式数据尚未发布",
                finishedAt=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            )
            return jsonify({
                "success": False,
                "error": "B2 修订依赖尚未发布的 HF Canonical；请同时选择 HF",
            }), 409
        _set_sync_progress(
            message=f"HF 正式数据已核对，正在生成 B2 Delivery",
            percent=28,
        )
        delivery = _prepare_delivery(
            decisions,
            canonical,
            {parse_key(name) for name in b2_names},
        ) if "b2" in targets else None
        hf_object_count = len(canonical.files) if "huggingface" in targets else 0
        b2_object_count = len(delivery.files) if delivery is not None else 0
        object_total = hf_object_count + b2_object_count
        _set_sync_progress(
            message=f"发布包已就绪，共 {object_total} 个远端对象",
            completed=0,
            total=object_total,
            percent=35,
        )
        state = _load_sync_state()
        target_state = state.setdefault("targets", {})
        assert isinstance(target_state, dict)
        results: dict[str, object] = {}
        errors: dict[str, str] = {}
        target_names = {"huggingface": hf_names, "b2": b2_names}
        for target in targets:
            if target == "b2" and "huggingface" in errors:
                errors[target] = "HF Canonical 发布失败，已停止 B2 发布以避免数据分叉"
                continue
            try:
                if target == "huggingface":
                    _set_sync_progress(
                        phase="huggingface",
                        message=f"正在提交 HF Canonical（{hf_object_count} 个对象）",
                        percent=40,
                    )
                    detail = _sync_huggingface(canonical)
                    commit = str(detail.get("commit") or "")
                    if commit:
                        remove_from_review_cache(
                            REVIEW_DB,
                            {parse_key(name) for name in hf_names},
                            commit,
                        )
                        review_source_manager.mark_published(commit)
                    _set_sync_progress(
                        completed=hf_object_count,
                        message="HF Canonical 已提交，正在准备 B2",
                        percent=65 if "b2" in targets else 95,
                    )
                else:
                    def report_b2(completed: int, total: int, name: str) -> None:
                        overall_completed = hf_object_count + completed
                        object_name = name.rsplit("/", 1)[-1]
                        percent = 68
                        if object_total:
                            percent = min(96, 40 + round(56 * overall_completed / object_total))
                        _set_sync_progress(
                            phase="b2",
                            message=f"正在更新 B2 Delivery（{completed}/{total}）：{object_name}",
                            completed=overall_completed,
                            percent=percent,
                        )

                    detail = _sync_b2(
                        delivery or DeliveryPatch(PUBLISH_ROOT),
                        report_b2,
                    )
                results[target] = detail
                target_state[target] = {
                    "publishedAt": published_at,
                    "acceptedCount": len(desired),
                    "desiredSha256": desired_sha256,
                    **detail,
                }
                publication_targets[target] = {"accepted": desired}
                _write_publication_state(publication_state)
                with DECISION_LOCK:
                    latest_pending = _load_pending_publication()
                    for name in target_names[target]:
                        current = latest_pending.get(name)
                        snapshot = pending_snapshot.get(name)
                        if current is None or snapshot is None:
                            continue
                        if current.get("contentSha256") != snapshot.get("contentSha256"):
                            continue
                        if current.get("decision", "accept") != snapshot.get("decision", "accept"):
                            continue
                        remaining = [
                            value for value in (current.get("targets") or [])
                            if value != target
                        ]
                        if remaining:
                            current["targets"] = remaining
                        else:
                            latest_pending.pop(name, None)
                    _write_pending_publication(latest_pending)
            except Exception as error:  # Each selected destination is independent.
                logging.exception("Unable to sync RMRB reviews to %s", target)
                errors[target] = str(error)
        state["formatVersion"] = "jojo-rmrb-review-sync-state/1"
        state["lastAttemptAt"] = published_at
        _write_sync_state(state)
        response = {
            "success": not errors,
            "stagedCount": len(pending_snapshot),
            "pendingPublication": len(_load_pending_publication()),
            "canonicalChanges": canonical.changed_article_count,
            "publishedChanges": max(
                (int(detail.get("publishedArticles") or 0) for detail in results.values() if isinstance(detail, dict)),
                default=0,
            ),
            "results": results,
            "errors": errors,
        }
        published_changes = int(response["publishedChanges"])
        if errors:
            _set_sync_progress(
                status="failed",
                phase="failed",
                message="发布未全部完成：" + "；".join(errors.values()),
                finishedAt=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                publishedChanges=published_changes,
            )
        else:
            _set_sync_progress(
                status="succeeded",
                phase="complete",
                message=f"已发布 {published_changes} 条修订，HF 与 B2 均已完成",
                completed=object_total,
                total=object_total,
                percent=100,
                finishedAt=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                publishedChanges=published_changes,
            )
        return jsonify(response), 200 if not errors else 502
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
    if decision == "accept" and not content:
        return jsonify({"success": False, "error": "accept requires a transcription"}), 400
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
        _stage_publication(key, content, decision)
    return jsonify({"success": True, "decision": row})
