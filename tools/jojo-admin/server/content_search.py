"""Local unified-content search backed by the configured Kibana Console proxy."""
from __future__ import annotations

import hashlib
import os
from typing import Any

from es_repair import KibanaConsoleClient, repair_config
from es_repair import active_query
from es_migrations import excluded_document_ids


def _filter_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _strings(value: Any, limit: int = 100) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value[:limit] if isinstance(item, str) and item]


def search_content(payload: dict[str, Any], client: KibanaConsoleClient | None = None) -> dict[str, Any]:
    query_text = str(payload.get("query") or "").strip()
    if not query_text:
        raise ValueError("搜索词为空")
    try:
        size = max(1, min(int(payload.get("size") or 8), 20))
    except (TypeError, ValueError) as exc:
        raise ValueError("size 参数错误") from exc

    index = os.getenv("ES_CONTENT_INDEX", "jojo-content-v1")
    release_id = os.getenv("ES_CONTENT_RELEASE_ID", "").strip()
    filters: list[dict[str, Any]] = []
    dataset_ids = _strings(payload.get("datasetIds"))
    item_ids = _strings(payload.get("itemIds"))
    document_types = _strings(payload.get("types"))
    sources = _strings(payload.get("sources"))
    if release_id:
        filters.append({"term": {"releaseId": release_id}})
        if dataset_ids:
            filters.append({"terms": {"datasetFilterKey": [_filter_key(value) for value in dataset_ids]}})
        if item_ids:
            filters.append({"terms": {"itemFilterKey": [_filter_key(value) for value in item_ids]}})
    else:
        if dataset_ids:
            filters.append({"terms": {"datasetId": dataset_ids}})
        if item_ids:
            filters.append({"terms": {"itemId": item_ids}})
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
