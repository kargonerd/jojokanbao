"""Bounded, read-only staging of one legacy B2 batch for HF migration."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any

from jojo_news_archive.migration.legacy_b2 import (
    prepare_archive_batch,
    verify_archive_batch,
)


_V1_BATCH = re.compile(
    r"^news-archive/v1/[a-z0-9]+(?:-[a-z0-9]+)*/\d{4}-\d{4}/[a-z0-9]+(?:-[a-z0-9]+)*$"
)
_V2_BATCH = re.compile(
    r"^news-archive/v2/validation-state/[a-z0-9]+(?:-[a-z0-9]+)*/"
    r"[a-z0-9]+(?:-[a-z0-9]+)*/\d{4}$"
)
_BUCKET = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]{4,48}[A-Za-z0-9]$")
_REMOTE_NAME = "jojoarchiveread"
_PASSTHROUGH_ENVIRONMENT = (
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
)
MAX_CANARY_FILES = 10_000
MAX_CANARY_BYTES = 2_000_000_000


@dataclass(frozen=True)
class RemoteInventory:
    files: int
    bytes: int


def validate_batch_prefix(value: str) -> str:
    normalized = value.strip("/")
    if normalized != value or not (
        _V1_BATCH.fullmatch(normalized) or _V2_BATCH.fullmatch(normalized)
    ):
        raise ValueError(
            "legacy prefix must select one complete v1 publisher/window/mode "
            "or one v2 cohort/publisher/year batch"
        )
    return normalized


def _archive_environment(environment: dict[str, str] | None = None) -> tuple[dict[str, str], str]:
    source = os.environ if environment is None else environment
    key_id = source.get("B2_ARCHIVE_KEY_ID", "").strip()
    application_key = source.get("B2_ARCHIVE_APPLICATION_KEY", "").strip()
    bucket = source.get("B2_ARCHIVE_BUCKET", "").strip()
    if not key_id or not application_key or not bucket:
        raise ValueError(
            "B2_ARCHIVE_KEY_ID, B2_ARCHIVE_APPLICATION_KEY, and B2_ARCHIVE_BUCKET are required"
        )
    if not _BUCKET.fullmatch(bucket):
        raise ValueError("B2_ARCHIVE_BUCKET has an invalid bucket name")
    process_environment = {
        name: source[name]
        for name in _PASSTHROUGH_ENVIRONMENT
        if source.get(name)
    }
    process_environment.update(
        {
            f"RCLONE_CONFIG_{_REMOTE_NAME.upper()}_TYPE": "b2",
            f"RCLONE_CONFIG_{_REMOTE_NAME.upper()}_ACCOUNT": key_id,
            f"RCLONE_CONFIG_{_REMOTE_NAME.upper()}_KEY": application_key,
        }
    )
    return process_environment, bucket


def _run_rclone(
    arguments: list[str], *, environment: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["rclone", *arguments],
            env=environment,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except FileNotFoundError as error:
        raise ValueError("rclone is required for legacy B2 staging") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or error.stdout or "rclone failed").strip()
        for name in (
            f"RCLONE_CONFIG_{_REMOTE_NAME.upper()}_ACCOUNT",
            f"RCLONE_CONFIG_{_REMOTE_NAME.upper()}_KEY",
        ):
            secret = environment.get(name)
            if secret:
                detail = detail.replace(secret, "<redacted>")
        detail = detail[:4_000]
        raise ValueError(f"read-only B2 staging failed: {detail}") from error


def remote_inventory(
    legacy_b2_prefix: str, *, environment: dict[str, str] | None = None
) -> RemoteInventory:
    prefix = validate_batch_prefix(legacy_b2_prefix)
    process_environment, bucket = _archive_environment(environment)
    result = _run_rclone(
        ["size", f"{_REMOTE_NAME}:{bucket}/{prefix}", "--json"],
        environment=process_environment,
    )
    try:
        payload: Any = json.loads(result.stdout)
        files = payload["count"]
        byte_count = payload["bytes"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise ValueError("rclone returned an invalid B2 inventory") from error
    if (
        isinstance(files, bool)
        or not isinstance(files, int)
        or isinstance(byte_count, bool)
        or not isinstance(byte_count, int)
        or files < 0
        or byte_count < 0
    ):
        raise ValueError("rclone returned an invalid B2 inventory")
    return RemoteInventory(files=files, bytes=byte_count)


def _local_inventory(root: Path) -> RemoteInventory:
    files = 0
    byte_count = 0
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"staging directory contains a symbolic link: {path}")
        if path.is_file():
            files += 1
            byte_count += path.stat().st_size
    return RemoteInventory(files=files, bytes=byte_count)


def stage_archive_batch(
    *,
    legacy_b2_prefix: str,
    output_dir: Path,
    manifest_dir: Path,
    max_files: int,
    max_bytes: int,
    execute: bool,
    transfers: int = 16,
    available_file_manifests: Sequence[Path] = (),
    environment: dict[str, str] | None = None,
) -> dict[str, object]:
    prefix = validate_batch_prefix(legacy_b2_prefix)
    if not 1 <= max_files <= MAX_CANARY_FILES:
        raise ValueError(f"max files must be between 1 and {MAX_CANARY_FILES}")
    if not 1 <= max_bytes <= MAX_CANARY_BYTES:
        raise ValueError(f"max bytes must be between 1 and {MAX_CANARY_BYTES}")
    if not 1 <= transfers <= 32:
        raise ValueError("transfers must be between 1 and 32")
    inventory = remote_inventory(prefix, environment=environment)
    if inventory.files == 0:
        raise ValueError("selected legacy B2 batch is empty")
    if inventory.files > max_files or inventory.bytes > max_bytes:
        raise ValueError(
            "selected legacy B2 batch exceeds the canary limit: "
            f"{inventory.files}/{max_files} files, {inventory.bytes}/{max_bytes} bytes"
        )
    report: dict[str, object] = {
        "legacyB2Prefix": prefix,
        "remote": {"files": inventory.files, "bytes": inventory.bytes},
        "execute": execute,
    }
    if not execute:
        return report

    process_environment, bucket = _archive_environment(environment)
    output = output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    _run_rclone(
        [
            "copy",
            f"{_REMOTE_NAME}:{bucket}/{prefix}",
            str(output),
            "--immutable",
            "--checksum",
            "--no-update-modtime",
            "--transfers",
            str(transfers),
            "--checkers",
            str(min(64, transfers * 2)),
        ],
        environment=process_environment,
    )
    local = _local_inventory(output)
    if local != inventory:
        raise ValueError(
            "staged B2 inventory changed during transfer: "
            f"remote={inventory.files}/{inventory.bytes}, local={local.files}/{local.bytes}"
        )
    phase_paths = prepare_archive_batch(
        output, manifest_dir, legacy_b2_prefix=prefix
    )
    verification = verify_archive_batch(
        output,
        manifest_dir,
        legacy_b2_prefix=prefix,
        available_file_manifests=available_file_manifests,
    )
    report.update(
        {
            "local": {"files": local.files, "bytes": local.bytes},
            "phaseManifests": {
                phase.value: str(path.resolve()) for phase, path in phase_paths.items()
            },
            "verification": verification,
        }
    )
    return report
