import json
import os
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


PRE_TAG = "@highlight@"
POST_TAG = "@/highlight@"


def process_keyword(keyword: str) -> str:
    keyword = re.sub(r"\band\b", "AND", keyword, flags=re.IGNORECASE)
    keyword = re.sub(r"\bor\b", "OR", keyword, flags=re.IGNORECASE)
    keyword = re.sub(r"\bnot\b", "NOT", keyword, flags=re.IGNORECASE)
    return keyword.replace("“", '"').replace("”", '"').replace("‘", '"').replace("’", '"')


def is_quoted_only_query(query: str) -> bool:
    return bool(re.match(r'^"[^"]+"$', query))


def get_sort_query(sort_order: Optional[str]) -> Optional[Dict[str, Dict[str, str]]]:
    if sort_order == "timeAsc":
        return {"date": {"order": "asc"}}
    if sort_order == "timeDesc":
        return {"date": {"order": "desc"}}
    return None


def build_search_query(
    keyword: str,
    *,
    from_num: int,
    size: int,
    source: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    sort_order: Optional[str] = None,
) -> Dict[str, Any]:
    query_str = process_keyword(keyword)
    if source:
        query_str += " AND source:" + source

    highlight = {
        "fields": {
            "title": {},
            "content": {},
        },
        "fragment_size": 2147483647,
        "pre_tags": PRE_TAG,
        "post_tags": POST_TAG,
    }

    if is_quoted_only_query(query_str):
        quoted_text = query_str[1:-1]
        query_clause: Dict[str, Any] = {
            "bool": {
                "should": [
                    {"wildcard": {"title.keyword": f"*{quoted_text}*"}},
                    {"wildcard": {"content.keyword": f"*{quoted_text}*"}},
                ],
                "minimum_should_match": 1,
            }
        }
    else:
        query_clause = {
            "query_string": {
                "query": query_str,
                "fields": ["title^2", "content"],
            }
        }

    if start_date and end_date:
        date_range_query = {
            "range": {
                "date": {
                    "gte": start_date,
                    "lte": end_date,
                }
            }
        }
        query_clause = {
            "bool": {
                "must": [
                    query_clause,
                    date_range_query,
                ]
            }
        }

    body: Dict[str, Any] = {
        "query": query_clause,
        "highlight": highlight,
        "from": from_num,
        "size": size,
    }
    sort_query = get_sort_query(sort_order)
    if sort_query:
        body["sort"] = sort_query
    return body


def rmrb_logical_id(root: Path, markdown_path: Path) -> str:
    rel = markdown_path.relative_to(root).as_posix()
    return f"rmrb:{rel}"


def parse_rmrb_markdown(markdown_path: Path, root: Path, *, version: int = 1) -> Dict[str, Any]:
    markdown = markdown_path.read_text(encoding="utf-8")
    pattern = r"###\s*([\s\S]+?)(\d{4}-\d{2}-\d{2})\s*第(\d*?)版.*\s*?专栏：\s*([\s\S]+)$"
    match = re.search(pattern, markdown)
    if not match:
        raise ValueError(f"Unsupported RMRB markdown format: {markdown_path}")

    title = match.group(1).strip()
    date = match.group(2)
    page_raw = match.group(3)
    content = match.group(4).strip()
    return {
        "logicalId": rmrb_logical_id(root, markdown_path),
        "version": version,
        "deleted": False,
        "title": title,
        "date": date,
        "page": int(page_raw) if page_raw else 0,
        "content": content,
        "source": "rmrb",
        "sourcePath": markdown_path.relative_to(root).as_posix(),
    }


def iter_rmrb_markdown_docs(root: Path, *, limit: Optional[int] = None) -> Iterable[Dict[str, Any]]:
    article_root = root / "7z"
    count = 0
    for directory in sorted(path for path in article_root.iterdir() if path.is_dir()):
        for path in sorted(directory.glob("*.md")):
            yield parse_rmrb_markdown(path, root)
            count += 1
            if limit is not None and count >= limit:
                return


def hit_to_result(hit: Dict[str, Any]) -> Dict[str, Any]:
    source = dict(hit.get("_source") or {})
    source.pop("@timestamp", None)
    highlight = hit.get("highlight") or {}
    title = highlight.get("title")
    if title:
        source["title"] = title[0]
    content = highlight.get("content")
    if content:
        source["content"] = content[0]
    source["_score"] = hit.get("_score") or 0
    return source


def _state_for_doc(doc: Dict[str, Any], patch_state: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    logical_id = doc.get("logicalId")
    if not logical_id:
        return {}
    return patch_state.get(logical_id) or {}


def merge_search_hits(
    base_hits: List[Dict[str, Any]],
    delta_hits: List[Dict[str, Any]],
    patch_state: Optional[Dict[str, Dict[str, Any]]] = None,
    *,
    offset: int,
    size: int,
) -> Tuple[int, List[Dict[str, Any]]]:
    patch_state = patch_state or {}
    by_logical_id: Dict[str, Dict[str, Any]] = {}
    anonymous: List[Dict[str, Any]] = []

    for hit in [*delta_hits, *base_hits]:
        doc = hit_to_result(hit)
        logical_id = doc.get("logicalId")
        if not logical_id:
            anonymous.append(doc)
            continue

        state = _state_for_doc(doc, patch_state)
        if state.get("deleted"):
            continue

        latest_version = state.get("version") or state.get("latestVersion")
        if latest_version is not None and int(doc.get("version") or 0) < int(latest_version):
            continue

        previous = by_logical_id.get(logical_id)
        if previous is None:
            by_logical_id[logical_id] = doc
            continue

        current_score = float(doc.get("_score") or 0)
        previous_score = float(previous.get("_score") or 0)
        current_version = int(doc.get("version") or 0)
        previous_version = int(previous.get("version") or 0)
        if current_version > previous_version or (
            current_version == previous_version and current_score > previous_score
        ):
            by_logical_id[logical_id] = doc

    merged = [*by_logical_id.values(), *anonymous]
    merged.sort(
        key=lambda item: (
            float(item.get("_score") or 0),
            int(item.get("version") or 0),
            str(item.get("date") or ""),
        ),
        reverse=True,
    )
    total = len(merged)
    return total, merged[offset : offset + size]


def build_patch_state(docs: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    state: Dict[str, Dict[str, Any]] = {}
    for doc in docs:
        logical_id = doc.get("logicalId")
        if not logical_id:
            continue
        version = int(doc.get("version") or 0)
        previous = state.get(logical_id)
        if previous is None or version >= int(previous.get("version") or 0):
            state[logical_id] = {
                "version": version,
                "deleted": bool(doc.get("deleted")),
            }
    return state


def load_patch_state_file(path: Optional[str]) -> Dict[str, Dict[str, Any]]:
    if not path:
        return {}
    patch_path = Path(path)
    if not patch_path.exists():
        return {}
    data = json.loads(patch_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"Patch state must be a JSON object: {patch_path}")
    return data


def runtime_path(*parts: str) -> Path:
    base = Path(os.environ.get("READER_SEARCH_RUNTIME_DIR", ".runtime"))
    return base.joinpath(*parts)
