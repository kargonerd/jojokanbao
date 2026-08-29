"""Synchronize JOJO Canonical content from Hugging Face into Elasticsearch.

The indexed business document is intentionally small and shared by books,
newspapers, and current news::

    type, title, content, date, source, metadata

``@timestamp`` is added only because Tencent ES Serverless stores the target as
a data stream.  ``metadata`` is stored but disabled in the mapping, so
type-specific navigation data cannot create an unbounded mapping.

All writes use ``_create`` with a stable logical ID.  Re-running a sync is
idempotent; if an existing ID has different content, the sync stops and asks
the operator to use the audited append-only repair workflow.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
import gzip
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
from typing import Any, Callable, Iterable, Iterator, Sequence

from es_repair import KibanaConsoleClient, _load_root_env, repair_config


DEFAULT_HF_REPO = "luoxiaozhuang/marxism-dataset"
DOCUMENT_TYPES = ("book", "newspaper", "news")
BUSINESS_FIELDS = ("type", "title", "content", "date", "source", "metadata")

UNIFIED_MAPPING: dict[str, Any] = {
    "_meta": {"jojoSchema": "jojo-search/1"},
    "dynamic": "strict",
    "properties": {
        "@timestamp": {"type": "date"},
        "type": {"type": "keyword"},
        "title": {
            "type": "text",
            "fields": {"keyword": {"type": "keyword", "ignore_above": 512}},
        },
        "content": {"type": "text"},
        "date": {"type": "date", "ignore_malformed": True},
        "source": {"type": "keyword"},
        "metadata": {"type": "object", "enabled": False},
    },
}


class _PlainTextParser(HTMLParser):
    BLOCKS = {
        "address", "article", "aside", "blockquote", "br", "div", "figcaption",
        "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
        "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table",
        "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag: str, _attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript"}:
            self.hidden += 1
        elif not self.hidden and tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self.hidden:
            self.hidden -= 1
        elif not self.hidden and tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.parts.append(data)


def plain_text(value: Any, body_format: str = "text") -> str:
    text = str(value or "")
    if body_format == "html":
        parser = _PlainTextParser()
        parser.feed(text)
        parser.close()
        text = "".join(parser.parts)
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line).strip()


def _required(value: Any, field: str) -> str:
    result = str(value or "").strip()
    if not result:
        raise ValueError(f"ES 文档缺少 {field}")
    return result


def _optional_date(value: Any) -> str | None:
    result = str(value or "").strip()
    if not result:
        return None
    candidate = result[:10]
    try:
        datetime.strptime(candidate, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError(f"ES 文档日期无效：{result}") from exc
    return result


def _json_value(value: Any) -> Any:
    # Round-trip once so callers cannot pass Path, datetime, or another value
    # that would fail much later inside a bulk request.
    return json.loads(json.dumps(value, ensure_ascii=False))


def unified_document(
    *,
    document_type: str,
    title: Any,
    content: Any,
    source: Any,
    metadata: dict[str, Any],
    date: Any = None,
    timestamp: str | None = None,
) -> dict[str, Any]:
    if document_type not in DOCUMENT_TYPES:
        raise ValueError(f"不支持的 ES 文档类型：{document_type}")
    clean_date = _optional_date(date)
    result = {
        "@timestamp": timestamp or clean_date or datetime.now(timezone.utc).isoformat(),
        "type": document_type,
        "title": _required(title, "title"),
        "content": _required(content, "content"),
        "source": _required(source, "source"),
        "metadata": _json_value(metadata),
    }
    if clean_date:
        result["date"] = clean_date
    return result


def stable_document_id(document_type: str, *identity: Any) -> str:
    canonical = json.dumps(
        [document_type, *(str(value) for value in identity)],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:40]
    return f"jojo-{document_type}-{digest}"


@dataclass(frozen=True)
class IndexedDocument:
    document_id: str
    document: dict[str, Any]


def book_documents(
    collection: dict[str, Any],
    item: dict[str, Any],
    *,
    canonical_object: str,
) -> Iterator[IndexedDocument]:
    dataset_id = _required(item.get("datasetId") or collection.get("datasetId"), "datasetId")
    item_id = _required(item.get("itemId"), "itemId")
    item_title = _required(item.get("title") or collection.get("title"), "itemTitle")
    collection_title = _required(collection.get("title") or item_title, "collectionTitle")
    item_metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    published_date = item_metadata.get("publishedDate")
    chapters = ((item.get("content") or {}).get("chapters") or [])
    for position, chapter in enumerate(chapters, start=1):
        if not isinstance(chapter, dict):
            continue
        chapter_id = _required(chapter.get("id"), "chapterId")
        body = chapter.get("body") if isinstance(chapter.get("body"), dict) else {}
        content = plain_text(body.get("value"), str(body.get("format") or "text"))
        if not content:
            continue
        metadata = {
            "datasetId": dataset_id,
            "itemId": item_id,
            "itemTitle": item_title,
            "chapterId": chapter_id,
            "chapterOrder": int(chapter.get("order") or position),
            "authors": item_metadata.get("authors") or [],
            "publisher": item_metadata.get("publisher"),
            "language": item.get("language") or collection.get("language"),
            "canonicalObject": canonical_object,
        }
        yield IndexedDocument(
            stable_document_id("book", dataset_id, item_id, chapter_id),
            unified_document(
                document_type="book",
                title=chapter.get("title") or item_title,
                content=content,
                date=published_date,
                source=collection_title,
                metadata=metadata,
            ),
        )


def newspaper_document(
    row: dict[str, Any],
    *,
    publication_id: str,
    publication_title: str,
    canonical_object: str,
) -> IndexedDocument | None:
    if str(row.get("status") or "") != "available":
        return None
    content = plain_text(row.get("content"))
    if not content:
        return None
    date = _required(row.get("date"), "date")
    page = int(row.get("page") or 0)
    ordinal = int(row.get("ordinal") or 0)
    return IndexedDocument(
        stable_document_id("newspaper", publication_id, date, page, ordinal),
        unified_document(
            document_type="newspaper",
            title=row.get("title"),
            content=content,
            date=date,
            source=publication_title,
            metadata={
                "publicationId": publication_id,
                "page": page,
                "ordinal": ordinal,
                "pdf": row.get("pdf"),
                "canonicalObject": canonical_object,
            },
        ),
    )


def news_document(article: dict[str, Any], *, canonical_object: str) -> IndexedDocument | None:
    if str(article.get("contentStatus") or "") != "full":
        return None
    body = article.get("body") if isinstance(article.get("body"), dict) else {}
    content = plain_text(body.get("value"), str(body.get("format") or "text"))
    if not content:
        return None
    source = article.get("source") if isinstance(article.get("source"), dict) else {}
    source_id = _required(source.get("id"), "source.id")
    article_id = _required(article.get("articleId"), "articleId")
    published_at = _required(article.get("publishedAt"), "publishedAt")
    return IndexedDocument(
        stable_document_id("news", source_id, article_id),
        unified_document(
            document_type="news",
            title=article.get("title"),
            content=content,
            date=published_at,
            source=source.get("name") or source_id,
            metadata={
                "sourceId": source_id,
                "articleId": article_id,
                "url": article.get("canonicalUrl"),
                "authors": article.get("authors") or [],
                "language": article.get("language"),
                "updatedAt": article.get("updatedAt"),
                "publisherCategories": article.get("publisherCategories") or [],
                "publisherSections": article.get("publisherSections") or [],
                "canonicalObject": canonical_object,
            },
        ),
    )


def latest_news_references(
    date_indexes: Iterable[tuple[str, dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Select one current Canonical object for each logical news article."""
    selected: dict[str, tuple[tuple[str, str, str], dict[str, Any]]] = {}
    for date_path, date_index in date_indexes:
        index_updated_at = str(date_index.get("updatedAt") or "")
        for reference in date_index.get("articles") or []:
            if not isinstance(reference, dict):
                continue
            article_id = str(reference.get("articleId") or "").strip()
            object_path = str(reference.get("object") or "").strip()
            if not article_id or not object_path:
                continue
            rank = (
                str(reference.get("publishedAt") or ""),
                index_updated_at,
                object_path,
            )
            previous = selected.get(article_id)
            if previous is None or rank > previous[0]:
                selected[article_id] = (rank, {**reference, "dateIndexObject": date_path})
    return [
        value[1]
        for _article_id, value in sorted(
            selected.items(),
            key=lambda item: (item[1][0][0], item[0]),
        )
    ]


class HuggingFaceCanonical:
    def __init__(
        self,
        repo_id: str,
        *,
        revision: str = "main",
        token: str | None = None,
        download_workers: int = 8,
    ):
        from huggingface_hub import HfApi

        self.repo_id = repo_id
        self.revision = revision
        self.token = token
        self.download_workers = max(1, min(download_workers, 16))
        self.api = HfApi(token=token)

    def revision_sha(self) -> str:
        return str(self.api.repo_info(
            repo_id=self.repo_id,
            repo_type="dataset",
            revision=self.revision,
        ).sha)

    def _download(self, path: str) -> Path:
        from huggingface_hub import hf_hub_download

        return Path(hf_hub_download(
            repo_id=self.repo_id,
            repo_type="dataset",
            filename=path,
            revision=self.revision,
            token=self.token,
        ))

    def json(self, path: str) -> dict[str, Any]:
        return json.loads(self._download(path).read_text(encoding="utf-8"))

    def json_gz(self, path: str) -> dict[str, Any]:
        with gzip.open(self._download(path), "rt", encoding="utf-8") as stream:
            return json.load(stream)

    def jsonl_gz(self, path: str) -> Iterator[dict[str, Any]]:
        with gzip.open(self._download(path), "rt", encoding="utf-8") as stream:
            for line in stream:
                if line.strip():
                    yield json.loads(line)

    def _tree(self, path: str, *, recursive: bool) -> list[Any]:
        from huggingface_hub.errors import EntryNotFoundError

        try:
            return list(self.api.list_repo_tree(
                repo_id=self.repo_id,
                repo_type="dataset",
                revision=self.revision,
                path_in_repo=path,
                recursive=recursive,
                expand=False,
            ))
        except EntryNotFoundError:
            return []

    def files(self, path: str, *, recursive: bool = True) -> list[str]:
        rows = self._tree(path, recursive=recursive)
        return sorted(
            str(row.path)
            for row in rows
            if getattr(row, "size", None) is not None
        )

    def directories(self, path: str) -> list[str]:
        return sorted(
            str(row.path)
            for row in self._tree(path, recursive=False)
            if getattr(row, "size", None) is None
        )

    def iter_books(self) -> Iterator[IndexedDocument]:
        catalog = self.json("books/catalog.json")
        for collection in catalog.get("collections") or []:
            for item_ref in collection.get("items") or []:
                object_path = f"books/{item_ref['downloadPath']}"
                item = self.json_gz(object_path)
                yield from book_documents(collection, item, canonical_object=object_path)

    def iter_newspapers(self, publications: set[str] | None = None) -> Iterator[IndexedDocument]:
        dataset_paths = [f"{path}/dataset.json" for path in self.directories("newspapers")]
        for dataset_path in dataset_paths:
            publication_id = dataset_path.split("/")[1]
            if publications and publication_id not in publications:
                continue
            dataset = self.json(dataset_path)
            title = str(dataset.get("title") or publication_id)
            article_root = f"newspapers/{publication_id}/data/articles"
            for object_path in (
                path for path in self.files(article_root) if path.endswith(".jsonl.gz")
            ):
                for row in self.jsonl_gz(object_path):
                    result = newspaper_document(
                        row,
                        publication_id=publication_id,
                        publication_title=title,
                        canonical_object=object_path,
                    )
                    if result:
                        yield result

    def iter_news(
        self,
        sources: set[str] | None = None,
        *,
        since: str | None = None,
        until: str | None = None,
    ) -> Iterator[IndexedDocument]:
        from huggingface_hub.errors import EntryNotFoundError

        dataset_paths = [f"{path}/dataset.json" for path in self.directories("canonical")]
        for dataset_path in dataset_paths:
            try:
                dataset = self.json(dataset_path)
            except EntryNotFoundError:
                # Root-level folders such as canonical/runs are not source
                # datasets.
                continue
            if dataset.get("formatVersion") != "jojo-news-dataset/2":
                continue
            source_id = _required(dataset.get("sourceId"), "sourceId")
            if sources and source_id not in sources:
                continue
            date_root = f"canonical/{source_id}/dates"
            date_indexes: list[tuple[str, dict[str, Any]]] = []
            for date_path in (
                path for path in self.files(date_root) if path.endswith(".json.gz")
            ):
                issue_date = Path(date_path).name[:10]
                if since and issue_date < since:
                    continue
                if until and issue_date > until:
                    continue
                date_indexes.append((date_path, self.json_gz(date_path)))
            references = latest_news_references(date_indexes)

            def load(reference: dict[str, Any]) -> tuple[str, dict[str, Any]]:
                object_path = str(reference["object"])
                return object_path, self.json_gz(object_path)

            with ThreadPoolExecutor(max_workers=self.download_workers) as executor:
                for object_path, article in executor.map(load, references):
                    result = news_document(article, canonical_object=object_path)
                    if result:
                        yield result


def _mapping_properties(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    for value in payload.values():
        if isinstance(value, dict) and isinstance(value.get("mappings"), dict):
            return value["mappings"].get("properties") or {}
    mappings = payload.get("mappings")
    return mappings.get("properties") or {} if isinstance(mappings, dict) else {}


def ensure_unified_mapping(client: KibanaConsoleClient, index: str) -> dict[str, Any]:
    status, payload = client.request("GET", f"{index}/_mapping")
    if status >= 400:
        raise RuntimeError(f"读取 ES mapping 失败：{payload}")
    existing = _mapping_properties(payload)
    metadata = existing.get("metadata")
    metadata_warning = None
    if metadata and metadata.get("enabled") is not False:
        # Existing Tencent Serverless data streams use dynamic mappings and do
        # not expose a mapping update API.  The metadata keys emitted by this
        # module are bounded and search queries never include metadata.*.
        metadata_warning = "metadata 使用 Serverless 动态 mapping；同步器不会查询 metadata.*"
    missing = {
        name: definition
        for name, definition in UNIFIED_MAPPING["properties"].items()
        if name not in existing
    }
    if missing:
        status, result = client.request("PUT", f"{index}/_mapping", {
            "_meta": UNIFIED_MAPPING["_meta"],
            "properties": missing,
        })
        if status >= 400:
            if "Serverless index does not support" in str(result):
                # Tencent Serverless indexes are created and mapped in its
                # console.  The HTTP compatibility layer still permits
                # dynamic fields, so keep the document contract strict in our
                # code and report that ES could not persist the mapping hint.
                return {
                    "managed": False,
                    "existing": sorted(existing),
                    "added": [],
                    "warning": "Tencent Serverless 禁止 PUT _mapping；使用现有动态 mapping",
                }
            raise RuntimeError(f"写入 ES mapping 失败：{result}")
    return {
        "managed": metadata_warning is None,
        "existing": sorted(existing),
        "added": sorted(missing),
        **({"warning": metadata_warning} if metadata_warning else {}),
    }


def _same_business_document(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return all(left.get(field) == right.get(field) for field in BUSINESS_FIELDS)


@dataclass
class SyncResult:
    created: int = 0
    unchanged: int = 0
    conflicts: int = 0
    failed: int = 0
    examined: int = 0
    conflict_ids: list[str] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "examined": self.examined,
            "created": self.created,
            "unchanged": self.unchanged,
            "conflicts": self.conflicts,
            "failed": self.failed,
            "conflictIds": self.conflict_ids or [],
        }


class AppendOnlySync:
    def __init__(
        self,
        client: KibanaConsoleClient,
        index: str,
        *,
        batch_size: int = 250,
        max_batch_bytes: int = 5 * 1024 * 1024,
    ):
        self.client = client
        self.index = index
        self.batch_size = max(1, min(batch_size, 500))
        self.max_batch_bytes = max(1024, max_batch_bytes)

    def _existing(self, document_ids: list[str]) -> dict[str, dict[str, Any]]:
        if not document_ids:
            return {}
        status, payload = self.client.request("POST", f"{self.index}/_search", {
            "size": len(document_ids),
            "track_total_hits": False,
            "query": {"ids": {"values": document_ids}},
        })
        if status >= 400:
            raise RuntimeError(f"查询既有 ES 文档失败：{payload}")
        return {
            str(hit.get("_id")): hit.get("_source") or {}
            for hit in ((payload.get("hits") or {}).get("hits") or [])
        }

    def _batch(self, rows: Sequence[IndexedDocument], result: SyncResult) -> None:
        lines: list[str] = []
        for row in rows:
            lines.append(json.dumps({
                "create": {"_index": self.index, "_id": row.document_id}
            }, ensure_ascii=False, separators=(",", ":")))
            lines.append(json.dumps(row.document, ensure_ascii=False, separators=(",", ":")))
        status, payload = self.client.request_raw("POST", "_bulk", "\n".join(lines) + "\n")
        if status >= 400:
            raise RuntimeError(f"ES bulk 请求失败：{payload}")
        items = payload.get("items") or []
        if len(items) != len(rows):
            raise RuntimeError("ES bulk 返回数量与请求不一致")
        existing_rows: list[IndexedDocument] = []
        for row, item in zip(rows, items, strict=True):
            detail = item.get("create") or {}
            item_status = int(detail.get("status") or 0)
            if item_status in {200, 201}:
                result.created += 1
            elif item_status == 409:
                existing_rows.append(row)
            else:
                result.failed += 1
                if result.conflict_ids is None:
                    result.conflict_ids = []
                if len(result.conflict_ids) < 20:
                    result.conflict_ids.append(row.document_id)
        existing = self._existing([row.document_id for row in existing_rows])
        for row in existing_rows:
            if _same_business_document(existing.get(row.document_id, {}), row.document):
                result.unchanged += 1
            else:
                result.conflicts += 1
                if result.conflict_ids is None:
                    result.conflict_ids = []
                if len(result.conflict_ids) < 20:
                    result.conflict_ids.append(row.document_id)

    def run(
        self,
        documents: Iterable[IndexedDocument],
        *,
        on_progress: Callable[[SyncResult], None] | None = None,
    ) -> SyncResult:
        result = SyncResult(conflict_ids=[])
        batch: list[IndexedDocument] = []
        batch_bytes = 0
        for row in documents:
            row_bytes = len(json.dumps(
                row.document,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")) + len(row.document_id) + 100
            if batch and (
                len(batch) >= self.batch_size
                or batch_bytes + row_bytes > self.max_batch_bytes
            ):
                self._batch(batch, result)
                batch = []
                batch_bytes = 0
                if on_progress:
                    on_progress(result)
            batch.append(row)
            batch_bytes += row_bytes
            result.examined += 1
        if batch:
            self._batch(batch, result)
            if on_progress:
                on_progress(result)
        return result


def _limited(rows: Iterable[IndexedDocument], limit: int | None) -> Iterator[IndexedDocument]:
    for position, row in enumerate(rows):
        if limit is not None and position >= limit:
            break
        yield row


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--repo", default=os.getenv("ES_SYNC_HF_REPO", DEFAULT_HF_REPO))
    result.add_argument("--revision", default="main")
    result.add_argument("--index", default=os.getenv("ES_SYNC_INDEX", "aitest-1tk2lxru"))
    result.add_argument("--types", nargs="+", choices=DOCUMENT_TYPES, default=list(DOCUMENT_TYPES))
    result.add_argument("--publication", action="append", dest="publications")
    result.add_argument("--news-source", action="append", dest="news_sources")
    result.add_argument("--since")
    result.add_argument("--until")
    result.add_argument("--limit-per-type", type=int)
    result.add_argument("--batch-size", type=int, default=250)
    result.add_argument("--max-batch-mb", type=int, default=5)
    result.add_argument("--download-workers", type=int, default=8)
    result.add_argument("--dry-run", action="store_true")
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    source = HuggingFaceCanonical(
        args.repo,
        revision=args.revision,
        token=os.getenv("HF_TOKEN") or None,
        download_workers=args.download_workers,
    )
    source_sha = source.revision_sha()
    source.revision = source_sha
    iterators: list[tuple[str, Iterable[IndexedDocument]]] = []
    selected = set(args.types)
    if "book" in selected:
        iterators.append(("book", source.iter_books()))
    if "newspaper" in selected:
        iterators.append(("newspaper", source.iter_newspapers(
            set(args.publications) if args.publications else None,
        )))
    if "news" in selected:
        iterators.append(("news", source.iter_news(
            set(args.news_sources) if args.news_sources else None,
            since=args.since,
            until=args.until,
        )))

    print(json.dumps({
        "repo": args.repo,
        "revision": source_sha,
        "index": args.index,
        "types": args.types,
        "dryRun": args.dry_run,
    }, ensure_ascii=False))

    if args.dry_run:
        counts: dict[str, int] = {}
        for name, rows in iterators:
            sample = list(_limited(rows, args.limit_per_type))
            counts[name] = len(sample)
            for row in sample[:3]:
                print(json.dumps({"_id": row.document_id, "_source": row.document}, ensure_ascii=False))
        print(json.dumps({"counts": counts}, ensure_ascii=False))
        return 0

    _load_root_env()
    config = repair_config()
    config["index"] = args.index
    client = KibanaConsoleClient(config)
    mapping = ensure_unified_mapping(client, args.index)
    print(json.dumps({"mapping": mapping}, ensure_ascii=False))
    combined = (
        row
        for _name, rows in iterators
        for row in _limited(rows, args.limit_per_type)
    )
    sync = AppendOnlySync(
        client,
        args.index,
        batch_size=args.batch_size,
        max_batch_bytes=max(1, args.max_batch_mb) * 1024 * 1024,
    )
    result = sync.run(
        combined,
        on_progress=lambda current: print(json.dumps(current.as_dict(), ensure_ascii=False)),
    )
    print(json.dumps({"result": result.as_dict()}, ensure_ascii=False))
    return 2 if result.conflicts or result.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
