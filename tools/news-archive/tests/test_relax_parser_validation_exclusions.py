from __future__ import annotations

import json
import sqlite3

from jojo_olds_api.parser_validation import initialize_parser_validation_schema
from tools.relax_parser_validation_exclusions import (
    finalize_overlap_audit,
    relax_exclusions_if_under_target,
)


def test_empty_state_does_not_require_capture_schema():
    connection = sqlite3.connect(":memory:")

    result = relax_exclusions_if_under_target(
        connection,
        sample_year=2014,
        target=300,
    )

    assert result["overlapAllowed"] is False
    assert result["selectedBefore"] == 0
    assert connection.execute(
        """
        SELECT 1 FROM sqlite_master
        WHERE type='table' AND name='archive_metadata'
        """
    ).fetchone() == (1,)


def test_relaxes_exclusions_when_disjoint_pool_is_under_target():
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        CREATE TABLE archive_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    connection.executemany(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        )
        VALUES (?, 2010, ?, 'now')
        """,
        [
            ("https://example.com/one", "1"),
            ("https://example.com/two", "2"),
        ],
    )
    connection.executemany(
        """
        INSERT INTO parser_validation_exclusions(
            canonical_url, source_cohort, excluded_at
        )
        VALUES (?, 'validation-v1', 'now')
        """,
        [
            ("https://example.com/old-one",),
            ("https://example.com/old-two",),
            ("https://example.com/old-three",),
        ],
    )

    result = relax_exclusions_if_under_target(
        connection,
        sample_year=2010,
        target=300,
    )

    assert result["overlapAllowed"] is True
    assert result["selectedBefore"] == 2
    assert result["exclusionsRelaxed"] == 3
    assert connection.execute(
        "SELECT COUNT(*) FROM parser_validation_exclusions"
    ).fetchone()[0] == 0
    audit = json.loads(
        connection.execute(
            """
            SELECT value FROM archive_metadata
            WHERE key='parser_validation_overlap_fallback:2010'
            """
        ).fetchone()[0]
    )
    assert audit["overlapAllowed"] is True
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        )
        VALUES ('https://example.com/old-one', 2010, '3', 'now')
        """
    )
    finalized = finalize_overlap_audit(
        connection,
        sample_year=2010,
    )
    assert finalized["selectedAfter"] == 3
    assert finalized["reusedSamples"] == 1
    assert finalized["finalized"] is True


def test_keeps_exclusions_when_target_is_already_reached():
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        CREATE TABLE archive_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    connection.executemany(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        )
        VALUES (?, 2024, ?, 'now')
        """,
        [
            (f"https://example.com/{index}", f"{index:03d}")
            for index in range(300)
        ],
    )
    connection.execute(
        """
        INSERT INTO parser_validation_exclusions(
            canonical_url, source_cohort, excluded_at
        )
        VALUES ('https://example.com/old', 'validation-v1', 'now')
        """
    )

    result = relax_exclusions_if_under_target(
        connection,
        sample_year=2024,
        target=300,
    )

    assert result["overlapAllowed"] is False
    assert connection.execute(
        "SELECT COUNT(*) FROM parser_validation_exclusions"
    ).fetchone()[0] == 1
