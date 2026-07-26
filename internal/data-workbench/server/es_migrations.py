"""Local, auditable migration files for append-only ES repairs."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from es_repair import KibanaConsoleClient, revision_id


MIGRATIONS_DIR = Path(__file__).resolve().parent / "es_migrations"
GENERATED_AT_PREVIEW = "<generated when applied>"


def preview_migration(
    supersedes_id: str,
    document: dict[str, Any],
    *,
    deleted: bool,
    reason: str,
    index: str,
) -> dict[str, Any]:
    """Build a deterministic, read-only preview for operator confirmation."""
    clean = _clean_document(document)
    migration_id = revision_id(supersedes_id, clean, deleted)
    migration = {
        "version": 1,
        "id": migration_id,
        "createdAt": GENERATED_AT_PREVIEW,
        "index": index,
        "operation": "delete" if deleted else "repair",
        "supersedesId": supersedes_id,
        "document": clean,
        "reason": reason.strip(),
        "state": "pending",
    }
    es_payload = {
        **clean,
        "@timestamp": GENERATED_AT_PREVIEW,
        "supersedesId": supersedes_id,
    }
    canonical = json.dumps(
        {"migration": migration, "esPayload": es_payload},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return {
        "migration": migration,
        "esPayload": es_payload,
        "previewHash": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    }


def create_migration(
    supersedes_id: str,
    document: dict[str, Any],
    *,
    deleted: bool,
    reason: str,
    index: str,
    directory: Path = MIGRATIONS_DIR,
) -> dict[str, Any]:
    clean = _clean_document(document)
    migration_id = revision_id(supersedes_id, clean, deleted)
    path = directory / f"{migration_id}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))

    migration = {
        "version": 1,
        "id": migration_id,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "index": index,
        "operation": "delete" if deleted else "repair",
        "supersedesId": supersedes_id,
        "document": clean,
        "reason": reason.strip(),
        "state": "pending",
    }
    _write(path, migration)
    return migration


def apply_migration(
    migration_id: str,
    *,
    client: KibanaConsoleClient | None = None,
    directory: Path = MIGRATIONS_DIR,
) -> dict[str, Any]:
    path = _safe_path(migration_id, directory)
    migration = json.loads(path.read_text(encoding="utf-8"))
    es_client = client or KibanaConsoleClient()
    if migration["index"] != es_client.config["index"]:
        raise ValueError(
            f"migration 索引为 {migration['index']}，当前配置为 {es_client.config['index']}"
        )
    result = es_client.create_revision(
        migration["supersedesId"],
        migration.get("document") or {},
        deleted=migration["operation"] == "delete",
    )
    migration["state"] = "applied"
    migration["appliedAt"] = datetime.now(timezone.utc).isoformat()
    migration["result"] = result
    _write(path, migration)
    return migration


def list_migrations(directory: Path = MIGRATIONS_DIR) -> list[dict[str, Any]]:
    if not directory.exists():
        return []
    result = []
    for path in directory.glob("repair-*.json"):
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
            item["file"] = path.name
            result.append(item)
        except (OSError, ValueError):
            continue
    return sorted(result, key=lambda item: item.get("createdAt", ""), reverse=True)


def excluded_document_ids(
    index: str,
    directory: Path = MIGRATIONS_DIR,
) -> set[str]:
    """Build the search exclusion set from applied migrations for one index."""
    excluded: set[str] = set()
    for migration in list_migrations(directory):
        if migration.get("state") != "applied" or migration.get("index") != index:
            continue
        supersedes_id = migration.get("supersedesId")
        if supersedes_id:
            excluded.add(str(supersedes_id))
        if migration.get("operation") == "delete":
            tombstone_id = (migration.get("result") or {}).get("documentId")
            excluded.add(str(tombstone_id or migration["id"]))
    return excluded


def _safe_path(migration_id: str, directory: Path) -> Path:
    digest = migration_id.removeprefix("repair-")
    if not migration_id.startswith("repair-") or len(digest) != 40 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("非法 migration id")
    path = directory / f"{migration_id}.json"
    if not path.exists():
        raise FileNotFoundError(f"migration 不存在：{migration_id}")
    return path


def _clean_document(document: dict[str, Any]) -> dict[str, Any]:
    return {
        key: document.get(key)
        for key in ("title", "content", "date", "page", "source")
        if document.get(key) not in (None, "")
    }


def _write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)
