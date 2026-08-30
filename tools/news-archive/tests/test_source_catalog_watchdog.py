from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from importlib.util import module_from_spec, spec_from_file_location

from jojo_news_archive.source_catalog_watchdog import (
    CATALOG_STATUS_FORMAT_VERSION,
    SOURCE_CATALOG_TARGETS,
    SourceCatalogTarget,
    plan_source_catalog_dispatch,
)


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "tools"
    / "write_source_catalog_status.py"
)
SPEC = spec_from_file_location("write_source_catalog_status", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
STATUS_MODULE = module_from_spec(SPEC)
SPEC.loader.exec_module(STATUS_MODULE)


def test_default_targets_include_both_scmp_official_archive_windows():
    scmp_sitemaps = {
        (target.from_year, target.to_year, target.max_discovery_pages)
        for target in SOURCE_CATALOG_TARGETS
        if target.publisher == "scmp"
        and target.manifest_mode == "sitemap-wayback"
    }

    assert scmp_sitemaps == {(2010, 2015, 30), (2016, 2026, 30)}


def _write_status(
    root: Path,
    target: SourceCatalogTarget,
    *,
    complete: bool,
    should_continue: bool,
) -> None:
    path = root / target.shard / "catalog" / "status.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "formatVersion": CATALOG_STATUS_FORMAT_VERSION,
                "publisher": target.publisher,
                "fromYear": target.from_year,
                "toYear": target.to_year,
                "manifestMode": target.manifest_mode,
                "complete": complete,
                "captureReady": True,
                "shouldContinue": should_continue,
            }
        ),
        encoding="utf-8",
    )


def test_catalog_watchdog_prioritizes_missing_sources_and_skips_active(
    tmp_path: Path,
):
    complete = SourceCatalogTarget(
        "nikkei", 2010, 2015, "wayback-urlkey", 10
    )
    active = SourceCatalogTarget(
        "scmp", 2010, 2015, "wayback-urlkey", 10
    )
    missing = SourceCatalogTarget(
        "aljazeera", 2010, 2015, "sitemap-wayback", 30
    )
    old_manifest = SourceCatalogTarget(
        "caixin", 2010, 2015, "wayback-urlkey", 10
    )
    _write_status(
        tmp_path,
        complete,
        complete=True,
        should_continue=False,
    )

    plan = plan_source_catalog_dispatch(
        status_root=tmp_path,
        active_titles=[active.run_title],
        available_source_shards={complete.shard, active.shard, old_manifest.shard},
        max_dispatch=2,
        max_active_catalogs=3,
        targets=[complete, active, old_manifest, missing],
    )

    assert plan["completeCatalogs"] == 1
    assert plan["activeCatalogs"] == 1
    assert [task["sourceManifestShard"] for task in plan["tasks"]] == [
        missing.shard,
        old_manifest.shard,
    ]


def test_catalog_watchdog_retries_invalid_status(tmp_path: Path):
    target = SourceCatalogTarget(
        "zaobao", 2016, 2026, "sitemap-wayback", 30
    )
    path = tmp_path / target.shard / "catalog" / "status.json"
    path.parent.mkdir(parents=True)
    path.write_text('{"formatVersion":"wrong"}', encoding="utf-8")

    plan = plan_source_catalog_dispatch(
        status_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        targets=[target],
    )

    assert plan["invalidStatuses"] == [
        f"{target.shard}/catalog/status.json"
    ]
    assert plan["tasks"][0]["publisher"] == "zaobao"


def test_catalog_watchdog_reserves_the_other_slot_for_validation(
    tmp_path: Path,
):
    active = SourceCatalogTarget(
        "aljazeera", 2010, 2015, "sitemap-wayback", 30
    )
    pending = SourceCatalogTarget(
        "zaobao", 2016, 2026, "sitemap-wayback", 30
    )

    plan = plan_source_catalog_dispatch(
        status_root=tmp_path,
        active_titles=[active.run_title],
        max_dispatch=1,
        max_active_catalogs=1,
        targets=[active, pending],
    )

    assert plan["activeCatalogs"] == 1
    assert plan["tasks"] == []


def test_catalog_watchdog_counts_non_bootstrap_archive_chain(
    tmp_path: Path,
):
    pending = SourceCatalogTarget(
        "aljazeera", 2010, 2015, "sitemap-wayback", 30
    )

    plan = plan_source_catalog_dispatch(
        status_root=tmp_path,
        active_titles=["news-raw-wsj-2016-2026-wayback-urlkey"],
        max_dispatch=1,
        max_active_catalogs=1,
        targets=[pending],
    )

    assert plan["activeCatalogs"] == 1
    assert plan["tasks"] == []


def test_catalog_watchdog_counts_dedicated_nikkei_common_crawl_chain(
    tmp_path: Path,
):
    pending = SourceCatalogTarget(
        "aljazeera", 2010, 2015, "sitemap-wayback", 30
    )

    plan = plan_source_catalog_dispatch(
        status_root=tmp_path,
        active_titles=["nikkei-common-crawl-2010-2015"],
        max_dispatch=1,
        max_active_catalogs=1,
        targets=[pending],
    )

    assert plan["activeCatalogs"] == 1
    assert plan["tasks"] == []


def test_catalog_watchdog_counts_any_publisher_common_crawl_chain(
    tmp_path: Path,
):
    pending = SourceCatalogTarget(
        "aljazeera", 2016, 2026, "sitemap-wayback", 30
    )

    plan = plan_source_catalog_dispatch(
        status_root=tmp_path,
        active_titles=["npr-common-crawl-2012-2016"],
        max_dispatch=1,
        max_active_catalogs=1,
        targets=[pending],
    )

    assert plan["activeCatalogs"] == 1
    assert plan["tasks"] == []


def test_catalog_status_writer_round_trip(tmp_path: Path):
    output = tmp_path / "status.json"
    payload = STATUS_MODULE.write_source_catalog_status(
        output,
        publisher="aljazeera",
        from_year=2010,
        to_year=2015,
        manifest_mode="sitemap-wayback",
        complete=False,
        capture_ready=True,
        should_continue=True,
        updated_at=datetime(2026, 8, 11, tzinfo=timezone.utc),
    )

    assert json.loads(output.read_text(encoding="utf-8")) == payload
    assert payload["updatedAt"] == "2026-08-11T00:00:00+00:00"
