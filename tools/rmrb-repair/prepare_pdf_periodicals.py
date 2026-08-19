#!/usr/bin/env python3
"""Build Canonical, Hugging Face, and Delivery data for PDF-only periodicals.

These collections currently have issue PDFs but no article directory.  Each
issue therefore records text=missing and pdf=available explicitly.  Original
PDFs remain readable assets with human-readable issue keys; Jox is used only
for Delivery objects.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import prepare_rmrb_publication as common


@dataclass(frozen=True)
class Publication:
    code: str
    slug: str
    title: str
    item_type: str
    key_kind: str
    root: Path


PUBLICATIONS = (
    Publication("CKXX", "ckxx", "参考消息", "newspaper", "daily", Path(r"D:\Cloud\OneDrive\ckxx\CKXX")),
    Publication("HQ", "hq", "红旗", "magazine", "issue", Path(r"D:\Cloud\OneDrive\红旗\HQ")),
    Publication("RMHB", "rmhb", "人民画报", "magazine", "issue", Path(r"D:\Cloud\OneDrive\rmhb\RMHB_full")),
    Publication("SJZS", "sjzs", "世界知识", "magazine", "issue", Path(r"D:\Cloud\OneDrive\世界知识\SJZS")),
)


def parse_source(publication: Publication, path: Path) -> dict[str, Any]:
    stem = path.stem
    if publication.key_kind == "daily":
        if not re.fullmatch(r"\d{8}", stem):
            raise ValueError(f"Unexpected daily PDF name: {path}")
        day = f"{stem[:4]}-{stem[4:6]}-{stem[6:8]}"
        # Validate the date rather than accepting a filename-shaped typo.
        datetime.strptime(day, "%Y-%m-%d")
        item_key = day
        relative_item = Path("items") / stem[:4] / stem[4:6] / f"{day}.json.gz"
        delivery_prefix = f"content/newspapers/{publication.slug}/items/{stem[:4]}/{stem[4:6]}/{day}"
        asset_path = f"assets/pdfs/{stem[:4]}/{stem[4:6]}/{day}.pdf"
        title = f"{publication.title} {stem[:4]}年{int(stem[4:6])}月{int(stem[6:8])}日"
        metadata = {"publishedDate": day, "issueNumber": None}
        order_key = day
    else:
        if not re.fullmatch(r"\d{6}", stem):
            raise ValueError(f"Unexpected issue PDF name: {path}")
        year, number = stem[:4], int(stem[4:])
        item_key = stem
        relative_item = Path("items") / year / f"{stem}.json.gz"
        delivery_prefix = f"content/newspapers/{publication.slug}/items/{year}/{stem}"
        asset_path = f"assets/pdfs/{year}/{stem}.pdf"
        title = f"{publication.title} {year}年第{number}期"
        metadata = {"publishedDate": None, "issueNumber": stem[4:]}
        order_key = stem
    return {
        "source": path,
        "sourceStem": stem,
        "year": stem[:4],
        "itemKey": item_key,
        "relativeItem": relative_item,
        "deliveryPrefix": delivery_prefix,
        "assetPath": asset_path,
        "title": title,
        "metadata": metadata,
        "orderKey": order_key,
    }


def discover(publication: Publication, year: str | None = None) -> list[dict[str, Any]]:
    if not publication.root.is_dir():
        raise FileNotFoundError(publication.root)
    rows = [parse_source(publication, path) for path in publication.root.rglob("*.pdf")]
    if year:
        rows = [row for row in rows if row["year"] == year]
    rows.sort(key=lambda row: row["orderKey"])
    keys = [str(row["itemKey"]) for row in rows]
    duplicates = sorted(key for key, count in Counter(keys).items() if count > 1)
    if duplicates:
        raise ValueError(f"Duplicate {publication.code} issue keys: {duplicates[:10]}")
    if not rows:
        raise ValueError(f"No PDFs found for {publication.code}")
    return rows


def viewer_pdf_url(publication: Publication, asset_path: str) -> str:
    return (
        "https://huggingface.co/datasets/luoxiaozhuang/marxism-dataset/resolve/main/"
        f"newspapers/{publication.slug}/{asset_path}"
    )


def build_publication(
    publication: Publication,
    output: Path,
    generated_at: str,
    limit: int | None = None,
    year: str | None = None,
) -> dict[str, Any]:
    rows = discover(publication, year)
    if limit is not None:
        rows = rows[:limit]
    canonical_root = output / "canonical" / "newspapers" / publication.slug
    hf_root = output / "huggingface" / "newspapers" / publication.slug
    delivery_root = output / "delivery"
    if canonical_root.exists() or hf_root.exists():
        raise SystemExit(f"Publication output already exists: {publication.slug}")

    year_stream: gzip.GzipFile | None = None
    current_year: str | None = None
    summaries: list[dict[str, Any]] = []
    total_bytes = 0
    for order, row in enumerate(rows, 1):
        source = Path(row["source"])
        digest = common.sha256_file(source)
        size = source.stat().st_size
        total_bytes += size
        asset_path = str(row["assetPath"])
        canonical_pdf = canonical_root / asset_path
        common.hardlink_or_copy(source, canonical_pdf)
        common.hardlink_or_copy(canonical_pdf, hf_root / asset_path)

        item = {
            "formatVersion": "jojo-item/1",
            "revision": 1,
            "itemId": f"{publication.slug}:{row['itemKey']}",
            "datasetId": publication.slug,
            "type": publication.item_type,
            "title": row["title"],
            "language": "zh-CN",
            "publicationStatus": "published",
            "access": "public",
            "availability": {"text": "missing", "pdf": "available"},
            "identifiers": {"sourceIssueKey": row["sourceStem"]},
            "metadata": row["metadata"],
            "content": {
                "schema": f"jojo-content/{publication.item_type}/1",
                "pages": [],
                "articles": [],
                "placements": [],
            },
            "assets": [{
                "id": f"asset:issue-pdf-{digest[:16]}",
                "type": "pdf",
                "role": "issue-pdf",
                "mediaType": "application/pdf",
                "title": f"{row['title']} 原刊",
                "alt": None,
                "caption": None,
                "size": size,
                "sha256": digest,
                "path": asset_path,
            }],
            "annotations": [],
            "provenance": {
                "source": "local-periodical-pdf-archive",
                "sourceId": row["sourceStem"],
                "sourceFormat": "pdf",
                "sourceSha256": digest,
                "importedAt": generated_at,
                "importer": "tools/rmrb-repair/prepare_pdf_periodicals.py",
            },
            "extensions": {publication.slug: {
                "legacyPdfObject": f"{publication.code}/{row['year']}/{row['sourceStem']}.pdf",
            }},
        }
        canonical_item = canonical_root / row["relativeItem"]
        common.write_json_gz(canonical_item, item)
        common.hardlink_or_copy(canonical_item, hf_root / row["relativeItem"])

        if current_year != row["year"]:
            if year_stream:
                year_stream.close()
            viewer_path = hf_root / "data" / "issues" / f"{row['year']}.jsonl.gz"
            viewer_path.parent.mkdir(parents=True, exist_ok=True)
            year_stream = gzip.open(viewer_path, "wt", encoding="utf-8", newline="\n", compresslevel=6)
            current_year = str(row["year"])
        assert year_stream is not None
        year_stream.write(common.json_dump({
            "publication": publication.title,
            "issueKey": row["itemKey"],
            "date": row["metadata"]["publishedDate"],
            "issue": row["metadata"]["issueNumber"],
            "title": row["title"],
            "textStatus": "missing",
            "pdfStatus": "available",
            "pdf": viewer_pdf_url(publication, asset_path),
        }) + "\n")

        item_prefix = str(row["deliveryPrefix"])
        pdf_object = "assets/issue.pdf.jox"
        info = common.write_jox_file(delivery_root, f"{item_prefix}/{pdf_object}", source)
        manifest = {
            "formatVersion": "jojo-item-manifest/1",
            "revision": 1,
            "itemId": item["itemId"],
            "datasetId": publication.slug,
            "type": publication.item_type,
            "title": row["title"],
            "language": "zh-CN",
            "publicationStatus": "published",
            "access": "public",
            "availability": {"text": "missing", "pdf": "available"},
            "identifiers": item["identifiers"],
            "metadata": item["metadata"],
            "content": {"schema": f"jojo-content/{publication.item_type}/1", "articles": []},
            "contentStats": {
                "articleCount": 0,
                "availableArticleCount": 0,
                "missingArticleCount": 0,
                "characterCount": 0,
            },
            "assets": [{
                "id": item["assets"][0]["id"],
                "type": "pdf",
                "role": "issue-pdf",
                "mediaType": "application/pdf",
                "title": item["assets"][0]["title"],
                "alt": None,
                "caption": None,
                "object": pdf_object,
                **info,
            }],
            "exports": [],
        }
        common.write_jox_json(delivery_root, f"{item_prefix}/manifest.jox", manifest)
        summaries.append({
            "itemId": item["itemId"],
            "itemKey": row["itemKey"],
            "type": publication.item_type,
            "order": order,
            "title": row["title"],
            "publishedDate": row["metadata"]["publishedDate"],
            "path": row["relativeItem"].as_posix(),
            "manifestObject": f"{item_prefix.split(f'content/newspapers/{publication.slug}/', 1)[1]}/manifest.jox",
            "availability": {"text": "missing", "pdf": "available"},
        })
    if year_stream:
        year_stream.close()

    item_path = "items/{YYYY}/{MM}/{YYYY-MM-DD}.json.gz" if publication.key_kind == "daily" else "items/{YYYY}/{YYYYNN}.json.gz"
    dataset: dict[str, Any] = {
        "formatVersion": "jojo-dataset/1",
        "datasetId": publication.slug,
        "type": publication.item_type,
        "title": publication.title,
        "language": "zh-CN",
        "publicationStatus": "published",
        "access": "public",
        "description": f"《{publication.title}》整期 PDF 数据集；当前尚无文章级文本目录。",
        "itemPath": item_path,
    }
    index: dict[str, Any] = {
        "formatVersion": "jojo-delivery-index/1",
        "revision": 1,
        "datasetId": publication.slug,
        "type": publication.item_type,
        "title": publication.title,
        "language": "zh-CN",
        "description": dataset["description"],
        "publicationStatus": "published",
        "access": "public",
    }
    if publication.key_kind == "daily":
        available_dates = {str(row["itemKey"]) for row in rows}
        start_date, end_date = min(available_dates), max(available_dates)
        availability = {
            "formatVersion": "jojo-periodical-availability/1",
            "text": common.adaptive_calendar(start_date, end_date, set()),
            "pdf": common.adaptive_calendar(start_date, end_date, available_dates),
        }
        dataset["availability"] = availability
        index["availability"] = availability
        index["itemPath"] = "items/{YYYY}/{MM}/{YYYY-MM-DD}/manifest.jox"
    else:
        dataset["items"] = summaries
        index["items"] = [{
            key: summary[key]
            for key in ("itemId", "itemKey", "type", "order", "title", "manifestObject", "availability")
        } for summary in summaries]

    common.write_json(canonical_root / "dataset.json", dataset)
    common.write_json(hf_root / "dataset.json", dataset)
    (hf_root / "README.md").write_text(
        f"# {publication.title}\n\n《{publication.title}》整期 PDF 数据集。当前仅提供期级 PDF，文章文本状态明确为 `missing`。\n\n"
        "- `data/issues/*.jsonl.gz`：按年份分片的期级索引。\n"
        "- `items/`：每期规范化元数据。\n"
        "- `assets/pdfs/`：使用日期或期号命名的原始整期 PDF。\n",
        encoding="utf-8", newline="\n",
    )
    common.write_jox_json(delivery_root, f"content/newspapers/{publication.slug}/index.jox", index)
    return {
        "datasetId": publication.slug,
        "title": publication.title,
        "itemCount": len(rows),
        "pdfCount": len(rows),
        "pdfBytes": total_bytes,
        "textAvailability": "missing",
        "pdfAvailability": "available",
    }


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    selected = {value.lower() for value in args.publication} if args.publication else None
    publications = [row for row in PUBLICATIONS if selected is None or row.slug in selected or row.code.lower() in selected]
    if not publications:
        raise SystemExit("No matching publications")
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    reports = [build_publication(row, output, generated_at, args.limit, args.year) for row in publications]
    newspapers_root = output / "huggingface" / "newspapers"
    entries = [
        f"- [`{row.slug}/`]({row.slug}/)：《{row.title}》"
        for row in (Publication("RMRB", "rmrb", "人民日报", "newspaper", "daily", Path()), *PUBLICATIONS)
        if (newspapers_root / row.slug).is_dir()
    ]
    newspapers_root.mkdir(parents=True, exist_ok=True)
    (newspapers_root / "README.md").write_text(
        "# 报刊数据集\n\n按报刊种类组织的文本、期级元数据与整期 PDF。\n\n" + "\n".join(entries) + "\n",
        encoding="utf-8", newline="\n",
    )
    report = {
        "formatVersion": "jojo-pdf-periodicals-report/1",
        "generatedAt": generated_at,
        "publications": reports,
        "itemCount": sum(row["itemCount"] for row in reports),
        "pdfBytes": sum(row["pdfBytes"] for row in reports),
        "scope": "staging-only",
        "b2Uploaded": False,
        "huggingFaceUploaded": False,
    }
    common.write_json(output / "pdf-periodicals-report.json", report)
    return report


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--publication", action="append", default=[])
    result.add_argument("--limit", type=int)
    result.add_argument("--year")
    return result


def main() -> None:
    args = parser().parse_args()
    print(json.dumps(prepare(args), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
