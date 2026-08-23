"""Local-first review and incremental publication API for missing RMRB content."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import threading
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from flask import Blueprint, jsonify, request

from rmrb_review_publish import (
    CanonicalPatch,
    DeliveryPatch,
    accepted_hashes,
    parse_key,
    prepare_canonical_patch,
    prepare_delivery_patch,
)


rmrb_review_blueprint = Blueprint("rmrb_review", __name__)

WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
REVIEW_ROOT = Path(
    os.environ.get(
        "RMRB_REVIEW_ROOT",
        WORKSPACE_ROOT / "tmp" / "rmrb-peopledata-full-directory",
    )
)
PEOPLE_DATA_BASE = (
    "https://webvpn.zju.edu.cn/https/"
    "77726476706e69737468656265737421f4f6559d69206d5f6e048ce29b5a2e7b74a4/rmrb"
)
REVIEW_DB = REVIEW_ROOT / "merged-missing-workbench.sqlite3"
WORKBENCH_DECISIONS = REVIEW_ROOT / "manual-review-decisions-workbench.jsonl"
SYNC_ROOT = REVIEW_ROOT / "sync"
SYNC_STATE = SYNC_ROOT / "review-sync-state.json"
PUBLISH_ROOT = SYNC_ROOT / "publish"
PUBLICATION_STATE = SYNC_ROOT / "publication-state.json"
SYNC_REMOTE_ROOT = "newspapers/rmrb/annotations"
COPY_MARKER_RE = re.compile(r"[（(]\s*人民数据库资料\s*[）)]")
DECISION_LOCK = threading.Lock()
SYNC_LOCK = threading.Lock()


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


def load_all_decisions() -> dict[tuple[str, int, int], dict[str, object]]:
    """Load all staged verdicts, with the interactive workbench taking priority."""
    decisions: dict[tuple[str, int, int], dict[str, object]] = {}
    paths = sorted(REVIEW_ROOT.glob("manual-review-decisions-*.jsonl"))
    if WORKBENCH_DECISIONS in paths:
        paths.remove(WORKBENCH_DECISIONS)
        paths.append(WORKBENCH_DECISIONS)
    for path in paths:
        try:
            for row in _read_decision_file(path):
                if not all(name in row for name in ("date", "page", "peopleDataOrdinal")):
                    continue
                decision = str(row.get("decision") or row.get("status") or "").lower()
                if decision in {"accept", "reject"}:
                    decisions[_key(row)] = {**row, "decision": decision}
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            logging.exception("Unable to read RMRB decision log %s", path)
    return decisions


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(payload)
    os.replace(temporary, path)


def _portable_decision(row: dict[str, object]) -> dict[str, object]:
    """Keep the remotely recoverable review fields and omit local evidence paths."""
    names = (
        "date", "page", "peopleDataOrdinal", "title", "decision", "content",
        "contentHtml", "reason", "reviewedAt",
    )
    return {name: row[name] for name in names if name in row}


def _build_sync_snapshot() -> tuple[Path, Path, dict[str, object]]:
    rows = [
        _portable_decision(row)
        for _, row in sorted(load_all_decisions().items(), key=lambda item: item[0])
    ]
    clear = b"".join(
        (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        for row in rows
    )
    compressed_buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=compressed_buffer, mode="wb", compresslevel=6, mtime=0) as stream:
        stream.write(clear)
    compressed = compressed_buffer.getvalue()
    artifact = SYNC_ROOT / "review-decisions.jsonl.gz"
    manifest_path = SYNC_ROOT / "review-decisions.manifest.json"
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    manifest: dict[str, object] = {
        "formatVersion": "jojo-rmrb-review-sync/1",
        "generatedAt": generated_at,
        "recordCount": len(rows),
        "sha256": hashlib.sha256(compressed).hexdigest(),
        "object": f"{SYNC_REMOTE_ROOT}/review-decisions.jsonl.gz",
    }
    _atomic_write(artifact, compressed)
    _atomic_write(
        manifest_path,
        (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    )
    return artifact, manifest_path, manifest


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


def _sync_huggingface(
    artifact: Path,
    manifest_path: Path,
    manifest: dict[str, object],
    canonical: CanonicalPatch,
) -> dict[str, object]:
    token = _huggingface_token()
    if not token:
        raise RuntimeError("Hugging Face 未登录且 HF_TOKEN 未配置")
    from huggingface_hub import CommitOperationAdd, HfApi

    repo_id = _huggingface_repo()
    operations = [
        CommitOperationAdd(
            path_in_repo=f"{SYNC_REMOTE_ROOT}/{artifact.name}",
            path_or_fileobj=str(artifact),
        ),
        CommitOperationAdd(
            path_in_repo=f"{SYNC_REMOTE_ROOT}/{manifest_path.name}",
            path_or_fileobj=str(manifest_path),
        ),
    ]
    operations.extend(
        CommitOperationAdd(path_in_repo=name, path_or_fileobj=str(path))
        for name, path in sorted(canonical.files.items())
    )
    commit = HfApi(token=token).create_commit(
        repo_id=repo_id,
        repo_type="dataset",
        operations=operations,
        commit_message=(
            f"Publish {canonical.changed_article_count} reviewed RMRB articles "
            f"and sync {manifest['recordCount']} decisions"
        ),
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
    artifact: Path,
    manifest_path: Path,
    manifest: dict[str, object],
    delivery: DeliveryPatch,
) -> dict[str, object]:
    # Publish immutable fragments first, issue manifests second, and the
    # collection index last so readers never observe dangling references.
    def priority(name: str) -> tuple[int, str]:
        if name.endswith("/index.jox"):
            return 2, name
        if name.endswith("/manifest.jox"):
            return 1, name
        return 0, name

    for name, path in sorted(delivery.files.items(), key=lambda item: priority(item[0])):
        _run_rclone_copyto(path, f"{_b2_remote()}/{name}")
    root = f"{_b2_remote()}/{SYNC_REMOTE_ROOT}"
    _run_rclone_copyto(artifact, f"{root}/{artifact.name}")
    # The manifest is the commit marker and is deliberately written last.
    _run_rclone_copyto(manifest_path, f"{root}/{manifest_path.name}")
    return {
        "remote": root,
        "sha256": manifest["sha256"],
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
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) and page > 0:
        return f"{PEOPLE_DATA_BASE}/{day.replace('-', '')}/{page}"
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
        "status": "local-content-missing",
        "rawRecoveryClass": "本地两份数据均无正文",
        "peopleDataHref": _people_data_href(row),
        "decision": decision,
    }


@rmrb_review_blueprint.get("/api/rmrb-review/queue")
def queue_api():
    if not REVIEW_DB.is_file():
        return jsonify({"success": False, "error": "missing-content workbench index is not built"}), 503
    decisions = load_all_decisions()
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
    if not REVIEW_DB.is_file():
        return jsonify({"success": False, "error": "missing-content workbench index is not built"}), 503
    decisions = load_all_decisions()
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
        "accept": int(handled.get("accept", 0)),
        "reject": int(handled.get("reject", 0)),
    }
    return jsonify({"success": True, "total": total, "counts": counts})


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
            "remotePath": SYNC_REMOTE_ROOT,
            "state": state,
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
    try:
        artifact, manifest_path, manifest = _build_sync_snapshot()
        decisions = load_all_decisions()
        desired = accepted_hashes(decisions)
        publication_state = _load_publication_state()
        publication_targets = publication_state.setdefault("targets", {})
        assert isinstance(publication_targets, dict)

        def published_for(target: str) -> dict[str, str] | None:
            value = publication_targets.get(target)
            if not isinstance(value, dict) or not isinstance(value.get("accepted"), dict):
                return None
            return {str(key): str(digest) for key, digest in value["accepted"].items()}

        hf_published = published_for("huggingface")
        b2_published = published_for("b2")
        hf_names = {
            name for name, digest in desired.items()
            if hf_published is None or hf_published.get(name) != digest
        }
        b2_names = {
            name for name, digest in desired.items()
            if b2_published is not None and b2_published.get(name) != digest
        }
        canonical = _prepare_publication(
            decisions,
            {parse_key(name) for name in hf_names | b2_names},
            {parse_key(name) for name in b2_names},
        )
        if b2_published is None:
            # The original HF and B2 snapshots were published together.  On
            # the first incremental run, only canonical differences discovered
            # above can be outstanding in Delivery.
            b2_names = {"|".join((key[0], str(key[1]), str(key[2]))) for key in canonical.changed_keys}
        if "b2" in targets and canonical.changed_keys and "huggingface" not in targets:
            return jsonify({
                "success": False,
                "error": "B2 修订依赖尚未发布的 HF Canonical；请同时选择 HF",
            }), 409
        delivery = _prepare_delivery(
            decisions,
            canonical,
            {parse_key(name) for name in b2_names},
        ) if "b2" in targets else None
        state = _load_sync_state()
        target_state = state.setdefault("targets", {})
        assert isinstance(target_state, dict)
        results: dict[str, object] = {}
        errors: dict[str, str] = {}
        sync_functions = {
            "huggingface": lambda: _sync_huggingface(
                artifact, manifest_path, manifest, canonical,
            ),
            "b2": lambda: _sync_b2(
                artifact, manifest_path, manifest, delivery or DeliveryPatch(PUBLISH_ROOT),
            ),
        }
        for target in targets:
            if target == "b2" and "huggingface" in errors:
                errors[target] = "HF Canonical 发布失败，已停止 B2 发布以避免数据分叉"
                continue
            try:
                detail = sync_functions[target]()
                results[target] = detail
                target_state[target] = {
                    "syncedAt": manifest["generatedAt"],
                    "recordCount": manifest["recordCount"],
                    "sha256": manifest["sha256"],
                    **detail,
                }
                publication_targets[target] = {"accepted": desired}
                if target == "huggingface" and b2_published is None and "b2" not in targets:
                    changed_names = {
                        "|".join((key[0], str(key[1]), str(key[2])))
                        for key in canonical.changed_keys
                    }
                    publication_targets["b2"] = {
                        "accepted": {
                            name: digest for name, digest in desired.items()
                            if name not in changed_names
                        }
                    }
                _write_publication_state(publication_state)
            except Exception as error:  # Each selected destination is independent.
                logging.exception("Unable to sync RMRB reviews to %s", target)
                errors[target] = str(error)
        state["formatVersion"] = "jojo-rmrb-review-sync-state/1"
        state["lastAttemptAt"] = manifest["generatedAt"]
        _write_sync_state(state)
        response = {
            "success": not errors,
            "recordCount": manifest["recordCount"],
            "acceptedCount": canonical.accepted_count,
            "canonicalChanges": canonical.changed_article_count,
            "publishedChanges": max(
                (int(detail.get("publishedArticles") or 0) for detail in results.values() if isinstance(detail, dict)),
                default=0,
            ),
            "sha256": manifest["sha256"],
            "results": results,
            "errors": errors,
        }
        return jsonify(response), 200 if not errors else 502
    except Exception as error:
        logging.exception("Unable to prepare RMRB review publication")
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
    row: dict[str, object] = {
        "date": key[0],
        "page": key[1],
        "peopleDataOrdinal": key[2],
        "title": source.get("title"),
        "decision": decision,
        "content": content if decision == "accept" else "",
        "reason": reason or ("人工复核确认" if decision == "accept" else "人工复核后拒绝"),
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
    return jsonify({"success": True, "decision": row})
