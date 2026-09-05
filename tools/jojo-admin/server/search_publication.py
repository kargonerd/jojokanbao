"""Publish Canonical changes to append-only Elasticsearch and activate them.

New ES documents are written before the COS search state is changed.  During a
failure readers may briefly see both versions, but never lose the only visible
version.  IDs and activation payloads are deterministic, so retries are safe.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Iterable
from urllib.parse import quote

from es_repair import KibanaConsoleClient, clean_repair_document, revision_id
from es_sync import BUSINESS_FIELDS


@dataclass(frozen=True)
class DesiredSearchDocument:
    """Desired searchable value for one stable Canonical identity."""

    base_id: str
    document: dict[str, Any] | None


def normalize_search_state(payload: dict[str, Any]) -> dict[str, Any]:
    excluded = payload.get("excludedIds") if isinstance(payload, dict) else None
    heads = payload.get("heads") if isinstance(payload, dict) else None
    revisions = payload.get("canonicalRevisions") if isinstance(payload, dict) else None
    if not isinstance(excluded, dict):
        raise ValueError("search-state.json 缺少 excludedIds 对象")
    normalized_excluded: dict[str, list[str]] = {}
    for index, values in excluded.items():
        if not isinstance(index, str) or not index or not isinstance(values, list):
            raise ValueError("search-state.json 的 excludedIds 格式错误")
        if any(not isinstance(value, str) or not value for value in values):
            raise ValueError("search-state.json 的 excludedIds 只能包含非空字符串")
        normalized_excluded[index] = sorted(set(values))
    if heads is not None and not isinstance(heads, dict):
        raise ValueError("search-state.json 的 heads 必须是对象")
    normalized_heads: dict[str, dict[str, str | None]] = {}
    for index, values in (heads or {}).items():
        if not isinstance(index, str) or not index or not isinstance(values, dict):
            raise ValueError("search-state.json 的 heads 格式错误")
        normalized_heads[index] = {}
        for base, active in values.items():
            if (
                not isinstance(base, str)
                or not base
                or (active is not None and (not isinstance(active, str) or not active))
            ):
                raise ValueError("search-state.json 的版本头必须是非空 ID 或 null")
            normalized_heads[index][base] = active
    if revisions is not None and not isinstance(revisions, dict):
        raise ValueError("search-state.json 的 canonicalRevisions 必须是对象")
    normalized_revisions: dict[str, dict[str, str]] = {}
    for index, values in (revisions or {}).items():
        if not isinstance(index, str) or not index or not isinstance(values, dict):
            raise ValueError("search-state.json 的 canonicalRevisions 格式错误")
        normalized_revisions[index] = {}
        for scope, revision in values.items():
            if not isinstance(scope, str) or not scope or not isinstance(revision, str) or not revision:
                raise ValueError("search-state.json 的 Canonical revision 必须是非空字符串")
            normalized_revisions[index][scope] = revision
    return {
        "formatVersion": "jojo-search-state/2",
        "excludedIds": normalized_excluded,
        "heads": normalized_heads,
        "canonicalRevisions": normalized_revisions,
    }


class AppendOnlySearchPublisher:
    """Create desired ES versions, returning a separate COS activation plan."""

    def __init__(
        self,
        client: KibanaConsoleClient,
        index: str,
        remote_state: dict[str, Any],
        *,
        fallback_heads: dict[str, str | None] | None = None,
    ) -> None:
        self.client = client
        self.index = index
        self.state = normalize_search_state(remote_state)
        self.heads = dict(fallback_heads or {})
        self.heads.update(self.state["heads"].get(index, {}))

    def publish(
        self,
        desired: Iterable[DesiredSearchDocument],
        *,
        scope: str,
        canonical_revision: str,
    ) -> dict[str, Any]:
        rows = sorted(desired, key=lambda row: row.base_id)
        if len({row.base_id for row in rows}) != len(rows):
            raise ValueError("搜索发布计划包含重复 base ID")
        active_ids = [
            active
            for row in rows
            if (active := self.heads.get(row.base_id, row.base_id)) is not None
        ]
        existing = self._existing(active_ids)
        created = 0
        unchanged = 0
        excluded: set[str] = set()
        expected_heads: dict[str, str | None] = {}
        desired_heads: dict[str, str | None] = {}

        for row in rows:
            active_id = self.heads.get(row.base_id, row.base_id)
            expected_heads[row.base_id] = active_id
            current = existing.get(active_id) if active_id is not None else None
            if row.document is None:
                desired_heads[row.base_id] = None
                if active_id is not None:
                    excluded.add(active_id)
                unchanged += 1
                continue

            if current is not None and _same_business_document(current, row.document):
                desired_heads[row.base_id] = active_id
                unchanged += 1
                continue

            if active_id == row.base_id and current is None:
                target_id = row.base_id
                document = row.document
            else:
                replaced_id = active_id or row.base_id
                clean = clean_repair_document(row.document)
                target_id = revision_id(replaced_id, clean, False)
                document = {**clean, "@timestamp": row.document.get("@timestamp")}
                excluded.add(replaced_id)
            if self._create(target_id, document):
                created += 1
            else:
                unchanged += 1
            desired_heads[row.base_id] = target_id

        return {
            "index": self.index,
            "scope": scope,
            "canonicalRevision": canonical_revision,
            "examined": len(rows),
            "created": created,
            "unchanged": unchanged,
            "activation": {
                "expectedHeads": expected_heads,
                # Base IDs are implicit. Persist only revisions/deletions so
                # ordinary inserts do not make search-state grow with the
                # entire corpus.
                "heads": {
                    base_id: active_id
                    for base_id, active_id in desired_heads.items()
                    if active_id != base_id
                },
                "excludedIds": sorted(excluded),
            },
        }

    def _existing(self, document_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
        values = sorted(set(document_ids))
        if not values:
            return {}
        status, payload = self.client.request("POST", f"{self.index}/_search", {
            "size": len(values),
            "track_total_hits": False,
            "query": {"ids": {"values": values}},
        })
        if status >= 400:
            raise RuntimeError(f"查询既有 ES 文档失败：{payload}")
        return {
            str(hit.get("_id")): hit.get("_source") or {}
            for hit in ((payload.get("hits") or {}).get("hits") or [])
        }

    def _create(self, document_id: str, document: dict[str, Any]) -> bool:
        existing = self._existing([document_id]).get(document_id)
        if existing is not None:
            if _same_business_document(existing, document):
                return False
            raise ValueError(f"确定性 ES ID 已存在但内容不同：{document_id}")
        status, payload = self.client.request(
            "POST",
            f"{self.index}/_create/{quote(document_id, safe='')}",
            document,
        )
        if status == 409:
            existing = self._existing([document_id]).get(document_id)
            if existing is not None and _same_business_document(existing, document):
                return False
        if status >= 400:
            raise RuntimeError(f"写入 ES 文档失败 {document_id}：{payload}")
        return True


def activate_search_publication(
    remote: dict[str, Any],
    publication: dict[str, Any],
) -> dict[str, Any]:
    """Apply one publication with optimistic head checks and monotonic excludes."""
    state = normalize_search_state(remote)
    index = str(publication["index"])
    activation = publication["activation"]
    current_heads = state["heads"].setdefault(index, {})
    for base_id, expected in activation["expectedHeads"].items():
        has_remote_head = base_id in current_heads
        current = current_heads.get(base_id, base_id)
        target = activation["heads"].get(base_id, base_id)
        if (
            not has_remote_head
            and expected != base_id
            and base_id in state["excludedIds"].get(index, [])
        ):
            # Bootstrap v1 state from the audited local migration chain. The
            # excluded base proves the remote state already activated a repair
            # even though v1 did not record its head.
            current = expected
        if current not in {expected, target}:
            raise ValueError(
                f"搜索版本头已被其他发布修改：{base_id}（期望 {expected}，当前 {current}）"
            )
    for base_id in activation["expectedHeads"]:
        target = activation["heads"].get(base_id, base_id)
        if target == base_id:
            current_heads.pop(base_id, None)
        else:
            current_heads[base_id] = target
    excluded = set(state["excludedIds"].setdefault(index, []))
    excluded.update(activation["excludedIds"])
    state["excludedIds"][index] = sorted(excluded)
    state["canonicalRevisions"].setdefault(index, {})[
        str(publication["scope"])
    ] = str(publication["canonicalRevision"])
    return state


def publish_search_activation(
    publication: dict[str, Any],
    *,
    loader: Callable[[], dict[str, Any]],
    uploader: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    remote = loader()
    payload = activate_search_publication(remote, publication)
    uploader(payload)
    index = str(publication["index"])
    return {
        "index": index,
        "scope": publication["scope"],
        "canonicalRevision": publication["canonicalRevision"],
        "excluded": len(payload["excludedIds"].get(index, [])),
        "heads": len(payload["heads"].get(index, {})),
    }


def _same_business_document(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return all(left.get(field) == right.get(field) for field in BUSINESS_FIELDS)
