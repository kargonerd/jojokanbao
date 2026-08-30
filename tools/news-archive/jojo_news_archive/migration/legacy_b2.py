"""Safe Hugging Face layout and exact file manifests for the legacy archive.

This module is deliberately transport agnostic.  It turns a local directory
whose relative paths represent legacy B2 object keys into exact, hashed file
sets that the TypeScript HF transport can upload.  No B2 or HF client lives
here, which keeps both migration review and unit tests deterministic.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import tempfile
from typing import Any


FILE_SET_FORMAT_VERSION = "jojo-hf-file-set/1"
LEGACY_V1_PREFIX = "news-archive/v1/"
LEGACY_V2_PREFIX = "news-archive/v2/validation-state/"
HF_V1_PREFIX = "raw/archive/v1/"
HF_V2_PREFIX = "raw/archive/v2/validation-state/"


class ArchivePhase(str, Enum):
    """Publication order for a recoverable archive batch."""

    IMMUTABLE = "immutable"
    CATALOG = "catalog"
    CHECKPOINT = "checkpoint"
    COMPLETION = "completion"


PHASE_ORDER = (
    ArchivePhase.IMMUTABLE,
    ArchivePhase.CATALOG,
    ArchivePhase.CHECKPOINT,
    ArchivePhase.COMPLETION,
)

PHASE_FILENAMES: Mapping[ArchivePhase, str] = {
    ArchivePhase.IMMUTABLE: "01-immutable.json",
    ArchivePhase.CATALOG: "02-catalog.json",
    ArchivePhase.CHECKPOINT: "03-checkpoint.json",
    ArchivePhase.COMPLETION: "04-completion.json",
}


@dataclass(frozen=True)
class HfArchiveFile:
    """One exact local-to-HF object mapping."""

    local_path: str
    object_name: str
    size: int
    sha256: str
    required: bool = True

    def as_json(self) -> dict[str, object]:
        return {
            "localPath": self.local_path,
            "objectName": self.object_name,
            "size": self.size,
            "sha256": self.sha256,
            "required": self.required,
        }


def _safe_posix_path(value: str, *, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    if "\\" in value or value.startswith("/") or value.endswith("/"):
        raise ValueError(f"unsafe {label}: {value!r}")
    pieces = value.split("/")
    if any(piece in {"", ".", ".."} for piece in pieces):
        raise ValueError(f"unsafe {label}: {value!r}")
    # A drive-qualified first component can escape a Windows root when joined.
    if ":" in pieces[0]:
        raise ValueError(f"unsafe {label}: {value!r}")
    return PurePosixPath(*pieces).as_posix()


def _join_posix(prefix: str, relative: str) -> str:
    normalized_relative = _safe_posix_path(relative, label="local path")
    if not prefix:
        return normalized_relative
    normalized_prefix = _safe_posix_path(
        prefix.strip("/"), label="legacy B2 prefix"
    )
    return f"{normalized_prefix}/{normalized_relative}"


def map_legacy_b2_object(object_key: str) -> str:
    """Map only the two approved legacy B2 namespaces into HF Raw.

    In particular, the retired ``research-archives`` experiment and every
    other bucket key are rejected rather than copied opportunistically.
    """

    key = _safe_posix_path(object_key, label="legacy B2 object key")
    if key.startswith(LEGACY_V1_PREFIX):
        suffix = key[len(LEGACY_V1_PREFIX) :]
        object_name = f"{HF_V1_PREFIX}{suffix}"
    elif key.startswith(LEGACY_V2_PREFIX):
        suffix = key[len(LEGACY_V2_PREFIX) :]
        object_name = f"{HF_V2_PREFIX}{suffix}"
    else:
        raise ValueError(f"legacy B2 object is outside the migration allowlist: {key}")
    # This also checks the structural shape and supported subtrees.
    archive_phase(object_name)
    return object_name


def legacy_b2_object_for_hf(object_name: str) -> str:
    """Return the unique approved legacy key for an HF archive object."""

    normalized = _safe_posix_path(object_name, label="HF object name")
    if normalized.startswith(HF_V1_PREFIX):
        legacy = f"{LEGACY_V1_PREFIX}{normalized[len(HF_V1_PREFIX):]}"
    elif normalized.startswith(HF_V2_PREFIX):
        legacy = f"{LEGACY_V2_PREFIX}{normalized[len(HF_V2_PREFIX):]}"
    else:
        raise ValueError(f"HF object is outside the archive Raw allowlist: {normalized}")
    # Keep inverse mapping strict as the layout evolves.
    if map_legacy_b2_object(legacy) != normalized:
        raise ValueError(f"HF archive object is not reversibly mapped: {normalized}")
    return legacy


def _is_completion_marker(relative_state_path: Sequence[str]) -> bool:
    if len(relative_state_path) != 1:
        return False
    filename = relative_state_path[0]
    return filename == "summary.json" or filename.endswith("-summary.json")


def archive_phase(object_name: str) -> ArchivePhase:
    """Classify an approved HF object into its required publish phase."""

    normalized = _safe_posix_path(object_name, label="HF object name")
    pieces = normalized.split("/")
    if normalized.startswith(HF_V1_PREFIX):
        # raw/archive/v1/{publisher}/{window}/{mode}/{area}/...
        suffix = pieces[3:]
        if len(suffix) < 5:
            raise ValueError(f"incomplete HF v1 archive object: {normalized}")
        _publisher, _window, _mode, area, *relative = suffix
        if area == "raw":
            if len(relative) < 2 or relative[0] not in {"objects", "records"}:
                raise ValueError(f"unsupported HF v1 Raw object: {normalized}")
            return ArchivePhase.IMMUTABLE
        if area == "catalog" and relative:
            return ArchivePhase.CATALOG
        if area == "state" and relative:
            return (
                ArchivePhase.COMPLETION
                if _is_completion_marker(relative)
                else ArchivePhase.CHECKPOINT
            )
        raise ValueError(f"unsupported HF v1 archive subtree: {normalized}")

    if normalized.startswith(HF_V2_PREFIX):
        # raw/archive/v2/validation-state/{cohort}/{publisher}/{year}/{area}/...
        suffix = pieces[4:]
        if len(suffix) < 5:
            raise ValueError(f"incomplete HF v2 validation object: {normalized}")
        _cohort, _publisher, _year, area, *relative = suffix
        if area == "catalog" and relative:
            return ArchivePhase.CATALOG
        if area == "state" and relative:
            return (
                ArchivePhase.COMPLETION
                if _is_completion_marker(relative)
                else ArchivePhase.CHECKPOINT
            )
        # Validation cohorts deliberately reference canonical v1 Raw objects;
        # duplicating objects or records below v2 would violate that contract.
        raise ValueError(f"unsupported HF v2 validation subtree: {normalized}")

    raise ValueError(f"HF object is outside the archive Raw allowlist: {normalized}")


def validate_phase_order(phases: Iterable[ArchivePhase | str]) -> tuple[ArchivePhase, ...]:
    """Reject duplicate, skipped, or out-of-order publication phases."""

    normalized = tuple(ArchivePhase(value) for value in phases)
    expected = PHASE_ORDER[: len(normalized)]
    if normalized != expected:
        raise ValueError(
            "archive phases must be published in order: "
            + " -> ".join(phase.value for phase in PHASE_ORDER)
        )
    return normalized


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inventory_archive_directory(
    root: Path,
    *,
    legacy_b2_prefix: str = "",
    excluded_paths: Iterable[Path] = (),
) -> tuple[HfArchiveFile, ...]:
    """Hash and map every regular file below ``root`` deterministically."""

    root = root.resolve()
    if not root.is_dir():
        raise ValueError(f"archive inventory root is not a directory: {root}")
    excluded = {path.resolve() for path in excluded_paths}
    entries: list[HfArchiveFile] = []
    object_names: set[str] = set()
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        resolved = path.resolve()
        if resolved in excluded:
            continue
        if path.is_symlink():
            raise ValueError(f"archive inventory cannot contain symlinks: {path}")
        if not path.is_file():
            continue
        local_path = path.relative_to(root).as_posix()
        legacy_key = _join_posix(legacy_b2_prefix, local_path)
        object_name = map_legacy_b2_object(legacy_key)
        if object_name in object_names:
            raise ValueError(f"duplicate HF object in archive inventory: {object_name}")
        object_names.add(object_name)
        entries.append(
            HfArchiveFile(
                local_path=local_path,
                object_name=object_name,
                size=path.stat().st_size,
                sha256=_sha256(path),
            )
        )
    return tuple(sorted(entries, key=lambda entry: (entry.object_name, entry.local_path)))


def file_set(entries: Iterable[HfArchiveFile]) -> dict[str, object]:
    """Serialize entries using the shared TypeScript/Python contract."""

    ordered = sorted(entries, key=lambda entry: (entry.object_name, entry.local_path))
    seen_local: set[str] = set()
    seen_objects: set[str] = set()
    files: list[dict[str, object]] = []
    for entry in ordered:
        _safe_posix_path(entry.local_path, label="local path")
        archive_phase(entry.object_name)
        if entry.local_path in seen_local:
            raise ValueError(f"duplicate local path in HF file set: {entry.local_path}")
        if entry.object_name in seen_objects:
            raise ValueError(f"duplicate object name in HF file set: {entry.object_name}")
        if entry.size < 0:
            raise ValueError(f"negative file size for {entry.local_path}")
        if len(entry.sha256) != 64 or any(
            character not in "0123456789abcdef" for character in entry.sha256
        ):
            raise ValueError(f"invalid SHA-256 for {entry.local_path}")
        seen_local.add(entry.local_path)
        seen_objects.add(entry.object_name)
        files.append(entry.as_json())
    return {"formatVersion": FILE_SET_FORMAT_VERSION, "files": files}


def split_inventory_by_phase(
    entries: Iterable[HfArchiveFile],
) -> dict[ArchivePhase, tuple[HfArchiveFile, ...]]:
    output: dict[ArchivePhase, list[HfArchiveFile]] = {
        phase: [] for phase in PHASE_ORDER
    }
    for entry in entries:
        output[archive_phase(entry.object_name)].append(entry)
    return {phase: tuple(output[phase]) for phase in PHASE_ORDER}


def _encoded_file_set(payload: Mapping[str, object]) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def write_file_set(path: Path, entries: Iterable[HfArchiveFile]) -> bool:
    """Atomically write a file set, preserving mtime when it is unchanged."""

    encoded = _encoded_file_set(file_set(entries))
    if path.exists() and path.read_bytes() == encoded:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(encoded)
    temporary.replace(path)
    return True


def prepare_archive_batch(
    root: Path,
    output_dir: Path,
    *,
    legacy_b2_prefix: str = "",
) -> dict[ArchivePhase, Path]:
    """Create the four ordered, exact file manifests for a local inventory."""

    output_dir = output_dir.resolve()
    destinations = {
        phase: output_dir / PHASE_FILENAMES[phase] for phase in PHASE_ORDER
    }
    ignored = [*destinations.values()]
    # A stale interrupted atomic write must not pollute a repeated inventory.
    ignored.extend(
        path.with_suffix(path.suffix + ".tmp") for path in tuple(ignored)
    )
    inventory = inventory_archive_directory(
        root,
        legacy_b2_prefix=legacy_b2_prefix,
        excluded_paths=ignored,
    )
    by_phase = split_inventory_by_phase(inventory)
    for phase in PHASE_ORDER:
        write_file_set(destinations[phase], by_phase[phase])
    return destinations


def parse_file_set(payload: object) -> tuple[HfArchiveFile, ...]:
    """Validate and parse the exact HF file-set JSON contract."""

    if not isinstance(payload, dict):
        raise ValueError("HF file set must be a JSON object")
    if set(payload) != {"formatVersion", "files"}:
        raise ValueError("HF file set must contain only formatVersion and files")
    if payload.get("formatVersion") != FILE_SET_FORMAT_VERSION:
        raise ValueError("unsupported HF file-set formatVersion")
    rows = payload.get("files")
    if not isinstance(rows, list):
        raise ValueError("HF file-set files must be an array")
    entries: list[HfArchiveFile] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"HF file-set row {index} must be an object")
        allowed = {"localPath", "objectName", "size", "sha256", "required"}
        if not set(row).issubset(allowed) or not {
            "localPath",
            "objectName",
            "size",
            "sha256",
        }.issubset(row):
            raise ValueError(f"HF file-set row {index} has invalid fields")
        local_path = _safe_posix_path(row["localPath"], label="local path")
        object_name = _safe_posix_path(row["objectName"], label="HF object name")
        archive_phase(object_name)
        size = row["size"]
        sha256 = row["sha256"]
        required = row.get("required", True)
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise ValueError(f"HF file-set row {index} has invalid size")
        if not isinstance(sha256, str) or len(sha256) != 64 or any(
            character not in "0123456789abcdef" for character in sha256
        ):
            raise ValueError(f"HF file-set row {index} has invalid sha256")
        if not isinstance(required, bool):
            raise ValueError(f"HF file-set row {index} has invalid required flag")
        entries.append(
            HfArchiveFile(
                local_path=local_path,
                object_name=object_name,
                size=size,
                sha256=sha256,
                required=required,
            )
        )
    # Reuse duplicate and value checks while retaining defaulted `required`.
    file_set(entries)
    return tuple(entries)


def load_file_set(path: Path) -> tuple[HfArchiveFile, ...]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read HF file set {path}: {error}") from error
    return parse_file_set(payload)


def _local_file(root: Path, local_path: str) -> Path:
    normalized = _safe_posix_path(local_path, label="local path")
    root = root.resolve()
    candidate = root.joinpath(*normalized.split("/")).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"local path escapes archive root: {local_path}")
    return candidate


def _verify_gzip(path: Path) -> None:
    try:
        with gzip.open(path, "rb") as source:
            for _chunk in iter(lambda: source.read(1024 * 1024), b""):
                pass
    except (OSError, EOFError) as error:
        raise ValueError(f"invalid gzip file {path}: {error}") from error


def _verify_sqlite_gzip(path: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="jojo-hf-sqlite-") as directory:
        temporary = Path(directory) / "checkpoint.sqlite3"
        try:
            with gzip.open(path, "rb") as source, temporary.open("wb") as target:
                shutil.copyfileobj(source, target)
        except (OSError, EOFError) as error:
            raise ValueError(f"invalid gzip SQLite checkpoint {path}: {error}") from error
        try:
            connection = sqlite3.connect(
                f"file:{temporary.resolve().as_posix()}?mode=ro",
                uri=True,
            )
            try:
                rows = [
                    str(row[0])
                    for row in connection.execute("PRAGMA integrity_check")
                ]
            finally:
                connection.close()
        except sqlite3.DatabaseError as error:
            raise ValueError(f"invalid SQLite checkpoint {path}: {error}") from error
        if rows != ["ok"]:
            raise ValueError(
                f"SQLite integrity_check failed for {path}: {'; '.join(rows)}"
            )


def _json_references(payload: Mapping[str, Any], *, record_name: str) -> tuple[str, ...]:
    references: list[str] = []
    raw_html = payload.get("rawHtml")
    if not isinstance(raw_html, dict) or not isinstance(raw_html.get("path"), str):
        raise ValueError(f"Raw capture record has no rawHtml.path: {record_name}")
    references.append(_safe_posix_path(raw_html["path"], label="Raw blob reference"))
    resources = payload.get("dependentResources", [])
    if not isinstance(resources, list):
        raise ValueError(f"Raw capture dependentResources is not an array: {record_name}")
    for index, resource in enumerate(resources):
        blob = resource.get("blob") if isinstance(resource, dict) else None
        path = blob.get("path") if isinstance(blob, dict) else None
        if not isinstance(path, str):
            raise ValueError(
                f"Raw capture resource {index} has no blob.path: {record_name}"
            )
        references.append(_safe_posix_path(path, label="Raw blob reference"))
    return tuple(references)


def _record_references(
    root: Path,
    entries: Sequence[HfArchiveFile],
    object_names: set[str],
) -> int:
    checked = 0
    marker = "/raw/records/"
    for entry in entries:
        if marker not in entry.object_name or not entry.object_name.endswith(".json"):
            continue
        path = _local_file(root, entry.local_path)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError(f"invalid Raw capture record {entry.local_path}: {error}") from error
        if not isinstance(payload, dict):
            raise ValueError(f"Raw capture record is not an object: {entry.local_path}")
        raw_root = entry.object_name.split(marker, 1)[0] + "/raw/"
        for reference in _json_references(payload, record_name=entry.object_name):
            expected = f"{raw_root}{reference}"
            if expected not in object_names:
                raise ValueError(
                    f"Raw capture record {entry.object_name} references missing object {expected}"
                )
            checked += 1
    return checked


def _sqlite_references(path: Path) -> tuple[str, ...]:
    references: list[str] = []
    with tempfile.TemporaryDirectory(prefix="jojo-hf-sqlite-") as directory:
        temporary = Path(directory) / "checkpoint.sqlite3"
        with gzip.open(path, "rb") as source, temporary.open("wb") as target:
            shutil.copyfileobj(source, target)
        connection = sqlite3.connect(
            f"file:{temporary.resolve().as_posix()}?mode=ro",
            uri=True,
        )
        try:
            tables = {
                str(row[0])
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            if "captures" not in tables:
                return ()
            columns = {
                str(row[1])
                for row in connection.execute("PRAGMA table_info(captures)")
            }
            selected = [name for name in ("raw_path", "record_path") if name in columns]
            if not selected:
                return ()
            query = "SELECT " + ", ".join(selected) + " FROM captures"
            for row in connection.execute(query):
                for value in row:
                    if value is not None:
                        if not isinstance(value, str):
                            raise ValueError(
                                f"SQLite capture reference is not text in {path}"
                            )
                        references.append(
                            _safe_posix_path(value, label="SQLite capture reference")
                        )
        finally:
            connection.close()
    return tuple(references)


def _v2_publisher(object_name: str) -> str | None:
    if not object_name.startswith(HF_V2_PREFIX):
        return None
    suffix = object_name[len(HF_V2_PREFIX) :].split("/")
    return suffix[1] if len(suffix) >= 2 else None


def _checkpoint_references(
    root: Path,
    entries: Sequence[HfArchiveFile],
    object_names: set[str],
) -> int:
    checked = 0
    for entry in entries:
        if not entry.object_name.endswith(".sqlite3.gz"):
            continue
        path = _local_file(root, entry.local_path)
        references = _sqlite_references(path)
        if not references:
            continue
        if entry.object_name.startswith(HF_V1_PREFIX):
            shard_root = entry.object_name.split("/state/", 1)[0]
            roots = (f"{shard_root}/raw/",)
        else:
            publisher = _v2_publisher(entry.object_name)
            roots = tuple(
                name[: -len(reference)]
                for reference in references[:1]
                for name in object_names
                if name.startswith(f"{HF_V1_PREFIX}{publisher}/")
                and name.endswith(f"/raw/{reference}")
            )
        for reference in references:
            if entry.object_name.startswith(HF_V1_PREFIX):
                present = any(f"{prefix}{reference}" in object_names for prefix in roots)
            else:
                publisher = _v2_publisher(entry.object_name)
                present = any(
                    name.startswith(f"{HF_V1_PREFIX}{publisher}/")
                    and name.endswith(f"/raw/{reference}")
                    for name in object_names
                )
            if not present:
                raise ValueError(
                    f"SQLite checkpoint {entry.object_name} references missing Raw path {reference}"
                )
            checked += 1
    return checked


def verify_file_entries(
    root: Path,
    entries: Sequence[HfArchiveFile],
    *,
    available_entries: Sequence[HfArchiveFile] | None = None,
) -> dict[str, int]:
    """Verify local bytes, compression, SQLite, and durable references."""

    root = root.resolve()
    available = tuple(available_entries) if available_entries is not None else tuple(entries)
    object_names = {entry.object_name for entry in available}
    verified = 0
    gzip_files = 0
    sqlite_files = 0
    json_files = 0
    for entry in entries:
        path = _local_file(root, entry.local_path)
        if not path.exists():
            if entry.required:
                raise ValueError(f"required HF upload file is missing: {entry.local_path}")
            continue
        if not path.is_file():
            raise ValueError(f"HF upload path is not a file: {entry.local_path}")
        actual_size = path.stat().st_size
        if actual_size != entry.size:
            raise ValueError(
                f"size mismatch for {entry.local_path}: expected {entry.size}, got {actual_size}"
            )
        actual_sha256 = _sha256(path)
        if actual_sha256 != entry.sha256:
            raise ValueError(
                f"SHA-256 mismatch for {entry.local_path}: expected {entry.sha256}, got {actual_sha256}"
            )
        if entry.object_name.endswith(".gz"):
            _verify_gzip(path)
            gzip_files += 1
        if entry.object_name.endswith(".sqlite3.gz"):
            _verify_sqlite_gzip(path)
            sqlite_files += 1
        elif entry.object_name.endswith(".json"):
            try:
                json.loads(path.read_text(encoding="utf-8"))
            except (UnicodeError, json.JSONDecodeError) as error:
                raise ValueError(f"invalid JSON file {entry.local_path}: {error}") from error
            json_files += 1
        verified += 1
    record_references = _record_references(root, entries, object_names)
    checkpoint_references = _checkpoint_references(root, entries, object_names)
    return {
        "files": verified,
        "gzipFiles": gzip_files,
        "sqliteFiles": sqlite_files,
        "jsonFiles": json_files,
        "references": record_references + checkpoint_references,
    }


def verify_archive_batch(
    root: Path,
    manifest_dir: Path,
    *,
    legacy_b2_prefix: str = "",
    available_file_manifests: Sequence[Path] = (),
) -> dict[str, object]:
    """Verify exact directory coverage and all four publication phases."""

    manifest_dir = manifest_dir.resolve()
    manifest_paths = {
        phase: manifest_dir / PHASE_FILENAMES[phase] for phase in PHASE_ORDER
    }
    validate_phase_order(PHASE_ORDER)
    loaded: dict[ArchivePhase, tuple[HfArchiveFile, ...]] = {}
    for phase in PHASE_ORDER:
        entries = load_file_set(manifest_paths[phase])
        wrong = [
            entry.object_name
            for entry in entries
            if archive_phase(entry.object_name) != phase
        ]
        if wrong:
            raise ValueError(
                f"{manifest_paths[phase]} contains objects from the wrong phase: {wrong[0]}"
            )
        loaded[phase] = entries

    all_entries = tuple(
        entry for phase in PHASE_ORDER for entry in loaded[phase]
    )
    # Duplicate detection must span manifests, not only each individual file.
    file_set(all_entries)
    ignored = [*manifest_paths.values()]
    ignored.extend(
        path.with_suffix(path.suffix + ".tmp") for path in tuple(ignored)
    )
    actual = inventory_archive_directory(
        root,
        legacy_b2_prefix=legacy_b2_prefix,
        excluded_paths=ignored,
    )
    expected_rows = [entry.as_json() for entry in all_entries]
    actual_rows = [entry.as_json() for entry in actual]
    if sorted(expected_rows, key=lambda row: str(row["objectName"])) != sorted(
        actual_rows, key=lambda row: str(row["objectName"])
    ):
        expected_names = {entry.object_name for entry in all_entries}
        actual_names = {entry.object_name for entry in actual}
        missing = sorted(expected_names - actual_names)
        extra = sorted(actual_names - expected_names)
        if missing or extra:
            raise ValueError(
                f"file manifests do not exactly cover directory inventory; missing={missing}, extra={extra}"
            )
        raise ValueError("file manifests do not match directory size/hash inventory")

    known_by_object = {entry.object_name: entry for entry in all_entries}
    for available_manifest in available_file_manifests:
        for entry in load_file_set(available_manifest):
            existing = known_by_object.get(entry.object_name)
            if existing and (
                existing.size != entry.size or existing.sha256 != entry.sha256
            ):
                raise ValueError(
                    "available HF object conflicts with the local batch: "
                    f"{entry.object_name}"
                )
            known_by_object.setdefault(entry.object_name, entry)

    available_entries = tuple(known_by_object.values())
    metrics: dict[str, dict[str, int]] = {}
    for phase in PHASE_ORDER:
        metrics[phase.value] = verify_file_entries(
            root,
            loaded[phase],
            available_entries=available_entries,
        )
    return {
        "formatVersion": FILE_SET_FORMAT_VERSION,
        "files": len(all_entries),
        "bytes": sum(entry.size for entry in all_entries),
        "availableReferenceObjects": len(available_entries) - len(all_entries),
        "phases": metrics,
    }
