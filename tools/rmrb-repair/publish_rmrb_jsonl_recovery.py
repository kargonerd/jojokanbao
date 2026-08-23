#!/usr/bin/env python3
"""Stage and optionally publish JSONL recoveries to HF Canonical and B2 Delivery."""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


WORKSPACE = Path(__file__).resolve().parents[2]
ADMIN_SERVER = WORKSPACE / "tools" / "jojo-admin" / "server"
sys.path.insert(0, str(ADMIN_SERVER))

from rmrb_review_publish import (  # noqa: E402
    MISSING_INDEX,
    prepare_canonical_patch,
    prepare_delivery_patch,
)


DEFAULT_HF_REPO = "luoxiaozhuang/marxism-dataset"
DEFAULT_B2_REMOTE = "jojo-b2-s3:jojo-newspaper"
# Direct LFS/CDN transfers are materially more reliable than Xet metadata
# finalization on the current proxied Windows link.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")


def load_decisions(path: Path) -> dict[tuple[str, int, int], dict[str, object]]:
    result: dict[tuple[str, int, int], dict[str, object]] = {}
    with path.open("r", encoding="utf-8-sig") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            key = (
                str(row["date"]),
                int(row["page"]),
                int(row["peopleDataOrdinal"]),
            )
            if key in result:
                raise ValueError(f"Duplicate recovery key at line {line_number}: {key}")
            if str(row.get("decision") or "") != "accept" or not str(row.get("content") or "").strip():
                raise ValueError(f"Recovery decision is not a non-empty accept at line {line_number}")
            result[key] = row
    if not result:
        raise ValueError("No recovery decisions found")
    return result


def hf_patterns(decisions: dict[tuple[str, int, int], dict[str, object]]) -> list[str]:
    years = sorted({key[0][:4] for key in decisions})
    days = sorted({key[0] for key in decisions})
    return [
        "newspapers/rmrb/dataset.json",
        MISSING_INDEX,
        *(f"newspapers/rmrb/data/articles/{year}.jsonl.gz" for year in years),
        *(f"newspapers/rmrb/items/{day[:4]}/{day[5:7]}/{day}.json.gz" for day in days),
    ]


def delivery_paths(decisions: dict[tuple[str, int, int], dict[str, object]]) -> list[str]:
    days = sorted({key[0] for key in decisions})
    return [
        "content/newspapers/rmrb/index.jox",
        *(
            f"content/newspapers/rmrb/items/{day[:4]}/{day[5:7]}/{day}/manifest.jox"
            for day in days
        ),
    ]


def run(command: list[str], *, cwd: Path = WORKSPACE) -> None:
    result = subprocess.run(command, cwd=cwd, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(command)}")


def hf_git_head(repo_id: str) -> str:
    """Read the public dataset head without consuming Hugging Face API quota."""
    result = subprocess.run(
        [
            "git",
            "ls-remote",
            f"https://huggingface.co/datasets/{repo_id}",
            "refs/heads/main",
        ],
        cwd=WORKSPACE,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Cannot read HF Git head: {result.stderr.strip()}")
    head = result.stdout.strip().split(maxsplit=1)[0] if result.stdout.strip() else ""
    if len(head) != 40:
        raise RuntimeError(f"Unexpected HF Git head response: {result.stdout.strip()!r}")
    return head


def cache_hf_source(
    repo_id: str,
    revision: str,
    patterns: list[str],
    workers: int,
    root: Path,
) -> Path:
    from huggingface_hub import hf_hub_download

    root.mkdir(parents=True, exist_ok=True)

    def download(filename: str) -> None:
        for attempt in range(1, 11):
            try:
                hf_hub_download(
                    repo_id=repo_id,
                    repo_type="dataset",
                    revision=revision,
                    filename=filename,
                    local_dir=root,
                )
                return
            except Exception as exc:
                if attempt == 10:
                    raise
                delay = min(60, attempt * 5)
                print(
                    f"retry HF source {filename} after {type(exc).__name__} "
                    f"({attempt}/10, {delay}s)",
                    flush=True,
                )
                time.sleep(delay)

    completed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(download, filename) for filename in patterns]
        for future in concurrent.futures.as_completed(futures):
            future.result()
            completed += 1
            if completed % 250 == 0 or completed == len(futures):
                print(f"downloaded HF source {completed}/{len(futures)}", flush=True)
    return root


def cache_delivery_source(remote: str, paths: list[str], root: Path, transfers: int) -> None:
    rclone = shutil.which("rclone.exe") or shutil.which("rclone")
    if not rclone:
        raise RuntimeError("rclone is required")
    file_list = root.parent / "delivery-source-files.txt"
    file_list.write_text("\n".join(paths) + "\n", encoding="utf-8", newline="\n")
    root.mkdir(parents=True, exist_ok=True)
    run(
        [
            rclone,
            "copy",
            remote.rstrip("/"),
            str(root),
            "--files-from",
            str(file_list),
            "--transfers",
            str(transfers),
            "--checkers",
            str(max(transfers, 64)),
            "--retries",
            "10",
            "--low-level-retries",
            "20",
            "--s3-no-check-bucket",
        ]
    )


def upload_hf(
    repo_id: str,
    parent_commit: str,
    files: dict[str, Path],
    count: int,
    workers: int,
) -> str | None:
    if not files:
        return None
    from huggingface_hub import CommitOperationAdd, HfApi, get_token

    token = get_token() or os.environ.get("HF_TOKEN", "").strip()
    if not token:
        raise RuntimeError("Hugging Face login or HF_TOKEN is required")
    operations = [
        CommitOperationAdd(path_in_repo=name, path_or_fileobj=str(path))
        for name, path in sorted(files.items())
    ]
    commit = HfApi(token=token).create_commit(
        repo_id=repo_id,
        repo_type="dataset",
        operations=operations,
        commit_message=f"Recover {count} RMRB bodies from legacy JSONL",
        parent_commit=parent_commit,
        num_threads=workers,
    )
    return str(commit.oid)


def upload_b2(remote: str, root: Path, transfers: int) -> None:
    rclone = shutil.which("rclone.exe") or shutil.which("rclone")
    if not rclone:
        raise RuntimeError("rclone is required")
    common = [
        "--transfers",
        str(transfers),
        "--checkers",
        str(max(transfers, 128)),
        "--retries",
        "10",
        "--low-level-retries",
        "20",
        "--s3-no-check-bucket",
    ]
    # Immutable article fragments/assets first, commit-marker manifests second.
    run([
        rclone, "copy", str(root), remote.rstrip("/"),
        "--exclude", "**/manifest.jox", "--exclude", "**/index.jox", *common,
    ])
    run([
        rclone, "copy", str(root), remote.rstrip("/"),
        "--include", "**/manifest.jox", "--exclude", "*", *common,
    ])
    index = root / "content/newspapers/rmrb/index.jox"
    if index.is_file():
        run([
            rclone, "copyto", str(index),
            f"{remote.rstrip('/')}/content/newspapers/rmrb/index.jox", *common,
        ])


def staged_files(root: Path) -> dict[str, Path]:
    if not root.is_dir():
        raise RuntimeError(f"Staged publication directory is missing: {root}")
    return {
        path.relative_to(root).as_posix(): path
        for path in root.rglob("*")
        if path.is_file()
    }


def publish_staged(args: argparse.Namespace) -> dict[str, Any]:
    """Publish a previously verified dry-run without rebuilding it."""
    work = args.work.resolve()
    decisions = load_decisions(args.decisions)
    report_path = work / "report.json"
    revision_file = work / "source-revision.json"
    if not report_path.is_file() or not revision_file.is_file():
        raise RuntimeError("Staged report or pinned source revision is missing")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    revision_state = json.loads(revision_file.read_text(encoding="utf-8"))
    revision = str(revision_state.get("revision") or "")
    if report.get("published") is True:
        raise RuntimeError("Staged publication is already marked published")
    if report.get("hfRepo") != args.hf_repo or revision_state.get("hfRepo") != args.hf_repo:
        raise RuntimeError("Staged publication belongs to another Hugging Face repository")
    if str(report.get("hfParentCommit") or "") != revision:
        raise RuntimeError("Staged report and pinned source revision disagree")
    if int(report.get("decisionCount") or -1) != len(decisions):
        raise RuntimeError("Staged report and recovery decisions disagree")

    canonical_files = staged_files(work / "canonical")
    delivery_files = staged_files(work / "delivery")
    if len(canonical_files) != int(report.get("canonicalFiles") or -1):
        raise RuntimeError("Staged Canonical file count disagrees with the dry-run report")
    if len(delivery_files) != int(report.get("deliveryFiles") or -1):
        raise RuntimeError("Staged Delivery file count disagrees with the dry-run report")

    current_revision = hf_git_head(args.hf_repo)
    existing_hf_commit = str(report.get("hfCommit") or "")
    if existing_hf_commit:
        if current_revision != existing_hf_commit:
            raise RuntimeError(
                "HF repository advanced after the Canonical commit; "
                "refusing to resume the B2 phase against a different head"
            )
    else:
        if current_revision != revision:
            raise RuntimeError(
                f"HF repository advanced after staging: {revision} -> {current_revision}; rebuild first"
            )
        report["hfCommit"] = upload_hf(
            args.hf_repo,
            revision,
            canonical_files,
            int(report["changedCanonicalArticles"]),
            args.hf_workers,
        )
        report["publicationPhase"] = "hf-published"
        # Persist the Canonical commit before starting B2 so a failed Delivery
        # transfer can resume without repeating an 8k-file HF commit.
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    upload_b2(args.b2_remote, work / "delivery", args.b2_transfers)
    report["published"] = True
    report["publicationPhase"] = "complete"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def stage(args: argparse.Namespace) -> dict[str, Any]:
    work = args.work.resolve()
    if work.exists() and any(work.iterdir()) and not args.resume:
        raise SystemExit(f"Work directory is not empty: {work}")
    work.mkdir(parents=True, exist_ok=True)
    decisions = load_decisions(args.decisions)

    from huggingface_hub import HfApi

    revision_file = work / "source-revision.json"
    if revision_file.is_file():
        revision_state = json.loads(revision_file.read_text(encoding="utf-8"))
        if revision_state.get("hfRepo") != args.hf_repo:
            raise RuntimeError("Resume directory belongs to another Hugging Face repository")
        revision = str(revision_state["revision"])
    else:
        cached_metadata = (
            work
            / "hf-source/.cache/huggingface/download/newspapers/rmrb/dataset.json.metadata"
        )
        if args.resume and cached_metadata.is_file():
            revision = cached_metadata.read_text(encoding="utf-8").splitlines()[0].strip()
        else:
            revision = str(HfApi().dataset_info(args.hf_repo).sha)
        revision_file.write_text(
            json.dumps({"hfRepo": args.hf_repo, "revision": revision}, indent=2) + "\n",
            encoding="utf-8",
        )
    hf_source = cache_hf_source(
        args.hf_repo,
        revision,
        hf_patterns(decisions),
        args.hf_workers,
        work / "hf-source",
    )
    b2_source = work / "delivery-source"
    cache_delivery_source(args.b2_remote, delivery_paths(decisions), b2_source, args.b2_transfers)

    canonical = prepare_canonical_patch(
        decisions,
        lambda name: hf_source / name,
        work / "canonical",
        set(decisions),
        set(decisions),
    )
    delivery = prepare_delivery_patch(
        decisions,
        canonical,
        lambda name: b2_source / name,
        work / "delivery",
        set(decisions),
    )
    report: dict[str, Any] = {
        "formatVersion": "jojo-rmrb-jsonl-recovery-publication/1",
        "hfRepo": args.hf_repo,
        "hfParentCommit": revision,
        "b2Remote": args.b2_remote,
        "decisionCount": len(decisions),
        "changedCanonicalArticles": canonical.changed_article_count,
        "canonicalFiles": len(canonical.files),
        "changedDeliveryArticles": delivery.changed_article_count,
        "deliveryFiles": len(delivery.files),
        "published": False,
    }
    report_path = work / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.publish:
        report["hfCommit"] = upload_hf(
            args.hf_repo,
            revision,
            canonical.files,
            canonical.changed_article_count,
            args.hf_workers,
        )
        upload_b2(args.b2_remote, delivery.root, args.b2_transfers)
        report["published"] = True
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--decisions", type=Path, required=True)
    result.add_argument("--work", type=Path, required=True)
    result.add_argument("--hf-repo", default=DEFAULT_HF_REPO)
    result.add_argument("--b2-remote", default=DEFAULT_B2_REMOTE)
    result.add_argument("--hf-workers", type=int, default=32)
    result.add_argument("--b2-transfers", type=int, default=128)
    result.add_argument("--resume", action="store_true")
    result.add_argument("--publish", action="store_true")
    result.add_argument(
        "--publish-staged",
        action="store_true",
        help="Publish an already verified dry-run without downloading and rebuilding it",
    )
    return result


def main() -> None:
    args = parser().parse_args()
    if args.publish and args.publish_staged:
        raise SystemExit("Choose either --publish or --publish-staged")
    action = publish_staged if args.publish_staged else stage
    print(json.dumps(action(args), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
