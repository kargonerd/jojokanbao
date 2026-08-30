from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1] / "workflow-templates"
WORKFLOW = REPOSITORY_ROOT / ".github" / "workflows" / "news-raw-archive.yml"


def test_optional_mihomo_failure_falls_back_to_runner_network() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    setup = workflow[
        workflow.index("- name: Start optional Mihomo archive proxy pool") :
        workflow.index("- name: Validate private B2 storage")
    ]

    assert "if ! (" in setup
    assert "Optional Mihomo pool unavailable" in setup
    assert "continuing on the runner network" in setup
    assert setup.index("if ! (") < setup.index("start_mihomo_proxy.py")


def test_sitemap_mode_supports_official_monthly_archives() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "ap|bloomberg|nyt|ft|axios|aljazeera|zaobao|scmp" in workflow
    assert "FT, Axios, Al Jazeera, Zaobao, and SCMP" in workflow
    assert 'if [ "$PUBLISHER" = "scmp" ]; then' in workflow
    assert "sitemap_interval=10.0" in workflow
    assert '--min-request-interval "$sitemap_interval"' in workflow


def test_axios_local_sitemap_uses_isolated_resumable_mode() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "- axios-local-sitemap" in workflow
    assert 'MANIFEST_MODE" = "axios-local-sitemap"' in workflow
    assert "--source-variant axios-local" in workflow
    assert "--min-request-interval 0.5" in workflow


def test_scmp_official_windows_share_one_sitewide_concurrency_group() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    concurrency = workflow[
        workflow.index("concurrency:") : workflow.index("env:")
    ]

    assert "news-raw-scmp-sitemap-wayback" in concurrency
    assert "inputs.publisher == 'scmp'" in concurrency
    assert "inputs.manifest_mode == 'sitemap-wayback'" in concurrency
    assert "format('news-raw-{0}-{1}-{2}-{3}'" in concurrency
    assert "cancel-in-progress: false" in concurrency


def test_live_raw_checkpoints_cannot_block_archive_workers() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    catalog_section = workflow[
        workflow.index("live_catalog_checkpoint() {")
        : workflow.index("run_catalog() {")
    ]
    capture_section = workflow[
        workflow.index("live_checkpoint() {")
        : workflow.index("request_interval=0.5")
    ]

    assert "timeout 30 rclone copyto" in catalog_section
    assert "--timeout 20s --contimeout 10s" in catalog_section
    assert capture_section.count("timeout 120 rclone copy") == 2
    assert capture_section.count("timeout 30 rclone copyto") == 3
    assert "Live object upload failed; state withheld." in capture_section
    assert "Live capture-state upload timed out." in capture_section


def test_wayback_discovery_retries_across_bounded_runs() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    wayback_section = workflow[
        workflow.index('elif [ "$MANIFEST_MODE" = "wayback-urlkey" ]; then')
        : workflow.index("else", workflow.index('elif [ "$MANIFEST_MODE" = "wayback-urlkey" ]; then'))
    ]

    assert "--timeout 30" in wayback_section
    assert "--attempts 2" in wayback_section
    assert "runner slot for the command defaults (90 seconds x 6)" in wayback_section


def test_wsj_catalog_only_uses_bounded_two_per_second_metadata_rate() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    wayback_section = workflow[
        workflow.index('elif [ "$MANIFEST_MODE" = "wayback-urlkey" ]; then') :
        workflow.index(
            "else",
            workflow.index(
                'elif [ "$MANIFEST_MODE" = "wayback-urlkey" ]; then'
            ),
        )
    ]

    assert 'discovery_interval=1.0' in wayback_section
    assert '[ "$PUBLISHER" = "wsj" ]' in wayback_section
    assert '[ "$MAX_CAPTURES" = "0" ]' in wayback_section
    assert 'discovery_interval=0.5' in wayback_section
    assert '--min-request-interval "$discovery_interval"' in wayback_section


def test_catalog_only_wayback_keeps_expanding_after_capture_ready() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    wayback_section = workflow[
        workflow.index('elif [ "$MANIFEST_MODE" = "wayback-urlkey" ]; then') :
        workflow.index(
            "else",
            workflow.index(
                'elif [ "$MANIFEST_MODE" = "wayback-urlkey" ]; then'
            ),
        )
    ]

    assert 'if [ "$MAX_CAPTURES" = "0" ]; then' in wayback_section
    assert (
        'wayback_catalog_args+=(--continue-after-capture-ready)'
        in wayback_section
    )
    assert '"${wayback_catalog_args[@]}"' in wayback_section


def test_common_crawl_supplements_merge_without_duplicate_raw_root() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    merge_section = workflow[
        workflow.index(
            "- name: Merge Common Crawl supplemental manifest"
        ) :
        workflow.index("- name: Checkpoint discovery")
    ]

    assert "inputs.publisher == 'npr'" in merge_section
    assert "inputs.publisher == 'axios'" in merge_section
    assert "inputs.publisher == 'nikkei'" in merge_section
    assert "inputs.publisher == 'reuters'" in merge_section
    assert "inputs.publisher == 'scmp'" in merge_section
    assert "inputs.publisher == 'caixin'" in merge_section
    assert "inputs.publisher == 'aljazeera'" in merge_section
    assert "inputs.manifest_mode == 'sitemap-wayback'" in merge_section
    assert "inputs.manifest_mode == 'wayback-urlkey'" in merge_section
    assert "commoncrawl-prefix" in merge_section
    assert "merge_archive_manifests.py" in merge_section
    assert '--publisher "$PUBLISHER"' in merge_section
    assert '--input "$supplemental"' in merge_section
    assert '--output "$merged"' in merge_section
    assert "raw/objects" not in merge_section


def test_final_manifest_summary_is_published_with_manifest() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    summary_section = workflow[
        workflow.index("- name: Summarize final capture manifest") :
        workflow.index("- name: Checkpoint discovery")
    ]
    publish_section = workflow[
        workflow.index("- name: Publish discovery checkpoint and manifest") :
        workflow.index("- name: Plan capture batch")
    ]

    assert "summarize_archive_manifest.py" in summary_section
    assert 'manifest-summary.json' in summary_section
    assert 'manifest-summary.json' in publish_section


def test_ap_raw_archive_merges_legacy_manifest_without_duplicate_raw_root() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    merge_section = workflow[
        workflow.index("- name: Merge AP legacy supplemental manifest") :
        workflow.index("- name: Checkpoint discovery")
    ]

    assert "inputs.publisher == 'ap'" in merge_section
    assert "inputs.manifest_mode == 'sitemap-wayback'" in merge_section
    assert "legacy-archive" in merge_section
    assert "merge_archive_manifests.py" in merge_section
    assert '--input "$supplemental"' in merge_section
    assert '--output "$merged"' in merge_section
    assert "wayback-yahoo-manifest.jsonl.gz" in merge_section
    assert '--input "$wayback_yahoo"' in merge_section
    assert '--output "$wayback_yahoo_merged"' in merge_section
    assert "wayback-bigstory-manifest.jsonl.gz" in merge_section
    assert '--input "$wayback_bigstory"' in merge_section
    assert '--output "$wayback_bigstory_merged"' in merge_section
    assert "raw/objects" not in merge_section


def test_archive_continuation_drains_actionable_captures_before_discovery() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    continuation_section = workflow[
        workflow.index("- name: Dispatch next bounded run") :
    ]

    assert 'actionable="${{ steps.after.outputs.actionable }}"' in continuation_section
    assert 'if [[ "$actionable" =~ ^[1-9][0-9]*$ ]]; then' in continuation_section
    assert "next_discovery_pages=0" in continuation_section
    assert '-f max_discovery_pages="$next_discovery_pages"' in continuation_section


def test_legacy_wsj_catalog_tail_uses_larger_continuation_batches() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    continuation_section = workflow[
        workflow.index("- name: Dispatch next bounded run") :
    ]

    assert '[ "$PUBLISHER" = "wsj" ]' in continuation_section
    assert '[ "$FROM_YEAR" = "2010" ]' in continuation_section
    assert '[ "$TO_YEAR" = "2015" ]' in continuation_section
    assert '[ "$MANIFEST_MODE" = "wayback-urlkey" ]' in continuation_section
    assert '[ "$MAX_CAPTURES" = "0" ]' in continuation_section
    assert "next_discovery_pages=500" in continuation_section
    assert "Batching the legacy WSJ catalog tail" in continuation_section


def test_zero_capture_limit_is_a_true_catalog_only_run() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    restore_section = workflow[
        workflow.index("- name: Restore discovery and capture checkpoints") :
        workflow.index("- name: Advance or select manifest")
    ]
    capture_step_names = (
        "Plan capture batch",
        "Plan replay of previously captured parser samples",
        "Restore previously captured parser sample HTML",
        "Replay current parser against restored sample HTML",
        "Publish parser validation replay checkpoint",
        "Capture bounded raw HTML batch",
        "Checkpoint capture state",
        "Publish raw objects, records, and capture checkpoint",
        "Report remaining capture work",
        "Propagate capture failure after checkpoint",
    )

    assert "use 0 for catalog-only" in workflow
    assert 'if [ "$MAX_CAPTURES" != "0" ]; then' in restore_section
    for index, step_name in enumerate(capture_step_names):
        start = workflow.index(f"- name: {step_name}")
        end = (
            workflow.index("- name:", start + 1)
            if index < len(capture_step_names) - 1
            else workflow.index("- name: Propagate discovery failure", start)
        )
        section = workflow[start:end]
        assert "inputs.max_captures != '0'" in section


def test_validation_only_archive_chain_releases_runner_at_ready_gate() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    capture_section = workflow[
        workflow.index("- name: Capture bounded raw HTML batch") :
        workflow.index("- name: Checkpoint capture state")
    ]
    replay_section = workflow[
        workflow.index("- name: Plan replay of previously captured parser samples") :
        workflow.index("- name: Restore previously captured parser sample HTML")
    ]
    continuation_section = workflow[
        workflow.index("- name: Dispatch next bounded run") :
    ]

    assert "stop_when_validation_ready:" in workflow
    assert "--stop-when-validation-ready" in capture_section
    assert "--stop-when-validation-target-reached" in capture_section
    assert "steps.after.outputs.validation_ready != 'true'" in continuation_section
    assert (
        "steps.after.outputs.validation_target_reached != 'true'"
        in continuation_section
    )
    assert workflow.count("--stop-at-validation-target") == 2
    assert (
        "steps.before.outputs.validation_target_reached != 'true'"
        in capture_section
    )
    assert "steps.validation_replay.outputs.replays != '0'" in capture_section
    assert "validation_target_reached" not in replay_section
    assert (
        '-f stop_when_validation_ready="${{ inputs.stop_when_validation_ready }}"'
        in continuation_section
    )


def test_zero_discovery_pages_refreshes_only_manifest_sidecar() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    catalog_section = workflow[
        workflow.index("run_catalog() {") : workflow.index(
            'if [ "$MANIFEST_MODE" = "sitemap-wayback" ]; then',
            workflow.index("run_catalog() {"),
        )
    ]

    assert 'if [ "$MAX_DISCOVERY_PAGES" = "0" ]; then' in catalog_section
    assert "Manifest-sidecar refresh requires an existing manifest." in catalog_section
    assert 'echo "complete=true"' in catalog_section
    assert 'echo "should_continue=false"' in catalog_section
