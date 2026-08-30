from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sqlite3


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "tools" / "capture_action_state.py"
)
SPEC = spec_from_file_location("capture_action_state", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def create_state(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE captures(status TEXT NOT NULL, attempts INTEGER NOT NULL)"
    )
    connection.executemany(
        "INSERT INTO captures(status, attempts) VALUES (?, ?)",
        [
            ("complete", 1),
            ("pending", 4),
            ("error", 2),
            ("error", 3),
        ],
    )
    connection.commit()
    connection.close()


def test_missing_state_starts_capture_chain(tmp_path: Path):
    result = MODULE.action_state(
        tmp_path / "missing.sqlite3",
        maximum_record_attempts=3,
    )
    assert result["shouldContinue"] is True
    assert result["retryErrors"] is False


def test_pending_precedes_error_retries(tmp_path: Path):
    state = tmp_path / "capture.sqlite3"
    create_state(state)
    result = MODULE.action_state(state, maximum_record_attempts=3)

    assert result["actionable"] == 2
    assert result["retryErrors"] is False
    assert result["terminalUnresolved"] == 1


def test_retry_errors_after_pending_finishes(tmp_path: Path):
    state = tmp_path / "capture.sqlite3"
    create_state(state)
    connection = sqlite3.connect(state)
    connection.execute("DELETE FROM captures WHERE status='pending'")
    connection.commit()
    connection.close()

    result = MODULE.action_state(state, maximum_record_attempts=3)

    assert result["retryErrors"] is True
    assert result["shouldContinue"] is True


def test_stale_completed_parser_sample_keeps_chain_running(
    tmp_path: Path,
):
    state = tmp_path / "capture.sqlite3"
    connection = sqlite3.connect(state)
    connection.executescript(
        """
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            raw_path TEXT
        );
        CREATE TABLE parser_validation_config (
            sample_year INTEGER PRIMARY KEY,
            target_size INTEGER NOT NULL,
            parser_version TEXT NOT NULL
        );
        CREATE TABLE parser_validation_samples (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL,
            parser_version TEXT
        );
        """
    )
    connection.execute(
        """
        INSERT INTO captures
        VALUES ('https://example.com/article', 'complete', 1, 'objects/a.gz')
        """
    )
    connection.execute(
        "INSERT INTO parser_validation_config VALUES (2024, 1, 'parser/2')"
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples
        VALUES ('https://example.com/article', 2024)
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_results
        VALUES ('https://example.com/article', 2024, 'parser/1')
        """
    )
    connection.commit()
    connection.close()

    result = MODULE.action_state(state, maximum_record_attempts=3)

    assert result["validationReplays"] == 1
    assert result["actionable"] == 1
    assert result["shouldContinue"] is True


def test_stale_qa_revision_keeps_replay_chain_running(tmp_path: Path):
    state = tmp_path / "capture.sqlite3"
    connection = sqlite3.connect(state)
    connection.executescript(
        """
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            raw_path TEXT
        );
        CREATE TABLE parser_validation_config (
            sample_year INTEGER PRIMARY KEY,
            target_size INTEGER NOT NULL,
            parser_version TEXT NOT NULL,
            qa_revision INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_samples (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL,
            parser_version TEXT,
            qa_revision INTEGER NOT NULL
        );
        INSERT INTO captures VALUES
            ('https://example.com/article', 'complete', 1, 'objects/a.gz');
        INSERT INTO parser_validation_config VALUES
            (2024, 1, 'parser/2', 1);
        INSERT INTO parser_validation_samples VALUES
            ('https://example.com/article', 2024);
        INSERT INTO parser_validation_results VALUES
            ('https://example.com/article', 2024, 'parser/2', 0);
        """
    )
    connection.commit()
    connection.close()

    result = MODULE.action_state(state, maximum_record_attempts=3)

    assert result["validationReplays"] == 1
    assert result["actionable"] == 1
    assert result["shouldContinue"] is True


def test_ready_parser_validation_stops_pending_capture_chain(
    tmp_path: Path,
):
    state = tmp_path / "capture.sqlite3"
    connection = sqlite3.connect(state)
    connection.executescript(
        """
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            raw_path TEXT
        );
        CREATE TABLE parser_validation_config (
            sample_year INTEGER PRIMARY KEY,
            target_size INTEGER NOT NULL,
            parser_version TEXT NOT NULL
        );
        CREATE TABLE parser_validation_samples (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL,
            parser_version TEXT NOT NULL,
            extraction_status TEXT NOT NULL,
            qa_pass INTEGER NOT NULL
        );
        """
    )
    connection.executemany(
        "INSERT INTO captures VALUES (?, 'pending', 0, NULL)",
        [
            ("https://example.com/pending-1",),
            ("https://example.com/pending-2",),
        ],
    )
    connection.execute(
        "INSERT INTO parser_validation_config VALUES (2024, 2, 'parser/2')"
    )
    connection.executemany(
        """
        INSERT INTO parser_validation_results
        VALUES (?, 2024, 'parser/2', 'complete', 1)
        """,
        [
            ("https://example.com/complete-1",),
            ("https://example.com/complete-2",),
        ],
    )
    connection.commit()
    connection.close()

    result = MODULE.action_state(state, maximum_record_attempts=3)

    assert result["actionable"] == 0
    assert result["validationReady"] is True
    assert result["shouldContinue"] is False
    assert result["parserValidation"]["years"] == [
        {
            "sampleYear": 2024,
            "target": 2,
            "parserVersion": "parser/2",
            "evaluated": 2,
            "qaPassed": 2,
            "complete": 2,
            "parserErrors": 0,
            "unboundCaptureInputs": 0,
            "qaPassRate": 1.0,
            "completeRate": 1.0,
            "targetReached": True,
        }
    ]


def test_failed_qa_keeps_runner_active_until_qa_target_is_reached(
    tmp_path: Path,
):
    state = tmp_path / "capture.sqlite3"
    connection = sqlite3.connect(state)
    connection.executescript(
        """
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            raw_path TEXT
        );
        CREATE TABLE parser_validation_config (
            sample_year INTEGER PRIMARY KEY,
            target_size INTEGER NOT NULL,
            parser_version TEXT NOT NULL
        );
        CREATE TABLE parser_validation_samples (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL,
            parser_version TEXT NOT NULL,
            extraction_status TEXT NOT NULL,
            qa_pass INTEGER NOT NULL
        );
        INSERT INTO captures VALUES
            ('https://example.com/pending', 'pending', 0, NULL);
        INSERT INTO parser_validation_config
            VALUES (2024, 2, 'parser/2');
        INSERT INTO parser_validation_results VALUES
            ('https://example.com/pass', 2024, 'parser/2', 'complete', 1),
            ('https://example.com/fail', 2024, 'parser/2', 'partial', 0);
        """
    )
    connection.commit()
    connection.close()

    normal = MODULE.action_state(
        state,
        maximum_record_attempts=3,
    )
    exact = MODULE.action_state(
        state,
        maximum_record_attempts=3,
        stop_at_validation_target=True,
    )

    assert exact["validationTargetReached"] is False
    assert exact["validationReady"] is False
    assert normal["shouldContinue"] is False
    assert exact["shouldContinue"] is False


def test_validation_ready_ignores_replacement_candidates_after_target(
    tmp_path: Path,
):
    state = tmp_path / "capture.sqlite3"
    connection = sqlite3.connect(state)
    connection.executescript(
        """
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            raw_path TEXT
        );
        CREATE TABLE parser_validation_config (
            sample_year INTEGER PRIMARY KEY,
            target_size INTEGER NOT NULL,
            parser_version TEXT NOT NULL
        );
        CREATE TABLE parser_validation_samples (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL,
            parser_version TEXT NOT NULL,
            extraction_status TEXT NOT NULL,
            qa_pass INTEGER NOT NULL
        );
        INSERT INTO parser_validation_config
            VALUES (2024, 2, 'parser/2');
        INSERT INTO parser_validation_results VALUES
            ('https://example.com/pass-1', 2024, 'parser/2', 'complete', 1),
            ('https://example.com/pass-2', 2024, 'parser/2', 'complete', 1),
            ('https://example.com/replacement', 2024, 'parser/2', 'partial', 0);
        """
    )
    connection.commit()
    connection.close()

    result = MODULE.action_state(
        state,
        maximum_record_attempts=3,
        stop_at_validation_target=True,
    )

    assert result["validationTargetReached"] is True
    assert result["validationReady"] is True
    assert result["shouldContinue"] is False


def test_unbound_capture_input_never_counts_as_ready_or_target(
    tmp_path: Path,
):
    state = tmp_path / "capture.sqlite3"
    connection = sqlite3.connect(state)
    connection.executescript(
        """
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            raw_path TEXT
        );
        CREATE TABLE parser_validation_config (
            sample_year INTEGER PRIMARY KEY,
            target_size INTEGER NOT NULL,
            parser_version TEXT NOT NULL,
            qa_revision INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_samples (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL,
            parser_version TEXT NOT NULL,
            qa_revision INTEGER NOT NULL,
            extraction_status TEXT NOT NULL,
            qa_pass INTEGER NOT NULL,
            source_capture_sha256 TEXT
        );
        INSERT INTO captures VALUES
            ('https://example.com/pending', 'pending', 0, NULL);
        INSERT INTO parser_validation_config VALUES
            (2024, 2, 'parser/2', 1);
        INSERT INTO parser_validation_results VALUES
            ('https://example.com/complete-1', 2024, 'parser/2', 1,
             'complete', 1, 'bound-sha'),
            ('https://example.com/complete-2', 2024, 'parser/2', 1,
             'complete', 1, NULL);
        """
    )
    connection.commit()
    connection.close()

    result = MODULE.action_state(
        state,
        maximum_record_attempts=3,
        stop_at_validation_target=True,
    )

    assert result["validationReady"] is False
    assert result["validationTargetReached"] is False
    assert result["shouldContinue"] is False


def test_validation_does_not_continue_for_unselected_global_pending_rows(
    tmp_path: Path,
):
    state = tmp_path / "capture.sqlite3"
    connection = sqlite3.connect(state)
    connection.executescript(
        """
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            raw_path TEXT
        );
        CREATE TABLE parser_validation_config (
            sample_year INTEGER PRIMARY KEY,
            target_size INTEGER NOT NULL,
            parser_version TEXT NOT NULL,
            qa_revision INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_samples (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL,
            parser_version TEXT NOT NULL,
            qa_revision INTEGER NOT NULL,
            extraction_status TEXT NOT NULL,
            qa_pass INTEGER NOT NULL,
            source_capture_sha256 TEXT
        );
        INSERT INTO captures VALUES
            ('https://example.com/terminal', 'error', 3, NULL),
            ('https://example.com/unselected', 'pending', 0, NULL);
        INSERT INTO parser_validation_config VALUES
            (2024, 800, 'parser/2', 1);
        INSERT INTO parser_validation_samples VALUES
            ('https://example.com/terminal', 2024);
        """
    )
    connection.commit()
    connection.close()

    result = MODULE.action_state(
        state,
        maximum_record_attempts=3,
        stop_at_validation_target=True,
    )

    assert result["capturesByStatus"]["pending"] == 1
    assert result["actionable"] == 0
    assert result["shouldContinue"] is False


def test_screened_nonarticle_does_not_dilute_article_qa_rate(tmp_path: Path):
    state = tmp_path / "capture.sqlite3"
    connection = sqlite3.connect(state)
    connection.executescript(
        """
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            raw_path TEXT
        );
        CREATE TABLE parser_validation_config (
            sample_year INTEGER PRIMARY KEY,
            target_size INTEGER NOT NULL,
            parser_version TEXT NOT NULL,
            qa_revision INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_samples (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL,
            parser_version TEXT NOT NULL,
            qa_revision INTEGER NOT NULL,
            extraction_status TEXT NOT NULL,
            qa_pass INTEGER NOT NULL,
            issues_json TEXT NOT NULL,
            source_capture_sha256 TEXT
        );
        INSERT INTO parser_validation_config VALUES
            (2010, 1, 'caixin-parser/0.1.8', 1);
        INSERT INTO parser_validation_results VALUES
            ('https://www.caixin.com/2010-01-01/article.html', 2010,
             'caixin-parser/0.1.8', 1, 'complete', 1, '[]', 'article-sha'),
            ('https://photos.caixin.com/2010-01-01/gallery.html', 2010,
             'caixin-parser/0.1.8', 1, 'complete', 0,
             '["nonarticle-desk"]', 'gallery-sha');
        """
    )
    connection.commit()
    connection.close()

    result = MODULE.action_state(
        state,
        maximum_record_attempts=3,
        stop_at_validation_target=True,
    )

    assert result["validationReady"] is True
    assert result["validationTargetReached"] is True


def test_wrong_year_candidate_does_not_dilute_article_qa_rate(
    tmp_path: Path,
):
    state = tmp_path / "capture.sqlite3"
    connection = sqlite3.connect(state)
    connection.executescript(
        """
        CREATE TABLE captures (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            raw_path TEXT
        );
        CREATE TABLE parser_validation_config (
            sample_year INTEGER PRIMARY KEY,
            target_size INTEGER NOT NULL,
            parser_version TEXT NOT NULL,
            qa_revision INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_samples (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_results (
            canonical_url TEXT PRIMARY KEY,
            sample_year INTEGER NOT NULL,
            parser_version TEXT NOT NULL,
            qa_revision INTEGER NOT NULL,
            extraction_status TEXT NOT NULL,
            qa_pass INTEGER NOT NULL,
            issues_json TEXT NOT NULL,
            source_capture_sha256 TEXT
        );
        INSERT INTO parser_validation_config VALUES
            (2017, 1, 'nyt-parser/0.8.155', 9);
        INSERT INTO parser_validation_results VALUES
            ('https://www.nytimes.com/2017/01/01/valid.html', 2017,
             'nyt-parser/0.8.155', 9, 'complete', 1, '[]', 'valid-sha'),
            ('https://www.nytimes.com/2017/12/31/wrong-year.html', 2017,
             'nyt-parser/0.8.155', 9, 'complete', 0,
             '["publication-year-mismatch"]', 'wrong-year-sha');
        """
    )
    connection.commit()
    connection.close()

    result = MODULE.action_state(
        state,
        maximum_record_attempts=3,
        stop_at_validation_target=True,
    )

    assert result["validationReady"] is True
    assert result["validationTargetReached"] is True
