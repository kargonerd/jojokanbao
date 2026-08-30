from __future__ import annotations

import argparse
from collections.abc import Iterable
from datetime import datetime
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
from typing import Any
from urllib.parse import urlsplit


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_news_archive.models import ArticleStatus, BlobReference, RawCapture
from jojo_news_archive.parsing.parser import parse_article
from jojo_news_archive.parsing.policy import qa_policy_revision


FORMAT_VERSION = "jojo-news-canonical-input/1"
RECORD_MARKER = "/raw/records/"


def _safe_object_name(value: str, *, label: str) -> str:
    if not value or "\\" in value or value.startswith("/") or value.endswith("/"):
        raise ValueError(f"unsafe {label}: {value!r}")
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts) or ":" in parts[0]:
        raise ValueError(f"unsafe {label}: {value!r}")
    return PurePosixPath(*parts).as_posix()


def _local_object(root: Path, object_name: str) -> Path:
    normalized = _safe_object_name(object_name, label="HF object name")
    resolved_root = root.resolve()
    target = resolved_root.joinpath(*normalized.split("/")).resolve()
    if target != resolved_root and resolved_root not in target.parents:
        raise ValueError(f"HF object escapes the local root: {object_name}")
    return target


def _raw_root_object(record_object: str) -> str:
    normalized = _safe_object_name(record_object, label="record object")
    if not normalized.startswith("raw/archive/v1/") or RECORD_MARKER not in normalized:
        raise ValueError(f"record is outside historical v1 Raw: {record_object}")
    if not normalized.endswith(".json"):
        raise ValueError(f"capture record must be JSON: {record_object}")
    return normalized.split(RECORD_MARKER, 1)[0] + "/raw"


def _blob_object(raw_root: str, reference: BlobReference) -> str:
    relative = _safe_object_name(reference.path, label="Raw blob reference")
    if not relative.startswith("objects/"):
        raise ValueError(f"Raw blob reference must start with objects/: {relative}")
    return f"{raw_root}/{relative}"


def _read_blob(root: Path, object_name: str, reference: BlobReference) -> bytes:
    path = _local_object(root, object_name)
    if not path.is_file():
        raise ValueError(f"Raw object is missing: {object_name}")
    stored = path.read_bytes()
    if len(stored) != reference.stored_byte_count:
        raise ValueError(
            f"stored byte count mismatch for {object_name}: "
            f"expected {reference.stored_byte_count}, got {len(stored)}"
        )
    if reference.content_encoding == "gzip":
        try:
            content = gzip.decompress(stored)
        except (OSError, EOFError) as error:
            raise ValueError(f"invalid gzip Raw object {object_name}: {error}") from error
    elif reference.content_encoding is None:
        content = stored
    else:
        raise ValueError(
            f"unsupported Raw content encoding for {object_name}: "
            f"{reference.content_encoding}"
        )
    if len(content) != reference.byte_count:
        raise ValueError(
            f"Raw byte count mismatch for {object_name}: "
            f"expected {reference.byte_count}, got {len(content)}"
        )
    digest = hashlib.sha256(content).hexdigest()
    if digest != reference.sha256:
        raise ValueError(
            f"Raw SHA-256 mismatch for {object_name}: "
            f"expected {reference.sha256}, got {digest}"
        )
    return content


def _source_id(capture: RawCapture) -> str:
    if capture.publisher != "nikkei":
        return capture.publisher
    hostname = (urlsplit(capture.canonical_url).hostname or "").lower()
    if hostname == "asia.nikkei.com":
        return "nikkei"
    if hostname in {"nikkei.com", "www.nikkei.com"}:
        return "nikkei-japan"
    raise ValueError(f"unsupported Nikkei hostname: {hostname or '<missing>'}")


def _qa_issues(capture: RawCapture, article: Any) -> list[str]:
    issues: list[str] = []
    if article.quality.status != ArticleStatus.COMPLETE:
        issues.append(f"extraction-{article.quality.status.value}")
    if not article.headline:
        issues.append("missing-headline")
    if not article.published_at:
        issues.append("missing-published-at")
    if article.canonical_url != capture.canonical_url:
        issues.append("source-link-mismatch")
    if not article.plain_text.strip():
        issues.append("empty-body")
    text_blocks = [
        " ".join(block.text.split()).casefold()
        for block in article.blocks
        if block.text and " ".join(block.text.split())
    ]
    if len(text_blocks) != len(set(text_blocks)):
        issues.append("duplicate-text-blocks")
    return issues


def _record_objects(path: Path) -> tuple[str, ...]:
    values: list[str] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        if value.startswith("{"):
            payload = json.loads(value)
            value = payload.get("recordObject") if isinstance(payload, dict) else None
            if not isinstance(value, str):
                raise ValueError(f"record list line {line_number} has no recordObject")
        values.append(_safe_object_name(value, label="record object"))
    return tuple(sorted(set(values)))


def _candidate_score(row: dict[str, Any]) -> tuple[int, int, int, datetime, str]:
    capture = row["_capture"]
    article = row["_article"]
    return (
        capture.quality_score,
        article.quality.body_characters,
        article.quality.images_selected,
        capture.retrieved_at,
        capture.raw_html.sha256,
    )


def export_batch(
    *,
    root: Path,
    record_objects: Iterable[str],
    raw_revision: str,
    raw_run_id: str,
    raw_run_manifest: str,
) -> list[dict[str, Any]]:
    if not raw_revision.strip() or not raw_run_id.strip():
        raise ValueError("raw revision and run id must be non-empty")
    run_manifest = _safe_object_name(raw_run_manifest, label="Raw run manifest")
    if not run_manifest.startswith("raw/archive/") or not run_manifest.endswith(".json"):
        raise ValueError("Raw run manifest must be a JSON object below raw/archive/")

    selected: dict[tuple[str, str], dict[str, Any]] = {}
    for record_object in sorted(set(record_objects)):
        raw_root = _raw_root_object(record_object)
        record_path = _local_object(root, record_object)
        if not record_path.is_file():
            raise ValueError(f"capture record is missing: {record_object}")
        capture = RawCapture.model_validate_json(record_path.read_text(encoding="utf-8"))
        raw_html_object = _blob_object(raw_root, capture.raw_html)
        raw_html = _read_blob(root, raw_html_object, capture.raw_html)
        dependent_resources: dict[str, bytes] = {}
        for resource in capture.dependent_resources:
            object_name = _blob_object(raw_root, resource.blob)
            dependent_resources[resource.source_url] = _read_blob(
                root, object_name, resource.blob
            )
        article = parse_article(
            raw_html,
            publisher=capture.publisher,
            canonical_url=capture.canonical_url,
            raw_capture=capture,
            dependent_resources=dependent_resources,
            parsed_at=capture.retrieved_at,
        )
        issues = _qa_issues(capture, article)
        if issues:
            continue
        source_id = _source_id(capture)
        published_at = article.published_at
        if published_at is None:
            continue
        row: dict[str, Any] = {
            "formatVersion": FORMAT_VERSION,
            "sourceId": source_id,
            "publisher": capture.publisher,
            "canonicalUrl": article.canonical_url,
            "recordObject": record_object,
            "rawHtmlObject": raw_html_object,
            "rawRevision": raw_revision,
            "rawRunId": raw_run_id,
            "rawRunManifest": run_manifest,
            "captureRecord": capture.model_dump(
                mode="json", by_alias=True, exclude_none=True
            ),
            "parserResult": article.model_dump(
                mode="json", by_alias=True, exclude_none=True
            ),
            "validation": {
                "sampleYear": published_at.year,
                "parserVersion": article.extraction.parser_version,
                "qaRevision": qa_policy_revision(capture.publisher),
                "qaPass": True,
                "issues": [],
                "sourceRawSha256": capture.raw_html.sha256,
            },
            "_capture": capture,
            "_article": article,
        }
        key = (source_id, article.canonical_url)
        previous = selected.get(key)
        if previous is None or _candidate_score(row) > _candidate_score(previous):
            selected[key] = row
        elif _candidate_score(row) == _candidate_score(previous):
            if record_object < str(previous["recordObject"]):
                selected[key] = row

    output: list[dict[str, Any]] = []
    for row in selected.values():
        output.append({key: value for key, value in row.items() if not key.startswith("_")})
    return sorted(
        output,
        key=lambda row: (
            str(row["sourceId"]),
            str(row["canonicalUrl"]),
            str(row["recordObject"]),
            str(row["rawHtmlObject"]),
        ),
    )


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    body = "".join(
        json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
        for row in rows
    ).encode("utf-8")
    encoded = gzip.compress(body, compresslevel=9, mtime=0) if path.suffix == ".gz" else body
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(encoded)
    temporary.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replay verified historical Raw captures into Canonical bridge input."
    )
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--record-list", type=Path, required=True)
    parser.add_argument("--raw-revision", required=True)
    parser.add_argument("--raw-run-id", required=True)
    parser.add_argument("--raw-run-manifest", required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rows = export_batch(
        root=args.root,
        record_objects=_record_objects(args.record_list),
        raw_revision=args.raw_revision,
        raw_run_id=args.raw_run_id,
        raw_run_manifest=args.raw_run_manifest,
    )
    write_jsonl(args.output, rows)
    print(json.dumps({"output": str(args.output), "articles": len(rows)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
