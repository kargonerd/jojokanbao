#!/usr/bin/env python3
"""Incrementally publish accepted RMRB JSONL directory omissions to HF and B2.

Each year is pinned, staged, published to HF Canonical, and only then committed
to B2 Delivery. Existing Items and manifests are patched in place; PDFs and
existing articles are never regenerated.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time
from typing import Any


WORKSPACE = Path(__file__).resolve().parents[2]
TOOLS_DIR = Path(__file__).resolve().parent
ADMIN_SERVER = WORKSPACE / "tools" / "jojo-admin" / "server"
sys.path.insert(0, str(TOOLS_DIR))
sys.path.insert(0, str(ADMIN_SERVER))

from rmrb_review_publish import (  # noqa: E402
    prepare_canonical_jsonl_supplement_append,
    prepare_delivery_jsonl_supplement_append,
)
from publish_rmrb_jsonl_recovery import (  # noqa: E402
    cache_delivery_source,
    cache_hf_source,
    hf_git_head,
    staged_files,
    upload_b2,
)


DEFAULT_HF_REPO = "luoxiaozhuang/marxism-dataset"
DEFAULT_B2_REMOTE = "jojo-b2-s3:jojo-newspaper"
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def load_supplement_rows(
    path: Path,
    report_path: Path,
) -> tuple[dict[str, dict[tuple[str, int, int], dict[str, object]]], dict[str, Any]]:
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("safe") is not True:
        raise ValueError("Classification report is not safe to publish")
    reported = Path(str(report.get("accepted") or ""))
    if not reported.is_absolute() or reported.resolve() != path.resolve():
        raise ValueError("Classification report describes another supplement file")
    expected = int(report.get("counters", {}).get("acceptedJsonlCanonicalRows", -1))
    by_year: dict[str, dict[tuple[str, int, int], dict[str, object]]] = {}
    count = 0
    with path.open(encoding="utf-8-sig") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            key = (str(row["date"]), int(row["page"]), int(row["ordinal"]))
            if (
                not str(row.get("content") or "").strip()
                or row.get("contentSource") != "jsonl"
                or row.get("matchMethod") != "jsonl_directory_omission"
                or "sourceOnly" in row
            ):
                raise ValueError(f"Invalid Canonical supplement at line {line_number}: {key}")
            year_rows = by_year.setdefault(key[0][:4], {})
            if key in year_rows:
                raise ValueError(f"Duplicate supplement key at line {line_number}: {key}")
            year_rows[key] = row
            count += 1
    if count != expected:
        raise ValueError(f"Supplement row count disagrees with report: {count} != {expected}")
    return by_year, report


def hf_patterns(year: str, rows: dict[tuple[str, int, int], dict[str, object]]) -> list[str]:
    days = sorted({key[0] for key in rows})
    return [
        "newspapers/rmrb/dataset.json",
        f"newspapers/rmrb/data/articles/{year}.jsonl.gz",
        *(f"newspapers/rmrb/items/{day[:4]}/{day[5:7]}/{day}.json.gz" for day in days),
    ]


def delivery_paths(rows: dict[tuple[str, int, int], dict[str, object]]) -> list[str]:
    days = sorted({key[0] for key in rows})
    return [
        "content/newspapers/rmrb/index.jox",
        *(f"content/newspapers/rmrb/items/{day[:4]}/{day[5:7]}/{day}/manifest.jox" for day in days),
    ]


def upload_hf_year(
    repo_id: str,
    parent_commit: str,
    files: dict[str, Path],
    year: str,
    article_count: int,
    workers: int,
) -> str:
    if not files:
        return parent_commit
    from huggingface_hub import CommitOperationAdd, HfApi, get_token

    token = get_token() or os.environ.get("HF_TOKEN", "").strip()
    if not token:
        raise RuntimeError("Hugging Face login or HF_TOKEN is required")
    operations = [
        CommitOperationAdd(path_in_repo=name, path_or_fileobj=str(path))
        for name, path in sorted(files.items())
    ]
    api = HfApi(token=token)
    for attempt in range(1, 21):
        try:
            result = api.create_commit(
                repo_id=repo_id,
                repo_type="dataset",
                operations=operations,
                commit_message=f"Add {article_count} RMRB JSONL directory omissions ({year})",
                parent_commit=parent_commit,
                num_threads=workers,
            )
            return str(result.oid)
        except Exception as exc:
            if is_hf_commit_conflict(exc):
                raise
            if attempt == 20:
                raise
            delay = min(60, attempt * 10)
            print(
                f"retry HF {year} upload after {type(exc).__name__} "
                f"({attempt}/20, {delay}s): {' '.join(str(exc).split())[:300]}",
                flush=True,
            )
            time.sleep(delay)
    raise AssertionError("unreachable")


def is_hf_commit_conflict(exc: Exception) -> bool:
    """Return true when the staged parent is no longer HF's branch head."""
    message = str(exc).lower()
    status = getattr(getattr(exc, "response", None), "status_code", None)
    return status in {409, 412} or any(
        marker in message
        for marker in (
            "parent commit",
            "a commit has happened",
            "branch was updated",
            "precondition failed",
        )
    )


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def reset_stage(path: Path, work: Path) -> None:
    resolved = path.resolve()
    if resolved.parent != work.resolve():
        raise RuntimeError(f"Unsafe staging cleanup target: {resolved}")
    if resolved.is_dir():
        shutil.rmtree(resolved)


def stage_year(
    args: argparse.Namespace,
    year: str,
    rows: dict[tuple[str, int, int], dict[str, object]],
    source_sha256: str,
) -> tuple[Path, dict[str, Any]]:
    stage = args.work.resolve() / year
    report_path = stage / "report.json"
    if report_path.is_file():
        report = json.loads(report_path.read_text(encoding="utf-8"))
        if (
            report.get("sourceSha256") == source_sha256
            and int(report.get("supplementRows") or -1) == len(rows)
            and report.get("hfRepo") == args.hf_repo
            and report.get("b2Remote") == args.b2_remote
        ):
            return stage, report
        reset_stage(stage, args.work)
    elif stage.exists():
        reset_stage(stage, args.work)
    stage.mkdir(parents=True, exist_ok=True)

    parent = hf_git_head(args.hf_repo)
    hf_source = stage / "hf-source"
    b2_source = stage / "delivery-source"
    patterns = hf_patterns(year, rows)
    for seed in args.hf_seed:
        for name in patterns:
            source = seed / name
            if not source.is_file():
                continue
            target = hf_source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    missing_patterns = [name for name in patterns if not (hf_source / name).is_file()]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        hf_future = (
            executor.submit(
                cache_hf_source,
                args.hf_repo,
                parent,
                missing_patterns,
                args.hf_workers,
                hf_source,
            )
            if missing_patterns
            else None
        )
        b2_future = executor.submit(
            cache_delivery_source,
            args.b2_remote,
            delivery_paths(rows),
            b2_source,
            args.b2_transfers,
        )
        if hf_future is not None:
            hf_future.result()
        b2_future.result()

    canonical = prepare_canonical_jsonl_supplement_append(
        rows,
        lambda name: hf_source / name,
        stage / "canonical",
    )
    delivery = prepare_delivery_jsonl_supplement_append(
        rows,
        canonical,
        lambda name: b2_source / name,
        stage / "delivery",
    )
    canonical_files = staged_files(stage / "canonical")
    delivery_files = staged_files(stage / "delivery")
    report = {
        "formatVersion": "jojo-rmrb-jsonl-supplement-year-publication/1",
        "year": year,
        "sourceSha256": source_sha256,
        "supplementRows": len(rows),
        "supplementDays": len({key[0] for key in rows}),
        "hfRepo": args.hf_repo,
        "hfParentCommit": parent,
        "b2Remote": args.b2_remote,
        "changedCanonicalArticles": canonical.changed_article_count,
        "canonicalFiles": len(canonical_files),
        "changedDeliveryArticles": delivery.changed_article_count,
        "deliveryFiles": len(delivery_files),
        "datasetChanged": canonical.dataset_changed,
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    shutil.rmtree(hf_source)
    shutil.rmtree(b2_source)
    return stage, report


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--supplements", required=True, type=Path)
    result.add_argument("--classification-report", required=True, type=Path)
    result.add_argument("--work", required=True, type=Path)
    result.add_argument("--hf-repo", default=DEFAULT_HF_REPO)
    result.add_argument("--b2-remote", default=DEFAULT_B2_REMOTE)
    result.add_argument("--hf-workers", type=int, default=32)
    result.add_argument("--b2-transfers", type=int, default=128)
    result.add_argument(
        "--hf-seed",
        action="append",
        default=[],
        type=Path,
        help="Optional local HF snapshot overlays, applied in argument order before downloads.",
    )
    result.add_argument("--year", action="append", default=[])
    result.add_argument("--publish", action="store_true")
    result.add_argument("--restage", action="store_true")
    return result


def main() -> None:
    args = parser().parse_args()
    args.work = args.work.resolve()
    args.work.mkdir(parents=True, exist_ok=True)
    rows_by_year, _classification_report = load_supplement_rows(
        args.supplements, args.classification_report
    )
    selected = sorted(set(args.year) if args.year else rows_by_year)
    unknown = [year for year in selected if year not in rows_by_year]
    if unknown:
        raise ValueError(f"Selected years have no JSONL supplement rows: {unknown}")
    source_sha256 = sha256_file(args.supplements)
    state_path = args.work / "publish-state.json"
    state = (
        json.loads(state_path.read_text(encoding="utf-8"))
        if state_path.is_file()
        else {"formatVersion": "jojo-rmrb-jsonl-supplement-publication-state/1", "years": {}}
    )
    if state.get("sourceSha256") not in (None, source_sha256):
        raise RuntimeError("Publication work directory belongs to another supplement snapshot")
    state["sourceSha256"] = source_sha256
    save_state(state_path, state)

    results: dict[str, Any] = {}
    for year in selected:
        if (state.get("years", {}).get(year) or {}).get("status") == "complete":
            print(f"skip completed supplement year {year}", flush=True)
            continue
        stage_path = args.work / year
        if args.restage and stage_path.exists():
            reset_stage(stage_path, args.work)
        for conflict_attempt in range(1, 6):
            stage_path, report = stage_year(
                args, year, rows_by_year[year], source_sha256,
            )
            results[year] = report
            if not args.publish:
                print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
                break
            year_state = state.setdefault("years", {}).setdefault(year, {})
            canonical_files = staged_files(stage_path / "canonical")
            if not year_state.get("hfCommit"):
                current = hf_git_head(args.hf_repo)
                if current != report["hfParentCommit"]:
                    print(
                        f"HF advanced while staging {year}; rebuilding "
                        f"({conflict_attempt}/5)",
                        flush=True,
                    )
                    reset_stage(stage_path, args.work)
                    continue
                try:
                    year_state["hfCommit"] = upload_hf_year(
                        args.hf_repo,
                        current,
                        canonical_files,
                        year,
                        int(report["changedCanonicalArticles"]),
                        args.hf_workers,
                    )
                except Exception as exc:
                    if conflict_attempt < 5 and is_hf_commit_conflict(exc):
                        reset_stage(stage_path, args.work)
                        continue
                    raise
                year_state["status"] = "hf-published"
                save_state(state_path, state)
            upload_b2(args.b2_remote, stage_path / "delivery", args.b2_transfers)
            year_state.update({
                "status": "complete",
                "supplementRows": len(rows_by_year[year]),
                "hfCommit": year_state["hfCommit"],
            })
            save_state(state_path, state)
            print(
                f"completed supplement year {year}: {len(rows_by_year[year])} articles",
                flush=True,
            )
            break
        else:
            raise RuntimeError(f"HF kept advancing while publishing {year}")
    print(json.dumps({"sourceSha256": source_sha256, "years": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
