from concurrent.futures import Future
from pathlib import Path
import sqlite3

from tools.capture_archive_batch import (
    _cancel_not_started_validation_futures,
    _historical_attempts_from_leased_row,
    _initial_capture_window,
    _record_validation_if_selected,
)


def test_non_validation_capture_does_not_query_validation_tables(
    tmp_path: Path,
):
    connection = sqlite3.connect(":memory:")

    result = _record_validation_if_selected(
        connection,
        validation_plan=None,
        capture=object(),
        canonical_url="https://www.nikkei.com/article/DGXLASFS15H2P",
        validation_target_reached=False,
        archive_root=tmp_path,
    )

    assert result is None


def test_validation_stop_cancels_only_futures_that_have_not_started():
    queued = Future()
    running = Future()
    assert running.set_running_or_notify_cancel()
    in_flight = {queued: object(), running: object()}

    cancelled = _cancel_not_started_validation_futures(in_flight)

    assert cancelled == 1
    assert queued.cancelled()
    assert queued not in in_flight
    assert running in in_flight
    running.set_result(None)


def test_non_validation_capture_keeps_two_worker_batches_prefetched():
    assert _initial_capture_window(workers=32, validation_summary=None) == 64


def test_validation_capture_window_shrinks_near_target():
    summary = {
        "years": {
            "2013": {"target": 800, "qaPassed": 798},
        }
    }

    assert _initial_capture_window(
        workers=32,
        validation_summary=summary,
    ) == 8


def test_validation_capture_window_uses_full_pool_for_large_remainder():
    summary = {
        "years": {
            "2012": {"target": 800, "qaPassed": 790},
            "2013": {"target": 800, "qaPassed": 795},
        }
    }

    assert _initial_capture_window(
        workers=32,
        validation_summary=summary,
    ) == 32


def test_fallback_staging_excludes_the_current_capture_lease():
    assert _historical_attempts_from_leased_row(0) == 0
    assert _historical_attempts_from_leased_row(1) == 0
    assert _historical_attempts_from_leased_row(2) == 1
