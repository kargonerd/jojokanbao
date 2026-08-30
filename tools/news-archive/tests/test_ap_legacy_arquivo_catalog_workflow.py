from __future__ import annotations

from pathlib import Path


NEWS_ARCHIVE_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_TEMPLATE_ROOT = NEWS_ARCHIVE_ROOT / "workflow-templates"
WORKFLOW = (
    WORKFLOW_TEMPLATE_ROOT
    / ".github"
    / "workflows"
    / "ap-legacy-arquivo-catalog.yml"
)


def test_ap_legacy_catalog_workflow_builds_and_publishes_supplement() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "build_ap_legacy_arquivo_manifest.py" in workflow
    tool = (
        NEWS_ARCHIVE_ROOT
        / "tools"
        / "build_ap_legacy_arquivo_manifest.py"
    ).read_text(encoding="utf-8")
    assert "sys.path.insert(0, str(SERVICE_ROOT))" in tool
    assert '--capture-from-year "$CAPTURE_FROM_YEAR"' in workflow
    assert '--capture-to-year "$CAPTURE_TO_YEAR"' in workflow
    assert '--recovery-workers "$RECOVERY_WORKERS"' in workflow
    assert "legacy-archive" in workflow
    assert "summarize_archive_manifest.py" in workflow
    assert '"$LOCAL_ROOT/catalog/manifest-summary.json"' in workflow
    assert '"${REMOTE_ROOT}/catalog/manifest.jsonl.gz"' in workflow
    assert '"${REMOTE_ROOT}/catalog/manifest-summary.json"' in workflow
    assert '"${REMOTE_ROOT}/state/summary.json"' in workflow
    assert "raw/objects" not in workflow
    assert "raw/records" not in workflow
