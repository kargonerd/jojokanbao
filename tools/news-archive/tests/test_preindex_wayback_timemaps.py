from __future__ import annotations

from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import sqlite3

from jojo_olds_api.news_models import CaptureCandidate, CaptureProvider


TOOL_PATH = (
    Path(__file__).resolve().parents[1]
    / "tools"
    / "preindex_wayback_timemaps.py"
)
SPEC = importlib.util.spec_from_file_location(
    "preindex_wayback_timemaps_tool",
    TOOL_PATH,
)
assert SPEC is not None and SPEC.loader is not None
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)


def test_pending_wayback_preindex_rows_selects_active_unevaluated_rows() -> None:
    connection = sqlite3.connect(":memory:")
    connection.executescript(
        """
        CREATE TABLE parser_validation_config (
            sample_year INTEGER PRIMARY KEY,
            parser_version TEXT NOT NULL,
            qa_revision INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_samples (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL,
            sample_priority TEXT NOT NULL
        );
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            parser_version TEXT NOT NULL,
            qa_revision INTEGER NOT NULL
        );
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            publisher TEXT NOT NULL,
            published_at TEXT,
            section TEXT,
            status TEXT NOT NULL,
            candidates_json TEXT NOT NULL
        );
        INSERT INTO parser_validation_config VALUES
            (2010, 'nyt-parser/current', 7),
            (2011, 'nyt-parser/current', 7);
        INSERT INTO parser_validation_samples VALUES
            ('https://www.nytimes.com/pending', 2010, '01'),
            ('https://www.nytimes.com/error', 2010, '02'),
            ('https://www.nytimes.com/exact', 2010, '03'),
            ('https://www.nytimes.com/evaluated', 2010, '04'),
            ('https://www.nytimes.com/other-year', 2011, '01'),
            ('https://example.com/other-publisher', 2010, '05');
        INSERT INTO parser_validation_results VALUES
            ('https://www.nytimes.com/evaluated', 'nyt-parser/current', 7);
        INSERT INTO captures VALUES
            ('https://www.nytimes.com/pending', 'nyt', '2010-01-01', NULL,
             'pending', '[{"provider":"wayback","snapshotUrl":"https://web.archive.org/guess"}]'),
            ('https://www.nytimes.com/error', 'nyt', '2010-01-02', NULL,
             'error', '[{"provider":"wayback","snapshotUrl":"https://web.archive.org/error"}]'),
            ('https://www.nytimes.com/exact', 'nyt', '2010-01-03', NULL,
             'pending', '[{"provider":"wayback","snapshotUrl":"https://web.archive.org/exact","capturedAt":"2010-01-03T00:00:00Z","digest":"EXACT"}]'),
            ('https://www.nytimes.com/evaluated', 'nyt', '2010-01-04', NULL,
             'pending', '[]'),
            ('https://www.nytimes.com/other-year', 'nyt', '2011-01-01', NULL,
             'pending', '[]'),
            ('https://example.com/other-publisher', 'ap', '2010-01-05', NULL,
             'pending', '[]');
        """
    )

    rows = TOOL.pending_wayback_preindex_rows(
        connection,
        publisher="nyt",
        maximum=10,
        from_year=2010,
        to_year=2010,
    )

    assert [item.canonical_url for item, _ in rows] == [
        "https://www.nytimes.com/pending",
        "https://www.nytimes.com/error",
    ]


def test_merged_candidate_json_puts_exact_rows_first_without_duplicates() -> None:
    snapshot_url = (
        "https://web.archive.org/web/20100102123456id_/"
        "https://www.nytimes.com/example"
    )
    exact = CaptureCandidate(
        provider=CaptureProvider.WAYBACK,
        snapshot_url=snapshot_url,
        captured_at=datetime(2010, 1, 2, 12, 34, 56, tzinfo=timezone.utc),
        digest="DIGEST",
        mime_type="text/html",
        status_code=200,
        byte_count=12_345,
    )

    serialized = TOOL.merged_candidate_json(
        [
            {"provider": "wayback", "snapshotUrl": snapshot_url},
            {
                "provider": "wayback",
                "snapshotUrl": "https://web.archive.org/guess",
            },
        ],
        (exact,),
    )

    assert serialized.count(snapshot_url) == 1
    assert serialized.index("DIGEST") < serialized.index("guess")


def test_apply_candidate_updates_writes_only_ready_rows(tmp_path: Path) -> None:
    connection = sqlite3.connect(tmp_path / "capture.sqlite3")
    connection.executescript(
        """
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            candidates_json TEXT NOT NULL,
            updated_at TEXT
        );
        INSERT INTO captures VALUES
            ('https://example.com/pending', 'pending', '[]', NULL),
            ('https://example.com/error', 'error', '[]', NULL),
            ('https://example.com/downloading', 'downloading', '[]', NULL);
        """
    )

    updated = TOOL.apply_candidate_updates(
        connection,
        [
            ('[{"provider":"wayback"}]', 'https://example.com/pending'),
            ('[{"provider":"wayback"}]', 'https://example.com/error'),
            (
                '[{"provider":"wayback"}]',
                'https://example.com/downloading',
            ),
        ],
    )

    assert updated == 2
    assert connection.in_transaction is False
    assert connection.execute(
        "SELECT candidates_json FROM captures WHERE canonical_url=?",
        ("https://example.com/downloading",),
    ).fetchone()[0] == "[]"
