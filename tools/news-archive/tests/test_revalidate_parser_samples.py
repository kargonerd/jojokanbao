from __future__ import annotations

import importlib.util
from pathlib import Path
import sqlite3


TOOL_PATH = (
    Path(__file__).resolve().parents[1]
    / "tools"
    / "revalidate_parser_samples.py"
)
SPEC = importlib.util.spec_from_file_location(
    "revalidate_parser_samples_tool",
    TOOL_PATH,
)
assert SPEC is not None and SPEC.loader is not None
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)


def test_forced_replay_candidates_reports_missing_raw_objects(
    tmp_path: Path,
) -> None:
    connection = sqlite3.connect(":memory:")
    connection.executescript(
        """
        CREATE TABLE parser_validation_config (
            sample_year INTEGER PRIMARY KEY,
            parser_version TEXT NOT NULL,
            qa_revision INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL,
            parser_version TEXT NOT NULL,
            qa_revision INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_samples (
            canonical_url TEXT PRIMARY KEY,
            sample_priority INTEGER NOT NULL
        );
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            raw_path TEXT
        );
        INSERT INTO parser_validation_config VALUES
            (2010, 'nyt-parser/current', 7);
        INSERT INTO parser_validation_results VALUES
            ('https://example.com/present', 2010, 'nyt-parser/current', 7),
            ('https://example.com/missing', 2010, 'nyt-parser/current', 7),
            ('https://example.com/no-path', 2010, 'nyt-parser/current', 7),
            ('https://example.com/stale', 2010, 'nyt-parser/old', 7);
        INSERT INTO parser_validation_samples VALUES
            ('https://example.com/present', 1),
            ('https://example.com/missing', 2),
            ('https://example.com/no-path', 3),
            ('https://example.com/stale', 4);
        INSERT INTO captures VALUES
            ('https://example.com/present', 'complete', 'objects/present.html'),
            ('https://example.com/missing', 'complete', 'objects/missing.html'),
            ('https://example.com/no-path', 'complete', NULL),
            ('https://example.com/stale', 'complete', 'objects/stale.html');
        """
    )
    present = tmp_path / "objects" / "present.html"
    present.parent.mkdir()
    present.write_text("archive", encoding="utf-8")
    (tmp_path / "objects" / "stale.html").write_text(
        "stale archive",
        encoding="utf-8",
    )

    replayable, missing = TOOL.forced_replay_candidates(
        connection,
        archive_root=tmp_path,
        maximum=500,
    )

    assert replayable == [
        ("https://example.com/present", "objects/present.html")
    ]
    assert missing == [
        ("https://example.com/missing", "objects/missing.html"),
        (
            "https://example.com/no-path",
            "<missing raw_path for https://example.com/no-path>",
        ),
    ]


def test_requeue_missing_validation_capture_resets_capture_and_result() -> None:
    connection = sqlite3.connect(":memory:")
    connection.executescript(
        """
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY
        );
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );
        INSERT INTO parser_validation_results VALUES
            ('https://example.com/missing');
        INSERT INTO captures VALUES
            ('https://example.com/missing', 'complete', 2, NULL, 'old');
        """
    )

    TOOL.requeue_missing_validation_capture(
        connection,
        canonical_url="https://example.com/missing",
    )

    assert connection.execute(
        "SELECT status, attempts, last_error FROM captures"
    ).fetchone() == (
        "pending",
        0,
        "raw quality policy rejected stored capture: "
        "validation-raw-object-missing",
    )
    assert connection.execute(
        "SELECT COUNT(*) FROM parser_validation_results"
    ).fetchone() == (0,)


def test_preserve_missing_raw_object_keeps_capture_and_result() -> None:
    connection = sqlite3.connect(":memory:")
    connection.executescript(
        """
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY
        );
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );
        INSERT INTO parser_validation_results VALUES
            ('https://example.com/missing');
        INSERT INTO captures VALUES
            ('https://example.com/missing', 'complete', 2, NULL, 'old');
        """
    )

    requeued = TOOL._handle_missing_raw_object(
        connection,
        canonical_url="https://example.com/missing",
        preserve_missing=True,
    )

    assert requeued is False
    assert connection.execute(
        "SELECT status, attempts, last_error FROM captures"
    ).fetchone() == ("complete", 2, None)
    assert connection.execute(
        "SELECT COUNT(*) FROM parser_validation_results"
    ).fetchone() == (1,)
