from __future__ import annotations

from pathlib import Path
import sqlite3

from jojo_news_archive.parsing.validation import initialize_parser_validation_schema
from tools.audit_parser_validation_holdout import audit_holdout


def _state(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    initialize_parser_validation_schema(connection)
    return connection


def _config(connection, *, year: int, version: str) -> None:
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version,
            qa_revision, updated_at
        ) VALUES (?, 800, 'seed', ?, 1, '2026-08-10T00:00:00Z')
        """,
        (year, version),
    )


def _sample(
    connection,
    *,
    url: str,
    year: int,
    version: str | None,
) -> None:
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, ?, 'a', '2026-08-10T00:00:00Z')
        """,
        (url, year),
    )
    if version is not None:
        connection.execute(
            """
            INSERT INTO parser_validation_results(
                canonical_url, publisher, sample_year, parser_version,
                qa_revision, extraction_status, qa_pass, warnings_json,
                issues_json, parsed_at
            ) VALUES (?, 'nyt', ?, ?, 1, 'complete', 1, '[]', '[]',
                      '2026-08-10T00:00:00Z')
            """,
            (url, year, version),
        )


def test_holdout_audit_accepts_union_and_overlapping_prior_labels(
    tmp_path: Path,
):
    first_path = tmp_path / "validation.sqlite3"
    second_path = tmp_path / "holdout-v1.sqlite3"
    current_path = tmp_path / "holdout-v2.sqlite3"
    first = _state(first_path)
    second = _state(second_path)
    current = _state(current_path)
    shared = "https://www.nytimes.com/2020/01/01/world/shared.html"
    first_only = "https://www.nytimes.com/2020/01/02/world/first.html"
    second_only = "https://www.nytimes.com/2020/01/03/world/second.html"
    current_url = "https://www.nytimes.com/2020/01/04/world/current.html"
    try:
        _config(first, year=2020, version="nyt-parser/0.8.50")
        _config(second, year=2020, version="nyt-parser/0.8.51")
        _config(current, year=2020, version="nyt-parser/0.8.55")
        for url in (shared, first_only):
            _sample(first, url=url, year=2020, version="nyt-parser/0.8.50")
        for url in (shared, second_only):
            _sample(second, url=url, year=2020, version="nyt-parser/0.8.51")
        _sample(current, url=current_url, year=2020, version=None)
        current.executemany(
            """
            INSERT INTO parser_validation_exclusions(
                canonical_url, source_cohort, excluded_at
            ) VALUES (?, ?, '2026-08-10T00:00:00Z')
            """,
            (
                (shared, "holdout-v1"),
                (first_only, "validation-v1"),
                (second_only, "holdout-v1"),
            ),
        )
        first.commit()
        second.commit()
        current.commit()
    finally:
        first.close()
        second.close()
        current.close()

    result = audit_holdout(
        previous_states=(
            ("validation-v1", first_path),
            ("holdout-v1", second_path),
        ),
        current_state=current_path,
        publisher="nyt",
        expected_parser_version="nyt-parser/0.8.55",
        from_year=2020,
        to_year=2020,
    )

    assert result["passed"] is True
    year = result["years"]["2020"]
    assert year["previousUniqueEvaluated"] == 3
    assert year["priorCohortOverlap"] == 0
    assert year["missingPriorExclusions"] == 0
    assert year["wrongExclusionCohortLabels"] == 0


def test_holdout_audit_rejects_overlap_missing_exclusion_and_short_target(
    tmp_path: Path,
):
    previous_path = tmp_path / "previous.sqlite3"
    current_path = tmp_path / "current.sqlite3"
    previous = _state(previous_path)
    current = _state(current_path)
    reused = "https://www.nytimes.com/2020/01/01/world/reused.html"
    try:
        _config(previous, year=2020, version="nyt-parser/0.8.54")
        _config(current, year=2020, version="nyt-parser/0.8.55")
        _sample(previous, url=reused, year=2020, version="nyt-parser/0.8.54")
        _sample(current, url=reused, year=2020, version="nyt-parser/0.8.55")
        previous.commit()
        current.commit()
    finally:
        previous.close()
        current.close()

    result = audit_holdout(
        previous_states=(("validation-v1", previous_path),),
        current_state=current_path,
        publisher="nyt",
        expected_parser_version="nyt-parser/0.8.55",
        from_year=2020,
        to_year=2020,
        require_complete=True,
    )

    assert result["passed"] is False
    assert "2020:current-evaluated-below-target" in result["issues"]
    assert "2020:prior-cohort-overlap" in result["issues"]
    assert "2020:missing-prior-exclusions" in result["issues"]


def test_holdout_audit_accepts_empty_previous_probe(tmp_path: Path):
    previous_path = tmp_path / "empty.sqlite3"
    current_path = tmp_path / "current.sqlite3"
    previous = _state(previous_path)
    current = _state(current_path)
    try:
        _config(current, year=2020, version="nyt-parser/0.8.55")
        _sample(
            current,
            url="https://www.nytimes.com/2020/01/04/world/current.html",
            year=2020,
            version=None,
        )
        previous.commit()
        current.commit()
    finally:
        previous.close()
        current.close()

    result = audit_holdout(
        previous_states=(("validation-v2", previous_path),),
        current_state=current_path,
        publisher="nyt",
        expected_parser_version="nyt-parser/0.8.55",
        from_year=2020,
        to_year=2020,
    )

    assert result["passed"] is True
    assert result["issues"] == []


def test_holdout_audit_recovers_compacted_cohort_from_labeled_exclusions(
    tmp_path: Path,
):
    previous_path = tmp_path / "compacted.sqlite3"
    current_path = tmp_path / "current.sqlite3"
    previous = _state(previous_path)
    current = _state(current_path)
    old_url = "https://www.nytimes.com/2020/01/01/world/old.html"
    current_url = "https://www.nytimes.com/2020/01/02/world/current.html"
    try:
        _config(previous, year=2020, version="nyt-parser/0.8.54")
        previous.execute(
            """
            CREATE TABLE captures(
                canonical_url TEXT PRIMARY KEY,
                published_at TEXT NOT NULL
            )
            """
        )
        previous.execute(
            "INSERT INTO captures VALUES (?, '2020-01-01T00:00:00Z')",
            (old_url,),
        )
        previous.execute(
            """
            INSERT INTO parser_validation_exclusions(
                canonical_url, source_cohort, excluded_at
            ) VALUES (?, 'holdout-v1', '2026-08-10T00:00:00Z')
            """,
            (old_url,),
        )
        _config(current, year=2020, version="nyt-parser/0.8.55")
        _sample(current, url=current_url, year=2020, version=None)
        current.execute(
            """
            INSERT INTO parser_validation_exclusions(
                canonical_url, source_cohort, excluded_at
            ) VALUES (?, 'holdout-v1', '2026-08-10T00:00:00Z')
            """,
            (old_url,),
        )
        previous.commit()
        current.commit()
    finally:
        previous.close()
        current.close()

    result = audit_holdout(
        previous_states=(("holdout-v1", previous_path),),
        current_state=current_path,
        publisher="nyt",
        expected_parser_version="nyt-parser/0.8.55",
        from_year=2020,
        to_year=2020,
    )

    assert result["passed"] is True
    cohort = result["years"]["2020"]["previousCohorts"]["holdout-v1"]
    assert cohort["evaluated"] == 1
    assert cohort["source"] == "retained-exclusions"


def test_holdout_audit_allows_first_cohort_without_previous_state(
    tmp_path: Path,
):
    current_path = tmp_path / "first-holdout.sqlite3"
    current = _state(current_path)
    try:
        _config(current, year=2014, version="caixin-parser/0.1.9")
        current.execute(
            "UPDATE parser_validation_config SET target_size=1 "
            "WHERE sample_year=2014"
        )
        _sample(
            current,
            url="https://magazine.caixin.com/2014-01-02/100600001.html",
            year=2014,
            version="caixin-parser/0.1.9",
        )
        current.commit()
    finally:
        current.close()

    result = audit_holdout(
        previous_states=(),
        current_state=current_path,
        publisher="caixin",
        expected_parser_version="caixin-parser/0.1.9",
        from_year=2014,
        to_year=2014,
        target_per_year=1,
        require_complete=True,
        allow_empty_previous=True,
    )

    assert result["passed"] is True
    year = result["years"]["2014"]
    assert year["previousUniqueEvaluated"] == 0
    assert year["priorCohortOverlap"] == 0
    assert year["missingPriorExclusions"] == 0


def test_holdout_audit_ignores_failed_and_reserve_attempts(tmp_path: Path):
    previous_path = tmp_path / "previous.sqlite3"
    current_path = tmp_path / "current.sqlite3"
    previous = _state(previous_path)
    current = _state(current_path)
    accepted = "https://www.nytimes.com/2020/01/01/world/accepted.html"
    failed = "https://www.nytimes.com/2020/01/02/world/failed.html"
    reserve = "https://www.nytimes.com/2020/01/03/world/reserve.html"
    current_url = "https://www.nytimes.com/2020/01/04/world/current.html"
    try:
        _config(previous, year=2020, version="nyt-parser/0.8.54")
        previous.execute(
            "UPDATE parser_validation_config SET target_size=1 "
            "WHERE sample_year=2020"
        )
        _config(current, year=2020, version="nyt-parser/0.8.55")
        for priority, url, qa_pass in (
            ("001", accepted, 1),
            ("002", failed, 0),
            ("003", reserve, 1),
        ):
            _sample(
                previous,
                url=url,
                year=2020,
                version="nyt-parser/0.8.54",
            )
            previous.execute(
                "UPDATE parser_validation_samples SET sample_priority=? "
                "WHERE canonical_url=?",
                (priority, url),
            )
            previous.execute(
                "UPDATE parser_validation_results SET qa_pass=? "
                "WHERE canonical_url=?",
                (qa_pass, url),
            )
        _sample(current, url=current_url, year=2020, version=None)
        current.execute(
            """
            INSERT INTO parser_validation_exclusions(
                canonical_url, source_cohort, excluded_at
            ) VALUES (?, 'validation-v1', '2026-08-10T00:00:00Z')
            """,
            (accepted,),
        )
        previous.commit()
        current.commit()
    finally:
        previous.close()
        current.close()

    result = audit_holdout(
        previous_states=(("validation-v1", previous_path),),
        current_state=current_path,
        publisher="nyt",
        expected_parser_version="nyt-parser/0.8.55",
        from_year=2020,
        to_year=2020,
    )

    assert result["passed"] is True
    assert result["years"]["2020"]["previousUniqueEvaluated"] == 1


def test_holdout_audit_normalizes_caixin_pagination_variants(
    tmp_path: Path,
):
    previous_path = tmp_path / "previous.sqlite3"
    current_path = tmp_path / "current.sqlite3"
    previous = _state(previous_path)
    current = _state(current_path)
    base = "https://magazine.caixin.com/2010-02-07/100116568"
    try:
        _config(previous, year=2010, version="caixin-parser/0.1.0")
        _config(current, year=2010, version="caixin-parser/0.1.1")
        _sample(
            previous,
            url=base + "_all.html",
            year=2010,
            version="caixin-parser/0.1.0",
        )
        _sample(
            current,
            url=(
                "https://magazine.caixin.com/2010-02-08/100116999.html"
            ),
            year=2010,
            version=None,
        )
        current.execute(
            """
            INSERT INTO parser_validation_exclusions(
                canonical_url, source_cohort, excluded_at
            ) VALUES (?, 'preflight-v1', '2026-08-10T00:00:00Z')
            """,
            (base + ".html",),
        )
        previous.commit()
        current.commit()
    finally:
        previous.close()
        current.close()

    result = audit_holdout(
        previous_states=(("preflight-v1", previous_path),),
        current_state=current_path,
        publisher="caixin",
        expected_parser_version="caixin-parser/0.1.1",
        from_year=2010,
        to_year=2010,
    )

    assert result["passed"] is True
    assert result["years"]["2010"]["missingPriorExclusions"] == 0
