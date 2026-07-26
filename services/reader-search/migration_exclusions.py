"""Build Reader Search document exclusions from reviewed migrations."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Iterable, Set


INTERNAL_REVISION_FIELDS = {
    "isRevision",
    "supersedesId",
    "replacedDocumentId",
    "deleted",
}


def build_active_query(
    query_clause: Dict[str, Any],
    excluded_ids: Iterable[str],
) -> Dict[str, Any]:
    """Wrap a query with IDs excluded by reviewed migrations."""
    ids = sorted({str(value) for value in excluded_ids if value})
    wrapped: Dict[str, Any] = {"must": [query_clause]}
    if ids:
        wrapped["must_not"] = [{"ids": {"values": ids}}]
    return {"bool": wrapped}


def load_excluded_ids(directory: Path, index: str) -> Set[str]:
    """Load applied migration exclusions for one ES index."""
    excluded: Set[str] = set()
    if not directory.exists():
        return excluded
    for path in directory.glob("repair-*.json"):
        try:
            migration = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if migration.get("state") != "applied" or migration.get("index") != index:
            continue
        replaced_document_id = (
            migration.get("replacedDocumentId") or migration.get("supersedesId")
        )
        if replaced_document_id:
            excluded.add(str(replaced_document_id))
        if migration.get("operation") == "delete":
            result_id = (migration.get("result") or {}).get("documentId")
            excluded.add(str(result_id or migration["id"]))
    return excluded


def hit_to_active_result(hit: Dict[str, Any]) -> Dict[str, Any]:
    source = dict(hit.get("_source") or {})
    source.pop("@timestamp", None)
    for field in INTERNAL_REVISION_FIELDS:
        source.pop(field, None)
    source["documentId"] = hit.get("_id")

    highlight = hit.get("highlight") or {}
    title = highlight.get("title")
    if title:
        source["title"] = title[0]
    content = highlight.get("content")
    if content:
        source["content"] = content[0]
    return source
