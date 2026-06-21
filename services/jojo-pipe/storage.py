#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Storage backend abstraction for JOJO Pipe.

The old tool wrote into a OneDrive synced folder directly. This module keeps
that local-folder behavior as one backend, and adds rclone-backed object storage
for R2/S3 without changing processing code when the target changes.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
import posixpath
import shutil
import subprocess
import tempfile
import time
from typing import Any


CONFIG_PATH = "config.json"
DEFAULT_PROCESSED_PREFIX = "{code}"
DEFAULT_SPLIT_PREFIX = "internal/{code}"


class StorageError(RuntimeError):
    """Raised when a configured storage backend cannot complete an operation."""


def load_full_config(config_path: str = CONFIG_PATH) -> dict[str, Any]:
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_publications(config_path: str = CONFIG_PATH) -> dict[str, Any]:
    return load_full_config(config_path).get("publications", {})


def _format_prefix(template: str, pub_code: str) -> str:
    return _normalize_key(template.format(code=pub_code, code_lower=pub_code.lower()))


def _normalize_key(value: str | None) -> str:
    if not value:
        return ""
    return str(value).replace("\\", "/").strip("/")


def _local_path(root: str, key: str) -> str:
    key = _normalize_key(key)
    if not key:
        return root
    return os.path.join(root, *key.split("/"))


def _remote_path(remote: str, key: str) -> str:
    remote = remote.rstrip("/")
    key = _normalize_key(key)
    if not key:
        return remote
    return f"{remote}/{key}"


def _join_key(*parts: str) -> str:
    cleaned = [_normalize_key(part) for part in parts if _normalize_key(part)]
    if not cleaned:
        return ""
    return posixpath.join(*cleaned)


def _backend_int(backend_config: dict[str, Any], name: str, default: int) -> int:
    try:
        return int(backend_config.get(name, default))
    except (TypeError, ValueError):
        return default


def _storage_overrides(pub_config: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
    storage_config = pub_config.get("storage")
    if isinstance(storage_config, str):
        return storage_config, {}
    if isinstance(storage_config, dict):
        backend = storage_config.get("backend") or storage_config.get("name")
        overrides = {k: v for k, v in storage_config.items() if k not in {"backend", "name"}}
        return backend, overrides
    return pub_config.get("storage_backend"), {}


def make_publication_storage_config(
    config: dict[str, Any],
    pub_code: str,
    pub_info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return the storage fragment that should be persisted for a publication."""
    pub_info = pub_info or {}
    backend_name, overrides = _storage_overrides(pub_info)
    storage_root = config.get("storage", {})
    backend_name = backend_name or storage_root.get("default_backend")

    if backend_name:
        result: dict[str, Any] = {"storage": {"backend": backend_name}}
        for key in ("processed_prefix", "split_prefix"):
            if key in overrides:
                result["storage"][key] = overrides[key]
        return result

    paths = config.get("paths", {})
    onedrive_root = paths.get("onedrive")
    if onedrive_root:
        return {
            "processed_path": os.path.join(onedrive_root, pub_code),
            "split_path": os.path.join(onedrive_root, "internal", pub_code),
        }

    return {}


def resolve_publication_storage(
    pub_code: str,
    pub_config: dict[str, Any] | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    config = config or load_full_config()
    if pub_config is None:
        pub_config = config.get("publications", {}).get(pub_code, {})

    storage_root = config.get("storage", {})
    backend_name, overrides = _storage_overrides(pub_config)
    backend_name = backend_name or storage_root.get("default_backend")
    backend = storage_root.get("backends", {}).get(backend_name or "")

    if backend:
        backend_type = backend.get("type", "local")
        processed_template = overrides.get(
            "processed_prefix",
            backend.get("processed_prefix", DEFAULT_PROCESSED_PREFIX),
        )
        split_template = overrides.get(
            "split_prefix",
            backend.get("split_prefix", DEFAULT_SPLIT_PREFIX),
        )
        processed_key = _format_prefix(processed_template, pub_code)
        split_key = _format_prefix(split_template, pub_code)

        if backend_type == "local":
            root = backend.get("root") or config.get("paths", {}).get("onedrive")
            if not root:
                raise StorageError(f"Local storage backend {backend_name} has no root")
            processed_path = _local_path(root, processed_key)
            split_path = _local_path(root, split_key)
            return {
                "backend": backend_name,
                "type": "local",
                "root": root,
                "processed_path": processed_path,
                "split_path": split_path,
                "processed_label": processed_path,
                "split_label": split_path,
                "backend_config": backend,
            }

        if backend_type == "rclone":
            remote = backend.get("remote")
            if not remote:
                raise StorageError(f"rclone storage backend {backend_name} has no remote")
            processed_remote = _remote_path(remote, processed_key)
            split_remote = _remote_path(remote, split_key)
            return {
                "backend": backend_name,
                "type": "rclone",
                "remote": remote,
                "processed_key": processed_key,
                "split_key": split_key,
                "processed_path": processed_remote,
                "split_path": split_remote,
                "processed_label": processed_remote,
                "split_label": split_remote,
                "backend_config": backend,
            }

        raise StorageError(f"Unsupported storage backend type: {backend_type}")

    processed_path = pub_config.get("processed_path")
    split_path = pub_config.get("split_path")
    if not processed_path or not split_path:
        onedrive_root = config.get("paths", {}).get("onedrive")
        if onedrive_root:
            processed_path = processed_path or os.path.join(onedrive_root, pub_code)
            split_path = split_path or os.path.join(onedrive_root, "internal", pub_code)

    if not processed_path or not split_path:
        raise StorageError(f"No storage target configured for publication {pub_code}")

    return {
        "backend": "legacy-local",
        "type": "local",
        "root": os.path.dirname(processed_path),
        "processed_path": processed_path,
        "split_path": split_path,
        "processed_label": processed_path,
        "split_label": split_path,
        "backend_config": {"type": "local"},
    }


def describe_publication_storage(
    pub_code: str,
    pub_config: dict[str, Any] | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    descriptor = resolve_publication_storage(pub_code, pub_config, config)
    return {
        "storage_backend": descriptor["backend"],
        "storage_type": descriptor["type"],
        "processed_path": descriptor["processed_label"],
        "split_path": descriptor["split_label"],
    }


def ensure_publication_storage(
    pub_code: str,
    pub_config: dict[str, Any] | None = None,
    config: dict[str, Any] | None = None,
) -> None:
    storage = PublicationStorage(pub_code, pub_config, config)
    storage.ensure()


def validate_config(config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or load_full_config()
    errors: list[str] = []
    warnings: list[str] = []

    storage_root = config.get("storage", {})
    backends = storage_root.get("backends", {})
    default_backend = storage_root.get("default_backend")

    if storage_root:
        if not isinstance(backends, dict) or not backends:
            errors.append("storage.backends must define at least one backend")
        if default_backend and default_backend not in backends:
            errors.append(f"storage.default_backend references unknown backend: {default_backend}")

        for name, backend in backends.items():
            if not isinstance(backend, dict):
                errors.append(f"storage.backends.{name} must be an object")
                continue
            backend_type = backend.get("type", "local")
            if backend_type not in {"local", "rclone"}:
                errors.append(f"storage.backends.{name}.type must be local or rclone")
            if backend_type == "local" and not backend.get("root"):
                errors.append(f"storage.backends.{name}.root is required for local backends")
            if backend_type == "rclone" and not backend.get("remote"):
                errors.append(f"storage.backends.{name}.remote is required for rclone backends")
            for numeric_key in ("upload_workers", "retries", "low_level_retries"):
                if numeric_key in backend:
                    try:
                        value = int(backend[numeric_key])
                        if value < 1:
                            errors.append(f"storage.backends.{name}.{numeric_key} must be >= 1")
                    except (TypeError, ValueError):
                        errors.append(f"storage.backends.{name}.{numeric_key} must be an integer")

    publications = config.get("publications", {})
    if not isinstance(publications, dict) or not publications:
        warnings.append("publications is empty")

    for code, pub in publications.items():
        if not isinstance(pub, dict):
            errors.append(f"publications.{code} must be an object")
            continue
        for key in ("name", "type", "vue_name", "date_format"):
            if not pub.get(key):
                errors.append(f"publications.{code}.{key} is required")
        if pub.get("type") not in {"newspaper", "journal"}:
            errors.append(f"publications.{code}.type must be newspaper or journal")
        backend_name, _ = _storage_overrides(pub)
        if backend_name and backend_name not in backends:
            errors.append(f"publications.{code}.storage.backend references unknown backend: {backend_name}")
        try:
            resolve_publication_storage(code, pub, config)
        except Exception as exc:
            errors.append(f"publications.{code} storage is invalid: {exc}")

    return {
        "success": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
    }


def check_storage_health(config: dict[str, Any] | None = None, *, write: bool = False) -> dict[str, Any]:
    config = config or load_full_config()
    validation = validate_config(config)
    result: dict[str, Any] = {
        "success": validation["success"],
        "errors": list(validation["errors"]),
        "warnings": list(validation["warnings"]),
        "backends": {},
    }

    storage_root = config.get("storage", {})
    for name, backend in storage_root.get("backends", {}).items():
        backend_result = {"success": True, "type": backend.get("type", "local"), "checks": []}
        try:
            if backend_result["type"] == "local":
                root = backend.get("root")
                if not root:
                    raise StorageError("missing local root")
                if write:
                    os.makedirs(root, exist_ok=True)
                    fd, probe = tempfile.mkstemp(prefix=".jojo-pipe-health-", dir=root)
                    os.close(fd)
                    os.remove(probe)
                    backend_result["checks"].append("write")
                else:
                    if not os.path.exists(root):
                        raise StorageError(f"local root does not exist: {root}")
                    backend_result["checks"].append("exists")
            elif backend_result["type"] == "rclone":
                version = subprocess.run(
                    ["rclone", "version"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=False,
                )
                if version.returncode != 0:
                    raise StorageError("rclone is not available")
                backend_result["checks"].append("rclone")

                remote = backend.get("remote")
                _run_rclone(backend, ["lsf", remote, "--max-depth", "1"], capture=True, allow_not_found=False)
                backend_result["checks"].append("list")

                if write:
                    probe_key = _join_key("_jojo_pipe_healthcheck", f"{int(time.time() * 1000)}.txt")
                    probe_remote = _remote_path(remote, probe_key)
                    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as temp_file:
                        temp_file.write("ok\n")
                        temp_name = temp_file.name
                    try:
                        _run_rclone(backend, ["copyto", temp_name, probe_remote])
                        _run_rclone(backend, ["deletefile", probe_remote], capture=True, allow_not_found=True)
                    finally:
                        os.remove(temp_name)
                    backend_result["checks"].append("write")
            else:
                raise StorageError(f"unsupported backend type: {backend_result['type']}")
        except Exception as exc:
            backend_result["success"] = False
            backend_result["error"] = str(exc)
            result["success"] = False
            result["errors"].append(f"storage backend {name}: {exc}")

        result["backends"][name] = backend_result

    return result


def _rclone_base_args(backend_config: dict[str, Any]) -> list[str]:
    return list(backend_config.get("rclone_args", []))


def _run_rclone(
    backend_config: dict[str, Any],
    args: list[str],
    *,
    capture: bool = False,
    allow_not_found: bool = False,
) -> subprocess.CompletedProcess[str]:
    command = ["rclone", *args, *_rclone_base_args(backend_config)]
    result = subprocess.run(
        command,
        capture_output=capture,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr or ""
        if allow_not_found and ("directory not found" in stderr.lower() or "object not found" in stderr.lower()):
            return result
        raise StorageError(f"rclone failed: {' '.join(command)}\n{stderr.strip()}")
    return result


class PublicationStorage:
    def __init__(
        self,
        pub_code: str,
        pub_config: dict[str, Any] | None = None,
        config: dict[str, Any] | None = None,
    ) -> None:
        self.pub_code = pub_code
        self.config = config or load_full_config()
        self.pub_config = pub_config or self.config.get("publications", {}).get(pub_code, {})
        self.descriptor = resolve_publication_storage(pub_code, self.pub_config, self.config)
        self.backend_config = self.descriptor.get("backend_config", {})

    @property
    def type(self) -> str:
        return self.descriptor["type"]

    @property
    def processed_label(self) -> str:
        return self.descriptor["processed_label"]

    @property
    def split_label(self) -> str:
        return self.descriptor["split_label"]

    def ensure(self) -> None:
        if self.type != "local":
            return
        os.makedirs(self.descriptor["processed_path"], exist_ok=True)
        os.makedirs(self.descriptor["split_path"], exist_ok=True)

    def list_processed_files(self) -> dict[str, list[str]]:
        if self.type == "local":
            return self._list_local_processed_files()
        if self.type == "rclone":
            return self._list_rclone_processed_files()
        raise StorageError(f"Unsupported storage backend type: {self.type}")

    def existing_processed_ids(self) -> set[str]:
        existing: set[str] = set()
        for files in self.list_processed_files().values():
            for filename in files:
                existing.add(os.path.splitext(filename)[0])
        return existing

    def put_processed(self, year: str, filename: str, source_file: str) -> bool:
        if self.type == "local":
            dst_year_dir = os.path.join(self.descriptor["processed_path"], year)
            os.makedirs(dst_year_dir, exist_ok=True)
            dst_file = os.path.join(dst_year_dir, filename)
            if os.path.exists(dst_file):
                return False
            shutil.move(source_file, dst_file)
            return True

        if self.type == "rclone":
            key = _join_key(self.descriptor["processed_key"], year, filename)
            if self._exists_key(key):
                return False
            self._copyto(source_file, key)
            return True

        raise StorageError(f"Unsupported storage backend type: {self.type}")

    def put_split(self, filename: str, source_file: str) -> bool:
        if self.type == "local":
            os.makedirs(self.descriptor["split_path"], exist_ok=True)
            dst_file = os.path.join(self.descriptor["split_path"], filename)
            if os.path.exists(dst_file):
                return False
            shutil.move(source_file, dst_file)
            return True

        if self.type == "rclone":
            key = _join_key(self.descriptor["split_key"], filename)
            if self._exists_key(key):
                return False
            self._copyto(source_file, key)
            return True

        raise StorageError(f"Unsupported storage backend type: {self.type}")

    def _list_local_processed_files(self) -> dict[str, list[str]]:
        processed_path = self.descriptor["processed_path"]
        years_data: dict[str, list[str]] = {}
        if not os.path.exists(processed_path):
            return years_data

        for year_folder in sorted(os.listdir(processed_path), reverse=True):
            year_path = os.path.join(processed_path, year_folder)
            if not os.path.isdir(year_path):
                continue
            files = sorted(f for f in os.listdir(year_path) if f.lower().endswith(".pdf"))
            if files:
                years_data[year_folder] = files
        return years_data

    def _list_rclone_processed_files(self) -> dict[str, list[str]]:
        result = _run_rclone(
            self.backend_config,
            ["lsf", self.descriptor["processed_path"], "--recursive", "--files-only"],
            capture=True,
            allow_not_found=True,
        )
        if result.returncode != 0:
            return {}

        years_data: dict[str, list[str]] = {}
        for raw_line in result.stdout.splitlines():
            item = raw_line.strip().replace("\\", "/")
            if not item.lower().endswith(".pdf"):
                continue
            parts = item.split("/")
            filename = parts[-1]
            year = parts[-2] if len(parts) >= 2 and parts[-2].isdigit() else os.path.splitext(filename)[0][:4]
            if not year:
                continue
            years_data.setdefault(year, []).append(filename)

        for year, files in years_data.items():
            years_data[year] = sorted(set(files))
        return dict(sorted(years_data.items(), reverse=True))

    def write_manifest(self, stats: dict[str, Any] | None = None) -> dict[str, Any]:
        years = self.list_processed_files()
        manifest = {
            "version": 1,
            "publication": self.pub_code,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "storage": {
                "backend": self.descriptor["backend"],
                "type": self.type,
                "processed": self.processed_label,
                "split": self.split_label,
            },
            "stats": stats or {},
            "years": [
                {
                    "year": year,
                    "files": [
                        {"id": os.path.splitext(filename)[0], "filename": filename}
                        for filename in files
                    ],
                }
                for year, files in sorted(years.items(), reverse=True)
            ],
        }

        manifest_prefix = self.backend_config.get("manifest_prefix", "manifests")
        manifest_key = _join_key(manifest_prefix, f"{self.pub_code}.json")

        if self.type == "local":
            root = self.descriptor.get("root") or os.path.dirname(self.descriptor["processed_path"])
            manifest_path = _local_path(root, manifest_key)
            os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
            with open(manifest_path, "w", encoding="utf-8") as f:
                json.dump(manifest, f, ensure_ascii=False, indent=2)
            return {"path": manifest_path, "key": manifest_key}

        if self.type == "rclone":
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as temp_file:
                json.dump(manifest, temp_file, ensure_ascii=False, indent=2)
                temp_name = temp_file.name
            try:
                headers = self.backend_config.get(
                    "manifest_headers",
                    {
                        "Content-Type": "application/json; charset=utf-8",
                        "Cache-Control": "no-cache",
                    },
                )
                self._copyto(temp_name, manifest_key, headers=headers, immutable=False)
            finally:
                os.remove(temp_name)
            return {"path": _remote_path(self.backend_config["remote"], manifest_key), "key": manifest_key}

        raise StorageError(f"Unsupported storage backend type: {self.type}")

    def _exists_key(self, target_key: str) -> bool:
        if self.type == "local":
            return os.path.exists(_local_path(self.descriptor["root"], target_key))
        if self.type != "rclone":
            return False
        remote = self.backend_config["remote"]
        target = _remote_path(remote, target_key)
        result = _run_rclone(
            self.backend_config,
            ["lsf", target, "--files-only"],
            capture=True,
            allow_not_found=True,
        )
        return result.returncode == 0 and bool(result.stdout.strip())

    def _copyto(
        self,
        source_file: str,
        target_key: str,
        *,
        headers: dict[str, str] | None = None,
        immutable: bool | None = None,
    ) -> None:
        remote = self.backend_config["remote"]
        target = _remote_path(remote, target_key)
        args = ["copyto", source_file, target]

        upload_headers = headers if headers is not None else self.backend_config.get("upload_headers", {})
        for name, value in upload_headers.items():
            args.extend(["--header-upload", f"{name}: {value}"])

        use_immutable = immutable if immutable is not None else self.backend_config.get("immutable", True)
        if use_immutable:
            args.append("--immutable")

        retries = _backend_int(self.backend_config, "retries", 5)
        low_level_retries = _backend_int(self.backend_config, "low_level_retries", 10)
        args.extend(["--retries", str(retries), "--low-level-retries", str(low_level_retries)])

        _run_rclone(self.backend_config, args)


@contextmanager
def processed_tree_for_scan(
    pub_code: str,
    pub_config: dict[str, Any] | None = None,
    config: dict[str, Any] | None = None,
):
    """Yield a local directory shaped like processed_path/YYYY/*.pdf.

    Local backends yield the real directory. rclone backends build a temporary
    zero-byte index tree because Vue generation only needs filenames.
    """
    storage = PublicationStorage(pub_code, pub_config, config)
    if storage.type == "local":
        yield storage.descriptor["processed_path"]
        return

    temp_dir = tempfile.mkdtemp(prefix=f"jojo_processed_index_{pub_code}_")
    try:
        for year, files in storage.list_processed_files().items():
            year_dir = os.path.join(temp_dir, year)
            os.makedirs(year_dir, exist_ok=True)
            for filename in files:
                open(os.path.join(year_dir, filename), "a", encoding="utf-8").close()
        yield temp_dir
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
