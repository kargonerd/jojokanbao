#!/usr/bin/env python3
"""Stage and publish the final RMRB JSONL reconciliation to HF and B2."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any, Callable


WORKSPACE = Path(__file__).resolve().parents[2]
TOOLS_DIR = Path(__file__).resolve().parent
ADMIN_SERVER = WORKSPACE / "tools" / "jojo-admin" / "server"
sys.path.insert(0, str(TOOLS_DIR))
sys.path.insert(0, str(ADMIN_SERVER))

from publish_rmrb_jsonl_recovery import (  # noqa: E402
    cache_delivery_source,
    cache_hf_source,
    hf_git_head,
    staged_files,
    upload_b2,
)
from publish_rmrb_jsonl_supplements import upload_hf_year  # noqa: E402
from rmrb_review_publish import (  # noqa: E402
    MISSING_INDEX,
    _read_jsonl_gz,
    prepare_canonical_jsonl_reconciliation,
    prepare_delivery_jsonl_reconciliation,
)


DEFAULT_HF_REPO = "luoxiaozhuang/marxism-dataset"
DEFAULT_B2_REMOTE = "jojo-b2-s3:jojo-newspaper"
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")


ArticleKey = tuple[str, int, int]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def load_rows(path: Path) -> dict[ArticleKey, dict[str, object]]:
    rows: dict[ArticleKey, dict[str, object]] = {}
    with path.open(encoding="utf-8-sig") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            key = (str(row["date"])[:10], int(row["page"]), int(row["ordinal"]))
            if key in rows:
                raise ValueError(f"Duplicate migration key at line {line_number}: {key}")
            rows[key] = row
    return rows


def validate_final_report(
    report_path: Path, upserts_path: Path, removals_path: Path,
) -> dict[str, Any]:
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("safe") is not True:
        raise ValueError("Final reconciliation report is not safe")
    expected = {
        "upserts": (upserts_path, "upsertRows"),
        "removals": (removals_path, "removeObsoleteRows"),
    }
    for name, (path, count_field) in expected.items():
        reported = Path(str(report.get(f"{name}Path") or ""))
        if not reported.is_absolute() or reported.resolve() != path.resolve():
            raise ValueError(f"Final report describes another {name} file")
        if report.get(f"{name}Sha256") != sha256_file(path):
            raise ValueError(f"Final report {name} digest is stale")
        if sum(1 for line in path.open(encoding="utf-8-sig") if line.strip()) != int(report[count_field]):
            raise ValueError(f"Final report {name} count is stale")
    return report


def hf_patterns(
    upserts: dict[ArticleKey, dict[str, object]],
    removals: dict[ArticleKey, dict[str, object]],
) -> list[str]:
    keys = set(upserts) | set(removals)
    years = sorted({key[0][:4] for key in keys})
    days = sorted({key[0] for key in keys})
    return [
        "newspapers/rmrb/dataset.json",
        MISSING_INDEX,
        *(f"newspapers/rmrb/data/articles/{year}.jsonl.gz" for year in years),
        *(f"newspapers/rmrb/items/{day[:4]}/{day[5:7]}/{day}.json.gz" for day in days),
    ]


def delivery_paths(
    upserts: dict[ArticleKey, dict[str, object]],
    removals: dict[ArticleKey, dict[str, object]],
) -> list[str]:
    days = sorted({key[0] for key in set(upserts) | set(removals)})
    return [
        "content/newspapers/rmrb/index.jox",
        *(f"content/newspapers/rmrb/items/{day[:4]}/{day[5:7]}/{day}/manifest.jox" for day in days),
    ]


def seeded_file(seed_root: Path, kind: str, name: str) -> Path | None:
    parts = Path(name).parts
    year = ""
    if "articles" in parts:
        year = Path(name).name[:4]
    elif "items" in parts:
        index = parts.index("items")
        year = parts[index + 1]
    if not year:
        return None
    candidate = seed_root / year / kind / Path(name)
    return candidate if candidate.is_file() else None


def source_resolver(
    downloaded: Path,
    seed_root: Path,
    kind: str,
    fixed: dict[str, Path] | None = None,
) -> Callable[[str], Path]:
    fixed = fixed or {}

    def resolve(name: str) -> Path:
        downloaded_path = downloaded / Path(name)
        if downloaded_path.is_file():
            return downloaded_path
        seeded = seeded_file(seed_root, kind, name)
        if seeded is not None:
            return seeded
        explicit = fixed.get(name)
        if explicit is not None and explicit.is_file():
            return explicit
        raise FileNotFoundError(f"Pinned source file is unavailable: {name}")

    return resolve


def save_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def stage(args: argparse.Namespace) -> dict[str, Any]:
    work = args.work.resolve()
    if work.exists() and any(work.iterdir()) and not args.resume:
        raise SystemExit(f"Work directory is not empty: {work}")
    work.mkdir(parents=True, exist_ok=True)
    final_report = validate_final_report(args.final_report, args.upserts, args.removals)
    upserts = load_rows(args.upserts)
    removals = load_rows(args.removals)
    revision = hf_git_head(args.hf_repo)
    save_json(work / "source-revision.json", {"hfRepo": args.hf_repo, "revision": revision})

    missing_seed = args.missing_seed.resolve()
    fixed_hf = {MISSING_INDEX: missing_seed}
    hf_download = work / "hf-source"
    hf_resolve = source_resolver(hf_download, args.seed_root.resolve(), "canonical", fixed_hf)
    patterns = hf_patterns(upserts, removals)
    missing_patterns: list[str] = []
    for name in patterns:
        try:
            hf_resolve(name)
        except FileNotFoundError:
            missing_patterns.append(name)
    if missing_patterns:
        cache_hf_source(args.hf_repo, revision, missing_patterns, args.hf_workers, hf_download)

    b2_download = work / "delivery-source"
    b2_resolve = source_resolver(b2_download, args.seed_root.resolve(), "delivery")
    missing_delivery: list[str] = []
    for name in delivery_paths(upserts, removals):
        try:
            b2_resolve(name)
        except FileNotFoundError:
            missing_delivery.append(name)
    if missing_delivery:
        cache_delivery_source(args.b2_remote, missing_delivery, b2_download, args.b2_transfers)

    missing_before = len(_read_jsonl_gz(hf_resolve(MISSING_INDEX)))
    missing_keys_before = {
        (str(row["date"]), int(row["page"]), int(row["ordinal"]))
        for row in _read_jsonl_gz(hf_resolve(MISSING_INDEX))
    }
    catalog_target_keys = {
        key
        for key, row in upserts.items()
        if str(row.get("matchMethod") or "") != "jsonl_directory_omission"
    }
    missing_catalog_targets = catalog_target_keys & missing_keys_before
    available_catalog_targets = catalog_target_keys - missing_keys_before
    canonical = prepare_canonical_jsonl_reconciliation(
        upserts, removals, hf_resolve, work / "canonical",
    )
    delivery = prepare_delivery_jsonl_reconciliation(
        upserts, removals, canonical, b2_resolve, work / "delivery",
    )
    missing_after = len(_read_jsonl_gz(canonical.files[MISSING_INDEX]))
    canonical_file_count = len(staged_files(work / "canonical"))
    delivery_file_count = len(staged_files(work / "delivery"))
    report: dict[str, Any] = {
        "formatVersion": "jojo-rmrb-jsonl-reconciliation-publication/1",
        "safe": (
            canonical.removed_article_count == int(final_report["removeObsoleteRows"])
            and len(catalog_target_keys) == int(final_report["peopleDataBodyUpserts"])
            and missing_before - missing_after == len(missing_catalog_targets)
        ),
        "hfRepo": args.hf_repo,
        "hfParentCommit": revision,
        "b2Remote": args.b2_remote,
        "upsertRows": len(upserts),
        "removalRows": len(removals),
        "catalogTargetRows": len(catalog_target_keys),
        "missingCatalogTargetsBefore": len(missing_catalog_targets),
        "availableCatalogTargetsBefore": len(available_catalog_targets),
        "changedCanonicalArticles": canonical.changed_article_count,
        "removedCanonicalArticles": canonical.removed_article_count,
        "canonicalFiles": canonical_file_count,
        "changedDeliveryArticles": delivery.changed_article_count,
        "removedDeliveryArticles": delivery.removed_article_count,
        "deliveryFiles": delivery_file_count,
        "missingBefore": missing_before,
        "missingAfter": missing_after,
        "missingReducedBy": missing_before - missing_after,
        "published": False,
    }
    if not report["safe"]:
        raise RuntimeError(f"Staged reconciliation accounting is unsafe: {report}")
    save_json(work / "report.json", report)
    return report


def publish_staged(args: argparse.Namespace) -> dict[str, Any]:
    work = args.work.resolve()
    report_path = work / "report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("safe") is not True:
        raise RuntimeError("Staged reconciliation is not safe")
    if report.get("published") is True:
        return report
    canonical_files = staged_files(work / "canonical")
    delivery_files = staged_files(work / "delivery")
    if len(canonical_files) != int(report["canonicalFiles"]):
        raise RuntimeError("Canonical stage file count changed")
    if len(delivery_files) != int(report["deliveryFiles"]):
        raise RuntimeError("Delivery stage file count changed")

    state_path = work / "publish-state.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.is_file() else {
        "formatVersion": "jojo-rmrb-jsonl-reconciliation-publish-state/1",
        "years": {},
    }
    current = hf_git_head(args.hf_repo)
    expected = str(state.get("hfHead") or report["hfParentCommit"])
    if current != expected:
        raise RuntimeError(f"HF advanced outside this publication: {expected} -> {current}")

    years = sorted({
        parts[3]
        for name in canonical_files
        if (parts := Path(name).parts)[:3] == ("newspapers", "rmrb", "items")
    } | {
        Path(name).name[:4]
        for name in canonical_files
        if name.startswith("newspapers/rmrb/data/articles/")
    })
    for year in years:
        if state["years"].get(year):
            continue
        files = {
            name: path
            for name, path in canonical_files.items()
            if name == f"newspapers/rmrb/data/articles/{year}.jsonl.gz"
            or name.startswith(f"newspapers/rmrb/items/{year}/")
        }
        current = upload_hf_year(
            args.hf_repo,
            current,
            files,
            year,
            int(report["changedCanonicalArticles"]),
            args.hf_workers,
        )
        state["years"][year] = current
        state["hfHead"] = current
        save_json(state_path, state)
        print(f"published HF reconciliation year {year}: {len(files)} files", flush=True)

    global_files = {
        name: path
        for name, path in canonical_files.items()
        if name in {"newspapers/rmrb/dataset.json", MISSING_INDEX}
    }
    if not state.get("globalCommit") and global_files:
        current = upload_hf_year(
            args.hf_repo,
            current,
            global_files,
            "indexes",
            int(report["missingReducedBy"]),
            args.hf_workers,
        )
        state["globalCommit"] = current
        state["hfHead"] = current
        save_json(state_path, state)
    upload_b2(args.b2_remote, work / "delivery", args.b2_transfers)
    state["b2Complete"] = True
    save_json(state_path, state)
    report.update({"published": True, "hfCommit": state.get("hfHead")})
    save_json(report_path, report)
    return report


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--upserts", required=True, type=Path)
    result.add_argument("--removals", required=True, type=Path)
    result.add_argument("--final-report", required=True, type=Path)
    result.add_argument("--work", required=True, type=Path)
    result.add_argument("--seed-root", required=True, type=Path)
    result.add_argument("--missing-seed", required=True, type=Path)
    result.add_argument("--hf-repo", default=DEFAULT_HF_REPO)
    result.add_argument("--b2-remote", default=DEFAULT_B2_REMOTE)
    result.add_argument("--hf-workers", type=int, default=32)
    result.add_argument("--b2-transfers", type=int, default=128)
    result.add_argument("--resume", action="store_true")
    result.add_argument("--publish-staged", action="store_true")
    return result


def main() -> None:
    args = parser().parse_args()
    action = publish_staged if args.publish_staged else stage
    print(json.dumps(action(args), ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
