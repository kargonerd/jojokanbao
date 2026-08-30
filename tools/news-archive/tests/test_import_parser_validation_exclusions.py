from __future__ import annotations

from pathlib import Path
import json
import sqlite3
import subprocess
import sys

from jojo_olds_api.parser_validation import initialize_parser_validation_schema


TOOL = (
    Path(__file__).resolve().parents[1]
    / "tools"
    / "import_parser_validation_exclusions.py"
)


def test_imports_only_urls_actually_evaluated_by_prior_cohort(
    tmp_path: Path,
):
    source_path = tmp_path / "source.sqlite3"
    target_path = tmp_path / "target.sqlite3"
    source = sqlite3.connect(source_path)
    source.executescript(
        """
        CREATE TABLE parser_validation_samples (
            canonical_url TEXT PRIMARY KEY
        );
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY
        );
        INSERT INTO parser_validation_samples VALUES
            ('https://apnews.com/article/evaluated'),
            ('https://apnews.com/article/reserve-only');
        INSERT INTO parser_validation_results VALUES
            ('https://apnews.com/article/evaluated');
        """
    )
    source.commit()
    source.close()

    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            "--source-state",
            str(source_path),
            "--target-state",
            str(target_path),
            "--source-cohort",
            "holdout-v1",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert '"sourceTable": "parser_validation_results"' in result.stdout

    target = sqlite3.connect(target_path)
    urls = {
        str(row[0])
        for row in target.execute(
            "SELECT canonical_url FROM parser_validation_exclusions"
        )
    }
    target.close()
    assert urls == {"https://apnews.com/article/evaluated"}


def test_formal_cohort_import_excludes_only_priority_ranked_qa_target(
    tmp_path: Path,
):
    source_path = tmp_path / "source.sqlite3"
    target_path = tmp_path / "target.sqlite3"
    source = sqlite3.connect(source_path)
    initialize_parser_validation_schema(source)
    source.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, updated_at
        ) VALUES (2010, 2, 'seed', 'npr-parser/0.1.20', 'now')
        """
    )
    rows = [
        ("https://www.npr.org/2010/01/01/1/first", "001", 1),
        ("https://www.npr.org/2010/01/01/2/failed", "002", 0),
        ("https://www.npr.org/2010/01/01/3/second", "003", 1),
        ("https://www.npr.org/2010/01/01/4/reserve", "004", 1),
    ]
    for url, priority, qa_pass in rows:
        source.execute(
            """
            INSERT INTO parser_validation_samples(
                canonical_url, sample_year, sample_priority, selected_at
            ) VALUES (?, 2010, ?, 'now')
            """,
            (url, priority),
        )
        source.execute(
            """
            INSERT INTO parser_validation_results(
                canonical_url, publisher, sample_year, parser_version,
                extraction_status, qa_pass, warnings_json, issues_json,
                parsed_at
            ) VALUES (?, 'npr', 2010, 'npr-parser/0.1.20',
                      'complete', ?, '[]', '[]', 'now')
            """,
            (url, qa_pass),
        )
    source.execute(
        """
        INSERT INTO parser_validation_exclusions(
            canonical_url, source_cohort, excluded_at
        ) VALUES ('https://www.npr.org/2010/01/01/0/inherited',
                  'older', 'now')
        """
    )
    source.commit()
    source.close()

    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            "--source-state",
            str(source_path),
            "--target-state",
            str(target_path),
            "--source-cohort",
            "validation-v1",
            "--publisher",
            "npr",
            "--sample-year",
            "2010",
            "--accepted-target-only",
            "--exclude-inherited",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert payload["evaluatedSourceSamples"] == 2
    assert payload["inheritedSourceExclusions"] == 0
    target = sqlite3.connect(target_path)
    urls = {
        row[0]
        for row in target.execute(
            "SELECT canonical_url FROM parser_validation_exclusions"
        )
    }
    target.close()
    assert urls == {
        "https://www.npr.org/2010/01/01/1/first",
        "https://www.npr.org/2010/01/01/3/second",
    }


def test_formal_cohort_import_requires_sample_and_result_years_to_match(
    tmp_path: Path,
):
    source_path = tmp_path / "source.sqlite3"
    target_path = tmp_path / "target.sqlite3"
    source = sqlite3.connect(source_path)
    initialize_parser_validation_schema(source)
    source.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, updated_at
        ) VALUES (2021, 1, 'seed', 'nyt-parser/0.8.74', 'now')
        """
    )
    # This URL was planned for 2020 but has a stale 2021 result row.  A
    # URL-only join must not let it displace the actual 2021 cohort sample.
    source.executemany(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, ?, ?, 'now')
        """,
        [
            (
                "https://www.nytimes.com/interactive/2021/us/covid-cases.html",
                2020,
                "001",
            ),
            (
                "https://www.nytimes.com/2021/12/08/opinion/supreme-court-abortion.html",
                2021,
                "002",
            ),
        ],
    )
    source.execute(
        """
        INSERT INTO parser_validation_results(
            canonical_url, publisher, sample_year, parser_version,
            extraction_status, qa_pass, warnings_json, issues_json,
            parsed_at
        ) VALUES (?, 'nyt', 2021, 'nyt-parser/0.8.74',
                  'complete', 1, '[]', '[]', 'now')
        """,
        (
            "https://www.nytimes.com/interactive/2021/us/covid-cases.html",
        ),
    )
    source.execute(
        """
        INSERT INTO parser_validation_results(
            canonical_url, publisher, sample_year, parser_version,
            extraction_status, qa_pass, warnings_json, issues_json,
            parsed_at
        ) VALUES (?, 'nyt', 2021, 'nyt-parser/0.8.74',
                  'complete', 1, '[]', '[]', 'now')
        """,
        (
            "https://www.nytimes.com/2021/12/08/opinion/supreme-court-abortion.html",
        ),
    )
    source.commit()
    source.close()

    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            "--source-state",
            str(source_path),
            "--target-state",
            str(target_path),
            "--source-cohort",
            "validation-v1",
            "--publisher",
            "nyt",
            "--sample-year",
            "2021",
            "--accepted-target-only",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert payload["evaluatedSourceSamples"] == 1
    target = sqlite3.connect(target_path)
    urls = {
        row[0]
        for row in target.execute(
            "SELECT canonical_url FROM parser_validation_exclusions"
        )
    }
    target.close()
    assert urls == {
        "https://www.nytimes.com/2021/12/08/opinion/supreme-court-abortion.html"
    }


def test_empty_formal_placeholder_is_skipped_without_resetting_target(
    tmp_path: Path,
):
    source_path = tmp_path / "placeholder.sqlite3"
    target_path = tmp_path / "target.sqlite3"
    source = sqlite3.connect(source_path)
    initialize_parser_validation_schema(source)
    source.commit()
    source.close()
    target = sqlite3.connect(target_path)
    initialize_parser_validation_schema(target)
    target.execute(
        """
        INSERT INTO parser_validation_exclusions(
            canonical_url, source_cohort, excluded_at
        ) VALUES ('https://www.ft.com/content/prior', 'validation-v1', 'now')
        """
    )
    target.commit()
    target.close()

    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            "--source-state",
            str(source_path),
            "--target-state",
            str(target_path),
            "--source-cohort",
            "validation-v2",
            "--publisher",
            "ft",
            "--sample-year",
            "2017",
            "--accepted-target-only",
            "--exclude-inherited",
            "--reset-target-exclusions",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert payload["skippedPlaceholder"] is True
    target = sqlite3.connect(target_path)
    assert target.execute(
        "SELECT canonical_url, source_cohort "
        "FROM parser_validation_exclusions"
    ).fetchall() == [
        ("https://www.ft.com/content/prior", "validation-v1")
    ]
    target.close()


def test_direct_rebuild_can_clear_stale_target_exclusions(tmp_path: Path):
    source_path = tmp_path / "source.sqlite3"
    target_path = tmp_path / "target.sqlite3"
    source = sqlite3.connect(source_path)
    source.execute(
        "CREATE TABLE parser_validation_results "
        "(canonical_url TEXT PRIMARY KEY)"
    )
    source.execute(
        "INSERT INTO parser_validation_results VALUES "
        "('https://apnews.com/article/formal-sample')"
    )
    source.commit()
    source.close()
    target = sqlite3.connect(target_path)
    initialize_parser_validation_schema(target)
    target.execute(
        """
        INSERT INTO parser_validation_exclusions(
            canonical_url, source_cohort, excluded_at
        ) VALUES ('https://apnews.com/article/stale-attempt', 'stale', 'now')
        """
    )
    target.commit()
    target.close()

    subprocess.run(
        [
            sys.executable,
            str(TOOL),
            "--source-state",
            str(source_path),
            "--target-state",
            str(target_path),
            "--source-cohort",
            "validation-v1",
            "--reset-target-exclusions",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    target = sqlite3.connect(target_path)
    urls = target.execute(
        "SELECT canonical_url FROM parser_validation_exclusions"
    ).fetchall()
    target.close()
    assert urls == [("https://apnews.com/article/formal-sample",)]


def test_removes_existing_samples_that_overlap_new_exclusions(
    tmp_path: Path,
):
    source_path = tmp_path / "source.sqlite3"
    target_path = tmp_path / "target.sqlite3"
    source = sqlite3.connect(source_path)
    source.executescript(
        """
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY
        );
        INSERT INTO parser_validation_results VALUES
            ('https://reuters.com/article/overlap');
        """
    )
    source.commit()
    source.close()
    target = sqlite3.connect(target_path)
    initialize_parser_validation_schema(target)
    target.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        )
        VALUES (?, 2012, 'priority', 'now')
        """,
        ("https://reuters.com/article/overlap",),
    )
    target.commit()
    target.close()

    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            "--source-state",
            str(source_path),
            "--target-state",
            str(target_path),
            "--source-cohort",
            "validation-v1",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert payload["removedSampleOverlap"] == 1
    assert payload["sampleOverlap"] == 0
    target = sqlite3.connect(target_path)
    assert target.execute(
        "SELECT COUNT(*) FROM parser_validation_samples"
    ).fetchone()[0] == 0
    target.close()


def test_can_limit_imported_exclusions_to_one_sample_year(tmp_path: Path):
    source_path = tmp_path / "source.sqlite3"
    target_path = tmp_path / "target.sqlite3"
    source = sqlite3.connect(source_path)
    source.executescript(
        """
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL
        );
        INSERT INTO parser_validation_results VALUES
            ('https://www.ft.com/content/from-2016', 2016),
            ('https://www.ft.com/content/from-2017', 2017);
        """
    )
    source.commit()
    source.close()

    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            "--source-state",
            str(source_path),
            "--target-state",
            str(target_path),
            "--source-cohort",
            "ft:2016:ft-parser/0.8.29",
            "--sample-year",
            "2016",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert payload["sampleYear"] == 2016
    assert payload["sourceSamples"] == 1
    target = sqlite3.connect(target_path)
    exclusions = target.execute(
        "SELECT canonical_url, source_cohort "
        "FROM parser_validation_exclusions"
    ).fetchall()
    target.close()
    assert exclusions == [
        (
            "https://www.ft.com/content/from-2016",
            "ft:2016:ft-parser/0.8.29",
        )
    ]


def test_normalizes_caixin_page_variants_before_excluding(tmp_path: Path):
    source_path = tmp_path / "source.sqlite3"
    target_path = tmp_path / "target.sqlite3"
    source = sqlite3.connect(source_path)
    source.executescript(
        """
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY
        );
        INSERT INTO parser_validation_results VALUES
            ('https://magazine.caixin.com/2010-02-07/100116568_all.html'),
            ('https://magazine.caixin.com/2010-02-07/100116568_2.html');
        """
    )
    source.commit()
    source.close()

    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            "--source-state",
            str(source_path),
            "--target-state",
            str(target_path),
            "--source-cohort",
            "preflight-v1",
            "--publisher",
            "caixin",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert payload["sourceSamples"] == 1
    target = sqlite3.connect(target_path)
    exclusions = target.execute(
        "SELECT canonical_url FROM parser_validation_exclusions"
    ).fetchall()
    target.close()
    assert exclusions == [
        ("https://magazine.caixin.com/2010-02-07/100116568.html",)
    ]


def test_removes_existing_sample_with_normalized_npr_exclusion_overlap(
    tmp_path: Path,
):
    source_path = tmp_path / "source.sqlite3"
    target_path = tmp_path / "target.sqlite3"
    canonical = "https://www.npr.org/2010/01/01/123456789/sample-story"
    legacy_variant = (
        "http://npr.org/2010/01/01/123456789/sample-story/?output=1"
    )
    source = sqlite3.connect(source_path)
    source.execute(
        "CREATE TABLE parser_validation_results (canonical_url TEXT PRIMARY KEY)"
    )
    source.execute(
        "INSERT INTO parser_validation_results VALUES (?)",
        (canonical,),
    )
    source.commit()
    source.close()
    target = sqlite3.connect(target_path)
    initialize_parser_validation_schema(target)
    target.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2010, 'priority', 'now')
        """,
        (legacy_variant,),
    )
    target.commit()
    target.close()

    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            "--source-state",
            str(source_path),
            "--target-state",
            str(target_path),
            "--source-cohort",
            "validation-v2",
            "--publisher",
            "npr",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert payload["removedSampleOverlap"] == 1
    assert payload["sampleOverlap"] == 0
    target = sqlite3.connect(target_path)
    assert target.execute(
        "SELECT COUNT(*) FROM parser_validation_samples"
    ).fetchone()[0] == 0
    target.close()


def test_inherits_transitive_exclusions_from_prior_validation_state(
    tmp_path: Path,
):
    source_path = tmp_path / "source.sqlite3"
    target_path = tmp_path / "target.sqlite3"
    source = sqlite3.connect(source_path)
    source.executescript(
        """
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_exclusions (
            canonical_url TEXT PRIMARY KEY,
            source_cohort TEXT NOT NULL,
            excluded_at TEXT NOT NULL
        );
        INSERT INTO parser_validation_results VALUES
            ('https://magazine.caixin.com/2010-01-01/evaluated.html', 2010);
        INSERT INTO parser_validation_exclusions VALUES
            ('https://magazine.caixin.com/2010-01-02/preflight.html',
             'preflight-v1', 'now');
        """
    )
    source.commit()
    source.close()

    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            "--source-state",
            str(source_path),
            "--target-state",
            str(target_path),
            "--source-cohort",
            "validation-v1",
            "--publisher",
            "caixin",
            "--sample-year",
            "2010",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert payload["sourceSamples"] == 2
    assert payload["evaluatedSourceSamples"] == 1
    assert payload["inheritedSourceExclusions"] == 1
    target = sqlite3.connect(target_path)
    exclusions = {
        row[0]: row[1]
        for row in target.execute(
            "SELECT canonical_url, source_cohort "
            "FROM parser_validation_exclusions"
        )
    }
    target.close()
    assert exclusions == {
        "https://magazine.caixin.com/2010-01-01/evaluated.html": (
            "validation-v1"
        ),
        "https://magazine.caixin.com/2010-01-02/preflight.html": (
            "preflight-v1"
        ),
    }


def test_direct_cohort_import_repairs_stale_inherited_label(tmp_path: Path):
    inherited_path = tmp_path / "inherited.sqlite3"
    direct_path = tmp_path / "direct.sqlite3"
    target_path = tmp_path / "target.sqlite3"
    inherited = sqlite3.connect(inherited_path)
    inherited.executescript(
        """
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_exclusions (
            canonical_url TEXT PRIMARY KEY,
            source_cohort TEXT NOT NULL,
            excluded_at TEXT NOT NULL
        );
        INSERT INTO parser_validation_results VALUES
            ('https://magazine.caixin.com/2010-01-02/new.html', 2010);
        INSERT INTO parser_validation_exclusions VALUES
            ('https://magazine.caixin.com/2010-01-01/old.html',
             'wrong-later-cohort', 'now');
        """
    )
    inherited.commit()
    inherited.close()
    direct = sqlite3.connect(direct_path)
    direct.executescript(
        """
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL
        );
        INSERT INTO parser_validation_results VALUES
            ('https://magazine.caixin.com/2010-01-01/old.html', 2010);
        """
    )
    direct.commit()
    direct.close()

    for source_path, source_cohort in (
        (inherited_path, "holdout-v2"),
        (direct_path, "holdout-v1"),
    ):
        subprocess.run(
            [
                sys.executable,
                str(TOOL),
                "--source-state",
                str(source_path),
                "--target-state",
                str(target_path),
                "--source-cohort",
                source_cohort,
                "--publisher",
                "caixin",
                "--sample-year",
                "2010",
            ],
            check=True,
            capture_output=True,
            text=True,
        )

    target = sqlite3.connect(target_path)
    exclusions = dict(
        target.execute(
            "SELECT canonical_url, source_cohort "
            "FROM parser_validation_exclusions"
        )
    )
    target.close()
    assert exclusions == {
        "https://magazine.caixin.com/2010-01-01/old.html": "holdout-v1",
        "https://magazine.caixin.com/2010-01-02/new.html": "holdout-v2",
    }
