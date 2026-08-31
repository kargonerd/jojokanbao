from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Iterable

from jojo_news_archive.sources.registry import registered_sources


FORMAT_VERSION = "jojo-source-catalog-watchdog/1"
CATALOG_STATUS_FORMAT_VERSION = "jojo-source-catalog-status/1"


@dataclass(frozen=True)
class SourceCatalogTarget:
    publisher: str
    from_year: int
    to_year: int
    manifest_mode: str
    max_discovery_pages: int

    @property
    def shard(self) -> str:
        return (
            f"{self.publisher}/{self.from_year}-{self.to_year}/"
            f"{self.manifest_mode}"
        )

    @property
    def run_title(self) -> str:
        return (
            f"news-raw-{self.publisher}-{self.from_year}-{self.to_year}-"
            f"{self.manifest_mode}"
        )


def _source_catalog_targets() -> tuple[SourceCatalogTarget, ...]:
    configured = sorted(
        (
            (target.priority, source.id, target)
            for source in registered_sources(enabled_only=True)
            for target in source.catalog_targets
        ),
        key=lambda item: (item[0], item[1]),
    )
    return tuple(
        SourceCatalogTarget(
            publisher=source_id,
            from_year=target.from_year,
            to_year=target.to_year,
            manifest_mode=target.manifest_mode,
            max_discovery_pages=target.max_discovery_pages,
        )
        for _, source_id, target in configured
    )


# Publishers own their bootstrap targets in sources/<publisher>/spec.py. The
# scheduler only consumes the merged priority queue.
SOURCE_CATALOG_TARGETS = _source_catalog_targets()


def plan_source_catalog_dispatch(
    *,
    status_root: Path,
    active_titles: Iterable[str],
    max_dispatch: int,
    max_active_catalogs: int = 1,
    available_source_shards: Iterable[str] | None = None,
    targets: Iterable[SourceCatalogTarget] = SOURCE_CATALOG_TARGETS,
) -> dict[str, object]:
    if max_dispatch < 0:
        raise ValueError("max_dispatch must be non-negative")
    if max_active_catalogs < 0:
        raise ValueError("max_active_catalogs must be non-negative")
    active = {title.strip() for title in active_titles if title.strip()}
    available = (
        None
        if available_source_shards is None
        else {
            shard.strip()
            for shard in available_source_shards
            if shard.strip()
        }
    )
    rows: list[dict[str, object]] = []
    invalid_statuses: list[str] = []
    for priority, target in enumerate(targets):
        status_path = status_root / target.shard / "catalog" / "status.json"
        status: dict[str, object] | None = None
        if status_path.is_file():
            try:
                candidate = json.loads(status_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                candidate = None
            if _status_matches_target(candidate, target=target):
                assert isinstance(candidate, dict)
                status = candidate
            else:
                invalid_statuses.append(
                    status_path.relative_to(status_root).as_posix()
                )
        manifest_available = (
            None if available is None else target.shard in available
        )
        complete = bool(
            status is not None
            and status.get("complete") is True
            and status.get("shouldContinue") is False
        )
        rows.append(
            {
                "target": target,
                "priority": priority,
                "statusPath": (
                    status_path.relative_to(status_root).as_posix()
                    if status_path.is_file()
                    else None
                ),
                "manifestAvailable": manifest_available,
                "complete": complete,
                "active": target.run_title in active,
                "shouldContinue": (
                    status.get("shouldContinue") if status is not None else None
                ),
            }
        )

    pending = [
        row
        for row in rows
        if not bool(row["complete"]) and not bool(row["active"])
    ]
    pending.sort(
        key=lambda row: (
            # Bootstrap a completely missing source before refreshing an old
            # manifest whose completion status predates the sidecar.
            0 if row["manifestAvailable"] is False else 1,
            int(row["priority"]),
        )
    )
    # Count every sustained source-archive chain, including dedicated
    # supplemental catalogs that run outside this bootstrap target list.
    # Otherwise a free slot could start a second catalog and crowd parser
    # validation out of the global two-run budget.
    # The dedicated Common Crawl workflow is publisher-agnostic: its run name
    # is ``<publisher>-common-crawl-...``. Count every source uniformly so a
    # second catalog cannot crowd parser validation out of the global budget.
    active_catalogs = sum(
        title.startswith("news-raw-") or "-common-crawl-" in title
        for title in active
    )
    catalog_slots = max(0, max_active_catalogs - active_catalogs)
    selected = pending[: min(max_dispatch, catalog_slots)]
    tasks = [_task(row["target"]) for row in selected]
    progress = [
        {
            "publisher": target.publisher,
            "fromYear": target.from_year,
            "toYear": target.to_year,
            "manifestMode": target.manifest_mode,
            "sourceManifestShard": target.shard,
            "manifestAvailable": row["manifestAvailable"],
            "statusPath": row["statusPath"],
            "complete": bool(row["complete"]),
            "active": bool(row["active"]),
            "shouldContinue": row["shouldContinue"],
        }
        for row in rows
        for target in [row["target"]]
    ]
    return {
        "formatVersion": FORMAT_VERSION,
        "targetCatalogs": len(rows),
        "completeCatalogs": sum(bool(row["complete"]) for row in rows),
        "activeCatalogs": active_catalogs,
        "pendingCatalogs": sum(not bool(row["complete"]) for row in rows),
        "invalidStatuses": invalid_statuses,
        "catalogProgress": progress,
        "tasks": tasks,
    }


def _status_matches_target(
    payload: object,
    *,
    target: SourceCatalogTarget,
) -> bool:
    if not isinstance(payload, dict):
        return False
    return bool(
        payload.get("formatVersion") == CATALOG_STATUS_FORMAT_VERSION
        and payload.get("publisher") == target.publisher
        and payload.get("fromYear") == target.from_year
        and payload.get("toYear") == target.to_year
        and payload.get("manifestMode") == target.manifest_mode
        and isinstance(payload.get("complete"), bool)
        and isinstance(payload.get("captureReady"), bool)
        and isinstance(payload.get("shouldContinue"), bool)
    )


def _task(target: SourceCatalogTarget) -> dict[str, object]:
    return {
        "publisher": target.publisher,
        "fromYear": target.from_year,
        "toYear": target.to_year,
        "manifestMode": target.manifest_mode,
        "sourceManifestShard": target.shard,
        "maxDiscoveryPages": target.max_discovery_pages,
        "runnerOs": "ubuntu-latest",
    }
