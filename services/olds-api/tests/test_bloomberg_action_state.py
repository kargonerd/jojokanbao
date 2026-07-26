from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sqlite3


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "tools" / "bloomberg_action_state.py"
)
SPEC = spec_from_file_location("bloomberg_action_state", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def create_state(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE articles(status TEXT NOT NULL, attempts INTEGER NOT NULL)"
    )
    connection.executemany(
        "INSERT INTO articles(status, attempts) VALUES (?, ?)",
        [
            ("complete", 1),
            ("pending", 8),
            ("error", 2),
            ("partial", 3),
        ],
    )
    connection.commit()
    connection.close()


def test_missing_state_starts_a_new_batch(tmp_path: Path):
    result = MODULE.action_state(
        tmp_path / "missing.sqlite3",
        maximum_record_attempts=3,
    )

    assert result["shouldContinue"] is True
    assert result["retryErrors"] is False


def test_pending_work_stays_ahead_of_recovery(tmp_path: Path):
    state_path = tmp_path / "archive.sqlite3"
    create_state(state_path)

    result = MODULE.action_state(
        state_path,
        maximum_record_attempts=3,
    )

    assert result["retryErrors"] is False
    assert result["actionable"] == 2
    assert result["terminalUnresolved"] == 1


def test_recovery_starts_only_after_pending_is_empty(tmp_path: Path):
    state_path = tmp_path / "archive.sqlite3"
    create_state(state_path)
    connection = sqlite3.connect(state_path)
    connection.execute("DELETE FROM articles WHERE status='pending'")
    connection.commit()
    connection.close()

    result = MODULE.action_state(
        state_path,
        maximum_record_attempts=3,
    )

    assert result["retryErrors"] is True
    assert result["shouldContinue"] is True
