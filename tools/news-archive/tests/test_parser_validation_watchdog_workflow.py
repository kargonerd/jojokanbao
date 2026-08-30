from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1] / "workflow-templates"
WORKFLOW = (
    REPOSITORY_ROOT / ".github" / "workflows" / "parser-validation-watchdog.yml"
)
KICK_SCRIPT = REPOSITORY_ROOT / ".github" / "scripts" / "kick-parser-watchdog.sh"


def test_watchdog_recurs_and_reads_v2_validation_state() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert 'cron: "17,47 * * * *"' in workflow
    assert "timeout 120 sudo apt-get update" in workflow
    assert "https://downloads.rclone.org/rclone-current-linux-amd64.zip" in workflow
    assert "news-archive/v2/validation-state" in workflow
    assert '--include "validation/*/*/state/summary.json"' in workflow
    assert '--include "holdout-v*/*/*/state/rotation-audit.json"' in workflow
    assert "copy_summary()" in workflow
    assert "restore_source_root()" in workflow
    assert "source_restore_parallelism=8" in workflow
    assert "wait_for_source_restore_batch" in workflow
    assert 'sort -u "$available_source_shards"' in workflow
    assert '"wsj/2016-2026/wayback"' in workflow
    source_roots = workflow[
        workflow.index("source_roots=(") : workflow.index(
            "available_source_shards=",
            workflow.index("source_roots=("),
        )
    ]
    assert '"scmp/2010-2015/sitemap-wayback"' in source_roots
    assert '"scmp/2016-2026/sitemap-wayback"' in source_roots
    assert "available-source-shards.txt" in workflow
    assert "--available-source-shards" in workflow
    assert "manifest-summary.json" in workflow
    assert 'supplemental_root="caixin/${supplemental_year}-${supplemental_year}/commoncrawl-prefix"' not in workflow
    assert '"ap/2010-2015/legacy-archive"' in workflow
    assert '--include "*manifest-summary.json"' in workflow
    for supplemental_root in (
        '"axios/2017-2026/commoncrawl-prefix"',
        '"axios/2017-2026/sitemap-wayback"',
        '"axios/2017-2026/axios-local-sitemap"',
        '"axios/2017-2017/commoncrawl-prefix"',
        '"axios/2018-2018/commoncrawl-prefix"',
        '"axios/2026-2026/commoncrawl-prefix"',
        '"ft/2010-2015/commoncrawl-prefix"',
        '"ft/2016-2026/commoncrawl-prefix"',
        '"reuters/2010-2015/commoncrawl-prefix"',
        '"reuters/2016-2020/commoncrawl-prefix"',
        '"reuters/2021-2026/commoncrawl-prefix"',
        '"aljazeera/2010-2015/commoncrawl-prefix"',
        '"aljazeera/2016-2026/commoncrawl-prefix"',
        '"aljazeera/2010-2015/wayback-urlkey"',
        '"aljazeera/2016-2026/wayback-urlkey"',
        '"aljazeera/2016-2016/commoncrawl-prefix"',
        '"aljazeera/2017-2017/commoncrawl-prefix"',
        '"aljazeera/2018-2018/commoncrawl-prefix"',
        '"nikkei/2010-2015/commoncrawl-prefix"',
        '"nikkei/2016-2026/commoncrawl-prefix"',
        '"nikkei/2010-2016/commoncrawl-asia-probe"',
        '"nikkei/2010-2010/commoncrawl-prefix"',
        '"nikkei/2011-2011/commoncrawl-prefix"',
        '"wsj/2010-2015/commoncrawl-prefix"',
        '"wsj/2016-2026/commoncrawl-prefix"',
        '"wsj/2010-2013/commoncrawl-legacy-probe"',
        '"scmp/2010-2015/sitemap-wayback"',
        '"scmp/2016-2026/sitemap-wayback"',
        '"scmp/2010-2015/commoncrawl-prefix"',
        '"scmp/2016-2026/commoncrawl-prefix"',
    ):
        assert supplemental_root in workflow
    assert '"npr/${supplemental_year}-${supplemental_year}/commoncrawl-prefix"' in workflow
    assert '"npr/${supplemental_year}-${supplemental_year}/official-archive"' in workflow
    assert 'default_capacity_name="manifest-summary.json"' in workflow
    assert 'rclone lsl "$default_capacity_remote"' in workflow
    assert '[ "$capacity_name" != "$default_capacity_name" ] || continue' in workflow
    assert 'source:"npr/2014-2014/official-archive",yearCounts' in workflow
    assert "NPR 2014 capacity sidecar readable but not restored" in workflow
    assert '"npr/2010-2015/commoncrawl-prefix"' in workflow
    assert '"npr/2012-2016/commoncrawl-prefix"' in workflow
    assert "--source-capacity-root" in workflow
    assert "Dispatch supplemental Common Crawl catalog" in workflow
    assert "capacity_deficient_cells=$(jq -r '.capacityDeficientCells // 0'" in workflow
    assert "CAPACITY_DEFICIENT_CELLS:" in workflow
    assert 'steps.plan.outputs.capacity_deficient_cells != \'0\'' in workflow
    assert '[ "$capacity_deficient_cells" -eq 0 ]' in workflow
    assert "nikkei-common-crawl-catalog.yml" in workflow
    assert "npr-official-archive-catalog.yml" in workflow
    assert "capacity_deficient_npr_years=" in workflow
    assert "active_npr_official_count=" in workflow
    assert "An NPR official archive chain is already active." in workflow
    assert "NPR official archive already complete" in workflow
    assert "jq -e '.complete == true'" in workflow
    assert "Dispatched NPR official archive catalog" in workflow
    assert workflow.index(
        '"publisher":"scmp","fromYear":"2016","toYear":"2026"'
    ) < workflow.index(
        '"publisher":"aljazeera","fromYear":"2016","toYear":"2026"'
    )
    assert '"publisher":"wsj","fromYear":"2010","toYear":"2015","collectionFromYear":"2014","collectionToYear":"2016","collectionOrder":"newest"' in workflow
    assert '"publisher":"wsj","fromYear":"2016","toYear":"2026","collectionFromYear":"2017","collectionToYear":"2026","collectionOrder":"newest"' in workflow
    assert (
        "(ft|wsj|aljazeera|scmp|npr|axios|nikkei)-"
        "([a-z0-9-]+-)?common-crawl-"
    ) in workflow
    assert 'canonical_title="${publisher}-canonical-common-crawl-${from_year}-${to_year}"' in workflow
    assert 'grep -Fxq "$canonical_title" "$active_titles"' in workflow
    assert 'MAX_CATALOG_CONCURRENCY: "3"' in workflow
    assert "active_catalog_count" in workflow
    assert '"kind":"caixin"' not in workflow
    assert "publisher=caixin" not in workflow
    assert "active_caixin_count" not in workflow
    assert 'catalog_concurrency_limit="$MAX_CATALOG_CONCURRENCY"' in workflow
    assert 'catalog_concurrency_limit=$((MAX_CATALOG_CONCURRENCY + 1))' in workflow
    assert "Capacity recovery active; reserving one supplemental catalog slot" in workflow
    assert "catalog_slots=$((catalog_concurrency_limit - active_catalog_count))" in workflow
    assert "catalog_slots=$((catalog_slots - 1))" in workflow
    assert "Supplemental Common Crawl concurrency is full" in workflow
    assert "hydrations=200" in workflow
    assert 'if [ "$publisher" = "scmp" ]; then' in workflow
    assert "hydrations=1000" in workflow
    assert 'if [ "$publisher" = "ft" ]; then' in workflow
    assert '"publisher":"ft","fromYear":"2010","toYear":"2015"' in workflow
    assert '"publisher":"ft","fromYear":"2010","toYear":"2015","collectionFromYear":"2014","collectionToYear":"2026","collectionOrder":"newest"' in workflow
    assert '"publisher":"ft","fromYear":"2016","toYear":"2026"' in workflow
    assert '"publisher":"npr","fromYear":"2014","toYear":"2014"' in workflow
    assert '"publisher":"npr","fromYear":"2016","toYear":"2016"' in workflow
    for publisher, year in (
        ("npr", 2010),
        ("npr", 2013),
        ("npr", 2015),
        ("axios", 2017),
        ("axios", 2018),
        ("axios", 2026),
        ("nikkei", 2010),
        ("nikkei", 2011),
        ("aljazeera", 2016),
        ("aljazeera", 2017),
        ("aljazeera", 2018),
    ):
        assert (
            f'"publisher":"{publisher}","fromYear":"{year}",'
            f'"toYear":"{year}"'
        ) in workflow
    assert 'if [ "$publisher" = "npr" ]; then' in workflow
    assert "hydrations=500" in workflow
    assert 'wsj|aljazeera|axios|nyt|ap|zaobao)' in workflow
    assert '-f max_hydrations="$hydrations"' in workflow
    assert "queries=8" in workflow
    assert "queries=32" in workflow
    assert "pages=1" in workflow
    assert 'if [ "$from_year" = "$to_year" ]; then' in workflow
    assert "pages=32" in workflow
    assert '-f max_pages="$pages"' in workflow
    assert '-f max_queries="$queries"' in workflow
    assert 'jq -r \'.collectionOrder // "oldest"\'' in workflow
    assert "Both standard parser slots are occupied" in workflow
    assert 'jq -e \'.shouldContinue == false\'' in workflow
    assert "target_articles=1200" in workflow
    assert '[[ "$publisher" =~ ^(npr|axios|nikkei|aljazeera)$ ]]' in workflow
    assert "target_articles=25000" in workflow
    assert "'.targetArticlesPerYear // 0'" in workflow
    assert '-ge "$target_articles"' in workflow
    assert '-f target_articles_per_year="$target_articles"' in workflow
    assert "- name: Restore validation summaries\n        timeout-minutes: 25" in workflow
    assert "ready: [" in workflow
    assert "capacityDeficient: [" in workflow
    assert 'object_listing="$(\n              rclone lsl' in workflow
    assert 'rclone lsl "$summary_remote" \\\n                --timeout 30s --contimeout 10s' in workflow
    assert '&& [ -n "$object_listing" ]; then' in workflow
    assert "--retries 3 --low-level-retries 6" in workflow
    assert "transient 5xx" in workflow
    assert "VALIDATION_PUBLISHERS:" in workflow
    assert (
        "ft wsj nyt ap axios npr nikkei zaobao aljazeera scmp"
        in workflow
    )
    assert "other currently requested publisher eligible" in workflow
    assert "--publishers $VALIDATION_PUBLISHERS" in workflow
    assert "cohort=\"$(jq -r '.cohort'" in workflow
    assert '-f cohort="$cohort"' in workflow
    assert "validation-capacity-probe.json" in workflow
    assert "activeSupersededRunCount" in workflow
    assert "effective_active_count" in workflow
    assert "superseded parser runs exempt" in workflow
    assert "only the" in workflow
    assert "test(\"^parser-(validation|holdout-v[0-9]+|smoke-v[0-9]+)-\")" in workflow
    assert 'MAX_SUPERSEDED_REFRESH_DISPATCH: "1"' in workflow
    assert "Reserved one parser refresh slot" in workflow
    assert "Keeping one dispatch slot reserved for parser validation." in workflow
    assert "catalog_dispatch_limit" in workflow
    assert "Keeping one dispatch slot reserved" in workflow
    assert "--json status,displayTitle,workflowName,createdAt" in workflow
    assert "list_runs_with_retry()" in workflow
    assert 'list_runs_with_retry "$runs"' in workflow
    assert 'list_runs_with_retry "$parser_runs"' in workflow
    assert "for attempt in 1 2 3 4 5" in workflow
    assert 'gh run list "$@" > "$output"' in workflow
    assert "GitHub run listing failed after 5 attempts." in workflow
    assert '--branch "$DISPATCH_REF" --limit 1000' not in workflow
    assert "--workflow parser-validation-accelerator.yml" in workflow
    assert 'parser_runs="$RUNNER_TEMP/parser-runs.json"' in workflow
    assert "fromdateiso8601" in workflow
    assert "$now - 18000" in workflow
    assert "stale" in workflow.lower()
    assert '.displayTitle == "Parser validation accelerator"' in workflow
    assert "generic_catalog_pending_count" in workflow
    assert '.workflowName == "Publisher Common Crawl catalog"' in workflow
    assert '.workflowName == "News raw archive"' in workflow
    assert "suppressing another catalog dispatch" in workflow


def test_watchdog_dispatches_two_workers_per_validation_job() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "workers=2" in workflow
    assert 'if [ "$publisher" = "ft" ] || [ "$publisher" = "wsj" ]; then' in workflow
    assert 'current_evaluated="$(jq -r \'.currentEvaluated // 0\'' in workflow
    assert '[ "$current_evaluated" -lt 200 ]' in workflow
    assert "Enabling bounded FT Infini-News discovery" in workflow
    assert '-f enable_ft_infini_direct_discovery="$enable_ft_infini_direct_discovery"' in workflow
    assert '-f workers="$workers"' in workflow
    assert "-f workers=8" not in workflow


def test_watchdog_keeps_fifteen_parser_slots_for_public_pool() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert 'MAX_STANDARD_CONCURRENCY: "15"' in workflow
    assert 'MAX_DISPATCH_PER_RUN: "4"' in workflow
    assert "available=$((MAX_STANDARD_CONCURRENCY - effective_active_count))" in workflow
    assert "effective_active_count + 1" not in workflow
    assert 'GENERIC_QUEUE_GRACE_SECONDS: "1800"' in workflow
    assert '--argjson generic_grace "$GENERIC_QUEUE_GRACE_SECONDS"' in workflow
    assert '>= ($now - $generic_grace)' in workflow
    assert 'MAX_CATALOG_CONCURRENCY: "3"' in workflow


def test_completed_batches_wake_only_the_default_branch_watchdog() -> None:
    script = KICK_SCRIPT.read_text(encoding="utf-8")

    assert "gh repo view \"$GITHUB_REPOSITORY\"" in script
    assert "--json defaultBranchRef" in script
    assert "--jq '.defaultBranchRef.name'" in script
    assert '--branch "$dispatch_ref"' in script
    assert '--ref "$dispatch_ref"' in script
    assert '--ref "$GITHUB_REF_NAME"' not in script
    assert "--json status,createdAt" in script
    assert ">= (now - 1800)" in script
    assert '.status == "in_progress"' in script
