"""Local unified-content search backed by the configured Kibana Console proxy."""
from __future__ import annotations

import os
from typing import Any

from es_repair import KibanaConsoleClient, repair_config
from es_repair import active_query
from es_migrations import excluded_document_ids

def _strings(value: Any, limit: int = 100) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value[:limit] if isinstance(item, str) and item]


def _identity_filter(field: str, values: list[str]) -> dict[str, Any]:
    """Match IDs on both the intended keyword mapping and old dynamic text mappings."""
    return {"bool": {
        "should": [
            {"terms": {field: values}},
            *({"match_phrase": {field: value}} for value in values),
        ],
        "minimum_should_match": 1,
    }}


def search_content(payload: dict[str, Any], client: KibanaConsoleClient | None = None) -> dict[str, Any]:
    query_text = str(payload.get("query") or "").strip()
    if not query_text:
        raise ValueError("搜索词为空")
    try:
        size = max(1, min(int(payload.get("size") or 8), 20))
    except (TypeError, ValueError) as exc:
        raise ValueError("size 参数错误") from exc

    index = os.getenv("ES_CONTENT_INDEX", "jojo-content-v1")
    filters: list[dict[str, Any]] = []
    dataset_ids = _strings(payload.get("datasetIds"))
    item_ids = _strings(payload.get("itemIds"))
    document_types = _strings(payload.get("types"))
    sources = _strings(payload.get("sources"))
    if dataset_ids:
        filters.append(_identity_filter("datasetId", dataset_ids))
    if item_ids:
        filters.append(_identity_filter("itemId", item_ids))
    if document_types:
        filters.append({"terms": {"type": document_types}})
    if sources:
        filters.append({"bool": {
            "should": [{"match_phrase": {"source": value}} for value in sources],
            "minimum_should_match": 1,
        }})

    query: dict[str, Any] = {
        "bool": {
            "must": [{"multi_match": {
                "query": query_text,
                "fields": [
                    "title^4", "content",  # jojo-search/1
                    "datasetTitle^4", "itemTitle^4", "targetTitle^3", "text",  # legacy book chunks
                ],
                "type": "best_fields",
                "operator": "and",
            }}],
            "should": [
                {"match_phrase": {"content": {"query": query_text, "boost": 8}}},
                {"match_phrase": {"text": {"query": query_text, "boost": 8}}},
            ],
            "filter": filters,
        }
    }
    excluded = excluded_document_ids(index)
    if excluded:
        query = active_query(query, excluded)
    body = {
        "size": min(size * 5, 100),
        "_source": [
            "type", "title", "content", "date", "source", "metadata",
            "datasetId", "datasetTitle", "itemId", "itemTitle", "itemType",
            "targetId", "targetTitle", "chunkId", "order", "text", "authors",
            "publishedDate", "manifestObject", "fragmentObject",
        ],
        "query": query,
        "highlight": {
            "fields": {
                "content": {"fragment_size": 260, "number_of_fragments": 2},
                "text": {"fragment_size": 260, "number_of_fragments": 2},
            },
            "pre_tags": ["<mark>"],
            "post_tags": ["</mark>"],
        },
    }
    if client is None:
        config = repair_config()
        config["index"] = index
        client = KibanaConsoleClient(config)
    status, data = client.request("POST", f"{index}/_search", body)
    if status >= 400:
        raise RuntimeError(f"内容搜索失败：{data}")
    hits = data.get("hits") or {}
    results: list[dict[str, Any]] = []
    seen_fragments: set[str] = set()
    for hit in hits.get("hits") or []:
        source = hit.get("_source") or {}
        if dataset_ids and source.get("datasetId") not in dataset_ids:
            continue
        if item_ids and source.get("itemId") not in item_ids:
            continue
        fragment_object = source.get("fragmentObject")
        if fragment_object and fragment_object in seen_fragments:
            continue
        if fragment_object:
            seen_fragments.add(fragment_object)
        results.append({
            **source,
            "documentId": hit.get("_id"),
            "score": hit.get("_score"),
            "highlights": (
                (hit.get("highlight") or {}).get("content")
                or (hit.get("highlight") or {}).get("text")
                or []
            ),
        })
        if len(results) >= size:
            break
    total = hits.get("total") or 0
    if isinstance(total, dict):
        total = total.get("value", 0)
    return {"data": {"total": total, "results": results}}
