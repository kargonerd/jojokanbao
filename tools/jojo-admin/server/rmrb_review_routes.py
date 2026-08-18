"""Staging-only review API for RMRB records that still lack local content."""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from flask import Blueprint, jsonify, request, send_file


rmrb_review_blueprint = Blueprint("rmrb_review", __name__)

WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
REVIEW_ROOT = Path(
    os.environ.get(
        "RMRB_REVIEW_ROOT",
        WORKSPACE_ROOT / "tmp" / "rmrb-peopledata-full-directory",
    )
)
SOURCE_PDF_ROOT = Path(os.environ.get("RMRB_SOURCE_PDF_ROOT", "D:/暂存"))
PEOPLE_DATA_BASE = (
    "https://webvpn.zju.edu.cn/https/"
    "77726476706e69737468656265737421f4f6559d69206d5f6e048ce29b5a2e7b74a4/rmrb"
)
REVIEW_DB = REVIEW_ROOT / "merged-missing-workbench.sqlite3"
WORKBENCH_DECISIONS = REVIEW_ROOT / "manual-review-decisions-workbench.jsonl"
COPY_MARKER_RE = re.compile(r"[（(]\s*人民数据库资料\s*[）)]")
DECISION_LOCK = threading.Lock()


def _key(row: dict[str, object]) -> tuple[str, int, int]:
    return (
        str(row.get("date")),
        int(row.get("page", -1)),
        int(row.get("peopleDataOrdinal", -1)),
    )


def _read_decision_file(path: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    with path.open(encoding="utf-8-sig") as stream:
        for line in stream:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def load_all_decisions() -> dict[tuple[str, int, int], dict[str, object]]:
    """Load all staged verdicts, with the interactive workbench taking priority."""
    decisions: dict[tuple[str, int, int], dict[str, object]] = {}
    paths = sorted(REVIEW_ROOT.glob("manual-review-decisions-*.jsonl"))
    if WORKBENCH_DECISIONS in paths:
        paths.remove(WORKBENCH_DECISIONS)
        paths.append(WORKBENCH_DECISIONS)
    for path in paths:
        try:
            for row in _read_decision_file(path):
                if not all(name in row for name in ("date", "page", "peopleDataOrdinal")):
                    continue
                decision = str(row.get("decision") or row.get("status") or "").lower()
                if decision in {"accept", "reject"}:
                    decisions[_key(row)] = {**row, "decision": decision}
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            logging.exception("Unable to read RMRB decision log %s", path)
    return decisions


def _open_db() -> sqlite3.Connection:
    connection = sqlite3.connect(REVIEW_DB)
    connection.row_factory = sqlite3.Row
    return connection


def _prepare_handled_table(
    connection: sqlite3.Connection,
    decisions: dict[tuple[str, int, int], dict[str, object]],
) -> None:
    connection.execute(
        "CREATE TEMP TABLE handled_articles ("
        "issue_date TEXT NOT NULL, page_number INTEGER NOT NULL, ordinal INTEGER NOT NULL, "
        "decision TEXT NOT NULL, PRIMARY KEY(issue_date, page_number, ordinal)) WITHOUT ROWID"
    )
    connection.executemany(
        "INSERT INTO handled_articles VALUES (?, ?, ?, ?)",
        ((key[0], key[1], key[2], row["decision"]) for key, row in decisions.items()),
    )


def _missing_article(key: tuple[str, int, int]) -> dict[str, object] | None:
    if not REVIEW_DB.is_file():
        return None
    with closing(_open_db()) as connection:
        row = connection.execute(
            "SELECT issue_date AS date, page_number AS page, ordinal AS peopleDataOrdinal, "
            "title, href, match_method AS matchMethod, content_source AS contentSource "
            "FROM missing_articles WHERE issue_date = ? AND page_number = ? AND ordinal = ?",
            key,
        ).fetchone()
    return dict(row) if row else None


def _people_data_href(row: dict[str, object]) -> str | None:
    href = str(row.get("href") or "").strip()
    if href.startswith("https://"):
        return href
    if href.startswith("/https/"):
        return "https://webvpn.zju.edu.cn" + href
    day = str(row.get("date") or "")
    page = int(row.get("page") or 0)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) and page > 0:
        return f"{PEOPLE_DATA_BASE}/{day.replace('-', '')}/{page}"
    return None


def _source_pdf(day: str) -> Path | None:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        return None
    candidate = SOURCE_PDF_ROOT / day[:4] / f"{day.replace('-', '')}.pdf"
    try:
        candidate.resolve().relative_to(SOURCE_PDF_ROOT.resolve())
    except (OSError, ValueError):
        return None
    return candidate if candidate.is_file() else None


def _public_row(
    row: dict[str, object], decision: dict[str, object] | None
) -> dict[str, object]:
    day = str(row.get("date") or "")
    return {
        "date": day,
        "page": row.get("page"),
        "peopleDataOrdinal": row.get("peopleDataOrdinal"),
        "title": row.get("title"),
        "status": "local-content-missing",
        "rawRecoveryClass": "本地两份数据均无正文",
        "peopleDataHref": _people_data_href(row),
        "sourcePdf": f"/api/rmrb-review/pdf?date={quote(day)}" if _source_pdf(day) else None,
        "decision": decision,
    }


@rmrb_review_blueprint.get("/api/rmrb-review/queue")
def queue_api():
    if not REVIEW_DB.is_file():
        return jsonify({"success": False, "error": "missing-content workbench index is not built"}), 503
    decisions = load_all_decisions()
    pending_only = request.args.get("pendingOnly", "").lower() in {"1", "true", "yes"}
    query = request.args.get("q", "").strip().lower()
    year = request.args.get("year", "").strip()
    offset = max(int(request.args.get("offset", 0) or 0), 0)
    limit = min(max(int(request.args.get("limit", 40) or 40), 1), 200)
    where: list[str] = []
    parameters: list[object] = []
    if pending_only:
        where.append("handled.ordinal IS NULL")
    if query:
        where.append("(LOWER(article.title) LIKE ? OR article.issue_date LIKE ?)")
        parameters.extend((f"%{query}%", f"%{query}%"))
    if year:
        where.append("article.issue_date LIKE ?")
        parameters.append(f"{year}%")
    where_sql = " WHERE " + " AND ".join(where) if where else ""
    from_sql = (
        " FROM missing_articles article LEFT JOIN handled_articles handled "
        "ON handled.issue_date = article.issue_date "
        "AND handled.page_number = article.page_number AND handled.ordinal = article.ordinal"
    )
    with closing(_open_db()) as connection:
        _prepare_handled_table(connection, decisions)
        total = connection.execute(
            "SELECT COUNT(*)" + from_sql + where_sql, parameters
        ).fetchone()[0]
        rows = connection.execute(
            "SELECT article.issue_date AS date, article.page_number AS page, "
            "article.ordinal AS peopleDataOrdinal, article.title, article.href, "
            "article.match_method AS matchMethod, article.content_source AS contentSource, "
            "handled.decision AS priorDecision" + from_sql + where_sql +
            " ORDER BY article.issue_date, article.page_number, article.ordinal LIMIT ? OFFSET ?",
            (*parameters, limit, offset),
        ).fetchall()
    items = []
    for result in rows:
        source = dict(result)
        items.append(_public_row(source, decisions.get(_key(source))))
    return jsonify(
        {
            "success": True,
            "total": total,
            "offset": offset,
            "limit": limit,
            "sort": "date-ascending",
            "items": items,
        }
    )


@rmrb_review_blueprint.get("/api/rmrb-review/stats")
def stats_api():
    if not REVIEW_DB.is_file():
        return jsonify({"success": False, "error": "missing-content workbench index is not built"}), 503
    decisions = load_all_decisions()
    with closing(_open_db()) as connection:
        _prepare_handled_table(connection, decisions)
        total = connection.execute("SELECT COUNT(*) FROM missing_articles").fetchone()[0]
        handled = dict(
            connection.execute(
                "SELECT handled.decision, COUNT(*) FROM missing_articles article "
                "JOIN handled_articles handled ON handled.issue_date = article.issue_date "
                "AND handled.page_number = article.page_number AND handled.ordinal = article.ordinal "
                "GROUP BY handled.decision"
            ).fetchall()
        )
    counts = {
        "pending": total - sum(handled.values()),
        "accept": int(handled.get("accept", 0)),
        "reject": int(handled.get("reject", 0)),
    }
    return jsonify({"success": True, "total": total, "counts": counts})


@rmrb_review_blueprint.get("/api/rmrb-review/pdf")
def pdf_api():
    day = request.args.get("date", "").strip()
    path = _source_pdf(day)
    if path is None:
        return jsonify({"success": False, "error": "source PDF not found"}), 404
    return send_file(path, mimetype="application/pdf")


def _write_workbench_decisions(rows: dict[tuple[str, int, int], dict[str, object]]) -> None:
    WORKBENCH_DECISIONS.parent.mkdir(parents=True, exist_ok=True)
    temporary = WORKBENCH_DECISIONS.with_suffix(".jsonl.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        for row in sorted(rows.values(), key=_key):
            stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(temporary, WORKBENCH_DECISIONS)


@rmrb_review_blueprint.post("/api/rmrb-review/decision")
def decision_api():
    payload = request.get_json(silent=True) or {}
    decision = str(payload.get("decision") or "").strip().lower()
    if decision not in {"accept", "reject"}:
        return jsonify({"success": False, "error": "decision must be accept or reject"}), 400
    try:
        key = (
            str(payload["date"]),
            int(payload["page"]),
            int(payload["peopleDataOrdinal"]),
        )
    except (KeyError, TypeError, ValueError):
        return jsonify({"success": False, "error": "invalid article key"}), 400
    source = _missing_article(key)
    if source is None:
        return jsonify({"success": False, "error": "article is not in the missing-content queue"}), 404
    content = COPY_MARKER_RE.sub("", str(payload.get("content") or "")).strip()
    reason = str(payload.get("reason") or "").strip()
    if decision == "accept" and not content:
        return jsonify({"success": False, "error": "accept requires a transcription"}), 400
    row: dict[str, object] = {
        "date": key[0],
        "page": key[1],
        "peopleDataOrdinal": key[2],
        "title": source.get("title"),
        "decision": decision,
        "content": content if decision == "accept" else "",
        "reason": reason or ("人工复核确认" if decision == "accept" else "人工复核后拒绝"),
        "reviewedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "scope": "staging-only",
        "sourceCorpusModified": False,
        "elasticsearchChanged": False,
    }
    with DECISION_LOCK:
        existing = {
            _key(item): item
            for item in (_read_decision_file(WORKBENCH_DECISIONS) if WORKBENCH_DECISIONS.is_file() else [])
        }
        existing[key] = row
        _write_workbench_decisions(existing)
    return jsonify({"success": True, "decision": row})
