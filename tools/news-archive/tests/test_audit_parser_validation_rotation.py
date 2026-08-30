from __future__ import annotations

import gzip
from pathlib import Path
import sqlite3

from jojo_olds_api.parser_validation import initialize_parser_validation_schema
from tools.audit_parser_validation_rotation import audit_rotation


def _state(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    initialize_parser_validation_schema(connection)
    return connection


def _seed_config(
    connection: sqlite3.Connection,
    *,
    year: int,
    parser_version: str,
) -> None:
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version,
            qa_revision, updated_at
        ) VALUES (?, 800, 'seed', ?, 1, '2026-08-09T00:00:00Z')
        """,
        (year, parser_version),
    )


def _seed_sample(
    connection: sqlite3.Connection,
    *,
    url: str,
    year: int,
    parser_version: str | None = None,
) -> None:
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, ?, 'a', '2026-08-09T00:00:00Z')
        """,
        (url, year),
    )
    if parser_version is not None:
        connection.execute(
            """
            INSERT INTO parser_validation_results(
                canonical_url, publisher, sample_year, parser_version,
                qa_revision, extraction_status, qa_pass, warnings_json,
                issues_json, parsed_at
            ) VALUES (?, 'npr', ?, ?, 1, 'complete', 1, '[]', '[]',
                      '2026-08-09T00:00:00Z')
            """,
            (url, year, parser_version),
        )


def test_audit_rotation_accepts_gzip_states_with_zero_overlap(tmp_path: Path):
    previous_path = tmp_path / "previous.sqlite3"
    current_path = tmp_path / "current.sqlite3"
    previous = _state(previous_path)
    current = _state(current_path)
    old_url = "https://www.npr.org/2014/01/01/1/old"
    new_url = "https://www.npr.org/2014/01/02/2/new"
    try:
        _seed_config(previous, year=2014, parser_version="npr-parser/0.1.14")
        _seed_sample(
            previous,
            url=old_url,
            year=2014,
            parser_version="npr-parser/0.1.14",
        )
        _seed_config(current, year=2014, parser_version="npr-parser/0.1.15")
        _seed_sample(current, url=new_url, year=2014)
        current.execute(
            """
            INSERT INTO parser_validation_exclusions(
                canonical_url, source_cohort, excluded_at
            ) VALUES (?, 'npr:2014:npr-parser/0.1.14',
                      '2026-08-09T00:00:00Z')
            """,
            (old_url,),
        )
        previous.commit()
        current.commit()
    finally:
        previous.close()
        current.close()

    previous_gz = tmp_path / "previous.sqlite3.gz"
    current_gz = tmp_path / "current.sqlite3.gz"
    for source, target in (
        (previous_path, previous_gz),
        (current_path, current_gz),
    ):
        with source.open("rb") as raw, gzip.open(target, "wb") as compressed:
            compressed.write(raw.read())

    result = audit_rotation(
        previous_state=previous_gz,
        current_state=current_gz,
        publisher="npr",
        expected_parser_version="npr-parser/0.1.15",
        from_year=2014,
        to_year=2014,
    )

    assert result["formatVersion"] == (
        "jojo-parser-validation-rotation-audit/2"
    )
    assert result["passed"] is True
    assert result["issues"] == []
    assert result["years"]["2014"] == {
        "previousParserVersion": "npr-parser/0.1.14",
        "previousEvaluated": 1,
        "currentParserVersion": "npr-parser/0.1.15",
        "currentPlanned": 1,
        "currentEvaluated": 0,
        "priorCohortOverlap": 0,
        "exclusionOverlap": 0,
        "missingPriorExclusions": 0,
        "wrongExclusionCohortLabels": 0,
    }

    strict = audit_rotation(
        previous_state=previous_gz,
        current_state=current_gz,
        publisher="npr",
        expected_parser_version="npr-parser/0.1.15",
        from_year=2014,
        to_year=2014,
        require_complete=True,
    )
    assert strict["passed"] is False
    assert strict["requireComplete"] is True
    assert "2014:current-evaluated-below-target" in strict["issues"]


def test_audit_rotation_rejects_reused_or_unexcluded_urls(tmp_path: Path):
    previous_path = tmp_path / "previous.sqlite3"
    current_path = tmp_path / "current.sqlite3"
    previous = _state(previous_path)
    current = _state(current_path)
    reused = "https://www.npr.org/2014/01/01/1/reused"
    try:
        _seed_config(previous, year=2014, parser_version="npr-parser/0.1.14")
        _seed_sample(
            previous,
            url=reused,
            year=2014,
            parser_version="npr-parser/0.1.14",
        )
        _seed_config(current, year=2014, parser_version="npr-parser/0.1.15")
        _seed_sample(current, url=reused, year=2014)
        previous.commit()
        current.commit()
    finally:
        previous.close()
        current.close()

    result = audit_rotation(
        previous_state=previous_path,
        current_state=current_path,
        publisher="npr",
        expected_parser_version="npr-parser/0.1.15",
        from_year=2014,
        to_year=2014,
    )

    assert result["passed"] is False
    assert "2014:prior-cohort-overlap" in result["issues"]
    assert "2014:missing-prior-exclusions" in result["issues"]


def test_audit_rotation_rejects_npr_section_alias_reuse(tmp_path: Path):
    previous_path = tmp_path / "previous.sqlite3"
    current_path = tmp_path / "current.sqlite3"
    previous = _state(previous_path)
    current = _state(current_path)
    root_url = "https://www.npr.org/2014/01/01/123456789/story"
    section_url = (
        "https://www.npr.org/sections/thetwo-way/2014/01/01/123456789/"
        "story"
    )
    try:
        _seed_config(previous, year=2014, parser_version="npr-parser/0.1.14")
        _seed_sample(
            previous,
            url=root_url,
            year=2014,
            parser_version="npr-parser/0.1.14",
        )
        _seed_config(current, year=2014, parser_version="npr-parser/0.1.15")
        _seed_sample(current, url=section_url, year=2014)
        current.execute(
            """
            INSERT INTO parser_validation_exclusions(
                canonical_url, source_cohort, excluded_at
            ) VALUES (?, 'npr:2014:npr-parser/0.1.14',
                      '2026-08-09T00:00:00Z')
            """,
            (root_url,),
        )
        previous.commit()
        current.commit()
    finally:
        previous.close()
        current.close()

    result = audit_rotation(
        previous_state=previous_path,
        current_state=current_path,
        publisher="npr",
        expected_parser_version="npr-parser/0.1.15",
        from_year=2014,
        to_year=2014,
    )

    assert result["passed"] is False
    assert "2014:prior-cohort-overlap" in result["issues"]
    assert "2014:exclusion-overlap" in result["issues"]
    assert "2014:missing-prior-exclusions" not in result["issues"]


def test_audit_rotation_accepts_explicit_holdout_source_cohort(tmp_path: Path):
    previous_path = tmp_path / "holdout-v2.sqlite3"
    current_path = tmp_path / "holdout-v3.sqlite3"
    previous = _state(previous_path)
    current = _state(current_path)
    old_url = "https://www.nytimes.com/2018/01/01/world/old.html"
    new_url = "https://www.nytimes.com/2018/01/02/world/new.html"
    try:
        _seed_config(previous, year=2018, parser_version="nyt-parser/0.8.54")
        _seed_sample(
            previous,
            url=old_url,
            year=2018,
            parser_version="nyt-parser/0.8.54",
        )
        _seed_config(current, year=2018, parser_version="nyt-parser/0.8.54")
        _seed_sample(current, url=new_url, year=2018)
        current.execute(
            """
            INSERT INTO parser_validation_exclusions(
                canonical_url, source_cohort, excluded_at
            ) VALUES (?, 'holdout-v2', '2026-08-09T00:00:00Z')
            """,
            (old_url,),
        )
        previous.commit()
        current.commit()
    finally:
        previous.close()
        current.close()

    result = audit_rotation(
        previous_state=previous_path,
        current_state=current_path,
        publisher="nyt",
        expected_parser_version="nyt-parser/0.8.54",
        expected_previous_source_cohort="holdout-v2",
        from_year=2018,
        to_year=2018,
    )

    assert result["passed"] is True
    assert result["expectedPreviousSourceCohort"] == "holdout-v2"
    assert result["years"]["2018"]["wrongExclusionCohortLabels"] == 0


def test_audit_rotation_accepts_legacy_previous_state_without_exclusions(
    tmp_path: Path,
):
    previous_path = tmp_path / "legacy.sqlite3"
    current_path = tmp_path / "current.sqlite3"
    previous = _state(previous_path)
    current = _state(current_path)
    old_url = "https://www.npr.org/2014/01/01/1/legacy"
    new_url = "https://www.npr.org/2014/01/02/2/current"
    try:
        _seed_config(previous, year=2014, parser_version="npr-parser/0.1.14")
        _seed_sample(
            previous,
            url=old_url,
            year=2014,
            parser_version="npr-parser/0.1.14",
        )
        previous.execute("DROP TABLE parser_validation_exclusions")
        _seed_config(current, year=2014, parser_version="npr-parser/0.1.15")
        _seed_sample(current, url=new_url, year=2014)
        current.execute(
            """
            INSERT INTO parser_validation_exclusions(
                canonical_url, source_cohort, excluded_at
            ) VALUES (?, 'npr:2014:npr-parser/0.1.14',
                      '2026-08-09T00:00:00Z')
            """,
            (old_url,),
        )
        previous.commit()
        current.commit()
    finally:
        previous.close()
        current.close()

    result = audit_rotation(
        previous_state=previous_path,
        current_state=current_path,
        publisher="npr",
        expected_parser_version="npr-parser/0.1.15",
        from_year=2014,
        to_year=2014,
    )

    assert result["passed"] is True
