from pathlib import Path


WORKFLOW = (
    Path(__file__).resolve().parents[1] / "workflow-templates"
    / ".github"
    / "workflows"
    / "news-archive-watchdog.yml"
)


def test_archive_watchdog_has_one_global_two_slot_dispatcher() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert 'MAX_STANDARD_CONCURRENCY: "2"' in workflow
    assert 'MAX_DISPATCH_PER_RUN: "2"' in workflow
    assert "strategy:" not in workflow
    assert "matrix:" not in workflow
    assert 'startswith("news-raw-")' in workflow
    assert 'contains("-common-crawl-")' in workflow
    assert 'startswith("parser-")' in workflow
    assert "available=$((MAX_STANDARD_CONCURRENCY - active_count))" in workflow
    assert 'if [ "$dispatched" -ge "$available" ]' in workflow
    assert 'gh run list --repo "$GITHUB_REPOSITORY"' in workflow
    assert '--branch "$DISPATCH_REF" --limit 1000' in workflow


def test_archive_watchdog_is_catalog_only_and_skips_complete_shards() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert '-f max_captures=0' in workflow
    assert "formal validation stores only its selected canonical raw samples" in workflow
    assert "catalog/status.json" in workflow
    assert 'jojo-source-catalog-status/1' in workflow
    assert ".shouldContinue == false" in workflow
    assert "manifest-summary.json" in workflow
    assert "jq -e '.complete == true'" in workflow


def test_archive_watchdog_limits_dispatch_to_active_convergence_set() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    for publisher in (
        "ft",
        "axios",
        "wsj",
        "nyt",
        "ap",
        "npr",
        "nikkei",
        "zaobao",
        "aljazeera",
        "scmp",
    ):
        assert f'"publisher":"{publisher}"' in workflow
    assert '"publisher":"caixin"' not in workflow
    assert "Keep every in-scope publisher eligible" in workflow
    assert "parser-validation watchdog independently decides" in workflow
    assert "nikkei-common-crawl-catalog.yml" in workflow
    assert '"kind":"common-crawl"' in workflow
    assert "collection_from_year" in workflow
