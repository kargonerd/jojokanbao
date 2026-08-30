from __future__ import annotations

import json
from pathlib import Path

from tools.plan_parser_validation_watchdog import (
    _load_source_year_capacities,
)


def test_load_source_year_capacities_uses_shard_relative_path(
    tmp_path: Path,
):
    path = (
        tmp_path
        / "caixin"
        / "2010-2015"
        / "wayback-urlkey"
        / "manifest-summary.json"
    )
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "formatVersion": "jojo-capture-manifest-summary/1",
                "publisher": "caixin",
                "yearCounts": {"2010": 1069, "2015": 1},
            }
        ),
        encoding="utf-8",
    )

    assert _load_source_year_capacities(tmp_path) == {
        "caixin/2010-2015/wayback-urlkey": {2010: 1069, 2015: 1}
    }


def test_load_source_year_capacities_merges_named_supplement_sidecars(
    tmp_path: Path,
):
    shard = tmp_path / "ap" / "2010-2015" / "legacy-archive"
    shard.mkdir(parents=True)
    for name, counts in (
        ("manifest-summary.json", {"2011": 101}),
        ("wayback-yahoo-manifest-summary.json", {"2011": 134075}),
        ("wayback-bigstory-manifest-summary.json", {"2011": 900}),
    ):
        (shard / name).write_text(
            json.dumps(
                {
                    "formatVersion": "jojo-capture-manifest-summary/1",
                    "publisher": "ap",
                    "yearCounts": counts,
                }
            ),
            encoding="utf-8",
        )

    assert _load_source_year_capacities(tmp_path) == {
        "ap/2010-2015/legacy-archive": {2011: 134075}
    }
