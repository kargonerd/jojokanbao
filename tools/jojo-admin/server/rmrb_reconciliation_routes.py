"""Temporary human-review API for unresolved RMRB JSONL reconciliation rows."""

from __future__ import annotations

import hashlib
import json
import os
import threading
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Blueprint, jsonify, request


rmrb_reconciliation_blueprint = Blueprint("rmrb_reconciliation", __name__)

WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
SOURCE_FILE = Path(
    os.environ.get(
        "RMRB_RECONCILIATION_REVIEW_SOURCE",
        WORKSPACE_ROOT
        / "tmp"
        / "rmrb-peopledata-full-directory"
        / "classify-source-only-v8"
        / "review-nearby-conflicts.jsonl",
    )
)
REVIEW_ROOT = Path(
    os.environ.get(
        "RMRB_RECONCILIATION_REVIEW_ROOT",
        WORKSPACE_ROOT / "tmp" / "rmrb-reconciliation-review",
    )
)
DECISIONS_FILE = REVIEW_ROOT / "review-decisions.jsonl"
PEOPLE_DATA_BASE = (
    "https://webvpn.zju.edu.cn/https/"
    "77726476706e69737468656265737421f4f6559d69206d5f6e048ce29b5a2e7b74a4/rmrb"
)
DECISION_LOCK = threading.Lock()
ALLOWED_RESOLUTIONS = {
    "jsonl_correct",
    "merge_candidate",
    "manual_metadata",
    "defer",
}
SIGNAL_LABELS = {
    "suspected_title_typo": "疑似一字之差",
    "same_date_other_page": "同日其他版有同标题",
    "adjacent_date": "相邻日期有同标题",
    "adjacent_month_same_day": "相邻月份同日有同标题",
}


def _source_key(row: dict[str, Any]) -> tuple[str, int, int]:
    return (
        str(row.get("date") or "")[:10],
        int(row.get("page") or 0),
        int(row.get("preservedOrdinal", row.get("ordinal", -1))),
    )


def _key_name(key: tuple[str, int, int]) -> str:
    return f"{key[0]}|{key[1]}|{key[2]}"


def _fingerprint(row: dict[str, Any]) -> str:
    payload = {
        "date": _source_key(row)[0],
        "page": _source_key(row)[1],
        "ordinal": _source_key(row)[2],
        "title": str(row.get("title") or ""),
        "content": str(row.get("content") or ""),
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _load_source_rows() -> list[dict[str, Any]]:
    if not SOURCE_FILE.is_file():
        raise FileNotFoundError(f"审核源文件不存在：{SOURCE_FILE}")
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, int, int]] = set()
    with SOURCE_FILE.open(encoding="utf-8-sig") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            key = _source_key(row)
            if not key[0] or key[1] <= 0 or key[2] < 0:
                raise ValueError(f"审核源第 {line_number} 行缺少有效键")
            if key in seen:
                raise ValueError(f"审核源包含重复键：{_key_name(key)}")
            seen.add(key)
            rows.append(row)
    rows.sort(key=_source_key)
    return rows


def _load_decisions() -> dict[tuple[str, int, int], dict[str, Any]]:
    if not DECISIONS_FILE.is_file():
        return {}
    decisions: dict[tuple[str, int, int], dict[str, Any]] = {}
    with DECISIONS_FILE.open(encoding="utf-8-sig") as stream:
        for line in stream:
            if not line.strip():
                continue
            row = json.loads(line)
            decisions[_source_key(row)] = row
    return decisions


def _write_decisions(decisions: dict[tuple[str, int, int], dict[str, Any]]) -> None:
    DECISIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = DECISIONS_FILE.with_suffix(".jsonl.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        for key in sorted(decisions):
            stream.write(
                json.dumps(decisions[key], ensure_ascii=False, separators=(",", ":"))
                + "\n"
            )
    os.replace(temporary, DECISIONS_FILE)


def _candidate_key(candidate: dict[str, Any]) -> str:
    return "|".join(
        (
            str(candidate.get("date") or "")[:10],
            str(int(candidate.get("page") or 0)),
            str(int(candidate.get("ordinal", -1))),
        )
    )


def _people_data_href(day: str, page: int, ordinal: int) -> str:
    query = {
        "cds": [
            {
                "fld": "dataTime",
                "cdr": "AND",
                "hlt": "false",
                "vlr": "OR",
                "qtp": "DEF",
                "val": day.replace("-", ""),
            },
            {
                "fld": "pageNum",
                "cdr": "AND",
                "hlt": "false",
                "vlr": "AND",
                "qtp": "DEF",
                "val": str(page),
            },
        ],
        "obs": [{"fld": "dataTime", "drt": "DESC"}],
    }
    encoded = urllib.parse.quote(
        json.dumps(query, ensure_ascii=False, separators=(",", ":")), safe=""
    )
    return (
        f"{PEOPLE_DATA_BASE}/pd.html?qs={encoded}"
        f"&tr=A&pageNo=1&pageSize=200&position={ordinal}"
    )


def _source_page_href(day: str, page: int) -> str:
    return f"{PEOPLE_DATA_BASE}/{day.replace('-', '')}/{page}"


def _candidates(row: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: dict[str, dict[str, Any]] = {}
    inputs = (
        ("suspected_title_typo", row.get("suspectedTypoCandidates") or []),
        (None, row.get("nearbyExactMatches") or []),
    )
    for default_relation, values in inputs:
        for value in values:
            candidate = dict(value)
            key = _candidate_key(candidate)
            relation = str(candidate.get("kind") or default_relation or "candidate")
            if key in candidates:
                relations = candidates[key].setdefault("relations", [])
                if relation not in relations:
                    relations.append(relation)
                continue
            day = str(candidate.get("date") or "")[:10]
            page = int(candidate.get("page") or 0)
            ordinal = int(candidate.get("ordinal", -1))
            candidates[key] = {
                "candidateKey": key,
                "date": day,
                "page": page,
                "ordinal": ordinal,
                "title": str(candidate.get("title") or ""),
                "editDistance": candidate.get("editDistance"),
                "relations": [relation],
                "peopleDataHref": _people_data_href(day, page, ordinal),
            }
    return sorted(
        candidates.values(),
        key=lambda value: (value["date"], value["page"], value["ordinal"]),
    )


def _public_row(
    row: dict[str, Any], decision: dict[str, Any] | None
) -> dict[str, Any]:
    key = _source_key(row)
    signals = [str(value) for value in row.get("reconciliationSignals") or []]
    return {
        "sourceKey": _key_name(key),
        "date": key[0],
        "page": key[1],
        "ordinal": key[2],
        "title": str(row.get("title") or ""),
        "content": str(row.get("content") or ""),
        "signals": signals,
        "signalLabels": [SIGNAL_LABELS.get(value, value) for value in signals],
        "sourcePageHref": _source_page_href(key[0], key[1]),
        "candidates": _candidates(row),
        "decision": decision,
    }


def _status_matches(
    decision: dict[str, Any] | None, status: str
) -> bool:
    if status == "all":
        return True
    if status == "pending":
        return decision is None
    if status == "deferred":
        return bool(decision and decision.get("resolution") == "defer")
    if status == "reviewed":
        return bool(decision and decision.get("resolution") != "defer")
    return False


def _stats(
    rows: list[dict[str, Any]],
    decisions: dict[tuple[str, int, int], dict[str, Any]],
) -> dict[str, int]:
    counts = {
        "total": len(rows),
        "pending": 0,
        "reviewed": 0,
        "jsonlCorrect": 0,
        "mergeCandidate": 0,
        "manualMetadata": 0,
        "deferred": 0,
    }
    for row in rows:
        decision = decisions.get(_source_key(row))
        if decision is None:
            counts["pending"] += 1
            continue
        resolution = decision.get("resolution")
        if resolution == "defer":
            counts["deferred"] += 1
            continue
        counts["reviewed"] += 1
        if resolution == "jsonl_correct":
            counts["jsonlCorrect"] += 1
        elif resolution == "merge_candidate":
            counts["mergeCandidate"] += 1
        elif resolution == "manual_metadata":
            counts["manualMetadata"] += 1
    return counts


@rmrb_reconciliation_blueprint.get("/api/rmrb-reconciliation/queue")
def queue_api():
    try:
        rows = _load_source_rows()
        decisions = _load_decisions()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return jsonify({"success": False, "error": str(error)}), 503
    query = request.args.get("q", "").strip().lower()
    signal = request.args.get("signal", "all").strip()
    status = request.args.get("status", "pending").strip()
    if status not in {"pending", "reviewed", "deferred", "all"}:
        return jsonify({"success": False, "error": "invalid status filter"}), 400
    offset = max(int(request.args.get("offset", 0) or 0), 0)
    limit = min(max(int(request.args.get("limit", 30) or 30), 1), 100)
    filtered = []
    for row in rows:
        decision = decisions.get(_source_key(row))
        if not _status_matches(decision, status):
            continue
        signals = [str(value) for value in row.get("reconciliationSignals") or []]
        if signal != "all" and signal not in signals:
            continue
        if query and query not in str(row.get("title") or "").lower() and query not in str(
            row.get("date") or ""
        ):
            continue
        filtered.append(row)
    items = [
        _public_row(row, decisions.get(_source_key(row)))
        for row in filtered[offset : offset + limit]
    ]
    return jsonify(
        {
            "success": True,
            "source": str(SOURCE_FILE.resolve()),
            "decisions": str(DECISIONS_FILE.resolve()),
            "total": len(filtered),
            "offset": offset,
            "limit": limit,
            "sort": "date-ascending",
            "items": items,
            "counts": _stats(rows, decisions),
        }
    )


@rmrb_reconciliation_blueprint.get("/api/rmrb-reconciliation/stats")
def stats_api():
    try:
        rows = _load_source_rows()
        decisions = _load_decisions()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return jsonify({"success": False, "error": str(error)}), 503
    return jsonify(
        {
            "success": True,
            "counts": _stats(rows, decisions),
            "source": str(SOURCE_FILE.resolve()),
            "decisions": str(DECISIONS_FILE.resolve()),
        }
    )


def _find_source(
    rows: list[dict[str, Any]], key: tuple[str, int, int]
) -> dict[str, Any] | None:
    return next((row for row in rows if _source_key(row) == key), None)


@rmrb_reconciliation_blueprint.post("/api/rmrb-reconciliation/decision")
def decision_api():
    payload = request.get_json(silent=True) or {}
    try:
        key = (
            str(payload["date"])[:10],
            int(payload["page"]),
            int(payload["ordinal"]),
        )
    except (KeyError, TypeError, ValueError):
        return jsonify({"success": False, "error": "invalid source key"}), 400
    resolution = str(payload.get("resolution") or "").strip()
    if resolution not in ALLOWED_RESOLUTIONS:
        return jsonify({"success": False, "error": "invalid resolution"}), 400
    try:
        rows = _load_source_rows()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return jsonify({"success": False, "error": str(error)}), 503
    source = _find_source(rows, key)
    if source is None:
        return jsonify({"success": False, "error": "source row not found"}), 404

    selected_candidate = None
    if resolution == "merge_candidate":
        candidate_key = str(payload.get("candidateKey") or "")
        selected_candidate = next(
            (
                candidate
                for candidate in _candidates(source)
                if candidate["candidateKey"] == candidate_key
            ),
            None,
        )
        if selected_candidate is None:
            return jsonify({"success": False, "error": "candidate is not valid for this row"}), 400

    resolved_metadata = None
    if resolution == "manual_metadata":
        try:
            resolved_metadata = {
                "date": str(payload["resolvedDate"])[:10],
                "page": int(payload["resolvedPage"]),
                "title": str(payload["resolvedTitle"]).strip(),
            }
        except (KeyError, TypeError, ValueError):
            return jsonify({"success": False, "error": "invalid resolved metadata"}), 400
        if (
            len(resolved_metadata["date"]) != 10
            or resolved_metadata["page"] <= 0
            or not resolved_metadata["title"]
        ):
            return jsonify({"success": False, "error": "resolved metadata is incomplete"}), 400

    decision = {
        "date": key[0],
        "page": key[1],
        "preservedOrdinal": key[2],
        "sourceTitle": str(source.get("title") or ""),
        "sourceFingerprint": _fingerprint(source),
        "resolution": resolution,
        "candidate": selected_candidate,
        "resolvedMetadata": resolved_metadata,
        "note": str(payload.get("note") or "").strip(),
        "reviewedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    with DECISION_LOCK:
        decisions = _load_decisions()
        decisions[key] = decision
        _write_decisions(decisions)
    return jsonify({"success": True, "decision": decision})


@rmrb_reconciliation_blueprint.delete("/api/rmrb-reconciliation/decision")
def delete_decision_api():
    payload = request.get_json(silent=True) or {}
    try:
        key = (
            str(payload["date"])[:10],
            int(payload["page"]),
            int(payload["ordinal"]),
        )
    except (KeyError, TypeError, ValueError):
        return jsonify({"success": False, "error": "invalid source key"}), 400
    with DECISION_LOCK:
        decisions = _load_decisions()
        removed = decisions.pop(key, None)
        _write_decisions(decisions)
    return jsonify({"success": True, "removed": removed is not None})
