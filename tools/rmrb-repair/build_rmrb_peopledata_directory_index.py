"""Build a local SQLite index from the complete PeopleData daily directories."""
from __future__ import annotations

import argparse
import json
import sqlite3
import unicodedata
from datetime import datetime, timezone
from pathlib import Path


WORKSPACE = Path(__file__).resolve().parents[2]
DEFAULT_INPUTS = (
    WORKSPACE / "tmp" / "rmrb-peopledata-full-directory" / "daily-directory.jsonl",
    WORKSPACE
    / "tmp"
    / "rmrb-peopledata-full-directory"
    / "daily-directory-2004-2025.jsonl",
)
DEFAULT_OUTPUT = (
    WORKSPACE / "tmp" / "rmrb-peopledata-full-directory" / "directory-index.sqlite3"
)
DEFAULT_REPORT = (
    WORKSPACE / "tmp" / "rmrb-peopledata-full-directory" / "directory-index-summary.json"
)


def normalized_title(value: object) -> str:
    return "".join(unicodedata.normalize("NFKC", str(value or "")).split())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, action="append", dest="inputs")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    args = parser.parse_args()
    inputs = tuple(args.inputs or DEFAULT_INPUTS)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.parent.mkdir(parents=True, exist_ok=True)
    if temporary.exists():
        temporary.unlink()

    connection = sqlite3.connect(temporary)
    connection.executescript(
        """
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        PRAGMA temp_store=MEMORY;
        CREATE TABLE issues (
            issue_date TEXT PRIMARY KEY,
            result_count INTEGER NOT NULL,
            edition_count INTEGER NOT NULL,
            page_counts_json TEXT NOT NULL,
            source TEXT NOT NULL,
            peopledata_available INTEGER NOT NULL,
            detail_recovered_count INTEGER NOT NULL
        );
        CREATE TABLE articles (
            issue_date TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            page_number INTEGER NOT NULL,
            title TEXT NOT NULL,
            normalized_title TEXT NOT NULL,
            href TEXT,
            PRIMARY KEY (issue_date, ordinal),
            FOREIGN KEY (issue_date) REFERENCES issues(issue_date)
        );
        """
    )
    issue_count = 0
    article_count = 0
    fallback_issue_count = 0
    recovered_article_count = 0
    seen_dates: set[str] = set()
    first_date: str | None = None
    last_date: str | None = None

    for input_path in inputs:
        with input_path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                row = json.loads(line)
                day = str(row["date"])
                if day in seen_dates:
                    raise RuntimeError(f"Duplicate issue date {day} in {input_path}:{line_number}")
                seen_dates.add(day)
                first_date = day if first_date is None or day < first_date else first_date
                last_date = day if last_date is None or day > last_date else last_date
                articles = list(row.get("articles") or [])
                if int(row.get("resultCount") or 0) != len(articles):
                    raise RuntimeError(
                        f"Article count mismatch {input_path}:{line_number}: "
                        f"reported={row.get('resultCount')} actual={len(articles)}"
                    )
                available = bool(row.get("peopleDataAvailable", True))
                recovered = int(row.get("detailRecoveredCount") or 0)
                connection.execute(
                    "INSERT INTO issues VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        day,
                        len(articles),
                        int(row.get("editionCount") or 0),
                        json.dumps(row.get("pageCounts") or {}, ensure_ascii=False, sort_keys=True),
                        str(row.get("source") or ""),
                        int(available),
                        recovered,
                    ),
                )
                connection.executemany(
                    "INSERT INTO articles VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        (
                            day,
                            ordinal,
                            int(article["page"]),
                            str(article.get("title") or ""),
                            normalized_title(article.get("title")),
                            article.get("href"),
                        )
                        for ordinal, article in enumerate(articles)
                    ),
                )
                issue_count += 1
                article_count += len(articles)
                fallback_issue_count += int(not available)
                recovered_article_count += recovered
                if issue_count % 500 == 0:
                    connection.commit()
                    print(
                        f"[{issue_count:05d}] {day}: {article_count:,} articles indexed",
                        flush=True,
                    )

    connection.commit()
    connection.executescript(
        """
        CREATE INDEX articles_by_date_page ON articles(issue_date, page_number);
        CREATE INDEX articles_by_date_title ON articles(issue_date, normalized_title);
        ANALYZE;
        """
    )
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    connection.close()
    if integrity != "ok":
        raise RuntimeError(f"SQLite integrity check failed: {integrity}")
    temporary.replace(args.output)

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "inputs": [str(path) for path in inputs],
        "output": str(args.output),
        "dateRange": {"start": first_date, "end": last_date},
        "issueCount": issue_count,
        "articleCount": article_count,
        "fallbackIssueCount": fallback_issue_count,
        "detailRecoveredArticleCount": recovered_article_count,
        "uniqueDates": len(seen_dates),
        "sqliteIntegrity": integrity,
    }
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
