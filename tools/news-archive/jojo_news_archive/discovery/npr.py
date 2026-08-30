from __future__ import annotations

from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import time
from urllib.parse import urljoin

from bs4 import BeautifulSoup
import httpx

from jojo_news_archive.sources.registry import ArchiveSourceSpec, normalize_article_url
from jojo_news_archive.discovery.client import GlobalRateLimiter
from jojo_news_archive.discovery.sitemap import wayback_candidates
from jojo_news_archive.discovery.wayback import MANIFEST_FORMAT_VERSION, infer_published_at


NPR_ARCHIVE_DISCOVERY_VERSION = "jojo-npr-official-archive/2"
NPR_ARCHIVE_URL = "https://www.npr.org/sections/news/archive"
NPR_ARCHIVE_PAGE_SIZE = 15
NPR_ARCHIVE_MAX_OFFSET = 1800
NPR_ARCHIVE_MAX_QUERY_ATTEMPTS = 3
RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}


class NprArchiveClient:
    def __init__(
        self,
        *,
        minimum_interval: float = 1.0,
        timeout: float = 45.0,
        attempts: int = 4,
        client: httpx.Client | None = None,
    ) -> None:
        if minimum_interval < 0:
            raise ValueError("minimum_interval must not be negative")
        if timeout <= 0 or attempts < 1:
            raise ValueError("timeout and attempts must be positive")
        self.rate_limiter = GlobalRateLimiter(minimum_interval)
        self.attempts = attempts
        self._provided_client = client
        self._client = client or httpx.Client(
            headers={
                "User-Agent": (
                    "JOJO-News-Archive-Research/0.1 "
                    "(authorized nonprofit academic archive)"
                )
            },
            follow_redirects=True,
            timeout=timeout,
        )

    def close(self) -> None:
        if self._provided_client is None:
            self._client.close()

    def page(self, *, cursor_date: str, offset: int) -> bytes:
        parsed_cursor = datetime.fromisoformat(cursor_date)
        params: dict[str, str | int] = {
            "date": parsed_cursor.strftime("%m-%d-%Y")
        }
        if offset:
            params["start"] = offset
        last_status: int | None = None
        for attempt in range(self.attempts):
            self.rate_limiter.wait()
            try:
                response = self._client.get(NPR_ARCHIVE_URL, params=params)
                last_status = response.status_code
                if response.status_code in RETRYABLE_STATUS_CODES:
                    raise RuntimeError(
                        f"retryable HTTP {response.status_code}"
                    )
                response.raise_for_status()
                return response.content
            except (httpx.HTTPError, RuntimeError):
                if attempt + 1 >= self.attempts:
                    break
                time.sleep(min(30.0, 2.0**attempt))
        raise RuntimeError(
            f"NPR archive request failed after {self.attempts} attempts"
            + (f" (last HTTP status {last_status})" if last_status else "")
        )


def initialize_npr_archive_schema(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
) -> None:
    if from_year > to_year:
        raise ValueError("from_year must not be after to_year")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS npr_archive_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS npr_archive_queries (
            year INTEGER PRIMARY KEY,
            cursor_date TEXT NOT NULL,
            next_offset INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            pages INTEGER NOT NULL DEFAULT 0,
            rows_seen INTEGER NOT NULL DEFAULT 0,
            rows_accepted INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS npr_archive_articles (
            canonical_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            headline TEXT,
            source_archive_url TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    query_columns = {
        str(row[1])
        for row in connection.execute("PRAGMA table_info(npr_archive_queries)")
    }
    if "cursor_date" not in query_columns:
        connection.execute(
            "ALTER TABLE npr_archive_queries ADD COLUMN cursor_date TEXT"
        )
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "publisher": "npr",
                "fromYear": from_year,
                "toYear": to_year,
                "archiveUrl": NPR_ARCHIVE_URL,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    existing = connection.execute(
        "SELECT value FROM npr_archive_metadata WHERE key='fingerprint'"
    ).fetchone()
    if existing is not None and str(existing[0]) != fingerprint:
        raise ValueError("NPR archive state belongs to another year window")
    connection.executemany(
        """
        INSERT INTO npr_archive_metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        {
            "schema_version": NPR_ARCHIVE_DISCOVERY_VERSION,
            "from_year": str(from_year),
            "to_year": str(to_year),
            "fingerprint": fingerprint,
        }.items(),
    )
    now = _now_iso()
    connection.executemany(
        """
        INSERT OR IGNORE INTO npr_archive_queries(
            year, cursor_date, updated_at
        ) VALUES (?, ?, ?)
        """,
        (
            (year, f"{year:04d}-12-31", now)
            for year in range(from_year, to_year + 1)
        ),
    )
    connection.execute(
        """
        UPDATE npr_archive_queries
        SET cursor_date=printf('%04d-12-31', year)
        WHERE cursor_date IS NULL OR cursor_date=''
        """
    )
    # NPR returns HTTP 500 for deep offsets near 2,000. Older v1 checkpoints
    # can therefore be stranded at the failing offset. Move the cursor to the
    # oldest date already observed and restart from offset zero; canonical-URL
    # upserts make the small boundary overlap harmless.
    for year, cursor_date in connection.execute(
        """
        SELECT year, cursor_date FROM npr_archive_queries
        WHERE status != 'complete' AND next_offset >= ?
        """,
        (NPR_ARCHIVE_MAX_OFFSET,),
    ).fetchall():
        oldest = connection.execute(
            """
            SELECT MIN(substr(published_at, 1, 10))
            FROM npr_archive_articles
            WHERE substr(published_at, 1, 4)=printf('%04d', ?)
            """,
            (year,),
        ).fetchone()[0]
        if oldest and str(oldest) <= str(cursor_date):
            connection.execute(
                """
                UPDATE npr_archive_queries
                SET cursor_date=?, next_offset=0, attempts=0,
                    status='running', last_error=NULL, updated_at=?
                WHERE year=?
                """,
                (str(oldest), now, year),
            )
    connection.commit()


def next_npr_archive_query(
    connection: sqlite3.Connection,
    *,
    maximum_attempts: int = NPR_ARCHIVE_MAX_QUERY_ATTEMPTS,
) -> tuple[int, str, int] | None:
    row = connection.execute(
        """
        SELECT year, cursor_date, next_offset
        FROM npr_archive_queries
        WHERE status != 'complete' AND attempts < ?
        ORDER BY year, next_offset
        LIMIT 1
        """,
        (maximum_attempts,),
    ).fetchone()
    return (
        (int(row[0]), str(row[1]), int(row[2]))
        if row is not None
        else None
    )


def parse_npr_archive_page(
    content: bytes,
    *,
    spec: ArchiveSourceSpec,
) -> list[tuple[str, str, str | None]]:
    soup = BeautifulSoup(content, "html.parser")
    result: list[tuple[str, str, str | None]] = []
    seen: set[str] = set()
    for item in soup.select("article.item"):
        link = item.select_one("h2.title a[href]") or item.select_one(
            "a[href]"
        )
        if link is None:
            continue
        original_url = urljoin(NPR_ARCHIVE_URL, str(link.get("href") or ""))
        canonical_url = normalize_article_url(spec, original_url)
        if canonical_url is None or canonical_url in seen:
            continue
        time_node = item.select_one("time[datetime]")
        published_at = (
            str(time_node.get("datetime") or "").strip()
            if time_node is not None
            else ""
        )
        if len(published_at) < 10:
            inferred = infer_published_at(canonical_url)
            published_at = inferred or ""
        try:
            parsed_date = datetime.fromisoformat(
                published_at[:10]
            ).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        headline = " ".join(link.get_text(" ", strip=True).split()) or None
        seen.add(canonical_url)
        result.append((canonical_url, parsed_date.isoformat(), headline))
    return result


def record_npr_archive_page(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    year: int,
    cursor_date: str,
    offset: int,
    content: bytes,
) -> dict[str, int | bool]:
    entries = parse_npr_archive_page(content, spec=spec)
    dated_entries = [
        entry for entry in entries if int(entry[1][:4]) == year
    ]
    page_years = [int(entry[1][:4]) for entry in entries]
    complete = not entries or any(value < year for value in page_years)
    archive_date = datetime.fromisoformat(cursor_date).strftime("%m-%d-%Y")
    source_archive_url = (
        f"{NPR_ARCHIVE_URL}?date={archive_date}"
        + (f"&start={offset}" if offset else "")
    )
    next_offset = offset + NPR_ARCHIVE_PAGE_SIZE
    next_cursor_date = cursor_date
    cursor_rotated = False
    if (
        not complete
        and entries
        and next_offset >= NPR_ARCHIVE_MAX_OFFSET
    ):
        next_cursor_date = min(entry[1][:10] for entry in entries)
        next_offset = 0
        cursor_rotated = True
    now = _now_iso()
    rows = [
        (canonical_url, published_at, headline, source_archive_url, now)
        for canonical_url, published_at, headline in dated_entries
    ]
    with connection:
        before = int(
            connection.execute(
                "SELECT COUNT(*) FROM npr_archive_articles"
            ).fetchone()[0]
        )
        connection.executemany(
            """
            INSERT INTO npr_archive_articles(
                canonical_url, published_at, headline,
                source_archive_url, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(canonical_url) DO UPDATE SET
                published_at=excluded.published_at,
                headline=COALESCE(
                    npr_archive_articles.headline,
                    excluded.headline
                ),
                source_archive_url=excluded.source_archive_url,
                updated_at=excluded.updated_at
            """,
            rows,
        )
        accepted = int(
            connection.execute(
                "SELECT COUNT(*) FROM npr_archive_articles"
            ).fetchone()[0]
        ) - before
        connection.execute(
            """
            UPDATE npr_archive_queries
            SET cursor_date=?, next_offset=?, status=?, attempts=0,
                pages=pages+1, rows_seen=rows_seen+?,
                rows_accepted=rows_accepted+?, last_error=NULL,
                updated_at=?
            WHERE year=?
            """,
            (
                next_cursor_date,
                next_offset,
                "complete" if complete else "running",
                len(entries),
                accepted,
                now,
                year,
            ),
        )
    return {
        "seen": len(entries),
        "accepted": accepted,
        "complete": complete,
        "cursorRotated": cursor_rotated,
    }


def record_npr_archive_error(
    connection: sqlite3.Connection,
    *,
    year: int,
    error: str,
) -> None:
    with connection:
        connection.execute(
            """
            UPDATE npr_archive_queries
            SET attempts=attempts+1, status='error', last_error=?,
                updated_at=?
            WHERE year=?
            """,
            (error, _now_iso(), year),
        )


def export_npr_archive_manifest(
    connection: sqlite3.Connection,
    *,
    destination: Path,
) -> dict[str, object]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    opener = gzip.open if destination.suffix == ".gz" else open
    articles = 0
    candidates = 0
    with opener(temporary, "wt", encoding="utf-8") as handle:
        for canonical_url, published_at, headline in connection.execute(
            """
            SELECT canonical_url, published_at, headline
            FROM npr_archive_articles
            ORDER BY canonical_url
            """
        ):
            candidate_rows = [
                {
                    "provider": "live-origin",
                    "snapshotUrl": canonical_url,
                    **(
                        {"expectedHeadline": headline}
                        if headline
                        else {}
                    ),
                },
                *[
                    {
                        **candidate,
                        **(
                            {"expectedHeadline": headline}
                            if headline
                            else {}
                        ),
                    }
                    for candidate in wayback_candidates(
                        canonical_url,
                        published_at=published_at,
                    )
                ],
            ]
            row = {
                "formatVersion": MANIFEST_FORMAT_VERSION,
                "publisher": "npr",
                "canonicalUrl": canonical_url,
                "publishedAt": published_at,
                "candidates": candidate_rows,
            }
            handle.write(
                json.dumps(row, ensure_ascii=False, separators=(",", ":"))
                + "\n"
            )
            articles += 1
            candidates += len(candidate_rows)
    temporary.replace(destination)
    return {
        "publisher": "npr",
        "articles": articles,
        "candidates": candidates,
        "manifest": str(destination),
    }


def npr_archive_summary(connection: sqlite3.Connection) -> dict[str, object]:
    counts = dict(
        connection.execute(
            "SELECT status, COUNT(*) FROM npr_archive_queries GROUP BY status"
        ).fetchall()
    )
    articles_by_year = {
        str(year): int(count)
        for year, count in connection.execute(
            """
            SELECT CAST(substr(published_at, 1, 4) AS INTEGER), COUNT(*)
            FROM npr_archive_articles GROUP BY 1 ORDER BY 1
            """
        )
    }
    totals = connection.execute(
        """
        SELECT COALESCE(SUM(pages), 0), COALESCE(SUM(rows_seen), 0),
               COALESCE(SUM(rows_accepted), 0)
        FROM npr_archive_queries
        """
    ).fetchone()
    incomplete = int(
        connection.execute(
            "SELECT COUNT(*) FROM npr_archive_queries "
            "WHERE status != 'complete'"
        ).fetchone()[0]
    )
    retryable = int(
        connection.execute(
            "SELECT COUNT(*) FROM npr_archive_queries "
            "WHERE status != 'complete' AND attempts < ?",
            (NPR_ARCHIVE_MAX_QUERY_ATTEMPTS,),
        ).fetchone()[0]
    )
    cursors = {
        str(year): {"date": str(cursor_date), "offset": int(offset)}
        for year, cursor_date, offset in connection.execute(
            "SELECT year, cursor_date, next_offset "
            "FROM npr_archive_queries ORDER BY year"
        )
    }
    return {
        "formatVersion": NPR_ARCHIVE_DISCOVERY_VERSION,
        "queriesByStatus": counts,
        "pages": int(totals[0]),
        "rowsSeen": int(totals[1]),
        "rowsAccepted": int(totals[2]),
        "articlesByYear": articles_by_year,
        "articles": sum(articles_by_year.values()),
        "queryCursors": cursors,
        "complete": incomplete == 0,
        "exhaustedQueries": incomplete - retryable,
        "shouldContinue": retryable > 0,
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
