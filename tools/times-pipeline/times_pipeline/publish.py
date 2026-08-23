from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import shutil
import subprocess
from zoneinfo import ZoneInfo


IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"
MUTABLE_CACHE_CONTROL = "public, max-age=60, must-revalidate"


def _run(command: list[str], *, capture: bool = False, allow_missing: bool = False) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode == 0:
        return result
    output = f"{result.stdout or ''}\n{result.stderr or ''}".lower()
    if allow_missing and any(marker in output for marker in ("not found", "directory not found", "object not found")):
        return result
    raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(command[:3])}")


def _require_rclone() -> None:
    if not shutil.which("rclone"):
        raise RuntimeError("rclone is required to publish Times to B2")


def download_previous_state(
    delivery_remote: str,
    state_directory: Path,
    *,
    raw_remote: str | None = None,
    retention_days: int = 7,
    now: datetime | None = None,
) -> None:
    _require_rclone()
    state_directory.mkdir(parents=True, exist_ok=True)
    objects = {
        "catalog.jox": "catalog.jox",
        "latest.jox": "content/newspapers/times/latest.jox",
        "index.jox": "content/newspapers/times/index.jox",
    }
    for local_name, object_key in objects.items():
        target = state_directory / local_name
        result = _run(
            ["rclone", "copyto", f"{delivery_remote.rstrip('/')}/{object_key}", str(target), "--retries", "2"],
            capture=True,
            allow_missing=True,
        )
        if result.returncode != 0:
            target.unlink(missing_ok=True)
    if raw_remote is None:
        return
    raw_base = raw_remote.rstrip("/")
    archive_state = state_directory / "archive-state.json.gz"
    result = _run(
        [
            "rclone", "copyto", f"{raw_base}/raw/web-archives/times/state.json.gz",
            str(archive_state), "--retries", "2",
        ],
        capture=True,
        allow_missing=True,
    )
    if result.returncode != 0:
        archive_state.unlink(missing_ok=True)

    generated_at = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo("Asia/Shanghai"))
    for offset in range(retention_days + 2):
        issue_date = (generated_at.date() - timedelta(days=offset)).isoformat()
        year, month, _day = issue_date.split("-")
        relative = Path("canonical") / "newspapers" / "times" / "items" / year / month / f"{issue_date}.json.gz"
        target = state_directory / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        result = _run(
            ["rclone", "copyto", f"{raw_base}/{relative.as_posix()}", str(target), "--retries", "2"],
            capture=True,
            allow_missing=True,
        )
        if result.returncode != 0:
            target.unlink(missing_ok=True)


def _copy_directory(source: Path, remote: str, cache_control: str | None = None, filters: list[str] | None = None) -> None:
    if not source.exists():
        return
    command = ["rclone", "copy", str(source), remote, "--checksum", "--transfers", "16", "--checkers", "32"]
    if cache_control:
        command.extend(["--header-upload", f"Cache-Control: {cache_control}"])
    command.extend(filters or [])
    _run(command)


def publish_release(
    build_directory: Path,
    *,
    delivery_remote: str,
    raw_remote: str,
) -> dict:
    _require_rclone()
    report = json.loads((build_directory / "report.json").read_text(encoding="utf-8"))
    delivery = build_directory / "delivery" / "content" / "newspapers" / "times"
    remote_times = f"{delivery_remote.rstrip('/')}/content/newspapers/times"

    _copy_directory(
        build_directory / "raw",
        f"{raw_remote.rstrip('/')}/raw",
        filters=["--exclude", "web-archives/times/state.json.gz"],
    )
    _copy_directory(build_directory / "canonical", f"{raw_remote.rstrip('/')}/canonical")
    archive_state = build_directory / "raw" / "web-archives" / "times" / "state.json.gz"
    if archive_state.exists():
        _run([
            "rclone", "copyto", str(archive_state),
            f"{raw_remote.rstrip('/')}/raw/web-archives/times/state.json.gz", "--checksum",
        ])

    _copy_directory(
        delivery / "items",
        f"{remote_times}/items",
        IMMUTABLE_CACHE_CONTROL,
        ["--exclude", "**/manifest.jox"],
    )
    _copy_directory(
        delivery / "items",
        f"{remote_times}/items",
        MUTABLE_CACHE_CONTROL,
        ["--include", "**/manifest.jox", "--exclude", "**"],
    )
    _copy_directory(delivery / "availability", f"{remote_times}/availability", MUTABLE_CACHE_CONTROL)
    for name in ("index.jox", "latest.jox"):
        _run([
            "rclone", "copyto", str(delivery / name), f"{remote_times}/{name}",
            "--checksum", "--header-upload", f"Cache-Control: {MUTABLE_CACHE_CONTROL}",
        ])
    catalog = build_directory / "delivery" / "catalog.jox"
    if catalog.exists():
        _run([
            "rclone", "copyto", str(catalog), f"{delivery_remote.rstrip('/')}/catalog.jox",
            "--checksum", "--header-upload", f"Cache-Control: {MUTABLE_CACHE_CONTROL}",
        ])
    return {
        "runId": report["runId"],
        "deliveryRemote": delivery_remote,
        "rawRemote": raw_remote,
        "latestObject": f"{remote_times}/latest.jox",
        "catalogUpdated": catalog.exists(),
    }
