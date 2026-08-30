"""Local, auditable migration files for append-only ES repairs."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from es_repair import KibanaConsoleClient, clean_repair_document, revision_id


MIGRATIONS_DIR = Path(__file__).resolve().parent / "es_migrations"
GENERATED_AT_PREVIEW = "<generated when applied>"


def preview_migration(
    replaced_document_id: str,
    document: dict[str, Any],
    *,
    deleted: bool,
    reason: str,
    index: str,
) -> dict[str, Any]:
    """Build a deterministic, read-only preview for operator confirmation."""
    clean = _clean_document(document)
    migration_id = revision_id(replaced_document_id, clean, deleted)
    migration = {
        "version": 1,
        "id": migration_id,
        "createdAt": GENERATED_AT_PREVIEW,
        "index": index,
        "operation": "delete" if deleted else "repair",
        "replacedDocumentId": replaced_document_id,
        "document": clean,
        "reason": reason.strip(),
        "state": "pending",
    }
    es_payload = {**clean, "@timestamp": GENERATED_AT_PREVIEW}
    if "type" not in clean:
        es_payload["replacedDocumentId"] = replaced_document_id
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
    replaced_document_id: str,
    document: dict[str, Any],
    *,
    deleted: bool,
    reason: str,
    index: str,
    directory: Path = MIGRATIONS_DIR,
) -> dict[str, Any]:
    clean = _clean_document(document)
    migration_id = revision_id(replaced_document_id, clean, deleted)
    path = directory / f"{migration_id}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))

    migration = {
        "version": 1,
        "id": migration_id,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "index": index,
        "operation": "delete" if deleted else "repair",
        "replacedDocumentId": replaced_document_id,
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
        migration.get("replacedDocumentId") or migration["supersedesId"],
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
        replaced_document_id = (
            migration.get("replacedDocumentId") or migration.get("supersedesId")
        )
        if replaced_document_id:
            excluded.add(str(replaced_document_id))
        if migration.get("operation") == "delete":
            tombstone_id = (migration.get("result") or {}).get("documentId")
            excluded.add(str(tombstone_id or migration["id"]))
    return excluded


def search_state_payload(
    indices: list[str],
    directory: Path = MIGRATIONS_DIR,
) -> dict[str, dict[str, list[str]]]:
    """Build the complete remote state consumed by Reader Search."""
    return {
        "excludedIds": {
            index: sorted(excluded_document_ids(index, directory))
            for index in sorted(set(indices))
        }
    }


def write_search_state(
    path: Path,
    indices: list[str],
    directory: Path = MIGRATIONS_DIR,
) -> dict[str, dict[str, list[str]]]:
    """Atomically write the one plain JSON object published to COS."""
    payload = search_state_payload(indices, directory)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    temp.replace(path)
    return payload


def active_revision_heads(
    index: str,
    directory: Path = MIGRATIONS_DIR,
) -> dict[str, str | None]:
    """Resolve every applied repair chain to its current searchable document.

    A value of ``None`` means that the logical document was deleted.  Both the
    original document ID and intermediate repair IDs are included so callers
    can start resolution at any point in a chain.
    """
    edges: dict[str, str | None] = {}
    for migration in list_migrations(directory):
        if migration.get("state") != "applied" or migration.get("index") != index:
            continue
        replaced_document_id = str(
            migration.get("replacedDocumentId") or migration.get("supersedesId") or ""
        ).strip()
        if not replaced_document_id:
            continue
        replacement_id = (
            None
            if migration.get("operation") == "delete"
            else str((migration.get("result") or {}).get("documentId") or migration["id"])
        )
        previous = edges.get(replaced_document_id, replacement_id)
        if replaced_document_id in edges and previous != replacement_id:
            raise ValueError(f"ES migration 出现分叉：{replaced_document_id}")
        edges[replaced_document_id] = replacement_id

    def resolve(start: str) -> str | None:
        current: str | None = start
        visited: set[str] = set()
        while current is not None and current in edges:
            if current in visited:
                raise ValueError(f"ES migration 出现循环：{start}")
            visited.add(current)
            current = edges[current]
        return current

    return {document_id: resolve(document_id) for document_id in edges}


def _safe_path(migration_id: str, directory: Path) -> Path:
    digest = migration_id.removeprefix("repair-")
    if not migration_id.startswith("repair-") or len(digest) != 40 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("非法 migration id")
    path = directory / f"{migration_id}.json"
    if not path.exists():
        raise FileNotFoundError(f"migration 不存在：{migration_id}")
    return path


def _clean_document(document: dict[str, Any]) -> dict[str, Any]:
    return clean_repair_document(document)


def _write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)
