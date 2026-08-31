from __future__ import annotations

import json
from pathlib import Path
import subprocess

import pytest

from jojo_news_archive.migration import staging
from jojo_news_archive.migration.legacy_b2 import ArchivePhase


ENVIRONMENT = {
    "B2_ARCHIVE_KEY_ID": "key-id",
    "B2_ARCHIVE_APPLICATION_KEY": "application-key",
    "B2_ARCHIVE_BUCKET": "jojo-news-raw",
}
PREFIX = "news-archive/v1/bloomberg/2020-2020/legacy-wayback"


@pytest.mark.parametrize(
    "value",
    [
        "news-archive/v1/bloomberg/2020-2020/legacy-wayback",
        "news-archive/v2/validation-state/holdout-v10/bloomberg/2020",
    ],
)
def test_accepts_only_one_complete_migration_batch(value: str):
    assert staging.validate_batch_prefix(value) == value


@pytest.mark.parametrize(
    "value",
    [
        "news-archive",
        "news-archive/v1/bloomberg",
        "news-archive/v1/bloomberg/2020-2020/../wsj",
        "/news-archive/v1/bloomberg/2020-2020/legacy-wayback",
        "research-archives/bloomberg/2020",
    ],
)
def test_rejects_broad_or_unsafe_prefixes(value: str):
    with pytest.raises(ValueError, match="one complete"):
        staging.validate_batch_prefix(value)


def test_dry_run_uses_only_the_archive_remote_and_enforces_limits(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    calls: list[tuple[list[str], dict[str, str]]] = []

    def run(arguments: list[str], *, environment: dict[str, str]):
        calls.append((arguments, environment))
        return subprocess.CompletedProcess(
            ["rclone", *arguments], 0, json.dumps({"count": 12, "bytes": 3456}), ""
        )

    monkeypatch.setattr(staging, "_run_rclone", run)
    report = staging.stage_archive_batch(
        legacy_b2_prefix=PREFIX,
        output_dir=tmp_path / "output",
        manifest_dir=tmp_path / "manifests",
        max_files=20,
        max_bytes=4_000,
        execute=False,
        environment=ENVIRONMENT,
    )
    assert report == {
        "legacyB2Prefix": PREFIX,
        "remote": {"files": 12, "bytes": 3456},
        "execute": False,
    }
    assert calls[0][0] == [
        "size",
        f"jojoarchiveread:jojo-news-raw/{PREFIX}",
        "--json",
    ]
    assert calls[0][1]["RCLONE_CONFIG_JOJOARCHIVEREAD_ACCOUNT"] == "key-id"
    assert "B2_ARCHIVE_APPLICATION_KEY" not in calls[0][1]
    assert not (tmp_path / "output").exists()

    with pytest.raises(ValueError, match="exceeds the canary limit"):
        staging.stage_archive_batch(
            legacy_b2_prefix=PREFIX,
            output_dir=tmp_path / "output",
            manifest_dir=tmp_path / "manifests",
            max_files=10,
            max_bytes=4_000,
            execute=False,
            environment=ENVIRONMENT,
        )


def test_requires_dedicated_archive_credentials(monkeypatch: pytest.MonkeyPatch):
    with pytest.raises(ValueError, match="B2_ARCHIVE"):
        staging.remote_inventory(PREFIX, environment={})


def test_rclone_errors_redact_archive_credentials(monkeypatch: pytest.MonkeyPatch):
    def fail(*_args, **_kwargs):
        raise subprocess.CalledProcessError(
            1,
            ["rclone"],
            stderr="account key-id rejected application-key",
        )

    monkeypatch.setattr(subprocess, "run", fail)
    environment, _bucket = staging._archive_environment(ENVIRONMENT)
    with pytest.raises(ValueError) as error:
        staging._run_rclone(["size", "remote:path"], environment=environment)
    assert "key-id" not in str(error.value)
    assert "application-key" not in str(error.value)
    assert "<redacted>" in str(error.value)


def test_execute_threads_verified_v1_manifests_into_v2_reference_checks(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    prefix = "news-archive/v2/validation-state/holdout-v10/bloomberg/2020"
    available = tmp_path / "v1-immutable.json"
    available.write_text("{}", encoding="utf-8")
    inventory = staging.RemoteInventory(files=4, bytes=120)
    monkeypatch.setattr(staging, "remote_inventory", lambda *_args, **_kwargs: inventory)
    rclone_calls: list[list[str]] = []

    def run_rclone(arguments: list[str], *, environment: dict[str, str]):
        rclone_calls.append(arguments)
        return subprocess.CompletedProcess(["rclone", *arguments], 0, "", "")

    monkeypatch.setattr(staging, "_run_rclone", run_rclone)
    monkeypatch.setattr(staging, "_local_inventory", lambda _root: inventory)
    monkeypatch.setattr(
        staging,
        "prepare_archive_batch",
        lambda _root, manifest_dir, *, legacy_b2_prefix: {
            phase: manifest_dir / f"{phase.value}.json" for phase in ArchivePhase
        },
    )
    observed: dict[str, object] = {}

    def verify(_root, _manifest_dir, **kwargs):
        observed.update(kwargs)
        return {"files": inventory.files, "bytes": inventory.bytes}

    monkeypatch.setattr(staging, "verify_archive_batch", verify)
    staging.stage_archive_batch(
        legacy_b2_prefix=prefix,
        output_dir=tmp_path / "output",
        manifest_dir=tmp_path / "manifests",
        max_files=10,
        max_bytes=1_000,
        execute=True,
        available_file_manifests=(available,),
        environment=ENVIRONMENT,
    )

    assert observed["legacy_b2_prefix"] == prefix
    assert observed["available_file_manifests"] == (available,)
    assert rclone_calls == [[
        "copy",
        f"jojoarchiveread:jojo-news-raw/{prefix}",
        str((tmp_path / "output").resolve()),
        "--immutable",
        "--checksum",
        "--no-update-modtime",
        "--transfers",
        "16",
        "--checkers",
        "32",
    ]]
