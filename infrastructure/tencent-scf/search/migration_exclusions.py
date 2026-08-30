"""Apply Reader Search document exclusions and clean revision metadata."""
from __future__ import annotations

from typing import Any, Dict, Iterable


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
