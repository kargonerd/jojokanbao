#!/usr/bin/env python3
"""Backfill Hugging Face Canonical from Delivery for item-enumerated magazines.

Delivery (B2) keeps the protected full-issue PDFs; Canonical (HF) keeps the
original PDFs and per-issue metadata. A magazine Delivery dataset can advance
without a Canonical commit, so this tool recreates the missing Canonical items
from Delivery. The Jox transform is a reversible byte mask, so the recovered
PDFs are byte-identical to the published originals.

Commands (run from the repository root):

    python tools/archive-pdf/canonicalize_magazines.py prepare --publication hq
    python tools/archive-pdf/canonicalize_magazines.py upload  --publication hq
    python tools/archive-pdf/canonicalize_magazines.py status  --publication hq

prepare downloads missing issue assets and writes Canonical items, PDFs,
dataset.json, and yearly issue shards under tmp/magazine-canonical/<pub>/.
upload commits one year per batch, then dataset.json last. Both phases are
resumable and never overwrite an existing Canonical item.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import subprocess
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

REPO = "luoxiaozhuang/jojokanbao-dataset"
REMOTE = os.environ.get("JOJO_DELIVERY_REMOTE", "jojo-b2-s3:jojo-newspaper")
CDN = "https://blacknews.jojokanbao.cn"
PUBLICATIONS = {
    "hq": {"title": "红旗"},
    "sjzs": {"title": "世界知识"},
    "rmhb": {"title": "人民画报"},
}
JOX_SALT = 0x4A4F5831


# jox

def _fnv1a(value: str) -> int:
    digest = 0x811C9DC5
    for byte in value.encode("utf-8"):
        digest ^= byte
        digest = (digest * 0x01000193) & 0xFFFFFFFF
    return digest


def _mask_byte(position: int, seed: int) -> int:
    value = ((position & 0xFFFFFFFF) + 0x9E3779B9) & 0xFFFFFFFF
    value ^= seed ^ JOX_SALT
    value &= 0xFFFFFFFF
    value ^= value >> 16
    value = (value * 0x7FEB352D) & 0xFFFFFFFF
    value ^= value >> 15
    value = (value * 0x846CA68B) & 0xFFFFFFFF
    value ^= value >> 16
    return value & 0xFF


def protect(data: bytes, key: str) -> bytes:
    seed = _fnv1a(key.replace("\\", "/").lstrip("/"))
    return bytes(byte ^ _mask_byte(index, seed) for index, byte in enumerate(data))


def decode_jox(data: bytes, key: str) -> dict:
    return json.loads(gzip.decompress(protect(data, key)).decode("utf-8"))


# delivery

def delivery_index(pub: str, work: Path) -> dict:
    key = f"content/newspapers/{pub}/index.jox"
    cached = work / "index.jox.bin"
    if not cached.is_file():
        cached.parent.mkdir(parents=True, exist_ok=True)
        url = f"{CDN}/{key}"
        print(f"fetching {url}", flush=True)
        with urllib.request.urlopen(url, timeout=120) as response:
            cached.write_bytes(response.read())
    return decode_jox(cached.read_bytes(), key)


def fetch_asset(pub: str, issue: str, work: Path) -> Path:
    year = issue[:4]
    object_key = f"content/newspapers/{pub}/items/{year}/{issue}/assets/issue.pdf.jox"
    target = work / "jox" / year / f"{issue}.pdf.jox"
    if target.is_file() and target.stat().st_size > 0:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".part")
    result = subprocess.run(
        ["rclone", "copyto", f"{REMOTE}/{object_key}", str(temporary),
         "--retries", "5", "--low-level-retries", "5", "--timeout", "180s"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"rclone failed for {object_key}: {result.stderr[:400]}")
    temporary.replace(target)
    return target


# canonical

def canonical_dataset(pub: str, work: Path) -> dict:
    from huggingface_hub import hf_hub_download

    target = work / "dataset.json"
    if target.is_file():
        return json.loads(target.read_text(encoding="utf-8"))
    path = hf_hub_download(REPO, f"newspapers/{pub}/dataset.json", repo_type="dataset")
    return json.loads(Path(path).read_text(encoding="utf-8"))


def issue_title(pub: str, issue: str) -> str:
    return f"{PUBLICATIONS[pub]['title']} {issue[:4]}年第{int(issue[4:])}期"


def build_item(pub: str, issue: str, pdf: bytes, delivery_key: str, imported_at: str) -> dict:
    digest = hashlib.sha256(pdf).hexdigest()
    asset_path = f"assets/pdfs/{issue[:4]}/{issue}.pdf"
    title = issue_title(pub, issue)
    return {
        "formatVersion": "jojo-item/1",
        "revision": 1,
        "itemId": f"{pub}:{issue}",
        "datasetId": pub,
        "type": "magazine",
        "title": title,
        "language": "zh-CN",
        "publicationStatus": "published",
        "access": "public",
        "availability": {"text": "missing", "pdf": "available"},
        "identifiers": {"sourceIssueKey": issue},
        "metadata": {"publishedDate": None, "issueNumber": issue[4:]},
        "content": {
            "schema": "jojo-content/magazine/1",
            "pages": [],
            "articles": [],
            "placements": [],
        },
        "assets": [{
            "id": f"asset:issue-pdf-{digest[:16]}",
            "type": "pdf",
            "role": "issue-pdf",
            "mediaType": "application/pdf",
            "title": f"{title} 原刊",
            "alt": None,
            "caption": None,
            "size": len(pdf),
            "sha256": digest,
            "path": asset_path,
        }],
        "annotations": [],
        "provenance": {
            "source": "delivery-jox",
            "sourceId": issue,
            "sourceFormat": "pdf",
            "sourceSha256": digest,
            "importedAt": imported_at,
            "importer": "tools/archive-pdf/canonicalize_magazines.py",
        },
        "extensions": {pub: {"deliveryObject": delivery_key}},
    }


def write_json_gz(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    path.write_bytes(gzip.compress(raw, mtime=0))


def viewer_line(pub: str, issue: str) -> str:
    record = {
        "publication": PUBLICATIONS[pub]["title"],
        "issueKey": issue,
        "date": None,
        "issue": issue[4:],
        "title": issue_title(pub, issue),
        "textStatus": "missing",
        "pdfStatus": "available",
        "pdf": f"https://huggingface.co/datasets/{REPO}/resolve/main/newspapers/{pub}/assets/pdfs/{issue[:4]}/{issue}.pdf",
    }
    return json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"


def prepare(pub: str, work: Path, workers: int, limit: int | None) -> None:
    index = delivery_index(pub, work)
    dataset = canonical_dataset(pub, work)
    canonical = {item["itemKey"] for item in dataset.get("items", [])}
    pending = [item for item in index["items"] if item["itemKey"] not in canonical]
    pending.sort(key=lambda item: item["itemKey"])
    if limit is not None:
        pending = pending[:limit]
    print(f"canonical items: {len(canonical)}; delivery items: {len(index['items'])}; pending: {len(pending)}", flush=True)
    if not pending:
        return

    imported_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    root = work / "canonical" / "newspapers" / pub
    built: dict[str, dict] = {}

    def one(entry: dict) -> tuple[str, dict]:
        issue = entry["itemKey"]
        item_path = root / "items" / issue[:4] / f"{issue}.json.gz"
        if item_path.is_file():
            item = json.loads(gzip.decompress(item_path.read_bytes()))
            pdf_path = root / item["assets"][0]["path"]
            if pdf_path.is_file() and pdf_path.stat().st_size == item["assets"][0]["size"]:
                return issue, item
        asset = fetch_asset(pub, issue, work)
        delivery_key = f"content/newspapers/{pub}/items/{issue[:4]}/{issue}/assets/issue.pdf.jox"
        pdf = protect(asset.read_bytes(), delivery_key)
        if pdf[:5] != b"%PDF-":
            raise RuntimeError(f"decoded asset is not a PDF: {issue}")
        item = build_item(pub, issue, pdf, delivery_key, imported_at)
        pdf_path = root / item["assets"][0]["path"]
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        if not pdf_path.is_file() or pdf_path.stat().st_size != len(pdf):
            pdf_path.write_bytes(pdf)
        write_json_gz(root / "items" / issue[:4] / f"{issue}.json.gz", item)
        return issue, item

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(one, entry): entry["itemKey"] for entry in pending}
        for done, future in enumerate(as_completed(futures), 1):
            issue, item = future.result()
            built[issue] = item
            if done % 10 == 0 or done == len(pending):
                print(f"prepared {done}/{len(pending)}", flush=True)

    known = {item["itemKey"]: item for item in dataset.get("items", [])}
    for entry in pending:
        issue = entry["itemKey"]
        item = built[issue]
        known[issue] = {
            "itemId": item["itemId"],
            "itemKey": issue,
            "type": "magazine",
            "order": entry["order"],
            "title": item["title"],
            "publishedDate": None,
            "path": f"items/{issue[:4]}/{issue}.json.gz",
            "manifestObject": entry["manifestObject"],
            "availability": {"text": "missing", "pdf": "available"},
        }
    dataset["items"] = [known[key] for key in sorted(known)]
    # Delivery order can lag behind a late-inserted issue, so Canonical order is
    # derived from its own sorted item keys.
    for position, item in enumerate(dataset["items"], 1):
        item["order"] = position
    (root / "dataset.json").write_text(json.dumps(dataset, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    years: dict[str, list[str]] = {}
    for entry in pending:
        years.setdefault(entry["itemKey"][:4], []).append(entry["itemKey"])
    for year, issues in years.items():
        shard = root / "data" / "issues" / f"{year}.jsonl.gz"
        shard.parent.mkdir(parents=True, exist_ok=True)
        shard.write_bytes(gzip.compress("".join(viewer_line(pub, issue) for issue in issues).encode("utf-8"), mtime=0))
    state = load_state(work)
    state["years"] = {year: "prepared" for year in years}
    state["pending"] = [entry["itemKey"] for entry in pending]
    save_state(work, state)
    print(f"prepared {len(built)} items across {len(years)} years", flush=True)


def upload(pub: str, work: Path) -> None:
    from huggingface_hub import CommitOperationAdd, HfApi

    state = load_state(work)
    pending = state.get("pending") or []
    if not pending:
        raise SystemExit("nothing prepared; run prepare first")
    root = work / "canonical" / "newspapers" / pub
    api = HfApi()
    parent = api.repo_info(REPO, repo_type="dataset").sha
    years: dict[str, list[str]] = {}
    for issue in pending:
        years.setdefault(issue[:4], []).append(issue)

    for year in sorted(years):
        if state["years"].get(year) == "uploaded":
            print(f"{year}: already uploaded", flush=True)
            continue
        operations = []
        for issue in years[year]:
            operations.append(CommitOperationAdd(
                f"newspapers/{pub}/items/{year}/{issue}.json.gz",
                str(root / "items" / year / f"{issue}.json.gz"),
            ))
            operations.append(CommitOperationAdd(
                f"newspapers/{pub}/assets/pdfs/{year}/{issue}.pdf",
                str(root / "assets" / "pdfs" / year / f"{issue}.pdf"),
            ))
        shard = root / "data" / "issues" / f"{year}.jsonl.gz"
        if shard.is_file():
            operations.append(CommitOperationAdd(f"newspapers/{pub}/data/issues/{year}.jsonl.gz", str(shard)))
        commit = api.create_commit(
            REPO, repo_type="dataset", parent_commit=parent,
            commit_message=f"Backfill Canonical {PUBLICATIONS[pub]['title']} {year} issue PDFs",
            operations=operations,
        )
        parent = commit.oid
        state["years"][year] = "uploaded"
        save_state(work, state)
        print(f"{year}: uploaded {len(years[year])} issues ({commit.oid[:8]})", flush=True)

    if state.get("dataset") != "uploaded":
        commit = api.create_commit(
            REPO, repo_type="dataset", parent_commit=parent,
            commit_message=f"List Canonical {PUBLICATIONS[pub]['title']} issues through {pending[-1]}",
            operations=[CommitOperationAdd(f"newspapers/{pub}/dataset.json", str(root / "dataset.json"))],
        )
        state["dataset"] = "uploaded"
        save_state(work, state)
        print(f"dataset.json uploaded ({commit.oid[:8]})", flush=True)


def status(pub: str, work: Path) -> None:
    state = load_state(work)
    print(json.dumps({
        "publication": pub,
        "pending": len(state.get("pending", [])),
        "years": state.get("years", {}),
        "dataset": state.get("dataset"),
    }, ensure_ascii=False, indent=2))


def load_state(work: Path) -> dict:
    path = work / "state.json"
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    work.mkdir(parents=True, exist_ok=True)
    return {"years": {}}


def save_state(work: Path, state: dict) -> None:
    temporary = work / "state.json.tmp"
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, work / "state.json")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["prepare", "upload", "status"])
    parser.add_argument("--publication", required=True, choices=sorted(PUBLICATIONS))
    parser.add_argument("--work", default=None)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()
    if os.environ.get("all_proxy", "").startswith("socks"):
        del os.environ["all_proxy"]
    work = Path(args.work) if args.work else Path("tmp") / "magazine-canonical" / args.publication
    if args.command == "prepare":
        prepare(args.publication, work, args.workers, args.limit)
    elif args.command == "upload":
        upload(args.publication, work)
    else:
        status(args.publication, work)


if __name__ == "__main__":
    main()
