from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1] / "workflow-templates"
WORKFLOW = (
    REPOSITORY_ROOT
    / ".github"
    / "workflows"
    / "npr-common-crawl-catalog.yml"
)


def test_catalog_is_bounded_checkpointed_and_private() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "build_common_crawl_prefix_manifest.py" in workflow
    assert "sudo apt-get install -y rclone" in workflow
    assert "--collection-from-year 2013" in workflow
    assert '--max-pages "$MAX_PAGES"' in workflow
    assert '--max-queries "$MAX_QUERIES"' in workflow
    assert 'TARGET_ARTICLES_PER_YEAR: ${{ inputs.target_articles_per_year }}' in workflow
    assert '--target-articles-per-year "$TARGET_ARTICLES_PER_YEAR"' in workflow
    assert "--min-request-interval 3" in workflow
    assert "verify_b2_private_bucket.py" in workflow
    assert "checkpoint_capture_state.py" in workflow
    assert "commoncrawl-prefix" in workflow
    assert "discovery.sqlite3.gz" in workflow
    assert "manifest.jsonl.gz" in workflow
    assert "summarize_archive_manifest.py" in workflow
    assert '"$LOCAL_ROOT/catalog/manifest-summary.json"' in workflow
    assert '"${REMOTE_ROOT}/catalog/manifest-summary.json"' in workflow


def test_catalog_continues_after_bounded_empty_query_batch() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    dispatch = workflow[workflow.index("Dispatch next bounded run") :]
    assert "steps.discovery.outputs.should_continue == 'true'" in dispatch
    assert "steps.discovery.outputs.advances != '0'" in dispatch
    assert '-f max_queries="$MAX_QUERIES"' in dispatch
    assert '-f target_articles_per_year="$TARGET_ARTICLES_PER_YEAR"' in dispatch
    assert "auto_continue=true" in dispatch
    assert '--ref "$GITHUB_REF_NAME"' in dispatch
    assert 'GITHUB_SHA' not in dispatch
