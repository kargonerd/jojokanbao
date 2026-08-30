from __future__ import annotations

import json
from pathlib import Path
import sqlite3

from jojo_news_archive.capture.raw import (
    initialize_capture_schema,
    load_capture_manifest,
)
from jojo_news_archive.parsing.validation import ensure_parser_validation_plan
from jojo_news_archive.capture.importers import (
    export_completed_capture_index,
    import_selected_source_captures,
)


def _write_manifest(path: Path) -> tuple[str, str]:
    urls = (
        "https://www.wsj.com/articles/source-import-one-123",
        "https://www.wsj.com/articles/source-import-two-456",
    )
    path.write_text(
        "".join(
            json.dumps(
                {
                    "publisher": "wsj",
                    "canonicalUrl": url,
                    "publishedAt": "2016-05-01T00:00:00Z",
                    "candidates": [
                        {
                            "provider": "wayback",
                            "snapshotUrl": (
                                "https://web.archive.org/web/"
                                f"20160502000000id_/{url}"
                            ),
                        }
                    ],
                }
            )
            + "\n"
            for url in urls
        ),
        encoding="utf-8",
    )
    return urls


def test_imports_only_selected_incomplete_source_captures(
    tmp_path: Path,
):
    manifest = tmp_path / "manifest.jsonl"
    first_url, second_url = _write_manifest(manifest)
    source = sqlite3.connect(":memory:")
    target = sqlite3.connect(":memory:")
    initialize_capture_schema(
        source,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        source,
        manifest_path=manifest,
        publisher="wsj",
    )
    # Production source shards created before dependent-resource archiving do
    # not have this additive state column.
    source.execute(
        "ALTER TABLE captures DROP COLUMN dependent_resources_json"
    )
    selected_candidate = json.dumps(
        {
            "provider": "wayback",
            "snapshotUrl": (
                "https://web.archive.org/web/20160502000000id_/"
                + first_url
            ),
        }
    )
    raw_sha256 = "a" * 64
    source.execute(
        """
        UPDATE captures
        SET status='complete',
            selected_candidate_json=?,
            final_url=?,
            http_status=200,
            content_type='text/html',
            quality_score=100,
            quality_signals_json='{"usable":true}',
            raw_path=?,
            raw_sha256=?,
            raw_bytes=2048,
            stored_bytes=512,
            retrieved_at='2026-07-26T00:00:00+00:00'
        WHERE canonical_url=?
        """,
        (
            selected_candidate,
            first_url,
            f"objects/{raw_sha256[:2]}/{raw_sha256}.html.gz",
            raw_sha256,
            first_url,
        ),
    )
    source.commit()

    result = import_selected_source_captures(
        source_connection=source,
        target_connection=target,
        manifest_path=manifest,
        publisher="wsj",
        sample_year=2016,
        target_per_year=1,
    )
    rows = target.execute(
        """
        SELECT canonical_url, status, raw_sha256, record_path
        FROM captures
        ORDER BY canonical_url
        """
    ).fetchall()

    assert result["imported"] == 1
    assert result["sourceMatches"] == 1
    assert result["rawPaths"] == [
        f"objects/{raw_sha256[:2]}/{raw_sha256}.html.gz"
    ]
    assert rows == [
        (first_url, "complete", raw_sha256, None),
        (second_url, "pending", None, None),
    ]


def test_import_skips_rows_already_rejected_by_raw_quality_gate(
    tmp_path: Path,
):
    manifest = tmp_path / "manifest.jsonl"
    first_url, _second_url = _write_manifest(manifest)
    source = sqlite3.connect(":memory:")
    target = sqlite3.connect(":memory:")
    initialize_capture_schema(
        source,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(source, manifest_path=manifest, publisher="wsj")
    source.execute(
        """
        UPDATE captures
        SET status='complete',
            final_url=canonical_url,
            http_status=200,
            content_type='text/html',
            quality_score=100,
            raw_path='objects/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        WHERE canonical_url=?
        """,
        (first_url,),
    )
    source.commit()

    initialize_capture_schema(
        target,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(target, manifest_path=manifest, publisher="wsj")
    ensure_parser_validation_plan(
        target,
        publisher="wsj",
        from_year=2016,
        to_year=2016,
        target_per_year=1,
        maximum_record_attempts=3,
    )
    target.execute("DELETE FROM parser_validation_samples")
    target.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        )
        VALUES (?, 2016, 'priority', '2026-08-13T00:00:00+00:00')
        """,
        (first_url,),
    )
    target.execute(
        """
        UPDATE captures
        SET status='pending',
            last_error=?
        WHERE canonical_url=?
        """,
        (
            "raw quality policy rejected stored capture: "
            "wsj-capture-parser-incomplete",
            first_url,
        ),
    )
    target.commit()

    result = import_selected_source_captures(
        source_connection=source,
        target_connection=target,
        manifest_path=manifest,
        publisher="wsj",
        sample_year=2016,
        target_per_year=1,
        reuse_target_plan=True,
    )

    assert result["selectedIncomplete"] == 0
    assert result["sourceMatches"] == 0
    assert result["imported"] == 0
    assert target.execute(
        "SELECT status, last_error FROM captures WHERE canonical_url=?",
        (first_url,),
    ).fetchone() == (
        "pending",
        "raw quality policy rejected stored capture: wsj-capture-parser-incomplete",
    )

    # A subsequent capture attempt may replace the explicit quality marker
    # with the provider-level reject detail. That form must not re-import the
    # same source row either.
    target.execute(
        """
        UPDATE captures
        SET status='error', attempts=1,
            last_error='wayback:http-200:score-100:reject-wsj-parser-unusable'
        WHERE canonical_url=?
        """,
        (first_url,),
    )
    target.commit()
    retry_result = import_selected_source_captures(
        source_connection=source,
        target_connection=target,
        manifest_path=manifest,
        publisher="wsj",
        sample_year=2016,
        target_per_year=1,
        reuse_target_plan=True,
    )
    assert retry_result["selectedIncomplete"] == 0
    assert retry_result["sourceMatches"] == 0
    assert retry_result["imported"] == 0


def test_compact_index_round_trips_completed_capture(tmp_path: Path):
    manifest = tmp_path / "manifest.jsonl"
    first_url, second_url = _write_manifest(manifest)
    source = sqlite3.connect(":memory:")
    index = sqlite3.connect(":memory:")
    target = sqlite3.connect(":memory:")
    initialize_capture_schema(
        source,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        source,
        manifest_path=manifest,
        publisher="wsj",
    )
    raw_sha256 = "b" * 64
    source.execute(
        """
        UPDATE captures
        SET status='complete',
            final_url=canonical_url,
            http_status=200,
            content_type='text/html',
            quality_score=100,
            quality_signals_json='{"usable":true}',
            raw_path=?,
            raw_sha256=?,
            raw_bytes=4096,
            stored_bytes=1024,
            retrieved_at='2026-07-26T00:00:00+00:00'
        WHERE canonical_url=?
        """,
        (
            f"objects/{raw_sha256[:2]}/{raw_sha256}.html.gz",
            raw_sha256,
            first_url,
        ),
    )
    source.execute(
        """
        UPDATE captures
        SET status='complete',
            raw_path='../invalid.html.gz',
            raw_sha256='short'
        WHERE canonical_url=?
        """,
        (second_url,),
    )
    source.commit()

    export_result = export_completed_capture_index(
        source_connection=source,
        destination_connection=index,
    )
    import_result = import_selected_source_captures(
        source_connection=index,
        target_connection=target,
        manifest_path=manifest,
        publisher="wsj",
        sample_year=2016,
        target_per_year=1,
    )

    assert export_result == {
        "formatVersion": "jojo-completed-capture-index/1",
        "totalComplete": 2,
        "exported": 1,
        "skipped": 1,
        "skippedKnownTruncated": 0,
    }
    assert import_result["imported"] == 1
    assert target.execute(
        """
        SELECT canonical_url, status, raw_sha256
        FROM captures
        ORDER BY canonical_url
        """
    ).fetchall() == [
        (first_url, "complete", raw_sha256),
        (second_url, "pending", None),
    ]


def test_legacy_common_crawl_one_mib_capture_is_not_reused(
    tmp_path: Path,
):
    manifest = tmp_path / "manifest.jsonl"
    first_url, _second_url = _write_manifest(manifest)
    source = sqlite3.connect(":memory:")
    compact_index = sqlite3.connect(":memory:")
    target = sqlite3.connect(":memory:")
    initialize_capture_schema(
        source,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(source, manifest_path=manifest, publisher="wsj")
    raw_sha256 = "c" * 64
    source.execute(
        """
        UPDATE captures
        SET status='complete',
            selected_candidate_json=?,
            final_url=canonical_url,
            http_status=200,
            content_type='text/html',
            quality_score=100,
            quality_signals_json='{"commonCrawlWarcValidated":true}',
            raw_path=?,
            raw_sha256=?,
            raw_bytes=1048576,
            stored_bytes=84613,
            retrieved_at='2026-08-19T18:48:03+00:00'
        WHERE canonical_url=?
        """,
        (
            json.dumps(
                {
                    "provider": "commoncrawl",
                    "byteCount": 1_048_576,
                    "warcLength": 88_448,
                }
            ),
            f"objects/{raw_sha256[:2]}/{raw_sha256}.html.gz",
            raw_sha256,
            first_url,
        ),
    )
    source.commit()

    import_result = import_selected_source_captures(
        source_connection=source,
        target_connection=target,
        manifest_path=manifest,
        publisher="wsj",
        sample_year=2016,
        target_per_year=1,
    )
    export_result = export_completed_capture_index(
        source_connection=source,
        destination_connection=compact_index,
    )

    assert import_result["imported"] == 0
    assert import_result["skippedKnownTruncated"] == 1
    assert import_result["rawPaths"] == []
    assert target.execute(
        "SELECT status FROM captures WHERE canonical_url=?",
        (first_url,),
    ).fetchone() == ("pending",)
    assert export_result == {
        "formatVersion": "jojo-completed-capture-index/1",
        "totalComplete": 1,
        "exported": 0,
        "skipped": 1,
        "skippedKnownTruncated": 1,
    }


def test_import_respects_existing_holdout_exclusions(tmp_path: Path):
    manifest = tmp_path / "manifest.jsonl"
    first_url, second_url = _write_manifest(manifest)
    source = sqlite3.connect(":memory:")
    target = sqlite3.connect(":memory:")
    initialize_capture_schema(
        source,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        source,
        manifest_path=manifest,
        publisher="wsj",
    )
    for index, url in enumerate((first_url, second_url), start=1):
        raw_sha256 = str(index) * 64
        source.execute(
            """
            UPDATE captures
            SET status='complete',
                final_url=canonical_url,
                http_status=200,
                content_type='text/html',
                quality_score=100,
                quality_signals_json='{"usable":true}',
                raw_path=?,
                raw_sha256=?,
                raw_bytes=4096,
                stored_bytes=1024,
                retrieved_at='2026-08-13T00:00:00+00:00'
            WHERE canonical_url=?
            """,
            (
                f"objects/{raw_sha256[:2]}/{raw_sha256}.html.gz",
                raw_sha256,
                url,
            ),
        )
    source.commit()

    initialize_capture_schema(
        target,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        target,
        manifest_path=manifest,
        publisher="wsj",
    )
    ensure_parser_validation_plan(
        target,
        publisher="wsj",
        from_year=2016,
        to_year=2016,
        target_per_year=1,
        maximum_record_attempts=3,
    )
    target.execute(
        """
        INSERT INTO parser_validation_exclusions(
            canonical_url, source_cohort, excluded_at
        )
        VALUES (?, 'holdout-v1', '2026-08-13T00:00:00+00:00')
        """,
        (first_url,),
    )
    target.execute("DELETE FROM parser_validation_samples")
    target.commit()

    result = import_selected_source_captures(
        source_connection=source,
        target_connection=target,
        manifest_path=manifest,
        publisher="wsj",
        sample_year=2016,
        target_per_year=1,
    )

    assert result["imported"] == 1
    assert target.execute(
        """
        SELECT canonical_url, status
        FROM captures
        ORDER BY canonical_url
        """
    ).fetchall() == [
        (first_url, "pending"),
        (second_url, "complete"),
    ]
    assert target.execute(
        "SELECT canonical_url FROM parser_validation_samples"
    ).fetchall() == [(second_url,)]


def test_import_can_reuse_prepared_target_plan_without_manifest(tmp_path: Path):
    manifest = tmp_path / "manifest.jsonl"
    first_url, _second_url = _write_manifest(manifest)
    source = sqlite3.connect(":memory:")
    target = sqlite3.connect(":memory:")
    initialize_capture_schema(
        source,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(source, manifest_path=manifest, publisher="wsj")
    raw_sha256 = "c" * 64
    source.execute(
        """
        UPDATE captures
        SET status='complete', raw_path=?, raw_sha256=?
        WHERE canonical_url=?
        """,
        (
            f"objects/{raw_sha256[:2]}/{raw_sha256}.html.gz",
            raw_sha256,
            first_url,
        ),
    )
    source.commit()
    initialize_capture_schema(
        target,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(target, manifest_path=manifest, publisher="wsj")
    ensure_parser_validation_plan(
        target,
        publisher="wsj",
        from_year=2016,
        to_year=2016,
        target_per_year=1,
        maximum_record_attempts=3,
    )

    result = import_selected_source_captures(
        source_connection=source,
        target_connection=target,
        manifest_path=tmp_path / "deliberately-missing.jsonl",
        publisher="wsj",
        sample_year=2016,
        target_per_year=1,
        reuse_target_plan=True,
    )

    assert result["imported"] == 1
    assert result["manifest"] == {"reusedTargetManifest": True}
    assert result["plan"] == {"reusedTargetPlan": True}


def test_reused_target_plan_must_match_sampling_identity(tmp_path: Path):
    manifest = tmp_path / "manifest.jsonl"
    _write_manifest(manifest)
    source = sqlite3.connect(":memory:")
    target = sqlite3.connect(":memory:")
    initialize_capture_schema(
        source,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    initialize_capture_schema(
        target,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(target, manifest_path=manifest, publisher="wsj")
    ensure_parser_validation_plan(
        target,
        publisher="wsj",
        from_year=2016,
        to_year=2016,
        target_per_year=1,
        maximum_record_attempts=3,
        seed="original-seed",
    )

    try:
        import_selected_source_captures(
            source_connection=source,
            target_connection=target,
            manifest_path=manifest,
            publisher="wsj",
            sample_year=2016,
            target_per_year=1,
            seed="different-seed",
            reuse_target_plan=True,
        )
    except ValueError as exc:
        assert "does not match" in str(exc)
    else:
        raise AssertionError("mismatched reused plan was accepted")


def test_reused_target_plan_skips_empty_source_placeholder(tmp_path: Path):
    manifest = tmp_path / "manifest.jsonl"
    _write_manifest(manifest)
    source = sqlite3.connect(":memory:")
    target = sqlite3.connect(":memory:")
    initialize_capture_schema(
        target,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(target, manifest_path=manifest, publisher="wsj")
    ensure_parser_validation_plan(
        target,
        publisher="wsj",
        from_year=2016,
        to_year=2016,
        target_per_year=1,
        maximum_record_attempts=3,
    )

    result = import_selected_source_captures(
        source_connection=source,
        target_connection=target,
        manifest_path=manifest,
        publisher="wsj",
        sample_year=2016,
        target_per_year=1,
        reuse_target_plan=True,
    )

    assert result["skippedSourcePlaceholder"] is True
    assert result["imported"] == 0
    assert result["rawPaths"] == []
