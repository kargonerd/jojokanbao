from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import re
import sqlite3
from urllib.parse import unquote, urlencode, urlsplit

from bs4 import BeautifulSoup

from .archive_sources import archive_source_spec, normalize_article_url
from .wayback_manifest import infer_published_at


SCHEMA_VERSION = "jojo-nyt-syndication-catalog/1"
DEFAULT_ENDPOINT = (
    "https://www.hawaiitribune-herald.com/wp-json/wp/v2/posts"
)
DEFAULT_TAG_ID = 768
PAGE_SIZE = 100
MAXIMUM_RESPONSE_BYTES = 10_000_000
RESOLUTION_TARGET_PER_YEAR = 500
YAHOO_SEARCH_ENDPOINT = "https://search.yahoo.com/search"
_STOP_WORDS = {
    "a",
    "an",
    "and",
    "as",
    "at",
    "by",
    "for",
    "from",
    "in",
    "of",
    "on",
    "the",
    "to",
    "with",
}


def initialize_nyt_syndication_schema(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
    endpoint: str = DEFAULT_ENDPOINT,
    tag_id: int = DEFAULT_TAG_ID,
) -> None:
    if from_year > to_year:
        raise ValueError("from_year must not exceed to_year")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS nyt_syndication_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS nyt_syndication_queries (
            year INTEGER NOT NULL,
            page INTEGER NOT NULL,
            request_url TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            rows_seen INTEGER NOT NULL DEFAULT 0,
            rows_accepted INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(year, page)
        );

        CREATE TABLE IF NOT EXISTS nyt_syndication_articles (
            canonical_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            syndicated_url TEXT NOT NULL,
            partner_published_at TEXT,
            headline TEXT NOT NULL DEFAULT '',
            mapping_method TEXT NOT NULL DEFAULT 'canonical-link',
            source_endpoint TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS nyt_syndication_unresolved (
            syndicated_url TEXT PRIMARY KEY,
            partner_published_at TEXT NOT NULL,
            headline TEXT NOT NULL,
            source_endpoint TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_nyt_syndication_articles_published
        ON nyt_syndication_articles(published_at);

        CREATE INDEX IF NOT EXISTS idx_nyt_syndication_unresolved_status
        ON nyt_syndication_unresolved(status, partner_published_at);
        """
    )
    article_columns = {
        str(row[1])
        for row in connection.execute(
            "PRAGMA table_info(nyt_syndication_articles)"
        )
    }
    if "headline" not in article_columns:
        connection.execute(
            """
            ALTER TABLE nyt_syndication_articles
            ADD COLUMN headline TEXT NOT NULL DEFAULT ''
            """
        )
    if "mapping_method" not in article_columns:
        connection.execute(
            """
            ALTER TABLE nyt_syndication_articles
            ADD COLUMN mapping_method TEXT NOT NULL DEFAULT 'canonical-link'
            """
        )
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "endpoint": endpoint,
                "tagId": tag_id,
                "fromYear": from_year,
                "toYear": to_year,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    existing = connection.execute(
        """
        SELECT value
        FROM nyt_syndication_metadata
        WHERE key='fingerprint'
        """
    ).fetchone()
    if existing and existing[0] != fingerprint:
        raise ValueError(
            "NYT syndication state belongs to a different source or window"
        )
    connection.executemany(
        """
        INSERT INTO nyt_syndication_metadata(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        {
            "schema_version": SCHEMA_VERSION,
            "endpoint": endpoint,
            "tag_id": str(tag_id),
            "from_year": str(from_year),
            "to_year": str(to_year),
            "fingerprint": fingerprint,
        }.items(),
    )
    now = _now_iso()
    connection.executemany(
        """
        INSERT OR IGNORE INTO nyt_syndication_queries(
            year,
            page,
            request_url,
            updated_at
        ) VALUES (?, 1, ?, ?)
        """,
        (
            (
                year,
                nyt_syndication_page_url(
                    year=year,
                    page=1,
                    endpoint=endpoint,
                    tag_id=tag_id,
                ),
                now,
            )
            for year in range(from_year, to_year + 1)
        ),
    )
    connection.commit()


def nyt_syndication_page_url(
    *,
    year: int,
    page: int,
    endpoint: str = DEFAULT_ENDPOINT,
    tag_id: int = DEFAULT_TAG_ID,
) -> str:
    if page < 1:
        raise ValueError("page must be positive")
    return endpoint + "?" + urlencode(
        {
            "tags": tag_id,
            "after": f"{year:04d}-01-01T00:00:00",
            "before": f"{year + 1:04d}-01-01T00:00:00",
            "per_page": PAGE_SIZE,
            "page": page,
            "orderby": "date",
            "order": "asc",
            "_fields": "date,date_gmt,link,title,content",
        }
    )


def next_nyt_syndication_query(
    connection: sqlite3.Connection,
) -> tuple[int, int, str] | None:
    row = connection.execute(
        """
        SELECT year, page, request_url
        FROM nyt_syndication_queries
        WHERE status != 'complete'
        ORDER BY year DESC, page
        LIMIT 1
        """
    ).fetchone()
    return (int(row[0]), int(row[1]), str(row[2])) if row else None


def record_nyt_syndication_page(
    connection: sqlite3.Connection,
    *,
    year: int,
    page: int,
    request_url: str,
    content: bytes,
    total_pages: int,
    endpoint: str = DEFAULT_ENDPOINT,
    tag_id: int = DEFAULT_TAG_ID,
) -> dict[str, int]:
    if total_pages < 0:
        raise ValueError("total_pages must not be negative")
    payload = json.loads(content)
    if not isinstance(payload, list):
        raise ValueError("NYT syndication page must be a JSON list")
    accepted: list[
        tuple[str, str, str, str | None, str, str, str, str]
    ] = []
    unresolved: list[tuple[str, str, str, str, str]] = []
    for row in payload:
        parsed = parse_nyt_syndication_post(
            row,
            source_endpoint=endpoint,
        )
        if parsed is None:
            metadata = _nyt_partner_post_metadata(row)
            if metadata is not None:
                (
                    syndicated_url,
                    partner_published_at,
                    headline,
                    _,
                ) = metadata
                if partner_published_at.startswith(f"{year:04d}-"):
                    unresolved.append(
                        (
                            syndicated_url,
                            partner_published_at,
                            headline,
                            endpoint,
                            _now_iso(),
                        )
                    )
            continue
        (
            canonical_url,
            published_at,
            syndicated_url,
            partner_published_at,
            headline,
        ) = parsed
        if not published_at.startswith(f"{year:04d}-"):
            continue
        accepted.append(
            (
                canonical_url,
                published_at,
                syndicated_url,
                partner_published_at,
                headline,
                "canonical-link",
                endpoint,
                _now_iso(),
            )
        )

    now = _now_iso()
    with connection:
        connection.executemany(
            """
            INSERT INTO nyt_syndication_articles(
                canonical_url,
                published_at,
                syndicated_url,
                partner_published_at,
                headline,
                mapping_method,
                source_endpoint,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(canonical_url) DO UPDATE SET
                published_at=excluded.published_at,
                syndicated_url=excluded.syndicated_url,
                partner_published_at=excluded.partner_published_at,
                headline=excluded.headline,
                mapping_method=excluded.mapping_method,
                source_endpoint=excluded.source_endpoint,
                updated_at=excluded.updated_at
            """,
            accepted,
        )
        connection.executemany(
            """
            INSERT INTO nyt_syndication_unresolved(
                syndicated_url,
                partner_published_at,
                headline,
                source_endpoint,
                updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(syndicated_url) DO UPDATE SET
                partner_published_at=excluded.partner_published_at,
                headline=excluded.headline,
                source_endpoint=excluded.source_endpoint,
                updated_at=excluded.updated_at
            WHERE nyt_syndication_unresolved.status != 'complete'
            """,
            unresolved,
        )
        connection.executemany(
            """
            DELETE FROM nyt_syndication_unresolved
            WHERE syndicated_url=?
            """,
            ((row[2],) for row in accepted),
        )
        connection.execute(
            """
            UPDATE nyt_syndication_queries
            SET status='complete',
                rows_seen=?,
                rows_accepted=?,
                updated_at=?
            WHERE year=? AND page=? AND request_url=?
            """,
            (
                len(payload),
                len(accepted),
                now,
                year,
                page,
                request_url,
            ),
        )
        connection.executemany(
            """
            INSERT OR IGNORE INTO nyt_syndication_queries(
                year,
                page,
                request_url,
                updated_at
            ) VALUES (?, ?, ?, ?)
            """,
            (
                (
                    year,
                    next_page,
                    nyt_syndication_page_url(
                        year=year,
                        page=next_page,
                        endpoint=endpoint,
                        tag_id=tag_id,
                    ),
                    now,
                )
                for next_page in range(2, total_pages + 1)
            ),
        )
    return {
        "seen": len(payload),
        "accepted": len(accepted),
        "unresolved": len(unresolved),
        "totalPages": total_pages,
    }


def parse_nyt_syndication_post(
    value: object,
    *,
    source_endpoint: str = DEFAULT_ENDPOINT,
) -> tuple[str, str, str, str | None, str] | None:
    metadata = _nyt_partner_post_metadata(value)
    if metadata is None:
        return None
    (
        syndicated_url,
        partner_published_at,
        headline,
        rendered,
    ) = metadata
    partner_date = _parse_datetime(partner_published_at)

    publisher_spec = archive_source_spec("nyt")
    candidates: list[tuple[int, int, str, str]] = []
    soup = BeautifulSoup(rendered, "html.parser")
    for position, anchor in enumerate(soup.select("a[href]")):
        href = anchor.get("href")
        if not isinstance(href, str):
            continue
        canonical_url = normalize_article_url(publisher_spec, href)
        if not canonical_url:
            continue
        published_at = infer_published_at(canonical_url)
        if published_at is None:
            continue
        published_date = _parse_datetime(published_at)
        if (
            partner_date is not None
            and published_date is not None
            and abs((partner_date.date() - published_date.date()).days) > 2
        ):
            continue
        context = anchor.parent.get_text(" ", strip=True).casefold()
        source_priority = (
            0
            if "originally appeared" in context
            else 1
            if "new york times" in anchor.get_text(" ", strip=True).casefold()
            else 2
        )
        candidates.append(
            (
                source_priority,
                -position,
                canonical_url,
                published_at,
            )
        )
    if not candidates:
        return None
    _, _, canonical_url, published_at = min(candidates)
    return (
        canonical_url,
        published_at,
        syndicated_url,
        partner_published_at,
        headline,
    )


def _nyt_partner_post_metadata(
    value: object,
) -> tuple[str, str, str, str] | None:
    if not isinstance(value, dict):
        return None
    syndicated_url = value.get("link")
    content_value = value.get("content")
    title_value = value.get("title")
    partner_published_at = value.get("date_gmt") or value.get("date")
    if (
        not isinstance(syndicated_url, str)
        or not isinstance(content_value, dict)
        or not isinstance(title_value, dict)
        or not isinstance(partner_published_at, str)
    ):
        return None
    rendered = content_value.get("rendered")
    rendered_title = title_value.get("rendered")
    if not isinstance(rendered, str) or not isinstance(rendered_title, str):
        return None
    headline = BeautifulSoup(
        rendered_title,
        "html.parser",
    ).get_text(" ", strip=True)
    if len(_significant_tokens(headline)) < 4:
        return None
    return syndicated_url, partner_published_at, headline, rendered


def next_nyt_syndication_resolution(
    connection: sqlite3.Connection,
    *,
    target_per_year: int = RESOLUTION_TARGET_PER_YEAR,
) -> tuple[str, str, str, str] | None:
    row = connection.execute(
        """
        SELECT
            unresolved.syndicated_url,
            unresolved.partner_published_at,
            unresolved.headline,
            unresolved.source_endpoint
        FROM nyt_syndication_unresolved AS unresolved
        WHERE unresolved.status='pending'
          AND (
            SELECT COUNT(*)
            FROM nyt_syndication_articles AS article
            WHERE substr(article.published_at, 1, 4)
                  = substr(unresolved.partner_published_at, 1, 4)
          ) < ?
        ORDER BY unresolved.partner_published_at DESC,
                 unresolved.syndicated_url
        LIMIT 1
        """,
        (target_per_year,),
    ).fetchone()
    if row is None:
        return None
    return tuple(str(value) for value in row)


def nyt_syndication_resolution_url(headline: str) -> str:
    return YAHOO_SEARCH_ENDPOINT + "?" + urlencode(
        {"p": headline + " New York Times"}
    )


def resolve_nyt_syndication_search(
    content: bytes,
    *,
    headline: str,
    partner_published_at: str,
) -> tuple[str, str] | None:
    partner_date = _parse_datetime(partner_published_at)
    if partner_date is None:
        return None
    publisher_spec = archive_source_spec("nyt")
    soup = BeautifulSoup(content, "html.parser")
    ranked: list[tuple[float, int, str, str]] = []
    for position, result in enumerate(soup.select("#web li")):
        anchor = (
            result.select_one(".compTitle > a")
            or result.select_one("h3 a")
            or result.select_one("a")
        )
        heading = result.select_one("h3")
        if anchor is None or heading is None:
            continue
        candidate_url = _decode_yahoo_result(anchor.get("href"))
        if candidate_url is None:
            continue
        canonical_url = normalize_article_url(
            publisher_spec,
            candidate_url,
        )
        if canonical_url is None:
            continue
        published_at = infer_published_at(canonical_url)
        published_date = _parse_datetime(published_at)
        if (
            published_at is None
            or published_date is None
            or abs((partner_date.date() - published_date.date()).days) > 2
        ):
            continue
        result_headline = _clean_search_headline(
            heading.get_text(" ", strip=True)
        )
        overlap = _headline_overlap(headline, result_headline)
        if overlap < 0.75:
            continue
        ranked.append((-overlap, position, canonical_url, published_at))
    if not ranked:
        return None
    _, _, canonical_url, published_at = min(ranked)
    return canonical_url, published_at


def record_nyt_syndication_resolution(
    connection: sqlite3.Connection,
    *,
    syndicated_url: str,
    partner_published_at: str,
    headline: str,
    source_endpoint: str,
    resolved: tuple[str, str] | None,
) -> None:
    now = _now_iso()
    with connection:
        if resolved is not None:
            canonical_url, published_at = resolved
            connection.execute(
                """
                INSERT INTO nyt_syndication_articles(
                    canonical_url,
                    published_at,
                    syndicated_url,
                    partner_published_at,
                    headline,
                    mapping_method,
                    source_endpoint,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, 'headline-search', ?, ?)
                ON CONFLICT(canonical_url) DO UPDATE SET
                    published_at=excluded.published_at,
                    syndicated_url=excluded.syndicated_url,
                    partner_published_at=excluded.partner_published_at,
                    headline=excluded.headline,
                    mapping_method=excluded.mapping_method,
                    source_endpoint=excluded.source_endpoint,
                    updated_at=excluded.updated_at
                """,
                (
                    canonical_url,
                    published_at,
                    syndicated_url,
                    partner_published_at,
                    headline,
                    source_endpoint,
                    now,
                ),
            )
        connection.execute(
            """
            UPDATE nyt_syndication_unresolved
            SET status='complete',
                attempts=attempts+1,
                last_error=?,
                updated_at=?
            WHERE syndicated_url=?
            """,
            (
                None if resolved is not None else "no strict title match",
                now,
                syndicated_url,
            ),
        )


def _decode_yahoo_result(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    match = re.search(r"/RU=([^/]+)/RK=", value)
    candidate_url = unquote(match.group(1)) if match else value
    parsed = urlsplit(candidate_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return candidate_url


def _clean_search_headline(value: str) -> str:
    value = re.sub(
        r"^\s*(?:opinion|guest essay)\s*[|:-]\s*",
        "",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(
        r"\s+(?:[-|]\s*)?(?:The )?New York Times\s*$",
        "",
        value,
        flags=re.IGNORECASE,
    )
    return re.sub(r"\s*(?:…|\.\.\.)\s*$", "", value).strip()


def _headline_overlap(first: str, second: str) -> float:
    first_tokens = _significant_tokens(first)
    second_tokens = _significant_tokens(second)
    if not first_tokens or not second_tokens:
        return 0.0
    return len(first_tokens & second_tokens) / min(
        len(first_tokens),
        len(second_tokens),
    )


def _significant_tokens(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", value.casefold())
        if token not in _STOP_WORDS
    }


def nyt_syndication_articles(
    connection: sqlite3.Connection,
) -> dict[str, tuple[str, str, str]]:
    if not _table_exists(connection, "nyt_syndication_articles"):
        return {}
    return {
        str(canonical_url): (
            str(published_at),
            str(syndicated_url),
            str(headline),
        )
        for canonical_url, published_at, syndicated_url, headline
        in connection.execute(
            """
            SELECT canonical_url, published_at, syndicated_url, headline
            FROM nyt_syndication_articles
            ORDER BY canonical_url
            """
        )
    }


def nyt_syndication_summary(
    connection: sqlite3.Connection,
) -> dict[str, object]:
    if not _table_exists(connection, "nyt_syndication_queries"):
        return {
            "queriesByStatus": {},
            "articles": 0,
            "resolutionByStatus": {},
            "resolutionNeeded": 0,
            "shouldContinue": False,
        }
    counts = dict(
        connection.execute(
            """
            SELECT status, COUNT(*)
            FROM nyt_syndication_queries
            GROUP BY status
            """
        ).fetchall()
    )
    articles = int(
        connection.execute(
            "SELECT COUNT(*) FROM nyt_syndication_articles"
        ).fetchone()[0]
    )
    resolution_counts = dict(
        connection.execute(
            """
            SELECT status, COUNT(*)
            FROM nyt_syndication_unresolved
            GROUP BY status
            """
        ).fetchall()
    )
    resolution_needed = int(
        connection.execute(
            """
            SELECT COUNT(*)
            FROM nyt_syndication_unresolved AS unresolved
            WHERE unresolved.status='pending'
              AND (
                SELECT COUNT(*)
                FROM nyt_syndication_articles AS article
                WHERE substr(article.published_at, 1, 4)
                      = substr(unresolved.partner_published_at, 1, 4)
              ) < ?
            """,
            (RESOLUTION_TARGET_PER_YEAR,),
        ).fetchone()[0]
    )
    return {
        "queriesByStatus": counts,
        "articles": articles,
        "resolutionByStatus": resolution_counts,
        "resolutionNeeded": resolution_needed,
        "shouldContinue": (
            any(
                status != "complete" and count > 0
                for status, count in counts.items()
            )
            or resolution_needed > 0
        ),
    }


def _table_exists(connection: sqlite3.Connection, name: str) -> bool:
    return (
        connection.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type='table' AND name=?
            """,
            (name,),
        ).fetchone()
        is not None
    )


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
