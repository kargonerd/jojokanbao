from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


AUTHORIZE_URL = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download exactly one B2 parser-validation sample for local audit."
    )
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--raw-remote-root", action="append", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--target", type=int, default=800)
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help=(
            "Download the currently available QA-passing rows when the "
            "configured validation target has not been reached. This is for "
            "early defect discovery only and does not satisfy the formal gate."
        ),
    )
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument(
        "--reuse-checkpoint",
        action="store_true",
        help=(
            "Reuse an already downloaded capture.sqlite3.gz in the output "
            "directory. The gzip is still decompressed and its selected raw "
            "objects are checksum-verified before success."
        ),
    )
    parser.add_argument(
        "--bucket", default=os.environ.get("B2_ARCHIVE_BUCKET")
    )
    return parser.parse_args()


def authorize(key_id: str, application_key: str) -> tuple[str, str]:
    basic = base64.b64encode(
        f"{key_id}:{application_key}".encode("utf-8")
    ).decode("ascii")
    request = Request(
        AUTHORIZE_URL,
        headers={"Authorization": f"Basic {basic}"},
    )
    payload: dict[str, Any] | None = None
    last_error: Exception | None = None
    for attempt in range(6):
        try:
            with urlopen(request, timeout=30) as response:
                payload = json.load(response)
            break
        except (URLError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt == 5:
                raise RuntimeError("B2 authorization failed after retries") from exc
            time.sleep(min(2**attempt, 10))
    if payload is None:
        raise RuntimeError("B2 authorization returned no payload") from last_error
    return (
        str(payload["authorizationToken"]),
        str(payload["apiInfo"]["storageApi"]["downloadUrl"]),
    )


def download_url(download_base: str, bucket: str, remote_name: str) -> str:
    encoded = "/".join(quote(part, safe="") for part in remote_name.split("/"))
    return f"{download_base}/file/{quote(bucket, safe='')}/{encoded}"


def safe_local_path(root: Path, relative: str) -> Path:
    relative_path = PurePosixPath(relative)
    parts = relative_path.parts
    if (
        relative_path.is_absolute()
        or not parts
        or any(part in {"", ".", ".."} for part in parts)
    ):
        raise ValueError(f"unsafe archive path: {relative!r}")
    # PurePosixPath has already excluded drive/root markers and traversal.
    # Avoid Path.resolve() here: Windows adds the ``\\?\`` long-path prefix
    # only after a path crosses MAX_PATH, which makes two otherwise identical
    # resolved paths incomparable.
    return root.joinpath(*parts)


def download_file(
    *,
    token: str,
    download_base: str,
    bucket: str,
    remote_names: list[str],
    target: Path,
    reuse_existing: bool = True,
) -> str:
    target.parent.mkdir(parents=True, exist_ok=True)
    if reuse_existing and target.exists() and target.stat().st_size:
        return "existing"
    last_error: Exception | None = None
    for remote_name in remote_names:
        for attempt in range(6):
            try:
                request = Request(
                    download_url(download_base, bucket, remote_name),
                    headers={"Authorization": token},
                )
                temporary = target.with_name(target.name + ".part")
                with (
                    urlopen(request, timeout=60) as response,
                    temporary.open("wb") as handle,
                ):
                    shutil.copyfileobj(response, handle)
                temporary.replace(target)
                return remote_name
            except HTTPError as exc:
                last_error = exc
                if exc.code == 404:
                    break
            except (URLError, TimeoutError, OSError) as exc:
                last_error = exc
            if attempt == 5:
                raise RuntimeError(
                    f"failed to download after retries: {remote_name}"
                ) from last_error
            time.sleep(min(2**attempt, 10))
    raise RuntimeError(
        f"object not found in any configured root: {remote_names}"
    ) from last_error


def selected_paths(
    state: Path,
    *,
    publisher: str,
    year: int,
    target: int,
    allow_partial: bool = False,
) -> tuple[list[tuple[str, str]], set[str]]:
    connection = sqlite3.connect(f"file:{state.resolve().as_posix()}?mode=ro", uri=True)
    try:
        config_columns = {
            str(row[1])
            for row in connection.execute(
                "PRAGMA table_info(parser_validation_config)"
            )
        }
        result_columns = {
            str(row[1])
            for row in connection.execute(
                "PRAGMA table_info(parser_validation_results)"
            )
        }
        has_qa_revision = (
            "qa_revision" in config_columns
            and "qa_revision" in result_columns
        )
        config = connection.execute(
            (
                "SELECT parser_version, qa_revision, target_size "
                if has_qa_revision
                else "SELECT parser_version, 0, target_size "
            )
            + "FROM parser_validation_config WHERE sample_year=?",
            (year,),
        ).fetchone()
        if config is None or int(config[2]) != target:
            raise ValueError("validation config target does not match requested target")
        qa_revision_clause = (
            "AND result.qa_revision=?" if has_qa_revision else ""
        )
        parameters: list[Any] = [
            year,
            publisher,
            year,
            str(config[0]),
        ]
        if has_qa_revision:
            parameters.append(int(config[1]))
        parameters.append(target)
        rows = connection.execute(
            """
            SELECT
              sample.canonical_url,
              capture.raw_path,
              capture.raw_sha256,
              capture.dependent_resources_json
            FROM parser_validation_samples AS sample
            JOIN parser_validation_results AS result
              ON result.canonical_url=sample.canonical_url
            JOIN captures AS capture
              ON capture.canonical_url=sample.canonical_url
            WHERE sample.sample_year=?
              AND result.publisher=?
              AND result.sample_year=?
              AND result.parser_version=?
              {qa_revision_clause}
              AND result.qa_pass=1
              AND capture.status='complete'
              AND capture.raw_path IS NOT NULL
            ORDER BY sample.sample_priority
            LIMIT ?
            """.format(qa_revision_clause=qa_revision_clause),
            parameters,
        ).fetchall()
    finally:
        connection.close()
    if allow_partial and not rows:
        raise ValueError("selected no completed QA-passing rows")
    if not allow_partial and len(rows) != target:
        raise ValueError(f"selected {len(rows)} completed rows, expected {target}")
    raw_hashes: list[tuple[str, str]] = []
    paths: set[str] = set()
    for _url, raw_path, raw_sha256, resources_json in rows:
        path = str(raw_path)
        paths.add(path)
        raw_hashes.append((path, str(raw_sha256)))
        for resource in json.loads(str(resources_json or "[]")):
            paths.add(str(resource["blob"]["path"]))
    return raw_hashes, paths


def verify_raw_hashes(root: Path, raw_hashes: list[tuple[str, str]]) -> None:
    for relative, expected in raw_hashes:
        path = safe_local_path(root, relative)
        if path.suffix == ".gz":
            with gzip.open(path, "rb") as handle:
                content = handle.read()
        else:
            content = path.read_bytes()
        actual = hashlib.sha256(content).hexdigest()
        if actual != expected:
            raise ValueError(
                f"raw HTML checksum mismatch for {relative}: {actual} != {expected}"
            )


def main() -> int:
    args = parse_args()
    key_id = os.environ.get("B2_ARCHIVE_KEY_ID", "")
    application_key = os.environ.get("B2_ARCHIVE_APPLICATION_KEY", "")
    if not key_id or not application_key or not args.bucket:
        raise SystemExit(
            "B2_ARCHIVE_KEY_ID, B2_ARCHIVE_APPLICATION_KEY, and bucket are required"
        )
    if args.workers < 1:
        raise SystemExit("workers must be positive")
    token, download_base = authorize(key_id, application_key)
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    checkpoint_gzip = output / "capture.sqlite3.gz"
    download_file(
        token=token,
        download_base=download_base,
        bucket=args.bucket,
        remote_names=[args.checkpoint],
        target=checkpoint_gzip,
        reuse_existing=args.reuse_checkpoint,
    )
    state = output / "capture.sqlite3"
    with gzip.open(checkpoint_gzip, "rb") as source, state.open("wb") as target_handle:
        shutil.copyfileobj(source, target_handle)
    raw_hashes, paths = selected_paths(
        state,
        publisher=args.publisher,
        year=args.year,
        target=args.target,
        allow_partial=args.allow_partial,
    )
    failures: list[str] = []
    completed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {}
        for relative in sorted(paths):
            remote_names = [
                f"{root.rstrip('/')}/{relative.lstrip('/')}"
                for root in args.raw_remote_root
            ]
            target = safe_local_path(output, relative)
            future = executor.submit(
                download_file,
                token=token,
                download_base=download_base,
                bucket=args.bucket,
                remote_names=remote_names,
                target=target,
            )
            futures[future] = relative
        for future in as_completed(futures):
            relative = futures[future]
            try:
                future.result()
            except Exception as exc:
                failures.append(f"{relative}: {type(exc).__name__}: {exc}")
            completed += 1
            if completed % 100 == 0:
                print(json.dumps({"downloaded": completed, "total": len(paths)}))
    if failures:
        raise RuntimeError("\n".join(failures[:20]))
    verify_raw_hashes(output, raw_hashes)
    print(
        json.dumps(
            {
                "publisher": args.publisher,
                "year": args.year,
                "sampleRows": len(raw_hashes),
                "formalTarget": args.target,
                "formalTargetReached": len(raw_hashes) == args.target,
                "downloadedPaths": len(paths),
                "rawChecksumsVerified": len(raw_hashes),
                "output": str(output),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
