#!/usr/bin/env python3
"""Upload a large folder to Hugging Face in API-efficient commit batches."""

from __future__ import annotations

import argparse
import concurrent.futures
import fnmatch
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

from huggingface_hub import CommitOperationAdd, HfApi


def log(message: str) -> None:
    print(f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] {message}", flush=True)


def batch_key(files: list[Path], source: Path, prefix: str) -> str:
    digest = hashlib.sha256()
    for path in files:
        stat = path.stat()
        relative = path.relative_to(source).as_posix()
        digest.update(f"{prefix}/{relative}\0{stat.st_size}\0{stat.st_mtime_ns}\n".encode("utf-8"))
    return digest.hexdigest()


def load_state(path: Path) -> dict:
    if not path.exists():
        return {"completed": {}}
    with path.open("r", encoding="utf-8-sig") as handle:
        state = json.load(handle)
    state.setdefault("completed", {})
    return state


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(temporary, path)


def retry_delay(error: BaseException) -> int:
    response = getattr(error, "response", None)
    if response is not None and getattr(response, "status_code", None) == 429:
        retry_after = response.headers.get("retry-after")
        if retry_after and retry_after.isdigit():
            return max(30, int(retry_after) + 5)
        return 310
    text = str(error)
    if "429" in text or "rate limit" in text.lower():
        return 310
    return 30


def select_files(source: Path, includes: list[str]) -> list[Path]:
    files = sorted(path for path in source.rglob("*") if path.is_file())
    if not includes:
        return files
    return [
        path
        for path in files
        if any(fnmatch.fnmatch(path.relative_to(source).as_posix(), pattern) for pattern in includes)
    ]


def materialize_batch(files: list[Path], source: Path, cache_root: Path, key: str, workers: int) -> dict[Path, Path]:
    batch_root = cache_root / key

    def copy_one(path: Path) -> tuple[Path, Path]:
        relative = path.relative_to(source)
        target = batch_root / relative
        source_stat = path.stat()
        if target.is_file():
            target_stat = target.stat()
            if target_stat.st_size == source_stat.st_size and target_stat.st_mtime_ns == source_stat.st_mtime_ns:
                return path, target
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".partial")
        shutil.copy2(path, temporary)
        os.replace(temporary, target)
        return path, target

    started = time.monotonic()
    log(f"materializing {len(files)} files into local cache {batch_root} with {workers} workers")
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        pairs = list(executor.map(copy_one, files))
    log(f"local cache ready in {time.monotonic() - started:.1f}s")
    return dict(pairs)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--prefix", default="")
    parser.add_argument("--include", action="append", default=[])
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--workers", type=int, default=32)
    parser.add_argument("--local-cache", type=Path)
    parser.add_argument("--commit-message", default="Upload dataset files")
    args = parser.parse_args()

    source = args.source.resolve()
    prefix = args.prefix.strip("/")
    files = select_files(source, args.include)
    if not files:
        raise RuntimeError(f"No matching files found under {source}")

    state = load_state(args.state)
    completed: dict[str, dict] = state["completed"]
    api = HfApi()
    batches = [files[index : index + args.batch_size] for index in range(0, len(files), args.batch_size)]
    log(
        f"found {len(files)} files in {len(batches)} batches; "
        f"batch_size={args.batch_size}, workers={args.workers}"
    )

    for number, files_in_batch in enumerate(batches, start=1):
        key = batch_key(files_in_batch, source, prefix)
        if key in completed:
            log(f"batch {number}/{len(batches)} already committed; skipping")
            continue

        first = files_in_batch[0].relative_to(source).as_posix()
        last = files_in_batch[-1].relative_to(source).as_posix()
        local_paths = None
        while True:
            try:
                log(f"batch {number}/{len(batches)} hashing and uploading {len(files_in_batch)} files: {first} .. {last}")
                if args.local_cache is not None and local_paths is None:
                    local_paths = materialize_batch(
                        files_in_batch,
                        source,
                        args.local_cache.resolve(),
                        key,
                        args.workers,
                    )
                operations = []
                for path in files_in_batch:
                    relative = path.relative_to(source).as_posix()
                    remote_path = f"{prefix}/{relative}" if prefix else relative
                    upload_path = local_paths[path] if local_paths is not None else path
                    operations.append(CommitOperationAdd(path_in_repo=remote_path, path_or_fileobj=str(upload_path)))
                result = api.create_commit(
                    repo_id=args.repo,
                    repo_type="dataset",
                    operations=operations,
                    commit_message=f"{args.commit_message} ({number:03d}/{len(batches):03d})",
                    num_threads=args.workers,
                )
                completed[key] = {
                    "batch": number,
                    "count": len(files_in_batch),
                    "first": first,
                    "last": last,
                    "commit": result.oid,
                    "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
                state.update(
                    {
                        "repo": args.repo,
                        "prefix": prefix,
                        "source": str(source),
                        "fileCount": len(files),
                        "batchCount": len(batches),
                        "includes": args.include,
                    }
                )
                save_state(args.state, state)
                log(f"batch {number}/{len(batches)} committed as {result.oid}")
                if args.local_cache is not None:
                    batch_cache = args.local_cache.resolve() / key
                    if batch_cache.is_dir() and batch_cache.parent == args.local_cache.resolve():
                        shutil.rmtree(batch_cache)
                        log(f"removed completed local cache batch {batch_cache}")
                break
            except KeyboardInterrupt:
                raise
            except BaseException as error:
                delay = retry_delay(error)
                log(f"batch {number}/{len(batches)} failed: {error!r}; retrying in {delay}s")
                time.sleep(delay)

    log("all batches committed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
