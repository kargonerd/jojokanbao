from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1] / "workflow-templates"
WORKFLOW = (
    REPOSITORY_ROOT
    / ".github"
    / "workflows"
    / "axios-common-crawl-catalog.yml"
)


def test_catalog_is_bounded_checkpointed_and_private() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "--publisher axios" in workflow
    assert "--from-year 2017" in workflow
    assert "--to-year 2026" in workflow
    assert "--collection-from-year 2017" in workflow
    assert '--max-pages "$MAX_PAGES"' in workflow
    assert '--max-queries "$MAX_QUERIES"' in workflow
    assert "--max-errors 12" in workflow
    assert "--page-size 1" in workflow
    assert "--target-articles-per-year 10000" in workflow
    assert "verify_b2_private_bucket.py" in workflow
    assert "checkpoint_capture_state.py" in workflow
    assert "summarize_archive_manifest.py" in workflow
    assert '"$LOCAL_ROOT/catalog/manifest-summary.json"' in workflow
    assert '"${REMOTE_ROOT}/catalog/manifest-summary.json"' in workflow
    assert "news-archive/v1/axios/2017-2026/commoncrawl-prefix" in workflow


def test_catalog_auto_continuation_is_checkpoint_bounded() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    dispatch = workflow[workflow.index("Dispatch next bounded run") :]

    assert "steps.discovery.outputs.should_continue == 'true'" in dispatch
    assert "steps.discovery.outputs.advances != '0'" in dispatch
    assert '-f max_queries="$MAX_QUERIES"' in dispatch
    assert '--ref "$GITHUB_REF_NAME"' in dispatch
