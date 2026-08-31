from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Iterable, Mapping

from jojo_news_archive.sources.registry import (
    publisher_spec,
    registered_sources,
    source_module,
)
from jojo_news_archive.parsing.policy import CONTENT_AUDIT_FORMAT_VERSION, qa_policy_revision
from jojo_news_archive.parsing.shards import (
    parser_source_manifest_shard,
    parser_supplemental_manifest_shards,
)


FORMAT_VERSION = "jojo-parser-validation-watchdog/1"
TARGET_YEARS = tuple(range(2010, 2027))
MINIMUM_SAMPLES = 800
MINIMUM_COMPLETE_RATE = 0.95
# A single QA finding requires a parser fix and a fresh holdout. Keep the
# scheduler aligned with parser_validation.py rather than treating a merely
# high pass rate as convergence.
MINIMUM_QA_PASS_RATE = 1.0
SUPPORTED_PUBLISHER_ORDER = tuple(
    source.id
    for source in sorted(
        registered_sources(),
        key=lambda source: (source.validation_priority, source.id),
    )
)
PUBLISHER_ORDER = tuple(
    source.id
    for source in sorted(
        registered_sources(enabled_only=True),
        key=lambda source: (source.validation_priority, source.id),
    )
)
ACTIVE_TITLE_RE = re.compile(
    r"^parser-(?P<cohort>qa|validation|holdout-v[1-9][0-9]*)-"
    r"(?P<publisher>"
    + "|".join(map(re.escape, SUPPORTED_PUBLISHER_ORDER))
    + r")-"
    r"(?P<year>20\d{2})$"
)


def _source_year_is_available(
    publisher: str,
    year: int,
    *,
    available_source_shards: set[str] | None,
    source_year_capacities: Mapping[str, Mapping[int, int]] | None,
) -> bool:
    try:
        source_shard = parser_source_manifest_shard(publisher, year)
    except ValueError:
        return False
    if (
        available_source_shards is not None
        and source_shard not in available_source_shards
    ):
        return False
    if source_year_capacities is None:
        return True
    known_counts = _known_source_capacities(
        publisher=publisher,
        year=year,
        source_shard=source_shard,
        source_year_capacities=source_year_capacities,
    )
    if not known_counts:
        # Capacity sidecars are rolling out shard by shard. Preserve the
        # existing availability behavior until a manifest-bound summary is
        # present, then use it as an authoritative impossibility filter.
        return True
    # A single independently deduplicated source with 800 URLs is sufficient
    # evidence of capacity. Summing sources here could count overlapping URLs
    # twice and incorrectly admit an impossible cell.
    return max(known_counts) >= MINIMUM_SAMPLES


def _known_source_capacities(
    *,
    publisher: str,
    year: int,
    source_shard: str,
    source_year_capacities: Mapping[str, Mapping[int, int]],
) -> list[int]:
    capacities: list[int] = []
    for shard in (
        source_shard,
        *parser_supplemental_manifest_shards(publisher, year),
    ):
        year_counts = source_year_capacities.get(shard)
        if year_counts is not None:
            # Once a manifest-bound sidecar exists, an omitted year is an
            # authoritative zero rather than unknown rolling-migration state.
            capacities.append(int(year_counts.get(year, 0)))
    return capacities


def plan_validation_dispatch(
    *,
    state_root: Path,
    active_titles: Iterable[str],
    max_dispatch: int,
    available_source_shards: Iterable[str] | None = None,
    source_year_capacities: Mapping[str, Mapping[int, int]] | None = None,
    publishers: Iterable[str] | None = None,
) -> dict[str, object]:
    if max_dispatch < 0:
        raise ValueError("max_dispatch must be non-negative")
    requested_publishers = (
        set(PUBLISHER_ORDER)
        if publishers is None
        else {publisher.strip() for publisher in publishers if publisher.strip()}
    )
    unsupported_publishers = requested_publishers - set(
        SUPPORTED_PUBLISHER_ORDER
    )
    if unsupported_publishers:
        raise ValueError(
            "unsupported watchdog publishers: "
            + ", ".join(sorted(unsupported_publishers))
        )
    publisher_order = tuple(
        publisher
        for publisher in SUPPORTED_PUBLISHER_ORDER
        if publisher in requested_publishers
    )
    available_shards = (
        None
        if available_source_shards is None
        else {
            shard.strip()
            for shard in available_source_shards
            if shard.strip()
        }
    )
    versions = {
        publisher: publisher_spec(publisher).parser_version
        for publisher in publisher_order
    }
    qa_revisions = {
        publisher: qa_policy_revision(publisher)
        for publisher in publisher_order
    }
    progress = {
        (publisher, year): {
            "ready": False,
            "evaluated": 0,
            "replayableEvaluated": 0,
            "eligibleCandidates": None,
            "eligibleCandidateUpperBound": None,
            "target": MINIMUM_SAMPLES,
            "completeRate": 0.0,
            "qaPassRate": 0.0,
            "errors": 0,
            "unboundCaptureInputs": 0,
            "screenedNonArticles": 0,
            "qaRevision": None,
            "parserVersion": None,
            "captureStateExhausted": False,
            "summaryPaths": [],
            "cohortRows": {},
            "observedRows": [],
        }
        for publisher in publisher_order
        for year in TARGET_YEARS
        if _source_year_is_available(
            publisher,
            year,
            available_source_shards=available_shards,
            source_year_capacities=source_year_capacities,
        )
    }
    summaries_read = 0
    invalid_summaries: list[str] = []
    invalid_rotation_audits: list[str] = []
    invalid_content_audits: list[str] = []
    for summary_path in sorted(state_root.rglob("summary.json")):
        publisher = _publisher_from_summary_path(
            summary_path,
            state_root=state_root,
        )
        if publisher not in versions:
            continue
        try:
            payload = json.loads(summary_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            invalid_summaries.append(
                summary_path.relative_to(state_root).as_posix()
            )
            continue
        summaries_read += 1
        rotation_audit: dict[str, object] | None = None
        rotation_audit_path = summary_path.with_name("rotation-audit.json")
        if rotation_audit_path.exists():
            try:
                candidate_audit = json.loads(
                    rotation_audit_path.read_text(encoding="utf-8")
                )
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                invalid_rotation_audits.append(
                    rotation_audit_path.relative_to(state_root).as_posix()
                )
            else:
                if isinstance(candidate_audit, dict):
                    rotation_audit = candidate_audit
                else:
                    invalid_rotation_audits.append(
                        rotation_audit_path.relative_to(state_root).as_posix()
                    )
        content_audit: dict[str, object] | None = None
        content_audit_path = summary_path.with_name("content-audit.json")
        if content_audit_path.exists():
            try:
                candidate_audit = json.loads(
                    content_audit_path.read_text(encoding="utf-8")
                )
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                invalid_content_audits.append(
                    content_audit_path.relative_to(state_root).as_posix()
                )
            else:
                if isinstance(candidate_audit, dict):
                    content_audit = candidate_audit
                else:
                    invalid_content_audits.append(
                        content_audit_path.relative_to(state_root).as_posix()
                    )
        cohort = _cohort_from_summary_path(
            summary_path,
            state_root=state_root,
        )
        validation = payload.get("parserValidation")
        if not isinstance(validation, dict):
            continue
        capture_status = payload.get("capturesByStatus")
        if not isinstance(capture_status, dict):
            capture_status = None
        years = validation.get("years")
        if not isinstance(years, dict):
            continue
        for year in TARGET_YEARS:
            cell_key = (publisher, year)
            if cell_key not in progress:
                continue
            row = years.get(str(year))
            if not isinstance(row, dict):
                continue
            evidence_row = {
                **row,
                "_rotationAudit": rotation_audit,
                "_contentAudit": content_audit,
                "_capturesByStatus": capture_status,
            }
            cell = progress[cell_key]
            cell["replayableEvaluated"] = max(
                int(cell["replayableEvaluated"]),
                _integer(row.get("evaluated")),
            )
            paths = cell["summaryPaths"]
            if isinstance(paths, list):
                paths.append(summary_path.relative_to(state_root).as_posix())
            if (
                _integer(row.get("evaluated")) > 0
                or (
                    "eligibleCandidates" in row
                    and "excludedCandidates" in row
                )
            ):
                observed = cell["observedRows"]
                assert isinstance(observed, list)
                observed.append({"cohort": cohort, "row": evidence_row})
            if (
                row.get("parserVersion") != versions[publisher]
                or _integer(row.get("qaRevision"))
                != qa_revisions[publisher]
            ):
                continue
            evaluated = _integer(row.get("evaluated"))
            cohort_rows = cell["cohortRows"]
            assert isinstance(cohort_rows, dict)
            previous = cohort_rows.get(cohort)
            if not isinstance(previous, dict) or evaluated >= _integer(
                previous.get("evaluated")
            ):
                cohort_rows[cohort] = evidence_row

    for (publisher, year), cell in progress.items():
        cohort_rows = cell["cohortRows"]
        assert isinstance(cohort_rows, dict)
        observed_rows = cell["observedRows"]
        assert isinstance(observed_rows, list)
        required_cohort = _required_holdout_cohort(
            publisher=publisher,
            year=year,
            observed_rows=observed_rows,
            current_rows=cohort_rows,
            parser_version=versions[publisher],
            qa_revision=qa_revisions[publisher],
        )
        selected_cohort = required_cohort
        if selected_cohort is None and cohort_rows:
            selected_cohort = _select_current_cohort(
                cohort_rows,
                publisher=publisher,
                year=year,
            )
        selected = cohort_rows.get(selected_cohort, {})
        if isinstance(selected, dict) and selected:
            cell["evaluated"] = _integer(selected.get("evaluated"))
            cell["target"] = max(
                MINIMUM_SAMPLES,
                _integer(selected.get("target")),
            )
            cell["completeRate"] = float(
                selected.get("completeRate") or 0
            )
            cell["qaPassRate"] = float(selected.get("qaPassRate") or 0)
            cell["errors"] = _integer(selected.get("errors"))
            cell["unboundCaptureInputs"] = _integer(
                selected.get("unboundCaptureInputs")
            )
            cell["qaRevision"] = _integer(selected.get("qaRevision"))
            cell["parserVersion"] = selected.get("parserVersion")
            if "eligibleCandidates" in selected:
                cell["eligibleCandidates"] = _integer(
                    selected.get("eligibleCandidates")
                )
            cell["screenedNonArticles"] = _integer(
                selected.get("screenedNonArticles")
            )
            cell["captureStateExhausted"] = _capture_state_exhausted(
                selected
            )
            cell["ready"] = _year_ready(
                selected,
                cohort=selected_cohort,
                publisher=publisher,
                year=year,
            )
        cell["eligibleCandidateUpperBound"] = (
            _eligible_candidate_upper_bound(
                publisher=publisher,
                year=year,
                observed_rows=observed_rows,
                source_year_capacities=source_year_capacities,
            )
        )
        cell["requiredCohort"] = required_cohort
        cell["selectedCohort"] = selected_cohort

    active_cells: set[tuple[str, int]] = set()
    active_current_titles: list[str] = []
    active_superseded_titles: list[str] = []
    for title in active_titles:
        match = ACTIVE_TITLE_RE.match(title.strip())
        if match is None:
            continue
        publisher = match.group("publisher")
        year = match.group("year")
        parsed_year = int(year)
        cell_key = (publisher, parsed_year)
        if cell_key not in progress:
            continue
        cell = progress[cell_key]
        title_cohort = match.group("cohort")
        # `qa` is a legacy spelling for the baseline validation cohort.  A
        # numbered holdout is compared against the exact required/current
        # cohort below, so an old holdout cannot block a fresh parser run.
        if title_cohort == "qa":
            title_cohort = "validation"
        required_cohort = cell.get("requiredCohort")
        selected_cohort = cell.get("selectedCohort")
        if isinstance(required_cohort, str) and required_cohort:
            expected_cohort = required_cohort
            is_current = title_cohort == expected_cohort
        elif isinstance(selected_cohort, str) and selected_cohort:
            expected_cohort = (
                selected_cohort
                if re.fullmatch(r"holdout-v[1-9][0-9]*", selected_cohort)
                else "validation"
            )
            is_current = title_cohort == expected_cohort
        else:
            # No checkpoint exists yet for this cell.  Do not speculate that
            # an active holdout is stale; it may be the first task creating
            # the required checkpoint, and dispatching a duplicate would
            # violate the per-cell single-writer guarantee.
            is_current = True
        if not is_current and _active_cohort_is_finalizing(
            cell,
            cohort=title_cohort,
            publisher=publisher,
            year=parsed_year,
            parser_version=versions[publisher],
            qa_revision=qa_revisions[publisher],
        ):
            # The accelerator writes its ready summary before generating and
            # uploading the two formal audit sidecars.  During that short
            # window ``_required_holdout_cohort`` correctly predicts the next
            # cohort, but the still-running writer must retain ownership of
            # the cell.  Otherwise a watchdog can launch a needless zero-
            # overlap cohort seconds before the passing audits arrive.
            is_current = True
        if is_current:
            active_cells.add(cell_key)
            active_current_titles.append(title.strip())
        else:
            active_superseded_titles.append(title.strip())

    ready_cells = {
        cell for cell, values in progress.items() if values["ready"]
    }
    content_audit_failed_cells = {
        cell
        for cell, values in progress.items()
        if _selected_content_audit_failed(
            values,
            publisher=cell[0],
            year=cell[1],
        )
    }
    capacity_deficient_cells = {
        cell
        for cell, values in progress.items()
        if (
            bool(values["captureStateExhausted"])
            or (
                # A parser/QA revision change is itself the reason to create
                # a fresh zero-overlap cohort.  Do not let the previous
                # cohort's screened/non-retryable tail block that first run;
                # the source-manifest availability gate above still prevents
                # dispatch when the raw source has fewer than 800 rows.
                not (
                    values.get("parserVersion") is None
                    and values.get("qaRevision") is None
                    and (
                        source_module(cell[0]).allow_initial_capacity_reset
                        or _supplemental_capacity_unlocks_cell(
                            publisher=cell[0],
                            year=cell[1],
                            source_year_capacities=(
                                source_year_capacities
                            ),
                        )
                    )
                )
                and
                _effective_candidate_capacity(values) is not None
                and int(_effective_candidate_capacity(values))
                < int(values["target"])
                and int(values["evaluated"]) < int(values["target"])
            )
        )
    }
    candidates = [
        cell
        for cell in progress
        if cell not in ready_cells
        and cell not in active_cells
        and cell not in capacity_deficient_cells
        and cell not in content_audit_failed_cells
    ]
    order = {
        publisher: index
        for index, publisher in enumerate(publisher_order)
    }
    candidates.sort(
        key=lambda cell: (
            -int(progress[cell]["replayableEvaluated"]),
            -int(progress[cell]["evaluated"]),
            order[cell[0]],
            cell[1],
        )
    )
    tasks = [
        _task(
            publisher=publisher,
            year=year,
            evaluated=int(progress[(publisher, year)]["evaluated"]),
            replayable_evaluated=int(
                progress[(publisher, year)]["replayableEvaluated"]
            ),
            parser_version=versions[publisher],
            cohort=_dispatch_cohort(progress[(publisher, year)]),
        )
        for publisher, year in candidates[:max_dispatch]
    ]
    cell_progress = [
        {
            "publisher": publisher,
            "year": year,
            "target": int(progress[(publisher, year)]["target"]),
            "evaluated": int(progress[(publisher, year)]["evaluated"]),
            "replayableEvaluated": int(
                progress[(publisher, year)]["replayableEvaluated"]
            ),
            "eligibleCandidates": progress[(publisher, year)][
                "eligibleCandidates"
            ],
            "eligibleCandidateUpperBound": progress[(publisher, year)][
                "eligibleCandidateUpperBound"
            ],
            "completeRate": float(
                progress[(publisher, year)]["completeRate"]
            ),
            "qaPassRate": float(progress[(publisher, year)]["qaPassRate"]),
            "errors": int(progress[(publisher, year)]["errors"]),
            "unboundCaptureInputs": int(
                progress[(publisher, year)]["unboundCaptureInputs"]
            ),
            "screenedNonArticles": int(
                progress[(publisher, year)]["screenedNonArticles"]
            ),
            "qaRevision": progress[(publisher, year)]["qaRevision"],
            "parserVersion": progress[(publisher, year)]["parserVersion"],
            "requiredCohort": progress[(publisher, year)]["requiredCohort"],
            "selectedCohort": progress[(publisher, year)]["selectedCohort"],
            "ready": (publisher, year) in ready_cells,
            "active": (publisher, year) in active_cells,
            "capacityDeficient": (
                (publisher, year) in capacity_deficient_cells
            ),
            "captureStateExhausted": bool(
                progress[(publisher, year)]["captureStateExhausted"]
            ),
            "contentAuditFailed": (
                (publisher, year) in content_audit_failed_cells
            ),
        }
        for publisher in publisher_order
        for year in TARGET_YEARS
        if (publisher, year) in progress
    ]
    return {
        "formatVersion": FORMAT_VERSION,
        "publishers": list(publisher_order),
        "targetCells": len(progress),
        "readyCells": len(ready_cells),
        "activeCells": len(active_cells),
        "activeCurrentRunCount": len(active_current_titles),
        "activeSupersededRunCount": len(active_superseded_titles),
        "activeCurrentTitles": active_current_titles,
        "activeSupersededTitles": active_superseded_titles,
        "capacityDeficientCells": len(capacity_deficient_cells),
        "contentAuditFailedCells": len(content_audit_failed_cells),
        "pendingCells": len(progress) - len(ready_cells),
        "summariesRead": summaries_read,
        "invalidSummaries": invalid_summaries,
        "invalidRotationAudits": invalid_rotation_audits,
        "invalidContentAudits": invalid_content_audits,
        "currentParserVersions": versions,
        "currentQaRevisions": qa_revisions,
        "cellProgress": cell_progress,
        "tasks": tasks,
    }


def _effective_candidate_capacity(
    cell: Mapping[str, object],
) -> int | None:
    exact = cell.get("eligibleCandidates")
    upper_bound = cell.get("eligibleCandidateUpperBound")
    if exact is not None:
        # Non-article screens are consumed from the current cohort's eligible
        # pool but can never satisfy the article sample target.  Treat them as
        # exhausted capacity so a tail of infographics/interactive desks does
        # not trigger another nominal 800-sample run.
        exact_value = max(
            0,
            int(exact)
            - min(
                int(exact),
                max(0, _integer(cell.get("screenedNonArticles"))),
            ),
        )
        if upper_bound is not None:
            target = max(
                MINIMUM_SAMPLES,
                _integer(cell.get("target")),
            )
            if exact_value < target:
                return max(exact_value, int(upper_bound))
        return exact_value
    return None if upper_bound is None else int(upper_bound)


def _supplemental_capacity_unlocks_cell(
    *,
    publisher: str,
    year: int,
    source_year_capacities: Mapping[str, Mapping[int, int]] | None,
) -> bool:
    """Return whether a supplement newly makes a stale cell feasible.

    A stale cohort's aggregate capture-row count cannot prove that it merged
    a later independent catalog.  Reopen one current-parser cohort when the
    canonical source is below 800 but a configured supplement independently
    clears the gate.  Once that current cohort exists, the normal conservative
    exhaustion calculation applies again and prevents repeated dispatches.
    """
    if source_year_capacities is None:
        return False
    try:
        primary = parser_source_manifest_shard(publisher, year)
    except ValueError:
        return False
    primary_counts = source_year_capacities.get(primary)
    if (
        primary_counts is not None
        and int(primary_counts.get(year, 0)) >= MINIMUM_SAMPLES
    ):
        return False
    return any(
        int(source_year_capacities.get(shard, {}).get(year, 0))
        >= MINIMUM_SAMPLES
        for shard in parser_supplemental_manifest_shards(publisher, year)
    )


def _active_cohort_is_finalizing(
    cell: Mapping[str, object],
    *,
    cohort: str,
    publisher: str,
    year: int,
    parser_version: str,
    qa_revision: int,
) -> bool:
    cohort_rows = cell.get("cohortRows")
    if not isinstance(cohort_rows, dict):
        return False
    row = cohort_rows.get(cohort)
    if (
        not isinstance(row, dict)
        or row.get("parserVersion") != parser_version
        or _integer(row.get("qaRevision")) != qa_revision
        or not _quality_gates_ready(row)
    ):
        return False
    if row.get("_contentAudit") is None:
        return True
    return bool(
        cohort.startswith("holdout-v") and row.get("_rotationAudit") is None
    )


def _capture_state_exhausted(row: Mapping[str, object]) -> bool:
    """Return whether a capture checkpoint is terminally short of samples.

    Candidate counts alone can overstate usable capacity when every remaining
    URL has already failed at its available archive sources.  Only treat that
    as exhausted after the checkpoint reports no pending/in-flight captures,
    at least one transport error, no parser errors, and fewer than the target
    number of evaluated articles.  A missing status block remains unknown and
    therefore schedulable.
    """
    status = row.get("_capturesByStatus")
    if not isinstance(status, dict):
        return False
    if "pending" not in status or "error" not in status:
        return False
    target = max(MINIMUM_SAMPLES, _integer(row.get("target")))
    return bool(
        _integer(status.get("pending")) == 0
        and _integer(status.get("downloading")) == 0
        and _integer(status.get("error")) > 0
        and _integer(row.get("errors")) == 0
        and _integer(row.get("evaluated")) < target
    )


def _eligible_candidate_upper_bound(
    *,
    publisher: str,
    year: int,
    observed_rows: list[object],
    source_year_capacities: Mapping[str, Mapping[int, int]] | None,
) -> int | None:
    if source_year_capacities is None:
        return None
    try:
        source_shard = parser_source_manifest_shard(publisher, year)
    except ValueError:
        return None
    known_counts = _known_source_capacities(
        publisher=publisher,
        year=year,
        source_shard=source_shard,
        source_year_capacities=source_year_capacities,
    )
    if not known_counts:
        return None
    # This value is deliberately conservative. Supplemental manifests are
    # often alternate crawls of the same URLs (for example Wayback plus
    # Common Crawl), so summing their row counts can keep an exhausted cohort
    # looking schedulable. Until a merged/deduplicated capacity sidecar is
    # available, use the largest independently deduplicated source and let a
    # later catalog growth reopen the cell.
    current_manifest_capacity = max(known_counts)
    evidence: list[tuple[int, int, int]] = []
    for item in observed_rows:
        if not isinstance(item, dict):
            continue
        cohort = item.get("cohort")
        row = item.get("row")
        if not isinstance(cohort, str) or not isinstance(row, dict):
            continue
        if (
            "eligibleCandidates" not in row
            or "excludedCandidates" not in row
        ):
            continue
        eligible = _integer(row.get("eligibleCandidates"))
        excluded = _integer(row.get("excludedCandidates"))
        # The source sidecar counts every URL, including deterministic
        # photo/video/utility desks that the parser-validation planner cannot
        # sample.  Include the current checkpoint's screened URL count when
        # measuring how much unseen source capacity remains; otherwise a
        # finite non-article tail can keep a year above the 800 gate forever.
        nonarticle_candidates = max(
            0,
            _integer(row.get("nonArticleCandidates")),
        )
        observed_capacity = eligible + excluded + nonarticle_candidates
        # A validation checkpoint loads every row from the filtered source
        # manifest before sampling.  Once its raw row count reaches the
        # largest known source-sidecar count, any remaining difference is
        # normalized URL aliasing rather than unseen article capacity.  Do
        # not keep dispatching replacement cohorts for those aliases; a
        # later catalog growth (a larger sidecar than this checkpoint) still
        # reopens the cell normally.
        loaded_capture_rows = _integer(row.get("captureRows"))
        if loaded_capture_rows >= current_manifest_capacity:
            growth = 0
        else:
            growth = max(0, current_manifest_capacity - observed_capacity)
        cohort_number = _cohort_number(cohort)
        screened_nonarticles = max(
            0,
            min(
                eligible,
                _integer(row.get("screenedNonArticles")),
            ),
        )
        evidence.append(
            (
                cohort_number if cohort_number is not None else 0,
                _integer(row.get("evaluated")),
                max(0, eligible - screened_nonarticles) + growth,
            )
        )
    if not evidence:
        return None
    # The newest cohort has the broadest exclusion union. Within the same
    # cohort, prefer its most advanced checkpoint.
    return max(evidence, key=lambda item: (item[0], item[1]))[2]


def _publisher_from_summary_path(
    summary_path: Path,
    *,
    state_root: Path,
) -> str | None:
    try:
        parts = summary_path.relative_to(state_root).parts
    except ValueError:
        return None
    if not parts:
        return None
    if parts[0] == "validation" or re.fullmatch(
        r"holdout-v[1-9][0-9]*", parts[0]
    ):
        return parts[1] if len(parts) > 1 else None
    return parts[0]


def _cohort_from_summary_path(
    summary_path: Path,
    *,
    state_root: Path,
) -> str:
    parts = summary_path.relative_to(state_root).parts
    if parts and (
        parts[0] == "validation"
        or re.fullmatch(r"holdout-v[1-9][0-9]*", parts[0])
    ):
        return parts[0]
    return "source"


def _quality_gates_ready(row: dict[str, object]) -> bool:
    evaluated = _integer(row.get("evaluated"))
    target = max(MINIMUM_SAMPLES, _integer(row.get("target")))
    qa_pass_rate = float(row.get("qaPassRate") or 0)
    qa_gate = qa_pass_rate >= MINIMUM_QA_PASS_RATE
    if not qa_gate and _integer(row.get("qaPassed")) >= target:
        # A validation checkpoint may evaluate a few reserve rows after the
        # formal target has already been reached.  Those extra rows are not
        # part of the independent 800-row sample; if the persisted formal
        # content audit proves the target sample, a failing reserve tail must
        # not make the completed cohort look unfinished and trigger another
        # download cycle.
        audit = row.get("_contentAudit")
        qa_gate = bool(
            isinstance(audit, dict)
            and audit.get("formalTargetReached") is True
            and _integer(audit.get("audited")) >= target
            and audit.get("passesContentChecks") is True
            and audit.get("passesHardChecks") is True
        )
    return bool(
        evaluated >= target
        and float(row.get("completeRate") or 0) >= MINIMUM_COMPLETE_RATE
        and qa_gate
        and _integer(row.get("errors")) == 0
        and _integer(row.get("unboundCaptureInputs")) == 0
    )


def _year_ready(
    row: dict[str, object],
    *,
    cohort: str | None,
    publisher: str,
    year: int,
) -> bool:
    if not _quality_gates_ready(row):
        return False
    if not _content_audit_passes(
        row,
        publisher=publisher,
        year=year,
    ):
        return False
    if not isinstance(cohort, str) or not cohort.startswith("holdout-v"):
        return True
    return _holdout_audit_passes(
        row,
        publisher=publisher,
        year=year,
    )


def _content_audit_passes(
    row: dict[str, object],
    *,
    publisher: str,
    year: int,
) -> bool:
    audit = row.get("_contentAudit")
    target = max(MINIMUM_SAMPLES, _integer(row.get("target")))
    if not isinstance(audit, dict):
        return False
    audited = _integer(audit.get("audited"))
    extraction_statuses = audit.get("extractionStatuses")
    allowed_statuses = {"complete", "unsupported"}
    unsupported = (
        _integer(extraction_statuses.get("unsupported"))
        if isinstance(extraction_statuses, dict)
        else 0
    )
    extraction_statuses_are_final = bool(
        isinstance(extraction_statuses, dict)
        and all(
            str(status) in allowed_statuses or _integer(count) == 0
            for status, count in extraction_statuses.items()
        )
        and (
            _integer(extraction_statuses.get("complete"))
            + _integer(extraction_statuses.get("unsupported"))
            == audited
        )
    )
    return bool(
        audit.get("formatVersion")
        == CONTENT_AUDIT_FORMAT_VERSION
        and audit.get("publisher") == publisher
        and _integer(audit.get("year")) == year
        and _integer(audit.get("target")) == target
        and audited >= target
        # A QA-passing video, gallery, audio package, or interactive can be
        # intentionally unsupported as text.  The content audit separately
        # makes any non-complete text article a hard anomaly, so accept only
        # final complete/unsupported states here while continuing to reject
        # every partial, error, or unknown extraction status.
        and extraction_statuses_are_final
        and (
            unsupported == 0
            or _integer(audit.get("validatedUnsupportedNonText"))
            == unsupported
        )
        and audit.get("formalTargetReached") is True
        and audit.get("configuredParserVersion") == row.get("parserVersion")
        and audit.get("parserVersion") == row.get("parserVersion")
        and _integer(audit.get("qaRevision"))
        == _integer(row.get("qaRevision"))
        and _integer(audit.get("hardAnomalyCount")) == 0
        and audit.get("passesContentChecks") is True
        and audit.get("passesHardChecks") is True
    )


def _selected_content_audit_failed(
    cell: Mapping[str, object],
    *,
    publisher: str,
    year: int,
) -> bool:
    selected_cohort = cell.get("selectedCohort")
    cohort_rows = cell.get("cohortRows")
    if not isinstance(selected_cohort, str) or not isinstance(cohort_rows, dict):
        return False
    row = cohort_rows.get(selected_cohort)
    if not isinstance(row, dict) or not _quality_gates_ready(row):
        return False
    audit = row.get("_contentAudit")
    return bool(
        isinstance(audit, dict)
        and audit.get("formatVersion")
        == CONTENT_AUDIT_FORMAT_VERSION
        and audit.get("publisher") == publisher
        and _integer(audit.get("year")) == year
        and _integer(audit.get("target"))
        == max(MINIMUM_SAMPLES, _integer(row.get("target")))
        and audit.get("configuredParserVersion") == row.get("parserVersion")
        and audit.get("parserVersion") == row.get("parserVersion")
        and _integer(audit.get("qaRevision"))
        == _integer(row.get("qaRevision"))
        and audit.get("passesHardChecks") is False
    )


def _holdout_audit_passes(
    row: dict[str, object],
    *,
    publisher: str,
    year: int,
) -> bool:
    audit = row.get("_rotationAudit")
    if not isinstance(audit, dict):
        return False
    years = audit.get("years")
    year_row = years.get(str(year)) if isinstance(years, dict) else None
    target = max(MINIMUM_SAMPLES, _integer(row.get("target")))
    return bool(
        audit.get("formatVersion")
        == "jojo-parser-validation-holdout-audit/1"
        and audit.get("passed") is True
        and audit.get("publisher") == publisher
        and audit.get("expectedParserVersion") == row.get("parserVersion")
        and audit.get("requireComplete") is True
        and _integer(audit.get("targetPerYear")) == target
        and isinstance(year_row, dict)
        and _integer(year_row.get("previousUniqueEvaluated")) > 0
        and _integer(year_row.get("currentEvaluated")) >= target
        and _integer(year_row.get("priorCohortOverlap")) == 0
        and _integer(year_row.get("exclusionOverlap")) == 0
        and _integer(year_row.get("missingPriorExclusions")) == 0
        and _integer(year_row.get("wrongExclusionCohortLabels")) == 0
    )


def _dispatch_cohort(cell: dict[str, object]) -> str:
    required = cell.get("requiredCohort")
    if isinstance(required, str) and required:
        return required
    selected = cell.get("selectedCohort")
    if isinstance(selected, str) and re.fullmatch(
        r"holdout-v[1-9][0-9]*", selected
    ):
        return selected
    return "validation"


def _required_holdout_cohort(
    *,
    publisher: str,
    year: int,
    observed_rows: list[object],
    current_rows: dict[str, object],
    parser_version: str,
    qa_revision: int,
) -> str | None:
    if (
        year in source_module(publisher).proven_rotated_validation_years
        and any(name in {"source", "validation"} for name in current_rows)
    ):
        return None
    stale_numbers: list[int] = []
    observed_numbers: list[int] = []
    observed_baseline = False
    for item in observed_rows:
        if not isinstance(item, dict):
            continue
        cohort = item.get("cohort")
        row = item.get("row")
        if not isinstance(cohort, str) or not isinstance(row, dict):
            continue
        number = _cohort_number(cohort)
        if number is None:
            continue
        observed_numbers.append(number)
        observed_baseline = observed_baseline or cohort in {
            "source",
            "validation",
        }
        if (
            row.get("parserVersion") != parser_version
            or _integer(row.get("qaRevision")) != qa_revision
        ):
            stale_numbers.append(number)
    current_holdouts = {
        number: cohort
        for cohort in current_rows
        if (number := _cohort_number(cohort)) is not None and number > 0
    }
    formally_ready_current_holdouts = {
        number: cohort
        for number, cohort in current_holdouts.items()
        if isinstance(current_rows.get(cohort), dict)
        and current_rows[cohort].get("parserVersion") == parser_version
        and _integer(current_rows[cohort].get("qaRevision")) == qa_revision
        and _year_ready(
            current_rows[cohort],
            cohort=cohort,
            publisher=publisher,
            year=year,
        )
    }
    if formally_ready_current_holdouts:
        # A watchdog that raced the audit upload may have left a newer partial
        # checkpoint before it was cancelled.  A fully audited, current-parser
        # cohort remains authoritative; do not let the higher cohort number or
        # an older stale baseline force that partial run to resume forever.
        return formally_ready_current_holdouts[
            max(formally_ready_current_holdouts)
        ]
    for number, cohort in current_holdouts.items():
        row = current_rows.get(cohort)
        if (
            isinstance(row, dict)
            and _quality_gates_ready(row)
            and not _holdout_audit_passes(
                row,
                publisher=publisher,
                year=year,
            )
        ):
            stale_numbers.append(number)
    if stale_numbers:
        newest_stale = max(stale_numbers)
        if current_holdouts and max(current_holdouts) > newest_stale:
            return current_holdouts[max(current_holdouts)]
        next_number = max(observed_numbers, default=0) + 1
        return f"holdout-v{max(1, next_number)}"
    if source_module(publisher).requires_independent_holdout and observed_baseline:
        if current_holdouts:
            return current_holdouts[max(current_holdouts)]
        return "holdout-v1"
    return None


def _select_current_cohort(
    current_rows: dict[str, object],
    *,
    publisher: str,
    year: int,
) -> str:
    holdouts = {
        number: cohort
        for cohort in current_rows
        if (number := _cohort_number(cohort)) is not None and number > 0
    }
    if holdouts:
        formally_ready_holdouts = {
            number: cohort
            for number, cohort in holdouts.items()
            if isinstance(current_rows.get(cohort), dict)
            and _year_ready(
                current_rows[cohort],
                cohort=cohort,
                publisher=publisher,
                year=year,
            )
        }
        if formally_ready_holdouts:
            # A cancelled or abandoned newer cohort can leave a partial
            # checkpoint behind.  Keep an older same-version cohort that has
            # already passed both formal audits authoritative until the newer
            # cohort actually reaches the gate.
            return formally_ready_holdouts[max(formally_ready_holdouts)]
        return holdouts[max(holdouts)]
    for cohort in ("validation", "source"):
        if cohort in current_rows:
            return cohort
    return max(
        current_rows,
        key=lambda name: _integer(
            current_rows[name].get("evaluated")
            if isinstance(current_rows[name], dict)
            else 0
        ),
    )


def _cohort_number(cohort: str) -> int | None:
    if cohort in {"source", "validation"}:
        return 0
    match = re.fullmatch(r"holdout-v([1-9][0-9]*)", cohort)
    return int(match.group(1)) if match is not None else None


def _integer(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _task(
    *,
    publisher: str,
    year: int,
    evaluated: int,
    replayable_evaluated: int,
    parser_version: str,
    cohort: str,
) -> dict[str, object]:
    return {
        "publisher": publisher,
        "year": year,
        "sourceManifestShard": parser_source_manifest_shard(
            publisher,
            year,
        ),
        # macOS 15 hosted runners currently do not ship the pinned 3.12.13
        # interpreter used by the archive workflow. Source-specific request
        # pacing is handled by its capture strategy on Ubuntu.
        "runnerOs": "ubuntu-latest",
        "currentEvaluated": evaluated,
        "replayableEvaluated": replayable_evaluated,
        "parserVersion": parser_version,
        "cohort": cohort,
    }
