"""Publish daily PDFs through the existing HF Canonical -> B2 Delivery format.

The old uppercase B2 directories are never publication destinations. Manifests
are committed only after their immutable media objects have been uploaded.
"""
from __future__ import annotations

import copy
import gzip
import hashlib
import json
import os
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "content-pipeline"))
from jojo_format import _adaptive_calendar, _available_dates, _decode_jox, _write_jox, _write_jox_file

DATASET = "newspapers/rmrb/dataset.json"
INDEX = "content/newspapers/rmrb/index.jox"
MUTABLE_CACHE = "public, max-age=0, must-revalidate"
IMMUTABLE_CACHE = "public, max-age=31536000, immutable"


def issue_keys(day: date) -> tuple[str, str, str]:
    suffix = f"{day:%Y/%m}/{day.isoformat()}"
    return (f"newspapers/rmrb/items/{suffix}.json.gz",
            f"newspapers/rmrb/assets/pdfs/{suffix}.pdf",
            f"content/newspapers/rmrb/items/{suffix}/manifest.jox")


def add_pdf_date(availability: dict, day: date) -> dict:
    """Extend each calendar without accidentally marking intervening dates available."""
    result = copy.deepcopy(availability)
    for kind in ("pdf", "text"):
        calendar = result[kind]
        available = _available_dates(calendar)
        if kind == "pdf":
            available.add(day.isoformat())
        calendar["startDate"] = min(calendar["startDate"], day.isoformat())
        calendar["endDate"] = max(calendar["endDate"], day.isoformat())
        result[kind] = _adaptive_calendar(calendar, available)
    return result


def write_json(root: Path, key: str, value: dict) -> Path:
    path = root / key
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    path.write_bytes(gzip.compress(raw, mtime=0) if key.endswith(".gz") else raw)
    return path


def replace_issue_pdf(assets: list[dict], replacement: dict) -> list[dict]:
    pdfs = [asset for asset in assets if asset.get("type") == "pdf"]
    selected = next((asset for asset in pdfs if asset.get("role") == "issue-pdf"), None)
    if selected is None and len(pdfs) > 1:
        raise ValueError("Cannot identify the primary issue PDF")
    selected = selected or (pdfs[0] if pdfs else None)
    return [asset for asset in assets if asset is not selected] + [replacement]


class HuggingFace:
    def __init__(self, repo: str | None = None):
        from huggingface_hub import HfApi
        self.repo = repo or os.getenv("RMRB_REVIEW_HF_REPO") or os.getenv("HF_DATASET_REPO") or "luoxiaozhuang/marxism-dataset"
        self.api = HfApi(token=os.getenv("HF_TOKEN") or None)
        self.revision = self.api.repo_info(self.repo, repo_type="dataset", expand=["sha"], timeout=30).sha

    def file(self, key: str) -> Path | None:
        from huggingface_hub import hf_hub_download
        from huggingface_hub.errors import EntryNotFoundError
        try:
            return Path(hf_hub_download(self.repo, key, repo_type="dataset", revision=self.revision, token=os.getenv("HF_TOKEN") or None))
        except EntryNotFoundError:
            return None

    def read(self, key: str) -> dict | None:
        path = self.file(key)
        if path is None:
            return None
        raw = path.read_bytes()
        return json.loads(gzip.decompress(raw) if key.endswith(".gz") else raw)

    def publish(self, files: dict[str, Path], day: date):
        from huggingface_hub import CommitOperationAdd
        commit = self.api.create_commit(
            self.repo, repo_type="dataset", parent_commit=self.revision,
            commit_message=f"Publish RMRB PDF {day.isoformat()}",
            operations=[CommitOperationAdd(path_in_repo=key, path_or_fileobj=str(path)) for key, path in files.items()],
        )
        self.revision = commit.oid


class Delivery:
    def __init__(self, remote: str, work: Path):
        self.remote = remote.rstrip("/")
        self.work = work
        self.snapshots: dict[str, bytes | None] = {}

    def file(self, key: str) -> Path | None:
        target = self.work / "remote" / key
        target.parent.mkdir(parents=True, exist_ok=True)
        flags = ["--retries", "2", "--low-level-retries", "2", "--contimeout", "15s", "--timeout", "60s", "--max-duration", "120s"]
        remote_path = f"{self.remote}/{key}"
        result = subprocess.run(["rclone", "lsjson", remote_path, "--stat", *flags], capture_output=True, timeout=150)
        if result.returncode in (3, 4):
            return None
        if result.returncode:
            raise RuntimeError(f"Cannot read {key}: {result.stderr.decode(errors='replace')[:500]}")
        info = json.loads(result.stdout)
        # Some rclone S3 versions return a synthetic directory for a missing
        # exact object, rather than exit code 4. Never decode that as a file.
        if info.get("IsDir"):
            if info.get("Path") == "" and info.get("Size") == -1:
                return None
            raise RuntimeError(f"Expected an object, found a directory: {key}")
        expected = info["Size"]
        with target.open("wb") as stream:
            result = subprocess.run(["rclone", "cat", remote_path, *flags], stdout=stream, stderr=subprocess.PIPE, timeout=150)
        if result.returncode or target.stat().st_size != expected:
            raise RuntimeError(f"Incomplete read of {key}: {result.stderr.decode(errors='replace')[:500]}")
        return target

    def read(self, key: str) -> dict | None:
        path = self.file(key)
        self.snapshots[key] = path.read_bytes() if path else None
        return _decode_jox(path, key) if path else None

    def unchanged(self, key: str):
        path = self.file(key)
        current = path.read_bytes() if path else None
        if current != self.snapshots[key]:
            raise RuntimeError(f"Delivery changed while preparing {key}; retry from the current revision")

    def publish(self, key: str, path: Path, *, immutable: bool = False):
        cache = IMMUTABLE_CACHE if immutable else MUTABLE_CACHE
        # rclone's native B2 backend needs the B2 metadata spelling as well.
        subprocess.run(["rclone", "copyto", str(path), f"{self.remote}/{key}",
                        "--header-upload", f"Cache-Control: {cache}",
                        "--header-upload", f"X-Bz-Info-b2-cache-control: {cache}",
                        "--retries", "5", "--low-level-retries", "10",
                        *(["--immutable", "--checksum"] if immutable else [])], check=True)


def prepare_issue(day: date, pdf: Path, canonical, delivery, work: Path) -> dict:
    """Read current metadata and stage exact files without changing either remote."""
    with pdf.open("rb") as stream:
        valid_pdf = stream.read(5) == b"%PDF-"
    if not valid_pdf:
        raise ValueError("Canonical source must be a decoded PDF")
    item_key, pdf_key, manifest_key = issue_keys(day)
    dataset = canonical.read(DATASET)
    index = delivery.read(INDEX)
    if not dataset or not index or dataset.get("datasetId") != "rmrb" or index.get("datasetId") != "rmrb":
        raise ValueError("Published RMRB Canonical and Delivery indices are required")
    item = canonical.read(item_key)
    manifest = delivery.read(manifest_key)
    expected_id = f"rmrb:{day.isoformat()}"
    for existing in (item, manifest):
        if existing and (existing.get("itemId") != expected_id or existing.get("datasetId") != "rmrb"):
            raise ValueError("Existing issue identity does not match the target date")
    if item is None:
        if manifest is not None:
            raise ValueError("Delivery has an issue without Canonical; repair its source first")
        item = {
            "formatVersion": "jojo-item/1", "itemId": expected_id, "datasetId": "rmrb", "type": "newspaper",
            "title": f"人民日报 {day.isoformat()}", "language": "zh-CN", "publicationStatus": "published", "access": "public",
            "identifiers": {"peopleDataDate": day.strftime("%Y%m%d")},
            "metadata": {"publishedDate": day.isoformat(), "issueNumber": None},
            "content": {"schema": "jojo-content/newspaper/1", "pages": [], "articles": [], "placements": []}, "assets": [],
            "annotations": [], "extensions": {},
            "provenance": {"source": "archive-pdf", "sourceId": day.strftime("%Y%m%d"), "sourceFormat": "pdf",
                           "importer": "tools/archive-pdf/sync_rmrb.py", "importedAt": datetime.now(timezone.utc).isoformat()},
        }
    if manifest is None:
        if item.get("content", {}).get("articles") or any(a.get("type") != "pdf" for a in item.get("assets", [])):
            raise ValueError("Rebuild the existing issue's complete Delivery before updating its PDF")
        manifest = {
            **{key: copy.deepcopy(item[key]) for key in ("itemId", "datasetId", "type", "title", "language", "publicationStatus", "access", "identifiers", "metadata") if key in item},
            "formatVersion": "jojo-item-manifest/1", "revision": 0,
            "content": {"schema": "jojo-content/newspaper/1", "articles": []},
            "contentStats": {"articleCount": 0, "availableArticleCount": 0, "missingArticleCount": 0, "characterCount": 0},
            "availability": {"text": "missing", "pdf": "missing"}, "assets": [], "exports": [],
        }
    with pdf.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    relative = f"assets/{digest}.pdf.jox"
    object_key = manifest_key.removesuffix("manifest.jox") + relative
    asset = {"id": f"asset:issue-pdf-{digest[:16]}", "type": "pdf", "role": "issue-pdf", "mediaType": "application/pdf",
             "title": f"人民日报 {day.isoformat()} 原报", "size": pdf.stat().st_size, "sha256": digest}
    item["assets"] = replace_issue_pdf(item.get("assets", []), {**asset, "path": pdf_key.removeprefix("newspapers/rmrb/")})
    item["revision"] = int(item.get("revision", 0)) + 1
    if "availability" in item:
        item["availability"]["pdf"] = "available"
    if "rmrb" in item.get("extensions", {}):
        item["extensions"]["rmrb"]["pdfAvailable"] = True
    manifest["assets"] = replace_issue_pdf(manifest.get("assets", []), {**asset, "object": relative})
    manifest.setdefault("availability", {})["pdf"] = "available"
    manifest["revision"] = int(manifest.get("revision", 0)) + 1
    dataset["availability"] = add_pdf_date(dataset["availability"], day)
    # Use the same authoritative calendar, preserving the index's other fields.
    index["availability"] = copy.deepcopy(dataset["availability"])
    index["revision"] = int(index.get("revision", 0)) + 1
    canonical_files = {
        DATASET: write_json(work / "canonical", DATASET, dataset),
        item_key: write_json(work / "canonical", item_key, item),
        pdf_key: pdf,
    }
    delivery_files = {key: work / "delivery" / key for key in (object_key, manifest_key, INDEX)}
    _write_jox_file(delivery_files[object_key], object_key, pdf)
    _write_jox(delivery_files[manifest_key], manifest_key, manifest)
    _write_jox(delivery_files[INDEX], INDEX, index)
    return {"canonical": canonical_files, "delivery": delivery_files, "asset": object_key, "manifest": manifest_key}


def publish_issue(day: date, plan: dict, canonical, delivery):
    for key in (plan["manifest"], INDEX):
        delivery.unchanged(key)
    canonical.publish(plan["canonical"], day)
    delivery.publish(plan["asset"], plan["delivery"][plan["asset"]], immutable=True)
    # Recheck after the slower Canonical/media upload so an operator's edits survive.
    for key in (plan["manifest"], INDEX):
        delivery.unchanged(key)
        delivery.publish(key, plan["delivery"][key])
