from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
import gzip
import json
import os
from pathlib import Path, PurePosixPath
import time
from typing import Any

from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.errors import EntryNotFoundError


RUN_ROOT = "raw/news/runs"


def _safe_object(base_object: str, relative_object: str) -> str:
    relative = PurePosixPath(relative_object)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"Unsafe Raw object path: {relative_object}")
    return str(PurePosixPath(base_object).parent / relative)


def _candidate_object(manifest_object: str, manifest: dict[str, Any]) -> str:
    for row in manifest.get("objects", []):
        if isinstance(row, dict) and PurePosixPath(str(row.get("path", ""))).name == "candidates.jsonl.gz":
            return _safe_object(manifest_object, str(row["path"]))
    raise ValueError(f"Raw source manifest has no candidates object: {manifest_object}")


def _candidate_dates(candidate_file: Path) -> set[str]:
    dates: set[str] = set()
    with gzip.open(candidate_file, "rt", encoding="utf-8") as rows:
        for line in rows:
            if not line.strip():
                continue
            value = json.loads(line).get("publishedAt")
            if not isinstance(value, str) or len(value) < 10:
                continue
            candidate = value[:10]
            try:
                date.fromisoformat(candidate)
            except ValueError:
                continue
            dates.add(candidate)
    return dates


def _canonical_objects(source_id: str, dates: set[str]) -> set[str]:
    root = PurePosixPath("canonical/news") / source_id
    objects = {str(root / "dataset.json")}
    objects.update(
        str(root / "articles" / issue_date[:4] / issue_date[5:7] / f"{issue_date}.jsonl.gz")
        for issue_date in dates
    )
    return objects


def _run_window_dates(run: dict[str, Any]) -> set[str]:
    started_value = str(run.get("startedAt", "")).replace("Z", "+00:00")
    completed_value = str(run.get("completedAt", run.get("startedAt", ""))).replace("Z", "+00:00")
    started = datetime.fromisoformat(started_value).astimezone(timezone.utc)
    completed = datetime.fromisoformat(completed_value).astimezone(timezone.utc)
    hours = float(run.get("windowHours", 24))
    if hours <= 0 or completed < started:
        raise ValueError("Invalid Times run window")
    first = (started - timedelta(hours=hours)).date()
    last = completed.date()
    return {
        (first + timedelta(days=offset)).isoformat()
        for offset in range((last - first).days + 1)
    }


class SnapshotDownloader:
    def __init__(self, repo_id: str, output: Path, token: str) -> None:
        self.repo_id = repo_id
        self.output = output.resolve()
        self.token = token
        self.api = HfApi(token=token)
        self.revision = self.api.repo_info(repo_id=repo_id, repo_type="dataset").sha

    def _download(self, object_name: str) -> Path:
        for attempt in range(4):
            try:
                return Path(hf_hub_download(
                    repo_id=self.repo_id,
                    repo_type="dataset",
                    filename=object_name,
                    revision=self.revision,
                    local_dir=self.output,
                    token=self.token,
                ))
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2**attempt)
        raise AssertionError("unreachable")

    def _tree_files(self, root: str) -> set[str]:
        try:
            rows = self.api.list_repo_tree(
                repo_id=self.repo_id,
                repo_type="dataset",
                path_in_repo=root,
                recursive=True,
                revision=self.revision,
                token=self.token,
            )
            return {row.path for row in rows if hasattr(row, "path")}
        except EntryNotFoundError:
            return set()

    def latest_complete_run(self) -> tuple[str, Path, dict[str, Any]]:
        run_objects = sorted(
            (row for row in self._tree_files(RUN_ROOT) if row.endswith(".json")),
            reverse=True,
        )
        for object_name in run_objects:
            local = self._download(object_name)
            run = json.loads(local.read_text(encoding="utf-8"))
            if run.get("complete") is True:
                return object_name, local, run
        raise RuntimeError("HF Raw has no complete Times run manifest")

    def download(self) -> dict[str, Any]:
        run_object, run_file, run = self.latest_complete_run()
        source_rows = [
            row for row in run.get("sources", [])
            if isinstance(row, dict) and isinstance((row.get("output") or {}).get("manifest"), str)
        ]

        def source_bundle(row: dict[str, Any]) -> tuple[str, set[str]]:
            manifest_object = row["output"]["manifest"]
            manifest_file = self._download(manifest_object)
            manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
            candidates = self._download(_candidate_object(manifest_object, manifest))
            return str(row["sourceId"]), _candidate_dates(candidates)

        with ThreadPoolExecutor(max_workers=8) as pool:
            bundles = list(pool.map(source_bundle, source_rows))

        window_dates = _run_window_dates(run)
        existing_canonical = self._tree_files("canonical/news")
        candidate_dates = set().union(*(dates for _, dates in bundles)) if bundles else set()
        wanted_dates = window_dates | candidate_dates
        canonical_sources = {
            PurePosixPath(object_name).parts[2]
            for object_name in existing_canonical
            if len(PurePosixPath(object_name).parts) >= 3
        }
        wanted_canonical = set().union(*(
            _canonical_objects(source_id, wanted_dates) for source_id in canonical_sources
        )) if canonical_sources else set()
        canonical_to_download = sorted(wanted_canonical & existing_canonical)
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(self._download, canonical_to_download))

        return {
            "revision": self.revision,
            "runId": run["runId"],
            "runObject": run_object,
            "runManifest": str(run_file.resolve()),
            "sources": len(source_rows),
            "rawFiles": 1 + len(source_rows) * 2,
            "canonicalFiles": len(canonical_to_download),
        }


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download only the HF objects needed to process the latest Times run")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--token-env", default="HF_TOKEN")
    return parser.parse_args()


def main() -> int:
    args = _args()
    token = os.environ.get(args.token_env, "").strip()
    if not token:
        raise RuntimeError(f"{args.token_env} is not configured")
    result = SnapshotDownloader(args.repo, args.output, token).download()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
