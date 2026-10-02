"""Apply Reader Search document exclusions."""
from __future__ import annotations

from typing import Any, Dict, Iterable


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
