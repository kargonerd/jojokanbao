"""Merge and publish the complete ES exclusion state as one COS JSON object."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable

from es_migrations import MIGRATIONS_DIR, search_state_payload
from es_repair import _load_root_env


DEFAULT_BUCKET = "jojo-search-1314955862"
DEFAULT_REGION = "ap-beijing"
DEFAULT_KEY = "runtime/search/search-state.json"
DEFAULT_INDICES = ("jojo-67f10bu8",)


def publication_config() -> dict[str, Any]:
    _load_root_env()
    configured_indices = os.getenv("SEARCH_STATE_INDICES", "").split(",")
    indices = [value.strip() for value in configured_indices if value.strip()]
    return {
        "bucket": os.getenv("SEARCH_STATE_COS_BUCKET", DEFAULT_BUCKET).strip(),
        "region": os.getenv("SEARCH_STATE_COS_REGION", DEFAULT_REGION).strip(),
        "key": os.getenv("SEARCH_STATE_COS_KEY", DEFAULT_KEY).strip().lstrip("/"),
        "profile": os.getenv("SEARCH_STATE_TCCLI_PROFILE", "").strip(),
        "indices": indices or list(DEFAULT_INDICES),
    }


def validate_publication_target(index: str, config: dict[str, Any] | None = None) -> None:
    settings = config or publication_config()
    if not index:
        raise ValueError("ES_REPAIR_INDEX 未配置")
    if index not in settings["indices"]:
        raise ValueError(
            f"修复索引 {index} 不在 SEARCH_STATE_INDICES 中；"
            "为防止测试索引进入线上状态，已停止写入"
        )
    missing = [key for key in ("bucket", "region", "key") if not settings.get(key)]
    if missing:
        raise ValueError("缺少 search-state 发布配置：" + ", ".join(missing))


def merge_search_state(
    remote: dict[str, Any],
    local: dict[str, Any],
    indices: list[str],
) -> dict[str, Any]:
    """Merge monotonically so a stale workstation cannot erase old repairs."""
    remote_excluded = _validated_excluded_ids(remote)
    local_excluded = _validated_excluded_ids(local)
    configured = set(indices)
    result: dict[str, Any] = {
        "formatVersion": "jojo-search-state/2",
        "excludedIds": {
            index: sorted(
                set(remote_excluded.get(index, [])) | set(local_excluded.get(index, []))
            )
            for index in sorted(set(indices))
        },
        "heads": {
            str(index): dict(values)
            for index, values in (remote.get("heads") or {}).items()
            if index in configured and isinstance(values, dict)
        },
        "canonicalRevisions": {
            str(index): dict(values)
            for index, values in (remote.get("canonicalRevisions") or {}).items()
            if index in configured and isinstance(values, dict)
        },
    }
    remote_heads = result["heads"]
    remote_excluded_sets = {
        index: set(values) for index, values in remote_excluded.items()
    }
    for index, local_values in (local.get("heads") or {}).items():
        if index not in configured or not isinstance(local_values, dict):
            continue
        merged = remote_heads.setdefault(index, {})
        for base_id, local_head in local_values.items():
            if base_id not in merged or merged[base_id] == local_head:
                merged[base_id] = local_head
                continue
            remote_head = merged[base_id]
            # A complete local chain maps the current remote head to the next
            # head. A stale workstation instead points at an ID already
            # excluded remotely and must never roll the head backward.
            if remote_head in local_values and local_values[remote_head] == local_head:
                merged[base_id] = local_head
            elif local_head in remote_excluded_sets.get(index, set()):
                continue
            else:
                raise ValueError(f"search-state 版本头冲突：{index}/{base_id}")
    return result


def load_remote_search_state(config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Load the one remote search activation object."""
    return _download_remote_state(config or publication_config())


def upload_remote_search_state(
    payload: dict[str, Any],
    config: dict[str, Any] | None = None,
) -> None:
    """Publish an already validated search activation object."""
    _upload_state(config or publication_config(), payload)


def load_remote_json_object(
    key: str,
    config: dict[str, Any] | None = None,
    *,
    missing_ok: bool = False,
) -> dict[str, Any] | None:
    """Load another small JSON control object from the configured COS bucket."""
    settings = {**(config or publication_config()), "key": key.strip().lstrip("/")}
    try:
        return _download_remote_state(settings)
    except subprocess.CalledProcessError:
        if missing_ok:
            return None
        raise


def upload_remote_json_object(
    key: str,
    payload: dict[str, Any],
    config: dict[str, Any] | None = None,
) -> None:
    """Write another small JSON control object to the configured COS bucket."""
    settings = {**(config or publication_config()), "key": key.strip().lstrip("/")}
    _upload_state(settings, payload)


def publish_applied_search_state(
    index: str,
    *,
    directory: Path = MIGRATIONS_DIR,
    config: dict[str, Any] | None = None,
    remote_loader: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    uploader: Callable[[dict[str, Any], dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    settings = config or publication_config()
    validate_publication_target(index, settings)
    load = remote_loader or _download_remote_state
    upload = uploader or _upload_state
    remote = load(settings)
    local = search_state_payload(settings["indices"], directory)
    payload = merge_search_state(remote, local, settings["indices"])
    upload(settings, payload)
    return {
        "object": f"cos://{settings['bucket']}/{settings['key']}",
        "indices": sorted(settings["indices"]),
        "excluded": sum(len(values) for values in payload["excludedIds"].values()),
    }


def _validated_excluded_ids(payload: dict[str, Any]) -> dict[str, list[str]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("excludedIds"), dict):
        raise ValueError("远端 search-state.json 格式错误：缺少 excludedIds 对象")
    result: dict[str, list[str]] = {}
    for index, values in payload["excludedIds"].items():
        if not isinstance(index, str) or not isinstance(values, list):
            raise ValueError("远端 search-state.json 格式错误：索引或排除列表无效")
        if any(not isinstance(value, str) or not value for value in values):
            raise ValueError("远端 search-state.json 格式错误：排除 ID 必须是非空字符串")
        result[index] = values
    return result


def _tccli_command(settings: dict[str, Any], *arguments: str) -> list[str]:
    executable = shutil.which("tccli")
    if not executable:
        raise RuntimeError("未找到 tccli；请先安装并执行 tccli auth login")
    command = [executable, "cos", *arguments]
    if settings.get("profile"):
        command.extend(["--profile", settings["profile"]])
    return command


def _download_remote_state(settings: dict[str, Any]) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="jojo-search-state-read-") as temp:
        output = Path(temp) / "search-state.json"
        command = _tccli_command(
            settings,
            "download",
            "--bucket", settings["bucket"],
            "--region", settings["region"],
            "--cos_key", settings["key"],
            "--local_path", str(output),
        )
        subprocess.run(command, check=True, capture_output=True, text=True)
        return json.loads(output.read_text(encoding="utf-8"))


def _upload_state(settings: dict[str, Any], payload: dict[str, Any]) -> None:
    with tempfile.TemporaryDirectory(prefix="jojo-search-state-write-") as temp:
        state_path = Path(temp) / "search-state.json"
        state_path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        command = _tccli_command(
            settings,
            "upload",
            "--bucket", settings["bucket"],
            "--region", settings["region"],
            "--local_path", str(state_path),
            "--cos_key", settings["key"],
            "--content_type", "application/json; charset=utf-8",
        )
        subprocess.run(command, check=True, capture_output=True, text=True)


def main() -> int:
    defaults = publication_config()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--index",
        action="append",
        default=[],
        help="ES index; repeat for every index served by the SCF",
    )
    parser.add_argument("--bucket", default=defaults["bucket"])
    parser.add_argument("--region", default=defaults["region"])
    parser.add_argument("--key", default=defaults["key"])
    parser.add_argument("--profile", default=defaults["profile"])
    parser.add_argument("--migrations-dir", type=Path, default=MIGRATIONS_DIR)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    settings = {
        "bucket": args.bucket,
        "region": args.region,
        "key": args.key.lstrip("/"),
        "profile": args.profile,
        "indices": [value.strip() for value in args.index if value.strip()]
        or defaults["indices"],
    }
    local = search_state_payload(settings["indices"], args.migrations_dir)
    if args.dry_run:
        print(json.dumps(local, ensure_ascii=False, separators=(",", ":")))
        return 0

    remote = _download_remote_state(settings)
    payload = merge_search_state(remote, local, settings["indices"])
    _upload_state(settings, payload)
    count = sum(len(values) for values in payload["excludedIds"].values())
    print(
        f"published cos://{settings['bucket']}/{settings['key']} "
        f"(indices={','.join(settings['indices'])}, excluded={count})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
