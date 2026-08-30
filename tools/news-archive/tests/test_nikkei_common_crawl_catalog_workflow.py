from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1] / "workflow-templates"
WORKFLOW = (
    REPOSITORY_ROOT
    / ".github"
    / "workflows"
    / "nikkei-common-crawl-catalog.yml"
)


def test_catalog_hydrates_dates_and_checkpoints_private_state() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "build_common_crawl_prefix_manifest.py" in workflow
    assert 'default: "nikkei"' in workflow
    assert '--publisher "$PUBLISHER"' in workflow
    assert '--source-variant "$SOURCE_VARIANT"' in workflow
    assert 'SOURCE_VARIANT: ${{ inputs.source_variant }}' in workflow
    assert 'remote_mode="commoncrawl-asia-probe"' in workflow
    assert 'remote_mode="commoncrawl-legacy-probe"' in workflow
    assert 'if [ "$SOURCE_VARIANT" = "nikkei-asia-probe" ]; then' in workflow
    assert 'if [ "$SOURCE_VARIANT" = "wsj-legacy-probe" ]; then' in workflow
    assert '"$PUBLISHER" != "wsj"' in workflow
    assert '--collection-from-year "$COLLECTION_FROM_YEAR"' in workflow
    assert '--collection-to-year "$COLLECTION_TO_YEAR"' in workflow
    assert '--collection-order "$COLLECTION_ORDER"' in workflow
    assert 'default: "oldest"' in workflow
    assert '--target-articles-per-year "$TARGET_ARTICLES_PER_YEAR"' in workflow
    assert 'MAX_HYDRATIONS: ${{ inputs.max_hydrations }}' in workflow
    assert 'effective_max_hydrations="$MAX_HYDRATIONS"' in workflow
    assert 'wsj|aljazeera|axios|nyt|ap|zaobao)' in workflow
    assert 'effective_max_pages="$MAX_PAGES"' in workflow
    assert 'effective_max_queries="$MAX_QUERIES"' in workflow
    assert 'if [ "$PUBLISHER" = "aljazeera" ]' in workflow
    assert '[ "$PUBLISHER" = "wsj" ]' in workflow
    assert '[ "$PUBLISHER" = "npr" ]; then' in workflow
    assert "effective_max_pages=32" in workflow
    assert "effective_max_queries=32" in workflow
    assert "effective_max_errors=32" in workflow
    assert 'effective_page_size=1000' in workflow
    assert 'effective_page_size=1' in workflow
    assert 'if [ "$PUBLISHER" = "ft" ]; then' in workflow
    assert '--page-size "$effective_page_size"' in workflow
    assert '--max-errors "$effective_max_errors"' in workflow
    assert '--max-date-hydrations "$effective_max_hydrations"' in workflow
    assert "--data-min-request-interval 0.5" in workflow
    assert "verify_b2_private_bucket.py" in workflow
    assert "checkpoint_capture_state.py" in workflow
    assert "summarize_archive_manifest.py" in workflow
    assert "manifest-summary.json" in workflow
    assert "commoncrawl-prefix" in workflow
    assert "discovery.sqlite3.gz" in workflow
    assert "manifest.jsonl.gz" in workflow


def test_catalog_continues_after_discovery_or_hydration_progress() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    dispatch = workflow[workflow.index("Dispatch next bounded run") :]
    assert "steps.discovery.outputs.should_continue == 'true'" in dispatch
    assert "steps.discovery.outputs.advances != '0'" in dispatch
    assert "steps.discovery.outputs.hydration_attempted != '0'" in dispatch
    assert '-f max_hydrations="$MAX_HYDRATIONS"' in dispatch
    assert '-f max_pages="$MAX_PAGES"' in dispatch
    assert '-f max_queries="$MAX_QUERIES"' in dispatch
    assert '-f publisher="$PUBLISHER"' in dispatch
    assert '-f source_variant="$SOURCE_VARIANT"' in dispatch
    assert '-f collection_order="$COLLECTION_ORDER"' in dispatch
    assert (
        '-f target_articles_per_year="$TARGET_ARTICLES_PER_YEAR"'
        in dispatch
    )
    assert "auto_continue=true" in dispatch
    assert '--ref "$GITHUB_REF_NAME"' in dispatch
