#!/usr/bin/env python3
"""Prepare a JOJO v1 RMRB Canonical snapshot without uploading it.

The converter is intentionally staging-only.  It streams the merged
PeopleData-aligned JSONL, applies staged review decisions, writes one
Canonical newspaper Item per day, and creates yearly Hugging Face viewer
shards.  Existing archive PDFs are referenced by their legacy B2 object key;
the 92 GiB PDF collection is never copied into this build.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import mimetypes
import os
import re
import shutil
import tarfile
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, TextIO


WORKSPACE = Path(__file__).resolve().parents[2]
DEFAULT_REVIEW_ROOT = WORKSPACE / "tmp" / "rmrb-peopledata-full-directory"
DEFAULT_MERGED = DEFAULT_REVIEW_ROOT / "merged-peopledata-canonical.jsonl"
DEFAULT_IMAGES = WORKSPACE / "tmp" / "pdfs" / "rmrb-peopledata-online-images"
COPY_MARKER_RE = re.compile(r"[（(]\s*人民数据库资料\s*[）)]")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}


ArticleKey = tuple[str, int, int]


@dataclass
class Decision:
    decision: str
    content: str
    reason: str
    image_path: Path | None = None
    image_sha256: str | None = None
    image_url: str | None = None
    source_files: set[str] = field(default_factory=set)


def article_key(row: dict[str, Any]) -> ArticleKey:
    ordinal = row.get("ordinal", row.get("peopleDataOrdinal"))
    return str(row["date"]), int(row["page"]), int(ordinal)


def json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def stable_suffix(*parts: object, length: int = 16) -> str:
    payload = "\0".join(str(part) for part in parts).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:length]


def resolve_evidence_path(value: str, review_root: Path) -> Path | None:
    candidate = Path(value)
    candidates = [candidate]
    if not candidate.is_absolute():
        candidates.extend((WORKSPACE / candidate, review_root.parent.parent / candidate))
    for path in candidates:
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES:
            return path
    return None


def load_decisions(review_root: Path) -> dict[ArticleKey, Decision]:
    """Load decisions with workbench rows last while retaining image evidence."""
    paths = sorted(review_root.glob("manual-review-decisions-*.jsonl"))
    workbench = review_root / "manual-review-decisions-workbench.jsonl"
    if workbench in paths:
        paths.remove(workbench)
        paths.append(workbench)
    decisions: dict[ArticleKey, Decision] = {}
    image_details: dict[ArticleKey, tuple[Path, str | None, str | None]] = {}
    sources: dict[ArticleKey, set[str]] = {}
    for path in paths:
        with path.open(encoding="utf-8-sig") as stream:
            for line in stream:
                if not line.strip():
                    continue
                row = json.loads(line)
                try:
                    key = article_key(row)
                except (KeyError, TypeError, ValueError):
                    continue
                verdict = str(row.get("decision") or row.get("status") or "").lower()
                if verdict not in {"accept", "reject"}:
                    continue
                sources.setdefault(key, set()).add(path.name)
                for evidence in row.get("evidence") or []:
                    if not isinstance(evidence, str):
                        continue
                    resolved = resolve_evidence_path(evidence, review_root)
                    if resolved:
                        image_details[key] = (
                            resolved,
                            str(row.get("imageSha256") or "") or None,
                            str(row.get("peopleDataImageUrl") or "") or None,
                        )
                        break
                decisions[key] = Decision(
                    decision=verdict,
                    content=COPY_MARKER_RE.sub("", str(row.get("content") or "")).strip(),
                    reason=str(row.get("reason") or "").strip(),
                )
    for key, decision in decisions.items():
        decision.source_files = sources.get(key, set())
        if key in image_details:
            decision.image_path, decision.image_sha256, decision.image_url = image_details[key]
    return decisions


def strip_exact_title_prefix(title: str, content: str) -> tuple[str, bool]:
    """Remove only a whitespace-equivalent title prefix, never a fuzzy match."""
    normalized = content.replace("\r\n", "\n").replace("\r", "\n").strip()
    lines = normalized.split("\n")
    wanted = re.sub(r"\s+", "", title)
    for count in range(1, min(6, len(lines) + 1)):
        prefix = re.sub(r"\s+", "", "".join(lines[:count]))
        if prefix == wanted:
            body = "\n".join(lines[count:]).strip()
            return body, True
        if len(prefix) > len(wanted):
            break
    return normalized, False


def hardlink_or_copy(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        return
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)


def write_json(path: Path, value: Any, *, pretty: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(
            value,
            stream,
            ensure_ascii=False,
            indent=2 if pretty else None,
            separators=None if pretty else (",", ":"),
        )
        stream.write("\n")


def write_json_gz(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8", newline="\n", compresslevel=6) as stream:
        stream.write(json_dump(value))
        stream.write("\n")


def open_year_shard(root: Path, year: str) -> TextIO:
    path = root / "huggingface" / "rmrb" / "data" / "articles" / f"{year}.jsonl.gz"
    path.parent.mkdir(parents=True, exist_ok=True)
    return gzip.open(path, "wt", encoding="utf-8", newline="\n", compresslevel=6)


def image_asset(decision: Decision, canonical_assets: Path) -> tuple[dict[str, Any], str] | None:
    if decision.image_path is None:
        return None
    digest = decision.image_sha256 or sha256_file(decision.image_path)
    if decision.image_sha256 and sha256_file(decision.image_path) != digest:
        raise ValueError(f"Image checksum mismatch: {decision.image_path}")
    suffix = decision.image_path.suffix.lower()
    target = canonical_assets / f"{digest}{suffix}"
    hardlink_or_copy(decision.image_path, target)
    asset_id = f"asset:image-{digest[:16]}"
    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return ({
        "id": asset_id,
        "type": "image",
        "role": "article-image",
        "mediaType": media_type,
        "title": None,
        "alt": None,
        "caption": None,
        "size": target.stat().st_size,
        "sha256": digest,
        "path": f"assets/{target.name}",
        **({"sourceUrl": decision.image_url} if decision.image_url else {}),
    }, asset_id)


def build_article(
    row: dict[str, Any],
    decisions: dict[ArticleKey, Decision],
    canonical_assets: Path,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None, bool]:
    key = article_key(row)
    day, page, ordinal = key
    title = str(row.get("title") or "").strip()
    source_content = str(row.get("content") or "").strip()
    decision = decisions.get(key)
    stripped_title = False
    asset: dict[str, Any] | None = None
    asset_refs: list[str] = []
    if source_content:
        body, stripped_title = strip_exact_title_prefix(title, source_content)
        status = "available"
    elif decision and decision.decision == "accept":
        body = decision.content
        if body == "【图片】":
            result = image_asset(decision, canonical_assets)
            if result:
                asset, asset_id = result
                asset_refs.append(asset_id)
                status = "image"
            else:
                status = "image-placeholder"
        else:
            status = "repaired"
    elif decision and decision.decision == "reject":
        body = ""
        status = "rejected"
    else:
        body = ""
        status = "missing"
    suffix = stable_suffix("rmrb", day, page, ordinal)
    article_id = f"article:{suffix}"
    article = {
        "id": article_id,
        "order": ordinal + 1,
        "title": title,
        "authors": [],
        "body": {"format": "text", "value": body},
        "assetRefs": asset_refs,
    }
    viewer_row = {
        "formatVersion": "jojo-newspaper-article-row/1",
        "datasetId": "rmrb",
        "itemId": f"rmrb:{day}",
        "articleId": article_id,
        "date": day,
        "page": page,
        "ordinal": ordinal,
        "title": title,
        "authors": [],
        "body": body,
        "status": status,
        "contentSource": row.get("contentSource"),
        "matchMethod": row.get("matchMethod"),
        "peopleDataHref": row.get("href"),
        "imageSha256": asset.get("sha256") if asset else None,
    }
    return article, viewer_row, asset, stripped_title


def build_day(
    day: str,
    rows: list[dict[str, Any]],
    decisions: dict[ArticleKey, Decision],
    output: Path,
    snapshot_id: str,
    generated_at: str,
    viewer: TextIO,
) -> tuple[dict[str, Any], Counter[str], int]:
    canonical_root = output / "canonical" / "newspapers" / "rmrb"
    articles: list[dict[str, Any]] = []
    placements: list[dict[str, Any]] = []
    pages = sorted({int(row["page"]) for row in rows})
    page_order = {page: index + 1 for index, page in enumerate(pages)}
    assets: dict[str, dict[str, Any]] = {}
    states: dict[str, str] = {}
    counts: Counter[str] = Counter()
    stripped_titles = 0
    page_article_order: Counter[int] = Counter()
    for row in sorted(rows, key=lambda value: (int(value["page"]), int(value["ordinal"]))):
        article, viewer_row, asset, stripped = build_article(row, decisions, canonical_root / "assets")
        articles.append(article)
        viewer.write(json_dump(viewer_row) + "\n")
        status = str(viewer_row["status"])
        counts[status] += 1
        stripped_titles += int(stripped)
        if status != "available":
            states[article["id"]] = status
        if asset:
            assets[asset["id"]] = asset
        page = int(row["page"])
        page_article_order[page] += 1
        placements.append({
            "id": f"placement:{stable_suffix('rmrb', day, page, int(row['ordinal']))}",
            "pageId": f"page:{page:02d}",
            "articleId": article["id"],
            "order": page_article_order[page],
            "role": "complete",
        })
    compact = day.replace("-", "")
    year, month, date_number = (int(part) for part in day.split("-"))
    issue_title = f"人民日报 {year}年{month}月{date_number}日"
    item = {
        "formatVersion": "jojo-item/1",
        "revision": 1,
        "itemId": f"rmrb:{day}",
        "datasetId": "rmrb",
        "type": "newspaper",
        "title": issue_title,
        "language": "zh-CN",
        "publicationStatus": "published",
        "access": "public",
        "identifiers": {"peopleDataDate": compact},
        "metadata": {"publishedDate": day, "issueNumber": None},
        "content": {
            "schema": "jojo-content/newspaper/1",
            "pages": [{
                "id": f"page:{page:02d}",
                "order": page_order[page],
                "number": page,
                "label": f"第{page}版",
                "title": None,
                "assetRefs": [],
            } for page in pages],
            "articles": articles,
            "placements": placements,
        },
        "assets": sorted(assets.values(), key=lambda value: value["id"]),
        "annotations": [],
        "provenance": {
            "source": "peopledata-directory-local-merge",
            "sourceFormat": "peopledata-directory+jsonl+xlsx+review-decisions",
            "importedAt": generated_at,
            "importer": "tools/rmrb-repair/prepare_rmrb_publication.py",
        },
        "extensions": {"rmrb": {
            "snapshotId": snapshot_id,
            "legacyPdfObject": f"RMRB/{day[:4]}/{compact}.pdf",
            "articleStates": states,
        }},
    }
    relative = Path("items") / day[:4] / day[5:7] / f"{day}.json.gz"
    canonical_item = canonical_root / relative
    write_json_gz(canonical_item, item)
    # Match the existing HF collection convention: dataset.json, items/, assets.tar.
    hf_item = output / "huggingface" / "rmrb" / relative
    hardlink_or_copy(canonical_item, hf_item)
    summary = {
        "itemId": item["itemId"],
        "itemKey": day,
        "type": "newspaper",
        "order": 0,
        "title": item["title"],
        "publishedDate": day,
        "path": relative.as_posix(),
        "articleCount": len(articles),
    }
    return summary, counts, stripped_titles


def decision_rows(decisions: dict[ArticleKey, Decision]) -> Iterable[dict[str, Any]]:
    for key in sorted(decisions):
        row = decisions[key]
        yield {
            "date": key[0],
            "page": key[1],
            "peopleDataOrdinal": key[2],
            "decision": row.decision,
            "content": row.content,
            "reason": row.reason,
            "imageSha256": row.image_sha256,
            "sourceFiles": sorted(row.source_files),
        }


def prepare_audit(output: Path, review_root: Path, snapshot_id: str, decisions: dict[ArticleKey, Decision]) -> None:
    audit = output / "raw" / "newspapers" / "rmrb" / "repair-runs" / snapshot_id
    audit.mkdir(parents=True, exist_ok=True)
    with gzip.open(audit / "normalized-decisions.jsonl.gz", "wt", encoding="utf-8", newline="\n") as stream:
        for row in decision_rows(decisions):
            stream.write(json_dump(row) + "\n")
    logs = sorted(review_root.glob("manual-review-decisions-*.jsonl"))
    with tarfile.open(audit / "source-decision-logs.tar.gz", "w:gz") as archive:
        for path in logs:
            archive.add(path, arcname=path.name, recursive=False)
    for name in (
        "merged-missing-workbench.sqlite3",
        "merged-peopledata-report.json",
        "peopledata-image-backfill-summary.json",
    ):
        source = review_root / name
        if source.is_file():
            hardlink_or_copy(source, audit / name)


def file_manifest(root: Path) -> list[dict[str, Any]]:
    rows = []
    for path in sorted(value for value in root.rglob("*") if value.is_file()):
        rows.append({
            "path": path.relative_to(root).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        })
    return rows


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        raise SystemExit(f"Output directory is not empty: {output}")
    output.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    decisions = load_decisions(args.review_root)
    items: list[dict[str, Any]] = []
    totals: Counter[str] = Counter()
    stripped_titles = 0
    current_day: str | None = None
    day_rows: list[dict[str, Any]] = []
    year_writer: TextIO | None = None
    writer_year: str | None = None
    days_written = 0

    def flush() -> bool:
        nonlocal year_writer, writer_year, days_written, stripped_titles
        if current_day is None or not day_rows:
            return True
        year = current_day[:4]
        if writer_year != year:
            if year_writer:
                year_writer.close()
            year_writer = open_year_shard(output, year)
            writer_year = year
        assert year_writer is not None
        summary, counts, stripped = build_day(
            current_day, day_rows, decisions, output, args.snapshot_id, generated_at, year_writer
        )
        summary["order"] = len(items) + 1
        items.append(summary)
        totals.update(counts)
        stripped_titles += stripped
        days_written += 1
        return args.limit_days is None or days_written < args.limit_days

    with args.merged.open(encoding="utf-8-sig") as stream:
        for line in stream:
            if not line.strip():
                continue
            row = json.loads(line)
            day = str(row["date"])
            if args.start_date and day < args.start_date:
                continue
            if args.end_date and day > args.end_date:
                flush()
                day_rows = []
                break
            if current_day is None:
                current_day = day
            if day != current_day:
                if day < current_day:
                    raise ValueError("Merged input must be sorted by date")
                if not flush():
                    day_rows = []
                    break
                day_rows = []
                current_day = day
            day_rows.append(row)
        else:
            flush()
    if year_writer:
        year_writer.close()

    dataset = {
        "formatVersion": "jojo-dataset/1",
        "datasetId": "rmrb",
        "type": "newspaper",
        "title": "人民日报",
        "language": "zh-CN",
        "publicationStatus": "published",
        "access": "public",
        "description": "以人民数据目录为权威目录、合并本地 JSONL 与年度 XLSX 正文的人民日报数字档案。",
        "itemPath": "items/{YYYY}/{MM}/{YYYY-MM-DD}.json.gz",
    }
    write_json(output / "canonical" / "newspapers" / "rmrb" / "dataset.json", dataset)
    hf_dataset = {**dataset, "items": items}
    write_json(output / "huggingface" / "rmrb" / "dataset.json", hf_dataset)
    hf_readme = """# 人民日报\n\nJOJO Canonical 的 Hugging Face 私有镜像。\n\n- `data/articles/*.jsonl.gz`：Dataset Viewer 用年度文章分片。\n- `items/`：一天一个完整 `jojo-item/1`。\n- `assets.tar`：按 SHA-256 命名的文章图片；解包后为 `assets/`。\n- 空正文记录不会删除；请查看 `status` 字段。\n"""
    (output / "huggingface" / "rmrb" / "README.md").write_text(hf_readme, encoding="utf-8", newline="\n")
    assets_root = output / "canonical" / "newspapers" / "rmrb" / "assets"
    if assets_root.is_dir():
        with tarfile.open(output / "huggingface" / "rmrb" / "assets.tar", "w") as archive:
            for path in sorted(value for value in assets_root.iterdir() if value.is_file()):
                archive.add(path, arcname=f"assets/{path.name}", recursive=False)
    if not args.skip_audit:
        prepare_audit(output, args.review_root, args.snapshot_id, decisions)
    report = {
        "formatVersion": "jojo-rmrb-publication-report/1",
        "snapshotId": args.snapshot_id,
        "generatedAt": generated_at,
        "source": str(args.merged),
        "dateRange": {"start": items[0]["publishedDate"] if items else None, "end": items[-1]["publishedDate"] if items else None},
        "itemCount": len(items),
        "articleCount": sum(totals.values()),
        "articleStatuses": dict(sorted(totals.items())),
        "exactTitlePrefixesRemoved": stripped_titles,
        "legacyPdfBytesCopied": 0,
        "legacyPdfPattern": "RMRB/{YYYY}/{YYYYMMDD}.pdf",
        "scope": "staging-only",
        "b2Uploaded": False,
        "huggingFaceUploaded": False,
    }
    write_json(output / "report.json", report)
    manifest = file_manifest(output)
    write_json(output / "manifest.json", {"snapshotId": args.snapshot_id, "files": manifest})
    write_json(output / "_SUCCESS.json", {
        "snapshotId": args.snapshot_id,
        "fileCount": len(manifest) + 2,
        "payloadBytes": sum(row["bytes"] for row in manifest),
        "report": report,
    })
    return report


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--merged", type=Path, default=DEFAULT_MERGED)
    result.add_argument("--review-root", type=Path, default=DEFAULT_REVIEW_ROOT)
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--snapshot-id", default="2026-08-18")
    result.add_argument("--start-date")
    result.add_argument("--end-date")
    result.add_argument("--limit-days", type=int)
    result.add_argument("--skip-audit", action="store_true")
    return result


def main() -> None:
    args = parser().parse_args()
    report = prepare(args)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
