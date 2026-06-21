import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib import error, request

from search_overlay import (
    build_patch_state,
    build_search_query,
    iter_rmrb_markdown_docs,
    merge_search_hits,
    runtime_path,
)


DEFAULT_RMRB_ROOT = r"D:\Cloud\OneDrive\jojokanbao\rmrb-master"
DEFAULT_PREFIX = "jojo-rmrb-overlay-test"
PATCH_TOKEN = "OverlayUniqueToken"


class EsHttpClient:
    def __init__(self, url: str, username: Optional[str], password: Optional[str]) -> None:
        self.url = url.rstrip("/")
        self.auth_header = None
        if username and password:
            token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
            self.auth_header = f"Basic {token}"

    def request(self, method: str, path: str, body: Optional[Any] = None) -> Dict[str, Any]:
        url = f"{self.url}/{path.lstrip('/')}"
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            if isinstance(body, bytes):
                data = body
                headers["Content-Type"] = "application/x-ndjson"
            else:
                data = json.dumps(body, ensure_ascii=False).encode("utf-8")
                headers["Content-Type"] = "application/json"
        if self.auth_header:
            headers["Authorization"] = self.auth_header

        req = request.Request(url, data=data, headers=headers, method=method)
        try:
            with request.urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8")
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ES HTTP {exc.code} {method} {path}: {detail}") from exc
        if not raw:
            return {}
        return json.loads(raw)

    def create_index(self, index: str) -> None:
        mapping = {
            "mappings": {
                "properties": {
                    "logicalId": {"type": "keyword"},
                    "version": {"type": "integer"},
                    "deleted": {"type": "boolean"},
                    "title": {
                        "type": "text",
                        "fields": {"keyword": {"type": "keyword", "ignore_above": 32766}},
                    },
                    "content": {
                        "type": "text",
                        "fields": {"keyword": {"type": "keyword", "ignore_above": 32766}},
                    },
                    "date": {"type": "date"},
                    "page": {"type": "integer"},
                    "source": {"type": "keyword"},
                    "sourcePath": {"type": "keyword"},
                    "updatedAt": {"type": "date"},
                }
            }
        }
        self.request("PUT", index, mapping)

    def bulk_create(self, index: str, docs: List[Dict[str, Any]]) -> None:
        lines: List[str] = []
        for doc in docs:
            lines.append(json.dumps({"create": {}}, ensure_ascii=False))
            lines.append(json.dumps(doc, ensure_ascii=False))
        payload = ("\n".join(lines) + "\n").encode("utf-8")
        result = self.request("POST", f"{index}/_bulk?refresh=true", payload)
        if result.get("errors"):
            failed = [
                item
                for item in result.get("items", [])
                if item.get("create", {}).get("error")
            ][:3]
            raise RuntimeError(f"bulk create returned errors: {json.dumps(failed, ensure_ascii=False)}")

    def search(self, index: str, body: Dict[str, Any]) -> Dict[str, Any]:
        return self.request("POST", f"{index}/_search", body)


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def make_patch_docs(base_docs: List[Dict[str, Any]], query: str) -> List[Dict[str, Any]]:
    update_doc = next((doc for doc in base_docs if query in doc.get("content", "")), base_docs[0])
    delete_doc = next(
        (
            doc
            for doc in base_docs
            if doc["logicalId"] != update_doc["logicalId"] and query in doc.get("content", "")
        ),
        base_docs[-1],
    )

    updated = dict(update_doc)
    updated["version"] = 2
    updated["title"] = "[修正版] " + updated["title"]
    updated["content"] = updated["content"] + f"\n\n{PATCH_TOKEN}"

    tombstone = {
        "logicalId": delete_doc["logicalId"],
        "version": 2,
        "deleted": True,
        "title": delete_doc["title"],
        "date": delete_doc["date"],
        "page": delete_doc["page"],
        "content": "",
        "source": delete_doc["source"],
        "sourcePath": delete_doc["sourcePath"],
    }
    return [updated, tombstone]


def create_and_verify(args: argparse.Namespace) -> int:
    root = Path(args.root)
    if not root.exists():
        raise RuntimeError(f"RMRB root does not exist: {root}")

    base_docs = list(iter_rmrb_markdown_docs(root, limit=args.limit))
    if len(base_docs) < 2:
        raise RuntimeError("Need at least two sample docs to verify update and delete behavior")

    delta_docs = make_patch_docs(base_docs, args.query)
    patch_state = build_patch_state(delta_docs)

    suffix = time.strftime("%Y%m%d%H%M%S")
    base_index = f"{args.prefix}-base-{suffix}"
    delta_index = f"{args.prefix}-delta-{suffix}"

    client = EsHttpClient(
        require_env("ELASTICSEARCH_URL"),
        os.environ.get("ELASTICSEARCH_USERNAME"),
        os.environ.get("ELASTICSEARCH_PASSWORD"),
    )

    print(f"creating {base_index}")
    client.create_index(base_index)
    print(f"creating {delta_index}")
    client.create_index(delta_index)
    print(f"indexing {len(base_docs)} base docs")
    client.bulk_create(base_index, base_docs)
    print(f"indexing {len(delta_docs)} delta docs")
    client.bulk_create(delta_index, delta_docs)

    state_path = runtime_path("patch-state-test.json")
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(patch_state, ensure_ascii=False, indent=2), encoding="utf-8")

    query_body = build_search_query(
        args.query,
        from_num=0,
        size=args.fetch_size,
        sort_order=args.sort,
    )
    base_hits = client.search(base_index, query_body)["hits"]["hits"]
    delta_hits = client.search(delta_index, query_body)["hits"]["hits"]
    total, merged = merge_search_hits(base_hits, delta_hits, patch_state, offset=0, size=args.size)

    token_body = build_search_query(PATCH_TOKEN, from_num=0, size=args.fetch_size)
    token_delta_hits = client.search(delta_index, token_body)["hits"]["hits"]
    token_total, token_merged = merge_search_hits([], token_delta_hits, patch_state, offset=0, size=args.size)

    print()
    print("test indices")
    print(f"  base : {base_index}")
    print(f"  delta: {delta_index}")
    print(f"  patch state: {state_path}")
    print()
    print(f"merged query={args.query!r} total={total} returned={len(merged)}")
    for idx, doc in enumerate(merged[:5], start=1):
        deleted = " deleted" if doc.get("deleted") else ""
        print(f"  {idx}. v{doc.get('version')} {doc.get('date')} p{doc.get('page')} {doc.get('title')!r}{deleted}")
    print()
    print(f"delta-only token query={PATCH_TOKEN!r} total={token_total} returned={len(token_merged)}")
    for idx, doc in enumerate(token_merged[:3], start=1):
        print(f"  {idx}. v{doc.get('version')} {doc.get('logicalId')}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a small base/delta Elasticsearch test index for RMRB overlay search.")
    parser.add_argument("--root", default=os.environ.get("RMRB_ROOT", DEFAULT_RMRB_ROOT))
    parser.add_argument("--prefix", default=os.environ.get("SEARCH_TEST_PREFIX", DEFAULT_PREFIX))
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--query", default="黄河")
    parser.add_argument("--size", type=int, default=10)
    parser.add_argument("--fetch-size", type=int, default=80)
    parser.add_argument("--sort", default="")
    args = parser.parse_args()

    try:
        return create_and_verify(args)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
