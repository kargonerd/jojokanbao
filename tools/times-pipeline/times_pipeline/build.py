from __future__ import annotations

from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
from pathlib import Path
import posixpath
from typing import Any
from zoneinfo import ZoneInfo

from .feeds import Article, RawFeed
from .jox import json_bytes, read_jox_json, write_jox_json
from .webarchive import ArticleCapture, write_web_archive


DATASET_ID = "times"
DATASET_TITLE = "今日时事"
DATASET_INDEX_OBJECT = "content/newspapers/times/index.jox"
LATEST_OBJECT = "content/newspapers/times/latest.jox"
CATALOG_OBJECT = "catalog.jox"
TIMEZONE = ZoneInfo("Asia/Shanghai")


def _ensure_empty(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise ValueError(f"Times build output must be empty: {directory}")


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json_bytes(value))


def _write_gzip_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(json_bytes(value), compresslevel=9, mtime=0))


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _issue_date(published_at: str) -> str:
    return _parse_datetime(published_at).astimezone(TIMEZONE).date().isoformat()


def _issue_prefix(issue_date: str) -> str:
    year, month, _day = issue_date.split("-")
    return f"content/newspapers/times/items/{year}/{month}/{issue_date}"


def _previous_object(previous_directory: Path | None, name: str, object_key: str) -> Any | None:
    if previous_directory is None:
        return None
    path = previous_directory / name
    if not path.exists():
        return None
    try:
        return read_jox_json(path, object_key)
    except (OSError, ValueError, json.JSONDecodeError, gzip.BadGzipFile):
        return None


def _previous_canonical_bodies(previous_directory: Path | None, issue_date: str) -> dict[str, str]:
    if previous_directory is None:
        return {}
    year, month, _day = issue_date.split("-")
    path = (
        previous_directory / "canonical" / "newspapers" / DATASET_ID / "items"
        / year / month / f"{issue_date}.json.gz"
    )
    if not path.exists():
        return {}
    try:
        value = json.loads(gzip.decompress(path.read_bytes()))
    except (OSError, gzip.BadGzipFile, json.JSONDecodeError, UnicodeDecodeError):
        return {}
    articles = value.get("content", {}).get("articles", []) if isinstance(value, dict) else []
    result: dict[str, str] = {}
    for article in articles if isinstance(articles, list) else []:
        body = article.get("body", {}) if isinstance(article, dict) else {}
        if isinstance(article.get("id"), str) and isinstance(body, dict) and isinstance(body.get("value"), str):
            result[article["id"]] = body["value"]
    return result


def _source_metadata(article: Article) -> dict:
    return {
        "id": article.source.id,
        "name": article.source.name,
        "language": article.source.language,
    }


def _article_fragment(article: Article) -> dict:
    return {
        "formatVersion": "jojo-fragment/1",
        "itemId": f"times:{_issue_date(article.published_at)}",
        "fragmentId": article.id,
        "type": "article",
        "order": 0,
        "title": article.title,
        "body": {"format": "text", "value": article.body},
        "assetRefs": [],
        "annotations": [],
        "metadata": {
            "publishedAt": article.published_at,
            "originalUrl": article.url,
            "source": _source_metadata(article),
            "contentStatus": article.content_status,
            "translations": article.translations,
        },
    }


def _article_entry(article: Article, object_key: str, descriptor: dict[str, int | str]) -> dict:
    return {
        "id": article.id,
        "title": article.title,
        "summary": article.summary,
        "url": article.url,
        "publishedAt": article.published_at,
        "issueDate": _issue_date(article.published_at),
        "language": article.source.language,
        "source": _source_metadata(article),
        "contentStatus": article.content_status,
        "translations": article.translations,
        "articleObject": object_key,
        "characterCount": len(article.body),
        "size": descriptor["size"],
        "sha256": descriptor["sha256"],
    }


def _canonical_article(entry: dict, body: str) -> dict:
    return {
        "id": entry["id"],
        "order": 0,
        "title": entry["title"],
        "authors": [],
        "body": {"format": "text", "value": body},
        "assetRefs": [],
    }


def _search_document(entry: dict, body: str, manifest_object: str) -> dict:
    text = body.strip()
    document_id = hashlib.sha256(
        f"{entry['id']}\0{text}".encode("utf-8")
    ).hexdigest()
    return {
        "formatVersion": "jojo-search-document/1",
        "@timestamp": entry["publishedAt"],
        "documentId": document_id,
        "datasetId": DATASET_ID,
        "datasetTitle": DATASET_TITLE,
        "itemId": f"times:{entry['issueDate']}",
        "itemTitle": f"{DATASET_TITLE} {entry['issueDate']}",
        "itemType": "newspaper",
        "revision": 1,
        "targetId": entry["id"],
        "targetType": "article",
        "targetTitle": entry["title"],
        "chunkId": "chunk:0001",
        "order": 1,
        "text": text,
        "authors": [],
        "publishedDate": entry["publishedAt"],
        "manifestObject": manifest_object,
        "fragmentObject": entry["articleObject"],
        "source": entry["source"],
        "originalUrl": entry["url"],
        "contentStatus": entry["contentStatus"],
    }


def _valid_previous_entries(value: Any) -> list[dict]:
    if not isinstance(value, dict) or value.get("formatVersion") != "jojo-times-latest/1":
        return []
    rows = value.get("articles")
    if not isinstance(rows, list):
        return []
    required = {
        "id", "title", "publishedAt", "issueDate", "source", "articleObject",
        "characterCount", "size", "sha256", "contentStatus",
    }
    return [row for row in rows if isinstance(row, dict) and required.issubset(row)]


def build_times_release(
    *,
    articles: list[Article],
    raw_feeds: list[RawFeed],
    article_captures: list[ArticleCapture] | None = None,
    source_statuses: list[dict],
    output_directory: Path,
    previous_directory: Path | None = None,
    previous_archive_state: dict[str, Any] | None = None,
    parser_report: dict[str, Any] | None = None,
    now: datetime | None = None,
    retention_days: int = 7,
    max_latest_articles: int = 1_000,
) -> dict:
    if retention_days < 1 or max_latest_articles < 1:
        raise ValueError("Times retention and latest article limits must be positive")
    generated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    _ensure_empty(output_directory)
    raw_root = output_directory / "raw"
    canonical_root = output_directory / "canonical"
    delivery_root = output_directory / "delivery"
    search_root = output_directory / "search"
    run_id = generated_at.strftime("%Y%m%dT%H%M%SZ")

    captures = article_captures or []
    archive_report = write_web_archive(
        raw_root,
        raw_feeds=raw_feeds,
        captures=captures,
        articles=articles,
        previous_state=previous_archive_state or {"articles": {}},
        source_statuses=source_statuses,
        generated_at=generated_at,
        run_id=run_id,
    )

    normalized_articles = 0
    for article in articles:
        if not isinstance(article.normalized, dict):
            continue
        normalized = json_bytes(article.normalized)
        normalized_hash = hashlib.sha256(normalized).hexdigest()[:16]
        parser_id = article.source.parser_id or article.source.id
        issue_date = _issue_date(article.published_at)
        year, month, _day = issue_date.split("-")
        target = (
            canonical_root / "news-articles" / parser_id / year / month
            / f"{article.id}-{normalized_hash}.json.gz"
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(gzip.compress(normalized, compresslevel=9, mtime=0))
        normalized_articles += 1

    previous_latest = _previous_object(previous_directory, "latest.jox", LATEST_OBJECT)
    previous_entries = _valid_previous_entries(previous_latest)
    entries_by_id = {entry["id"]: entry for entry in previous_entries}
    new_entries: list[dict] = []
    body_by_id: dict[str, str] = {}
    cutoff = generated_at - timedelta(days=retention_days)
    for article in articles:
        if _parse_datetime(article.published_at) < cutoff:
            continue
        issue_prefix = _issue_prefix(_issue_date(article.published_at))
        previous_entry = entries_by_id.get(article.id)
        if (
            article.content_status == "summary"
            and isinstance(previous_entry, dict)
            and previous_entry.get("contentStatus") in {"full", "partial"}
        ):
            continue
        fragment = _article_fragment(article)
        clear = json_bytes(fragment)
        body_hash = hashlib.sha256(clear).hexdigest()[:16]
        object_key = f"{issue_prefix}/articles/{article.id}-{body_hash}.jox"
        fragment_unchanged = (
            isinstance(previous_entry, dict)
            and previous_entry.get("articleObject") == object_key
            and isinstance(previous_entry.get("size"), int)
            and isinstance(previous_entry.get("sha256"), str)
        )
        descriptor = (
            {"size": previous_entry["size"], "sha256": previous_entry["sha256"]}
            if fragment_unchanged
            else write_jox_json(delivery_root, object_key, fragment)
        )
        entry = _article_entry(article, object_key, descriptor)
        entries_by_id[article.id] = entry
        if not fragment_unchanged:
            new_entries.append(entry)
        body_by_id[article.id] = article.body

    retained_entries = [
        entry for entry in entries_by_id.values()
        if _parse_datetime(str(entry["publishedAt"])) >= cutoff
    ]
    retained_entries.sort(key=lambda entry: str(entry["publishedAt"]), reverse=True)
    retained_entries = retained_entries[:max_latest_articles]
    retained_ids = {entry["id"] for entry in retained_entries}
    new_entries = [entry for entry in new_entries if entry["id"] in retained_ids]

    previous_index = _previous_object(previous_directory, "index.jox", DATASET_INDEX_OBJECT)
    previous_items = (
        previous_index.get("items", [])
        if isinstance(previous_index, dict) and previous_index.get("formatVersion") == "jojo-delivery-index/1"
        else []
    )
    index_items = {
        item.get("itemId"): item
        for item in previous_items
        if isinstance(item, dict) and isinstance(item.get("itemId"), str)
    }

    changed_dates = sorted({entry["issueDate"] for entry in new_entries})
    search_documents: list[dict] = []
    previous_body_cache: dict[str, dict[str, str]] = {}
    for issue_date in changed_dates:
        issue_entries = [entry for entry in retained_entries if entry["issueDate"] == issue_date]
        issue_entries.sort(key=lambda entry: str(entry["publishedAt"]), reverse=True)
        issue_prefix = _issue_prefix(issue_date)
        manifest_object = f"{issue_prefix}/manifest.jox"
        manifest_directory = posixpath.dirname(manifest_object)
        descriptors = []
        for order, entry in enumerate(issue_entries, start=1):
            descriptors.append({
                "id": entry["id"],
                "order": order,
                "title": entry["title"],
                "characterCount": entry["characterCount"],
                "object": posixpath.relpath(entry["articleObject"], manifest_directory),
                "size": entry["size"],
                "sha256": entry["sha256"],
            })
        manifest = {
            "formatVersion": "jojo-item-manifest/1",
            "revision": int(generated_at.timestamp()),
            "itemId": f"times:{issue_date}",
            "datasetId": DATASET_ID,
            "type": "newspaper",
            "title": f"{DATASET_TITLE} {issue_date}",
            "language": "mul",
            "publicationStatus": "published",
            "access": "public",
            "identifiers": {"date": issue_date},
            "metadata": {
                "publishedDate": issue_date,
                "updatedAt": generated_at.isoformat(),
                "articleCount": len(issue_entries),
                "sources": sorted({entry["source"]["name"] for entry in issue_entries}),
            },
            "content": {"schema": "jojo-content/newspaper/1", "articles": descriptors},
            "contentStats": {
                "chapterCount": 0,
                "characterCount": sum(int(entry["characterCount"]) for entry in issue_entries),
            },
            "assets": [],
            "exports": [],
        }
        write_jox_json(delivery_root, manifest_object, manifest)

        canonical_articles = []
        previous_body_cache[issue_date] = _previous_canonical_bodies(previous_directory, issue_date)
        for order, entry in enumerate(issue_entries, start=1):
            body = body_by_id.get(
                entry["id"],
                previous_body_cache[issue_date].get(entry["id"], entry.get("summary") or ""),
            )
            canonical = _canonical_article(entry, body)
            canonical["order"] = order
            canonical_articles.append(canonical)
            if entry["id"] in body_by_id:
                search_documents.append(_search_document(entry, body, manifest_object))
        canonical_item = {
            "formatVersion": "jojo-item/1",
            "revision": int(generated_at.timestamp()),
            "itemId": f"times:{issue_date}",
            "datasetId": DATASET_ID,
            "type": "newspaper",
            "title": f"{DATASET_TITLE} {issue_date}",
            "language": "mul",
            "publicationStatus": "published",
            "access": "public",
            "identifiers": {"date": issue_date},
            "metadata": {"publishedDate": issue_date, "updatedAt": generated_at.isoformat()},
            "content": {
                "schema": "jojo-content/newspaper/1",
                "pages": [{
                    "id": "page:1", "order": 1, "number": 1, "label": "时事", "title": None, "assetRefs": [],
                }],
                "articles": canonical_articles,
                "placements": [
                    {"id": f"placement:{entry['id']}", "pageId": "page:1", "articleId": entry["id"], "order": order, "role": "complete"}
                    for order, entry in enumerate(issue_entries, start=1)
                ],
            },
            "assets": [],
            "annotations": [],
            "provenance": {"pipeline": "jojo-times-offline/1", "runId": run_id},
            "extensions": {"sourceStatuses": source_statuses},
        }
        year, month, _day = issue_date.split("-")
        _write_gzip_json(
            canonical_root / "newspapers" / DATASET_ID / "items" / year / month / f"{issue_date}.json.gz",
            canonical_item,
        )
        index_items[f"times:{issue_date}"] = {
            "itemId": f"times:{issue_date}",
            "itemKey": issue_date,
            "type": "newspaper",
            "order": int(issue_date.replace("-", "")),
            "title": f"{DATASET_TITLE} {issue_date}",
            "manifestObject": posixpath.relpath(manifest_object, posixpath.dirname(DATASET_INDEX_OBJECT)),
            "publicationStatus": "published",
            "access": "public",
        }

    sorted_items = sorted(
        index_items.values(),
        key=lambda item: (int(item.get("order", 0)), str(item.get("title", ""))),
        reverse=True,
    )
    index_revision = int(previous_index.get("revision", 0)) + 1 if isinstance(previous_index, dict) else 1
    dataset_index = {
        "formatVersion": "jojo-delivery-index/1",
        "revision": index_revision,
        "datasetId": DATASET_ID,
        "type": "newspaper",
        "title": DATASET_TITLE,
        "language": "mul",
        "description": "每十分钟更新的多来源时事索引。",
        "aiEnabled": False,
        "publicationStatus": "published",
        "access": "public",
        "items": sorted_items,
    }
    write_jox_json(delivery_root, DATASET_INDEX_OBJECT, dataset_index)
    _write_json(canonical_root / "newspapers" / DATASET_ID / "dataset.json", {
        "formatVersion": "jojo-dataset/1",
        "datasetId": DATASET_ID,
        "type": "newspaper",
        "title": DATASET_TITLE,
        "language": "mul",
        "aiEnabled": False,
        "publicationStatus": "published",
        "access": "public",
        "description": dataset_index["description"],
        "itemPath": "items/{YYYY}/{MM}/{YYYY-MM-DD}.json.gz",
    })

    for year in sorted({str(item["itemKey"])[:4] for item in sorted_items}):
        year_items = [item for item in sorted_items if str(item["itemKey"]).startswith(year)]
        availability_object = f"content/newspapers/times/availability/{year}.jox"
        availability_directory = posixpath.dirname(availability_object)
        write_jox_json(delivery_root, availability_object, {
            "formatVersion": "jojo-newspaper-availability/1",
            "revision": index_revision,
            "datasetId": DATASET_ID,
            "year": int(year),
            "issues": [
                {
                    "date": item["itemKey"],
                    "itemId": item["itemId"],
                    "manifestObject": posixpath.relpath(
                        posixpath.join(posixpath.dirname(DATASET_INDEX_OBJECT), item["manifestObject"]),
                        availability_directory,
                    ),
                }
                for item in year_items
            ],
        })

    latest_revision = int(previous_latest.get("revision", 0)) + 1 if isinstance(previous_latest, dict) else 1
    latest = {
        "formatVersion": "jojo-times-latest/1",
        "revision": latest_revision,
        "updatedAt": generated_at.isoformat(),
        "datasetId": DATASET_ID,
        "indexObject": DATASET_INDEX_OBJECT,
        "retentionDays": retention_days,
        "sources": source_statuses,
        "articles": retained_entries,
    }
    write_jox_json(delivery_root, LATEST_OBJECT, latest)

    previous_catalog = _previous_object(previous_directory, "catalog.jox", CATALOG_OBJECT)
    catalog_entries = {
        entry.get("datasetId"): entry
        for entry in (
            previous_catalog.get("datasets", [])
            if isinstance(previous_catalog, dict) and previous_catalog.get("formatVersion") == "jojo-catalog/1"
            else []
        )
        if isinstance(entry, dict) and isinstance(entry.get("datasetId"), str)
    }
    catalog_migrated = False
    for dataset_id, entry in list(catalog_entries.items()):
        if "aiEnabled" not in entry and entry.get("type") in {"book", "book-series"}:
            catalog_entries[dataset_id] = {**entry, "aiEnabled": True}
            catalog_migrated = True
    times_catalog_entry = {
        "datasetId": DATASET_ID,
        "type": "newspaper",
        "title": DATASET_TITLE,
        "language": "mul",
        "indexObject": DATASET_INDEX_OBJECT,
        "aiEnabled": False,
        "publicationStatus": "published",
        "access": "public",
    }
    existing_times_entry = catalog_entries.get(DATASET_ID)
    catalog_changed = catalog_migrated or not isinstance(existing_times_entry, dict) or any(
        existing_times_entry.get(key) != value for key, value in times_catalog_entry.items()
    )
    if catalog_changed:
        catalog_entries[DATASET_ID] = {**(existing_times_entry or {}), **times_catalog_entry}
        write_jox_json(delivery_root, CATALOG_OBJECT, {
            "formatVersion": "jojo-catalog/1",
            "revision": int(previous_catalog.get("revision", 0)) + 1 if isinstance(previous_catalog, dict) else 1,
            "updatedAt": generated_at.isoformat(),
            "datasets": sorted(catalog_entries.values(), key=lambda entry: str(entry.get("title", ""))),
        })

    search_run_root = search_root / "times" / "runs" / run_id
    search_run_root.mkdir(parents=True, exist_ok=True)
    search_payload = "".join(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n"
        for document in search_documents
    ).encode("utf-8")
    (search_run_root / "documents.jsonl.gz").write_bytes(
        gzip.compress(search_payload, compresslevel=9, mtime=0)
    )
    _write_json(search_run_root / "run.json", {
        "formatVersion": "jojo-times-search-run/1",
        "runId": run_id,
        "documents": len(search_documents),
    })

    archive_by_source: dict[str, dict[str, Any]] = {}
    for capture in captures:
        row = archive_by_source.setdefault(capture.source_id, {
            "sourceId": capture.source_id,
            "attempts": 0,
            "succeeded": 0,
            "failed": 0,
            "responses": 0,
            "responseBytes": 0,
            "pageBytes": 0,
            "truncatedResponses": 0,
            "elapsedMs": 0,
            "maxElapsedMs": 0,
            "httpStatuses": {},
        })
        final = capture.final_exchange
        succeeded = capture.error is None and final is not None and 200 <= final.status_code < 400
        row["attempts"] += 1
        row["succeeded" if succeeded else "failed"] += 1
        row["responses"] += len(capture.exchanges)
        row["responseBytes"] += sum(len(exchange.body) for exchange in capture.exchanges)
        row["pageBytes"] += sum(len(exchange.body) for exchange in capture.exchanges if exchange.is_page)
        row["truncatedResponses"] += sum(exchange.truncated for exchange in capture.exchanges)
        row["elapsedMs"] += capture.elapsed_ms
        row["maxElapsedMs"] = max(row["maxElapsedMs"], capture.elapsed_ms)
        status_key = str(final.status_code) if final is not None else "none"
        row["httpStatuses"][status_key] = row["httpStatuses"].get(status_key, 0) + 1

    content_by_source: dict[str, dict[str, Any]] = {}
    for article in articles:
        row = content_by_source.setdefault(article.source.id, {
            "sourceId": article.source.id,
            "articles": 0,
            "full": 0,
            "partial": 0,
            "summary": 0,
        })
        row["articles"] += 1
        status_key = article.content_status if article.content_status in {"full", "partial"} else "summary"
        row[status_key] += 1

    report = {
        "formatVersion": "jojo-times-pipeline-report/1",
        "runId": run_id,
        "generatedAt": generated_at.isoformat(),
        "fetchedArticles": len(articles),
        "latestArticles": len(retained_entries),
        "changedIssues": changed_dates,
        "sourceCount": len(source_statuses),
        "availableSourceCount": sum(status.get("status") in {"ok", "partial"} for status in source_statuses),
        "searchDocuments": len(search_documents),
        "normalizedArticles": normalized_articles,
        "archiveResponses": archive_report["responses"],
        "archivedArticles": archive_report["pages"],
        "archiveArticleFailures": archive_report["articleFailures"],
        "archiveSucceededArticles": sum(row["succeeded"] for row in archive_by_source.values()),
        "archiveFailedArticles": sum(row["failed"] for row in archive_by_source.values()),
        "archiveWarcBytes": archive_report["warcBytes"],
        "archiveWaczBytes": archive_report["waczBytes"],
        "archiveBySource": sorted(archive_by_source.values(), key=lambda row: row["sourceId"]),
        "contentBySource": sorted(content_by_source.values(), key=lambda row: row["sourceId"]),
        "waczObject": archive_report["waczObject"],
        "parser": parser_report or {},
        "catalogChanged": catalog_changed,
        "outputDirectory": str(output_directory.resolve()),
    }
    _write_json(output_directory / "report.json", report)
    return report
