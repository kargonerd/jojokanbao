import importlib.util
import json
import sys
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).resolve().parents[1] / "publish_all_periodicals.py"
SPEC = importlib.util.spec_from_file_location("publish_all_periodicals", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC.loader.exec_module(MODULE)


def write_report(path: Path, merged: Path, *, safe: bool, orphan_count: int) -> None:
    path.write_text(
        json.dumps(
            {
                "output": str(merged.resolve()),
                "safeToPublish": safe,
                "counters": {"jsonlOrphanedContentRows": orphan_count},
            }
        ),
        encoding="utf-8",
    )


def test_validate_safe_rmrb_merge_accepts_zero_orphans(tmp_path: Path):
    merged = tmp_path / "merged.jsonl"
    merged.write_text("", encoding="utf-8")
    report = tmp_path / "report.json"
    write_report(report, merged, safe=True, orphan_count=0)

    loaded = MODULE.validate_safe_rmrb_merge(merged, report)

    assert loaded["safeToPublish"] is True


@pytest.mark.parametrize(
    ("safe", "orphan_count"),
    [(False, 1), (True, 1), (False, 0)],
)
def test_validate_safe_rmrb_merge_rejects_any_unproven_loss(
    tmp_path: Path, safe: bool, orphan_count: int
):
    merged = tmp_path / "merged.jsonl"
    merged.write_text("", encoding="utf-8")
    report = tmp_path / "report.json"
    write_report(report, merged, safe=safe, orphan_count=orphan_count)

    with pytest.raises(RuntimeError, match="not safe to publish"):
        MODULE.validate_safe_rmrb_merge(merged, report)


def test_validate_safe_rmrb_merge_rejects_report_for_another_file(tmp_path: Path):
    merged = tmp_path / "merged.jsonl"
    merged.write_text("", encoding="utf-8")
    other = tmp_path / "other.jsonl"
    other.write_text("", encoding="utf-8")
    report = tmp_path / "report.json"
    write_report(report, other, safe=True, orphan_count=0)

    with pytest.raises(RuntimeError, match="does not describe"):
        MODULE.validate_safe_rmrb_merge(merged, report)
