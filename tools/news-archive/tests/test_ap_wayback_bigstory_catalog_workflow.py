from __future__ import annotations

from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1] / "workflow-templates"
WORKFLOW = (
    REPOSITORY_ROOT
    / ".github"
    / "workflows"
    / "ap-wayback-bigstory-catalog.yml"
)


def test_ap_wayback_bigstory_workflow_publishes_catalog_only() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "build_ap_wayback_bigstory_manifest.py" in workflow
    assert '--from-year "$FROM_YEAR"' in workflow
    assert '--to-year "$TO_YEAR"' in workflow
    assert '--limit "$LIMIT_PER_PREFIX"' in workflow
    assert "wayback-bigstory-manifest.jsonl.gz" in workflow
    assert "wayback-bigstory-summary.json" in workflow
    assert "summarize_archive_manifest.py" in workflow
    assert "wayback-bigstory-manifest-summary.json" in workflow
    assert "news-archive/v1/ap/2010-2015/legacy-archive" in workflow
    assert "raw/objects" not in workflow
    assert "raw/records" not in workflow
