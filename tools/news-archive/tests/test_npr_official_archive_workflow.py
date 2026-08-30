from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1] / "workflow-templates"
WORKFLOW = (
    REPOSITORY_ROOT
    / ".github"
    / "workflows"
    / "npr-official-archive-catalog.yml"
)


def test_npr_official_archive_workflow_is_resumable_and_private() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "npr-official-archive-${{ inputs.year }}" in workflow
    assert "cancel-in-progress: false" in workflow
    assert "verify_b2_private_bucket.py" in workflow
    assert "build_npr_archive_manifest.py" in workflow
    assert "--min-request-interval 1.0" in workflow
    assert "checkpoint_capture_state.py" in workflow
    assert "discovery.sqlite3.gz" in workflow
    assert "manifest-summary.json" in workflow
    assert "official-archive" in workflow
    assert "steps.discovery.outputs.should_continue == 'true'" in workflow
    assert "steps.discovery.outputs.errors != '0'" in workflow
    assert "npr-official-archive-catalog.yml" in workflow
    assert "kick-parser-watchdog.sh" in workflow
