from __future__ import annotations

import json
from pathlib import Path

import pytest

from jojo_news_archive.parser_validation_watchdog import (
    plan_validation_dispatch,
)
from jojo_news_archive.parser_validation import qa_policy_revision
from jojo_news_archive.parser_qa_policy import CONTENT_AUDIT_FORMAT_VERSION
from jojo_news_archive.publisher_specs import publisher_spec


def _write_summary(
    root: Path,
    relative_path: str,
    *,
    publisher: str,
    year: int,
    evaluated: int,
    complete_rate: float = 1.0,
    qa_rate: float = 1.0,
    errors: int = 0,
    unbound_capture_inputs: int = 0,
    qa_revision: int | None = None,
    parser_version: str | None = None,
    eligible_candidates: int | None = None,
    excluded_candidates: int | None = None,
    screened_nonarticles: int = 0,
    nonarticle_candidates: int | None = None,
    capture_rows: int | None = None,
    captures_by_status: dict[str, int] | None = None,
    qa_passed: int | None = None,
) -> None:
    path = root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    effective_parser_version = (
        parser_version or publisher_spec(publisher).parser_version
    )
    payload = {
                "parserValidation": {
                    "years": {
                        str(year): {
                            "target": 800,
                            "parserVersion": (
                                effective_parser_version
                            ),
                            "evaluated": evaluated,
                            "completeRate": complete_rate,
                            "qaPassRate": qa_rate,
                            "qaPassed": (
                                qa_passed
                                if qa_passed is not None
                                else round(evaluated * qa_rate)
                            ),
                            "errors": errors,
                            "unboundCaptureInputs": (
                                unbound_capture_inputs
                            ),
                            "screenedNonArticles": screened_nonarticles,
                            "qaRevision": (
                                qa_revision
                                if qa_revision is not None
                                else qa_policy_revision(publisher)
                            ),
                        }
                    }
                }
            }
    if captures_by_status is not None:
        payload["capturesByStatus"] = captures_by_status
    if eligible_candidates is not None:
        payload["parserValidation"]["years"][str(year)][
            "eligibleCandidates"
        ] = eligible_candidates
    if excluded_candidates is not None:
        payload["parserValidation"]["years"][str(year)][
            "excludedCandidates"
        ] = excluded_candidates
    if nonarticle_candidates is not None:
        payload["parserValidation"]["years"][str(year)][
            "nonArticleCandidates"
        ] = nonarticle_candidates
    if capture_rows is not None:
        payload["parserValidation"]["years"][str(year)][
            "captureRows"
        ] = capture_rows
    path.write_text(
        json.dumps(payload),
        encoding="utf-8",
    )
    if (
        evaluated >= 800
        and complete_rate >= 0.95
        and (
            qa_rate == 1.0
            or (qa_passed is not None and qa_passed >= 800)
        )
        and errors == 0
        and unbound_capture_inputs == 0
    ):
        content_audit_path = path.with_name("content-audit.json")
        content_audit_path.write_text(
            json.dumps(
                {
                    "formatVersion": (
                        CONTENT_AUDIT_FORMAT_VERSION
                    ),
                    "publisher": publisher,
                    "year": year,
                    "target": 800,
                    "audited": 800,
                    "extractionStatuses": {"complete": 800},
                    "formalTargetReached": True,
                    "configuredParserVersion": effective_parser_version,
                    "parserVersion": effective_parser_version,
                    "qaRevision": (
                        qa_revision
                        if qa_revision is not None
                        else qa_policy_revision(publisher)
                    ),
                    "hardAnomalyCount": 0,
                    "passesContentChecks": True,
                    "passesHardChecks": True,
                }
            ),
            encoding="utf-8",
        )
    if (
        relative_path.startswith("holdout-v")
        and evaluated >= 800
        and complete_rate >= 0.95
        and (
            qa_rate == 1.0
            or (qa_passed is not None and qa_passed >= 800)
        )
        and errors == 0
        and unbound_capture_inputs == 0
    ):
        audit_path = path.with_name("rotation-audit.json")
        audit_path.write_text(
            json.dumps(
                {
                    "formatVersion": (
                        "jojo-parser-validation-holdout-audit/1"
                    ),
                    "publisher": publisher,
                    "expectedParserVersion": effective_parser_version,
                    "targetPerYear": 800,
                    "requireComplete": True,
                    "passed": True,
                    "issues": [],
                    "years": {
                        str(year): {
                            "previousUniqueEvaluated": 800,
                            "currentEvaluated": evaluated,
                            "priorCohortOverlap": 0,
                            "exclusionOverlap": 0,
                            "missingPriorExclusions": 0,
                            "wrongExclusionCohortLabels": 0,
                        }
                    },
                }
            ),
            encoding="utf-8",
        )


def test_watchdog_accepts_ready_full_or_accelerator_summary(
    tmp_path: Path,
):
    _write_summary(
        tmp_path,
        "ap/2016-2026/sitemap-wayback/state/summary.json",
        publisher="ap",
        year=2016,
        evaluated=800,
    )
    _write_summary(
        tmp_path,
        "validation/bloomberg/2017/state/summary.json",
        publisher="bloomberg",
        year=2017,
        evaluated=800,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=66,
    )
    cells = {
        (task["publisher"], task["year"])
        for task in plan["tasks"]
    }

    assert plan["targetCells"] == 204
    assert ("axios", 2016) not in {
        (row["publisher"], row["year"])
        for row in plan["cellProgress"]
    }
    assert ("axios", 2017) in {
        (row["publisher"], row["year"])
        for row in plan["cellProgress"]
    }
    assert ("zaobao", 2015) not in {
        (row["publisher"], row["year"])
        for row in plan["cellProgress"]
    }
    assert ("zaobao", 2016) in {
        (row["publisher"], row["year"])
        for row in plan["cellProgress"]
    }
    assert plan["readyCells"] == 2
    assert ("ap", 2016) not in cells
    assert ("bloomberg", 2017) not in cells
    ap_2016 = next(
        row
        for row in plan["cellProgress"]
        if row["publisher"] == "ap" and row["year"] == 2016
    )
    assert ap_2016 == {
        "publisher": "ap",
        "year": 2016,
        "target": 800,
        "evaluated": 800,
        "replayableEvaluated": 800,
        "eligibleCandidates": None,
        "eligibleCandidateUpperBound": None,
        "completeRate": 1.0,
        "qaPassRate": 1.0,
        "errors": 0,
        "unboundCaptureInputs": 0,
        "screenedNonArticles": 0,
        "qaRevision": 1,
        "parserVersion": "ap-parser/0.6.27",
        "requiredCohort": None,
        "selectedCohort": "source",
        "ready": True,
            "active": False,
            "capacityDeficient": False,
            "captureStateExhausted": False,
            "contentAuditFailed": False,
        }


def test_watchdog_ignores_failed_reserve_tail_after_target_audit(
    tmp_path: Path,
):
    # The formal sample contains 800 QA-passing rows, but two reserve rows
    # were also evaluated and failed. The completed target/content audit is
    # authoritative for convergence; the reserve tail must not cause a
    # duplicate holdout dispatch.
    _write_summary(
        tmp_path,
        "holdout-v1/nyt/2014/state/summary.json",
        publisher="nyt",
        year=2014,
        evaluated=802,
        complete_rate=799 / 802,
        qa_rate=800 / 802,
        qa_passed=800,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["nyt"],
        available_source_shards={"nyt/2010-2015/sitemap-wayback"},
    )

    cell = next(
        row
        for row in plan["cellProgress"]
        if row["publisher"] == "nyt" and row["year"] == 2014
    )
    assert plan["readyCells"] == 1
    assert cell["ready"] is True
    assert not any(
        task["publisher"] == "nyt" and task["year"] == 2014
        for task in plan["tasks"]
    )


def test_watchdog_ignores_old_parser_and_active_cell(tmp_path: Path):
    _write_summary(
        tmp_path,
        "ft/2016-2026/sitemap-wayback/state/summary.json",
        publisher="ft",
        year=2018,
        evaluated=500,
        parser_version="ft-parser/0.7.0",
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[
            "parser-validation-ft-2018",
            "unrelated workflow title",
        ],
        max_dispatch=66,
    )
    cells = {
        (task["publisher"], task["year"])
        for task in plan["tasks"]
    }

    assert plan["readyCells"] == 0
    assert plan["activeCells"] == 0
    assert plan["activeCurrentRunCount"] == 0
    assert plan["activeSupersededRunCount"] == 1
    assert ("ft", 2018) in cells
    ft_2018 = next(
        row
        for row in plan["cellProgress"]
        if row["publisher"] == "ft" and row["year"] == 2018
    )
    assert ft_2018["evaluated"] == 0
    assert ft_2018["replayableEvaluated"] == 500
    assert ft_2018["parserVersion"] is None
    assert ft_2018["active"] is False


def test_watchdog_does_not_let_superseded_holdout_block_new_parser(
    tmp_path: Path,
):
    _write_summary(
        tmp_path,
        "holdout-v214/ft/2012/state/summary.json",
        publisher="ft",
        year=2012,
        evaluated=554,
        parser_version="ft-parser/0.8.51",
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=["parser-holdout-v214-ft-2012"],
        max_dispatch=1,
        publishers=["ft"],
    )

    assert plan["activeCells"] == 0
    assert plan["activeCurrentRunCount"] == 0
    assert plan["activeSupersededRunCount"] == 1
    assert plan["activeSupersededTitles"] == [
        "parser-holdout-v214-ft-2012"
    ]
    assert plan["tasks"] == [
        {
            "publisher": "ft",
            "year": 2012,
            "sourceManifestShard": "ft/2010-2015/sitemap-wayback",
            "runnerOs": "ubuntu-latest",
            "currentEvaluated": 0,
            "replayableEvaluated": 554,
                "parserVersion": "ft-parser/0.8.69",
            "cohort": "holdout-v215",
        }
    ]


def test_watchdog_accepts_ready_holdout_and_tracks_active_holdout(
    tmp_path: Path,
):
    _write_summary(
        tmp_path,
        "holdout-v3/nyt/2018/state/summary.json",
        publisher="nyt",
        year=2018,
        evaluated=800,
    )
    _write_summary(
        tmp_path,
        "smoke-v1/nyt/2019/state/summary.json",
        publisher="nyt",
        year=2019,
        evaluated=800,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=["parser-holdout-v4-nyt-2020"],
        max_dispatch=66,
        publishers=["nyt"],
    )
    tasks = {
        (task["publisher"], task["year"])
        for task in plan["tasks"]
    }

    assert plan["readyCells"] == 1
    assert plan["activeCells"] == 1
    assert ("nyt", 2018) not in tasks
    assert ("nyt", 2019) in tasks
    assert ("nyt", 2020) not in tasks


def test_watchdog_rejects_ready_stale_parser_or_qa_revision(
    tmp_path: Path,
):
    _write_summary(
        tmp_path,
        "validation/wsj/2020/state/summary.json",
        publisher="wsj",
        year=2020,
        evaluated=800,
        parser_version="wsj-parser/0.8.44",
    )
    _write_summary(
        tmp_path,
        "validation/wsj/2021/state/summary.json",
        publisher="wsj",
        year=2021,
        evaluated=800,
        qa_revision=0,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=66,
        available_source_shards={"wsj/2016-2026/wayback"},
    )
    tasks = {
        (task["publisher"], task["year"])
        for task in plan["tasks"]
    }

    assert plan["readyCells"] == 0
    assert ("wsj", 2020) in tasks
    assert ("wsj", 2021) in tasks
    for year in (2020, 2021):
        row = next(
            item
            for item in plan["cellProgress"]
            if item["publisher"] == "wsj" and item["year"] == year
        )
        assert row["evaluated"] == 0
        assert row["replayableEvaluated"] == 800
        assert row["ready"] is False


def test_watchdog_rotates_stale_nyt_parser_to_next_holdout(
    tmp_path: Path,
):
    _write_summary(
        tmp_path,
        "validation/nyt/2018/state/summary.json",
        publisher="nyt",
        year=2018,
        evaluated=800,
        parser_version="nyt-parser/0.8.52",
    )
    _write_summary(
        tmp_path,
        "holdout-v3/nyt/2018/state/summary.json",
        publisher="nyt",
        year=2018,
        evaluated=800,
        parser_version="nyt-parser/0.8.54",
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["nyt"],
        available_source_shards={"nyt/2016-2026/sitemap-wayback"},
    )

    assert plan["tasks"][0]["cohort"] == "holdout-v4"
    cell = next(
        row
        for row in plan["cellProgress"]
        if row["publisher"] == "nyt" and row["year"] == 2018
    )
    assert cell["requiredCohort"] == "holdout-v4"
    assert cell["evaluated"] == 0


def test_watchdog_accepts_current_holdout_after_stale_cohorts(
    tmp_path: Path,
):
    _write_summary(
        tmp_path,
        "holdout-v2/axios/2017/state/summary.json",
        publisher="axios",
        year=2017,
        evaluated=327,
        parser_version="axios-parser/0.1.6",
    )
    _write_summary(
        tmp_path,
        "holdout-v3/axios/2017/state/summary.json",
        publisher="axios",
        year=2017,
        evaluated=800,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["axios"],
        available_source_shards={"axios/2017-2026/wayback-urlkey"},
    )

    assert plan["readyCells"] == 1
    cell = next(
        row
        for row in plan["cellProgress"]
        if row["publisher"] == "axios" and row["year"] == 2017
    )
    assert cell["requiredCohort"] == "holdout-v3"
    assert cell["selectedCohort"] == "holdout-v3"
    assert cell["ready"] is True


def test_watchdog_keeps_formally_ready_holdout_when_newer_one_is_partial(
    tmp_path: Path,
):
    _write_summary(
        tmp_path,
        "validation/nyt/2021/state/summary.json",
        publisher="nyt",
        year=2021,
        evaluated=800,
        parser_version="nyt-parser/0.8.82",
    )
    _write_summary(
        tmp_path,
        "holdout-v206/nyt/2021/state/summary.json",
        publisher="nyt",
        year=2021,
        evaluated=800,
    )
    _write_summary(
        tmp_path,
        "holdout-v207/nyt/2021/state/summary.json",
        publisher="nyt",
        year=2021,
        evaluated=155,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["nyt"],
        available_source_shards={"nyt/2016-2026/sitemap-wayback"},
    )

    assert plan["readyCells"] == 1
    assert all(task["year"] != 2021 for task in plan["tasks"])
    cell = next(
        row
        for row in plan["cellProgress"]
        if row["publisher"] == "nyt" and row["year"] == 2021
    )
    assert cell["requiredCohort"] == "holdout-v206"
    assert cell["selectedCohort"] == "holdout-v206"
    assert cell["ready"] is True


def test_watchdog_requires_passing_content_audit_and_quarantines_failure(
    tmp_path: Path,
):
    relative = "validation/axios/2022/state/summary.json"
    _write_summary(
        tmp_path,
        relative,
        publisher="axios",
        year=2022,
        evaluated=800,
    )
    audit_path = (tmp_path / relative).with_name("content-audit.json")
    audit_path.unlink()

    missing = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["axios"],
        available_source_shards={"axios/2017-2026/wayback-urlkey"},
    )
    assert missing["readyCells"] == 0
    assert missing["contentAuditFailedCells"] == 0
    assert missing["tasks"][0]["year"] == 2022
    missing_cell = next(
        row
        for row in missing["cellProgress"]
        if row["publisher"] == "axios" and row["year"] == 2022
    )
    assert missing_cell["contentAuditFailed"] is False

    _write_summary(
        tmp_path,
        relative,
        publisher="axios",
        year=2022,
        evaluated=800,
    )
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    audit["hardAnomalyCount"] = 1
    audit["passesContentChecks"] = False
    audit["passesHardChecks"] = False
    audit_path.write_text(json.dumps(audit), encoding="utf-8")

    failed = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=10,
        publishers=["axios"],
        available_source_shards={"axios/2017-2026/wayback-urlkey"},
    )
    assert failed["readyCells"] == 0
    assert failed["contentAuditFailedCells"] == 1
    assert all(task["year"] != 2022 for task in failed["tasks"])
    failed_cell = next(
        row
        for row in failed["cellProgress"]
        if row["publisher"] == "axios" and row["year"] == 2022
    )
    assert failed_cell["contentAuditFailed"] is True

    _write_summary(
        tmp_path,
        relative,
        publisher="axios",
        year=2022,
        evaluated=800,
    )
    passed = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["axios"],
        available_source_shards={"axios/2017-2026/wayback-urlkey"},
    )
    assert passed["readyCells"] == 1
    assert passed["contentAuditFailedCells"] == 0


def test_watchdog_rejects_partial_rows_inside_formal_content_sample(
    tmp_path: Path,
):
    relative = "validation/aljazeera/2013/state/summary.json"
    _write_summary(
        tmp_path,
        relative,
        publisher="aljazeera",
        year=2013,
        evaluated=800,
    )
    audit_path = (tmp_path / relative).with_name("content-audit.json")
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    audit["extractionStatuses"] = {"complete": 793, "partial": 7}
    audit_path.write_text(json.dumps(audit), encoding="utf-8")

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["aljazeera"],
        available_source_shards={
            "aljazeera/2010-2015/sitemap-wayback"
        },
    )

    assert plan["readyCells"] == 0
    assert plan["tasks"][0]["year"] == 2013


def test_watchdog_accepts_qa_passing_unsupported_nontext_rows(
    tmp_path: Path,
):
    relative = "validation/scmp/2021/state/summary.json"
    _write_summary(
        tmp_path,
        relative,
        publisher="scmp",
        year=2021,
        evaluated=800,
    )
    audit_path = (tmp_path / relative).with_name("content-audit.json")
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    audit["extractionStatuses"] = {"complete": 798, "unsupported": 2}
    audit_path.write_text(json.dumps(audit), encoding="utf-8")

    unvalidated = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["scmp"],
        available_source_shards={"scmp/2016-2026/wayback-urlkey"},
    )
    assert unvalidated["readyCells"] == 0

    audit["validatedUnsupportedNonText"] = 2
    audit_path.write_text(json.dumps(audit), encoding="utf-8")
    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["scmp"],
        available_source_shards={"scmp/2016-2026/wayback-urlkey"},
    )

    assert plan["readyCells"] == 1
    assert all(task["year"] != 2021 for task in plan["tasks"])


def test_watchdog_rejects_content_audit_bound_to_wrong_parser(tmp_path: Path):
    relative = "validation/caixin/2011/state/summary.json"
    _write_summary(
        tmp_path,
        relative,
        publisher="caixin",
        year=2011,
        evaluated=800,
    )
    audit_path = (tmp_path / relative).with_name("content-audit.json")
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    audit["parserVersion"] = "caixin-parser/stale"
    audit_path.write_text(json.dumps(audit), encoding="utf-8")

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["caixin"],
        available_source_shards={"caixin/2010-2015/wayback-urlkey"},
    )

    assert plan["readyCells"] == 0
    assert plan["contentAuditFailedCells"] == 0
    assert plan["tasks"][0]["year"] == 2011


def test_watchdog_rejects_superseded_content_audit_format(tmp_path: Path):
    relative = "holdout-v1/wsj/2015/state/summary.json"
    _write_summary(
        tmp_path,
        relative,
        publisher="wsj",
        year=2015,
        evaluated=800,
    )
    audit_path = (tmp_path / relative).with_name("content-audit.json")
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    audit["formatVersion"] = "jojo-parser-validation-content-audit/1"
    audit_path.write_text(json.dumps(audit), encoding="utf-8")

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["wsj"],
        available_source_shards={"wsj/2010-2015/wayback-urlkey"},
    )

    assert plan["readyCells"] == 0
    assert plan["contentAuditFailedCells"] == 0
    assert plan["tasks"][0]["year"] == 2015
    assert plan["tasks"][0]["cohort"] == "holdout-v1"


def test_watchdog_rotates_ready_holdout_with_missing_or_failed_audit(
    tmp_path: Path,
):
    relative = "holdout-v1/nyt/2019/state/summary.json"
    _write_summary(
        tmp_path,
        relative,
        publisher="nyt",
        year=2019,
        evaluated=800,
    )
    (tmp_path / relative).with_name("rotation-audit.json").unlink()

    active_missing = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=["parser-holdout-v1-nyt-2019"],
        max_dispatch=1,
        publishers=["nyt"],
        available_source_shards={"nyt/2016-2026/sitemap-wayback"},
    )
    assert active_missing["readyCells"] == 0
    assert active_missing["activeCells"] == 1
    assert active_missing["activeCurrentRunCount"] == 1
    assert active_missing["activeSupersededRunCount"] == 0
    assert not any(task["year"] == 2019 for task in active_missing["tasks"])

    missing = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["nyt"],
        available_source_shards={"nyt/2016-2026/sitemap-wayback"},
    )
    assert missing["readyCells"] == 0
    assert missing["tasks"][0]["cohort"] == "holdout-v2"

    _write_summary(
        tmp_path,
        relative,
        publisher="nyt",
        year=2019,
        evaluated=800,
    )
    audit_path = (tmp_path / relative).with_name("rotation-audit.json")
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    audit["passed"] = False
    audit["issues"] = ["2019:prior-cohort-overlap"]
    audit_path.write_text(json.dumps(audit), encoding="utf-8")

    failed = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=["parser-holdout-v1-nyt-2019"],
        max_dispatch=1,
        publishers=["nyt"],
        available_source_shards={"nyt/2016-2026/sitemap-wayback"},
    )
    assert failed["readyCells"] == 0
    assert failed["activeCells"] == 0
    assert failed["activeSupersededRunCount"] == 1
    assert failed["tasks"][0]["cohort"] == "holdout-v2"


def test_watchdog_requires_npr_holdout_for_unaudited_stale_source(
    tmp_path: Path,
):
    _write_summary(
        tmp_path,
        "npr/2010-2015/wayback-urlkey/state/summary.json",
        publisher="npr",
        year=2014,
        evaluated=800,
        parser_version="npr-parser/0.1.17",
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["npr"],
        available_source_shards={"npr/2010-2015/wayback-urlkey"},
    )

    assert plan["tasks"][0]["year"] == 2014
    assert plan["tasks"][0]["cohort"] == "holdout-v1"


def test_watchdog_retains_audited_rotated_validation_cell(
    tmp_path: Path,
):
    _write_summary(
        tmp_path,
        "ft/2016-2026/sitemap-wayback/state/summary.json",
        publisher="ft",
        year=2016,
        evaluated=524,
        parser_version="ft-parser/0.8.29",
    )
    _write_summary(
        tmp_path,
        "validation/ft/2016/state/summary.json",
        publisher="ft",
        year=2016,
        evaluated=800,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["ft"],
        available_source_shards={"ft/2016-2026/sitemap-wayback"},
    )

    cell = next(
        row
        for row in plan["cellProgress"]
        if row["publisher"] == "ft" and row["year"] == 2016
    )
    assert cell["requiredCohort"] is None
    assert cell["selectedCohort"] == "validation"
    assert cell["ready"] is True


def test_watchdog_only_plans_cells_with_readable_source_manifests(
    tmp_path: Path,
):
    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=66,
        available_source_shards={"axios/2017-2026/wayback-urlkey"},
    )

    assert plan["targetCells"] == 10
    assert {
        (task["publisher"], task["year"])
        for task in plan["tasks"]
    } == {("axios", year) for year in range(2017, 2027)}


def test_watchdog_filters_to_explicit_pending_publishers(tmp_path: Path):
    _write_summary(
        tmp_path,
        "validation/reuters/2024/state/summary.json",
        publisher="reuters",
        year=2024,
        evaluated=799,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=66,
        publishers=["wsj", "nyt"],
    )

    assert plan["publishers"] == ["wsj", "nyt"]
    assert plan["targetCells"] == 34
    assert {
        row["publisher"] for row in plan["cellProgress"]
    } == {"wsj", "nyt"}
    assert all(
        task["publisher"] in {"wsj", "nyt"}
        for task in plan["tasks"]
    )


def test_watchdog_rejects_unknown_explicit_publisher(tmp_path: Path):
    with pytest.raises(ValueError, match="unsupported watchdog publishers"):
        plan_validation_dispatch(
            state_root=tmp_path,
            active_titles=[],
            max_dispatch=1,
            publishers=["unknown-news"],
        )


def test_watchdog_prioritizes_nearly_complete_current_sample(
    tmp_path: Path,
):
    _write_summary(
        tmp_path,
        "validation/reuters/2023/state/summary.json",
        publisher="reuters",
        year=2023,
        evaluated=499,
        complete_rate=1.0,
        qa_rate=1.0,
    )
    _write_summary(
        tmp_path,
        "validation/bloomberg/2020/state/summary.json",
        publisher="bloomberg",
        year=2020,
        evaluated=300,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
    )

    assert plan["tasks"] == [
        {
            "publisher": "reuters",
            "year": 2023,
            "sourceManifestShard": (
                "reuters/2021-2026/reuters-sitemap-wayback"
            ),
            "runnerOs": "ubuntu-latest",
            "currentEvaluated": 499,
            "replayableEvaluated": 499,
            "parserVersion": "reuters-parser/0.7.32",
            "cohort": "validation",
        }
    ]


def test_watchdog_requires_disjoint_wsj_holdout_after_validation(
    tmp_path: Path,
):
    _write_summary(
        tmp_path,
        "validation/wsj/2022/state/summary.json",
        publisher="wsj",
        year=2022,
        evaluated=800,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["wsj"],
        available_source_shards={"wsj/2016-2026/wayback"},
    )

    assert plan["readyCells"] == 0
    assert plan["tasks"][0]["cohort"] == "holdout-v1"
    cell = next(
        row
        for row in plan["cellProgress"]
        if row["publisher"] == "wsj" and row["year"] == 2022
    )
    assert cell["requiredCohort"] == "holdout-v1"
    assert cell["selectedCohort"] == "holdout-v1"
    assert cell["evaluated"] == 0
    assert cell["replayableEvaluated"] == 800
    assert cell["ready"] is False

    _write_summary(
        tmp_path,
        "holdout-v1/wsj/2022/state/summary.json",
        publisher="wsj",
        year=2022,
        evaluated=800,
    )
    complete = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["wsj"],
        available_source_shards={"wsj/2016-2026/wayback"},
    )
    complete_cell = next(
        row
        for row in complete["cellProgress"]
        if row["publisher"] == "wsj" and row["year"] == 2022
    )
    assert complete_cell["evaluated"] == 800
    assert complete_cell["ready"] is True


def test_watchdog_requires_wsj_holdout_for_legacy_source_summary(
    tmp_path: Path,
):
    _write_summary(
        tmp_path,
        "wsj/2010-2015/wayback-urlkey/state/summary.json",
        publisher="wsj",
        year=2013,
        evaluated=835,
        qa_revision=0,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["wsj"],
        available_source_shards={"wsj/2010-2015/wayback-urlkey"},
    )

    assert plan["readyCells"] == 0
    assert plan["tasks"][0]["year"] == 2013
    assert plan["tasks"][0]["cohort"] == "holdout-v1"
    cell = next(
        row
        for row in plan["cellProgress"]
        if row["year"] == 2013
    )
    assert cell["requiredCohort"] == "holdout-v1"
    assert cell["evaluated"] == 0
    assert cell["replayableEvaluated"] == 835


def test_watchdog_does_not_redispatch_exhausted_independent_holdout(
    tmp_path: Path,
):
    shard = "wsj/2010-2015/wayback-urlkey"
    _write_summary(
        tmp_path,
        f"{shard}/state/summary.json",
        publisher="wsj",
        year=2013,
        evaluated=835,
        qa_revision=0,
    )
    _write_summary(
        tmp_path,
        "holdout-v1/wsj/2013/state/summary.json",
        publisher="wsj",
        year=2013,
        evaluated=265,
        eligible_candidates=381,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["wsj"],
        available_source_shards={shard},
        source_year_capacities={shard: {2013: 1225}},
    )

    assert plan["tasks"] == []
    assert plan["capacityDeficientCells"] == 1
    assert plan["targetCells"] == 1
    cell = plan["cellProgress"][0]
    assert cell["evaluated"] == 265
    assert cell["replayableEvaluated"] == 835
    assert cell["eligibleCandidates"] == 381
    assert cell["capacityDeficient"] is True


def test_watchdog_uses_stale_holdout_capacity_as_conservative_upper_bound(
    tmp_path: Path,
):
    shard = "wsj/2010-2015/wayback-urlkey"
    _write_summary(
        tmp_path,
        f"{shard}/state/summary.json",
        publisher="wsj",
        year=2013,
        evaluated=835,
        parser_version="wsj-parser/0.8.45",
    )
    _write_summary(
        tmp_path,
        "holdout-v1/wsj/2013/state/summary.json",
        publisher="wsj",
        year=2013,
        evaluated=265,
        parser_version="wsj-parser/0.8.45",
        eligible_candidates=381,
        excluded_candidates=844,
    )

    deficient = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["wsj"],
        available_source_shards={shard},
        source_year_capacities={shard: {2013: 1225}},
    )

    assert deficient["tasks"] == []
    cell = deficient["cellProgress"][0]
    assert cell["requiredCohort"] == "holdout-v2"
    assert cell["eligibleCandidates"] is None
    assert cell["eligibleCandidateUpperBound"] == 381
    assert cell["capacityDeficient"] is True

    expanded = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["wsj"],
        available_source_shards={shard},
        source_year_capacities={shard: {2013: 1644}},
    )

    assert expanded["tasks"][0]["cohort"] == "holdout-v2"
    expanded_cell = expanded["cellProgress"][0]
    assert expanded_cell["eligibleCandidateUpperBound"] == 800
    assert expanded_cell["capacityDeficient"] is False


def test_watchdog_does_not_count_loaded_alias_rows_as_source_growth(
    tmp_path: Path,
):
    shard = "npr/2010-2015/wayback-urlkey"
    _write_summary(
        tmp_path,
        "holdout-v202/npr/2010/state/summary.json",
        publisher="npr",
        year=2010,
        evaluated=6,
        eligible_candidates=10,
        excluded_candidates=19176,
        capture_rows=22520,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["npr"],
        available_source_shards={shard},
        source_year_capacities={shard: {2010: 21438}},
    )

    assert plan["tasks"] == []
    assert plan["capacityDeficientCells"] == 1
    cell = plan["cellProgress"][0]
    assert cell["eligibleCandidateUpperBound"] == 10
    assert cell["capacityDeficient"] is True


def test_watchdog_dispatches_fresh_parser_cohort_before_old_capacity_gate(
    tmp_path: Path,
):
    shard = "caixin/2010-2015/wayback-urlkey"
    _write_summary(
        tmp_path,
        "holdout-v216/caixin/2010/state/summary.json",
        publisher="caixin",
        year=2010,
        evaluated=75,
        parser_version="caixin-parser/0.1.14",
        eligible_candidates=574,
        excluded_candidates=5665,
        screened_nonarticles=499,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["caixin"],
        available_source_shards={shard},
        source_year_capacities={shard: {2010: 5996}},
    )

    assert plan["tasks"][0]["cohort"] == "holdout-v217"
    cell = plan["cellProgress"][0]
    assert cell["parserVersion"] is None
    assert cell["eligibleCandidateUpperBound"] == 75
    assert cell["capacityDeficient"] is False


def test_watchdog_treats_screened_nonarticles_as_exhausted_capacity(
    tmp_path: Path,
):
    shard = "scmp/2016-2026/wayback-urlkey"
    _write_summary(
        tmp_path,
        "holdout-v217/scmp/2016/state/summary.json",
        publisher="scmp",
        year=2016,
        evaluated=0,
        eligible_candidates=27,
        excluded_candidates=5841,
        screened_nonarticles=27,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["scmp"],
        available_source_shards={shard},
        source_year_capacities={shard: {2016: 5868}},
    )

    assert plan["tasks"] == []
    assert plan["capacityDeficientCells"] == 1
    cell = plan["cellProgress"][0]
    assert cell["eligibleCandidates"] == 27
    assert cell["screenedNonArticles"] == 27
    assert cell["eligibleCandidateUpperBound"] == 0
    assert cell["capacityDeficient"] is True


def test_watchdog_subtracts_unselected_nonarticle_source_tail(
    tmp_path: Path,
):
    shard = "caixin/2010-2015/wayback-urlkey"
    _write_summary(
        tmp_path,
        "holdout-v217/caixin/2010/state/summary.json",
        publisher="caixin",
        year=2010,
        evaluated=538,
        eligible_candidates=538,
        excluded_candidates=5094,
        nonarticle_candidates=954,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["caixin"],
        available_source_shards={shard},
        source_year_capacities={shard: {2010: 5996}},
    )

    assert plan["tasks"] == []
    assert plan["capacityDeficientCells"] == 1
    cell = plan["cellProgress"][0]
    assert cell["eligibleCandidateUpperBound"] == 538
    assert cell["capacityDeficient"] is True


def test_watchdog_marks_terminal_capture_errors_as_exhausted_capacity(
    tmp_path: Path,
):
    shard = "wsj/2016-2026/wayback"
    _write_summary(
        tmp_path,
        "holdout-v196/wsj/2021/state/summary.json",
        publisher="wsj",
        year=2021,
        evaluated=123,
        eligible_candidates=2290,
        excluded_candidates=3878,
        captures_by_status={
            "complete": 124,
            "error": 1219,
            "pending": 0,
            "downloading": 0,
        },
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["wsj"],
        available_source_shards={shard},
        source_year_capacities={shard: {2021: 6178}},
    )

    assert plan["tasks"] == []
    assert plan["capacityDeficientCells"] == 1
    cell = next(
        row
        for row in plan["cellProgress"]
        if row["year"] == 2021
    )
    assert cell["captureStateExhausted"] is True
    assert cell["capacityDeficient"] is True


def test_watchdog_keeps_inflight_capture_errors_schedulable(
    tmp_path: Path,
):
    shard = "wsj/2016-2026/wayback"
    _write_summary(
        tmp_path,
        "holdout-v196/wsj/2021/state/summary.json",
        publisher="wsj",
        year=2021,
        evaluated=123,
        eligible_candidates=2290,
        excluded_candidates=3878,
        captures_by_status={
            "complete": 124,
            "error": 1219,
            "pending": 10,
            "downloading": 2,
        },
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["wsj"],
        available_source_shards={shard},
        source_year_capacities={shard: {2021: 6178}},
    )

    assert plan["tasks"][0]["year"] == 2021
    cell = next(
        row
        for row in plan["cellProgress"]
        if row["year"] == 2021
    )
    assert cell["captureStateExhausted"] is False
    assert cell["capacityDeficient"] is False


def test_watchdog_reopens_screened_tail_after_source_growth(
    tmp_path: Path,
):
    shard = "scmp/2016-2026/wayback-urlkey"
    _write_summary(
        tmp_path,
        "holdout-v217/scmp/2016/state/summary.json",
        publisher="scmp",
        year=2016,
        evaluated=0,
        eligible_candidates=27,
        excluded_candidates=5841,
        screened_nonarticles=27,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["scmp"],
        available_source_shards={shard},
        source_year_capacities={shard: {2016: 7000}},
    )

    assert plan["tasks"][0]["year"] == 2016
    cell = plan["cellProgress"][0]
    assert cell["eligibleCandidateUpperBound"] == 1132
    assert cell["capacityDeficient"] is False


def test_watchdog_reopens_scmp_after_official_sitemap_growth(
    tmp_path: Path,
):
    primary = "scmp/2016-2026/wayback-urlkey"
    official = "scmp/2016-2026/sitemap-wayback"
    _write_summary(
        tmp_path,
        "holdout-v217/scmp/2021/state/summary.json",
        publisher="scmp",
        year=2021,
        evaluated=0,
        eligible_candidates=9,
        excluded_candidates=976,
        screened_nonarticles=9,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["scmp"],
        available_source_shards={primary},
        source_year_capacities={
            primary: {2021: 2693},
            official: {2021: 38_000},
        },
    )

    assert plan["tasks"][0]["year"] == 2021
    cell = next(
        row
        for row in plan["cellProgress"]
        if row["year"] == 2021
    )
    assert cell["eligibleCandidateUpperBound"] == 37_015
    assert cell["capacityDeficient"] is False


def test_watchdog_excludes_years_below_manifest_capacity(tmp_path: Path):
    shard = "caixin/2010-2015/wayback-urlkey"
    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=10,
        publishers=["caixin"],
        available_source_shards={shard},
        source_year_capacities={
            shard: {
                2010: 1069,
                2011: 1268,
                2012: 1238,
                2013: 1103,
                2014: 2837,
                2015: 1,
            }
        },
    )

    assert plan["targetCells"] == 5
    assert {
        (row["publisher"], row["year"])
        for row in plan["cellProgress"]
    } == {
        ("caixin", 2010),
        ("caixin", 2011),
        ("caixin", 2012),
        ("caixin", 2013),
        ("caixin", 2014),
    }


def test_watchdog_admits_year_with_sufficient_supplemental_capacity(
    tmp_path: Path,
):
    primary = "caixin/2016-2026/wayback-urlkey"
    supplemental = "caixin/2018-2018/commoncrawl-prefix"

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=10,
        publishers=["caixin"],
        available_source_shards={primary},
        source_year_capacities={
            primary: {2018: 258},
            supplemental: {2018: 1501},
        },
    )

    assert plan["targetCells"] == 1
    assert plan["tasks"][0]["year"] == 2018


def test_watchdog_admits_npr_year_from_official_archive_capacity(
    tmp_path: Path,
):
    primary = "npr/2010-2015/wayback-urlkey"
    official = "npr/2014-2014/official-archive"

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=10,
        publishers=["npr"],
        available_source_shards={primary},
        source_year_capacities={
            primary: {2014: 574},
            official: {2014: 10_452},
        },
    )

    assert plan["targetCells"] == 1
    assert plan["tasks"][0]["year"] == 2014
    cell = plan["cellProgress"][0]
    assert cell["capacityDeficient"] is False


def test_watchdog_reopens_stale_npr_cohort_for_new_official_capacity(
    tmp_path: Path,
):
    primary = "npr/2010-2015/wayback-urlkey"
    official = "npr/2014-2014/official-archive"
    _write_summary(
        tmp_path,
        "holdout-v313/npr/2014/state/summary.json",
        publisher="npr",
        year=2014,
        evaluated=805,
        parser_version="npr-parser/0.1.58",
        eligible_candidates=574,
        excluded_candidates=20_000,
        capture_rows=20_574,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["npr"],
        available_source_shards={primary},
        source_year_capacities={
            official: {2014: 10_452},
        },
    )

    assert plan["tasks"][0]["publisher"] == "npr"
    assert plan["tasks"][0]["year"] == 2014
    cell = plan["cellProgress"][0]
    assert cell["parserVersion"] is None
    assert cell["capacityDeficient"] is False


def test_watchdog_reopens_incomplete_ap_cell_after_supplemental_growth(
    tmp_path: Path,
):
    primary = "ap/2010-2015/sitemap-wayback"
    supplemental = "ap/2010-2015/legacy-archive"
    _write_summary(
        tmp_path,
        "holdout-v207/ap/2011/state/summary.json",
        publisher="ap",
        year=2011,
        evaluated=0,
        eligible_candidates=1,
        excluded_candidates=1317,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
        publishers=["ap"],
        available_source_shards={primary},
        source_year_capacities={
            primary: {2011: 1318},
            supplemental: {2011: 134075},
        },
    )

    assert plan["tasks"][0]["year"] == 2011
    cell = plan["cellProgress"][0]
    assert cell["eligibleCandidates"] == 1
    assert cell["eligibleCandidateUpperBound"] >= 800
    assert cell["capacityDeficient"] is False


def test_watchdog_does_not_sum_subthreshold_sources_to_admit_year(
    tmp_path: Path,
):
    primary = "caixin/2016-2026/wayback-urlkey"
    supplemental = "caixin/2018-2018/commoncrawl-prefix"

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=10,
        publishers=["caixin"],
        available_source_shards={primary},
        source_year_capacities={
            primary: {2018: 500},
            supplemental: {2018: 500},
        },
    )

    assert plan["targetCells"] == 0
    assert plan["tasks"] == []


def test_watchdog_prioritizes_stale_corpus_for_parser_replay(
    tmp_path: Path,
):
    _write_summary(
        tmp_path,
        "bloomberg/2016-2026/sitemap-wayback/state/summary.json",
        publisher="bloomberg",
        year=2016,
        evaluated=519,
        parser_version="bloomberg-parser/0.8.0",
    )
    _write_summary(
        tmp_path,
        "validation/reuters/2024/state/summary.json",
        publisher="reuters",
        year=2024,
        evaluated=41,
    )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=1,
    )

    assert plan["tasks"][0]["publisher"] == "bloomberg"
    assert plan["tasks"][0]["year"] == 2016
    assert plan["tasks"][0]["currentEvaluated"] == 0
    assert plan["tasks"][0]["replayableEvaluated"] == 519
    assert plan["tasks"][0]["cohort"] == "holdout-v1"


def test_watchdog_requires_all_quality_gates(tmp_path: Path):
    for year, complete_rate, qa_rate, errors, unbound in (
        (2021, 0.9499, 1.0, 0, 0),
        (2022, 1.0, 0.9999, 0, 0),
        (2023, 1.0, 1.0, 1, 0),
        (2024, 1.0, 1.0, 0, 1),
    ):
        _write_summary(
            tmp_path,
            f"validation/wsj/{year}/state/summary.json",
            publisher="wsj",
            year=year,
            evaluated=800,
            complete_rate=complete_rate,
            qa_rate=qa_rate,
            errors=errors,
            unbound_capture_inputs=unbound,
        )

    plan = plan_validation_dispatch(
        state_root=tmp_path,
        active_titles=[],
        max_dispatch=66,
    )
    cells = {
        (task["publisher"], task["year"])
        for task in plan["tasks"]
    }

    assert ("wsj", 2021) in cells
    assert ("wsj", 2022) in cells
    assert ("wsj", 2023) in cells
    assert ("wsj", 2024) in cells
