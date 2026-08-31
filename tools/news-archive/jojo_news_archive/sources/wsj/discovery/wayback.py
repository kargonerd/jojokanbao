from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable
from xml.etree import ElementTree
import re
import sqlite3

import httpx

from jojo_news_archive.sources.registry import (
    ArchiveSourceSpec,
    archive_source_spec,
    normalize_article_url,
)
from jojo_news_archive.discovery.client import GlobalRateLimiter
from jojo_news_archive.discovery.wayback import (
    GOOGLE_NEWS_RSS_ENDPOINT,
    PARSER_VALIDATION_CATALOG_MINIMUM_PER_YEAR,
    candidate_rank,
    decode_google_news_url as _decode_google_news_url,
    infer_published_at,
    parse_iso_datetime as _parse_iso_datetime,
    parse_rss_datetime as _parse_rss_datetime,
    table_exists as _table_exists,
    utc_now_iso as _now_iso,
)

from jojo_news_archive.sources.wsj.discovery.infini import (
    wsj_infini_articles,
    wsj_infini_capture_candidates,
    wsj_infini_should_continue,
    wsj_infini_summary,
)
from jojo_news_archive.sources.wsj.discovery.infini_direct import (
    wsj_infini_direct_capture_candidates,
    wsj_infini_direct_should_continue,
    wsj_infini_direct_summary,
)
from jojo_news_archive.sources.wsj.discovery.syndication import (
    wsj_syndication_articles,
    wsj_syndication_should_continue,
    wsj_syndication_summary,
)


WSJ_BLUESKY_ENDPOINT = (
    "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed"
)


WSJ_BLUESKY_START_YEAR = 2024


WSJ_CATALOG_TARGET_PER_YEAR = 750


WSJ_GOOGLE_NEWS_YEARS = (2023, 2024)


WSJ_GOOGLE_NEWS_MINIMUM_CATALOG = 750


WSJ_GOOGLE_NEWS_MAXIMUM_DECODES = 100


WSJ_RSS_ENDPOINTS = (
    "https://feeds.content.dowjones.io/public/rss/RSSOpinion",
    "https://feeds.content.dowjones.io/public/rss/RSSWorldNews",
    "https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness",
    "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain",
    "https://feeds.content.dowjones.io/public/rss/RSSWSJD",
    "https://feeds.content.dowjones.io/public/rss/RSSLifestyle",
    "https://feeds.content.dowjones.io/public/rss/RSSUSnews",
    "https://feeds.content.dowjones.io/public/rss/socialpoliticsfeed",
    "https://feeds.content.dowjones.io/public/rss/socialeconomyfeed",
    "https://feeds.content.dowjones.io/public/rss/RSSArtsCulture",
    "https://feeds.content.dowjones.io/public/rss/latestnewsrealestate",
    "https://feeds.content.dowjones.io/public/rss/RSSPersonalFinance",
    "https://feeds.content.dowjones.io/public/rss/socialhealth",
    "https://feeds.content.dowjones.io/public/rss/RSSStyle",
    "https://feeds.content.dowjones.io/public/rss/rsssportsfeed",
)


WSJ_LEGACY_DATE_HYDRATIONS_PER_RUN = 100


def initialize_wsj_legacy_date_schema(
    connection: sqlite3.Connection,
) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS wsj_legacy_date_hydration (
            canonical_url TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            published_at TEXT,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_wsj_legacy_date_status
            ON wsj_legacy_date_hydration(status, attempts, updated_at);
        """
    )
    undated_urls = [
        (str(row[0]), _now_iso())
        for row in connection.execute(
            "SELECT DISTINCT canonical_url FROM candidates"
        )
        if infer_published_at(str(row[0])) is None
    ]
    connection.executemany(
        """
        INSERT OR IGNORE INTO wsj_legacy_date_hydration(
            canonical_url, updated_at
        ) VALUES (?, ?)
        """,
        undated_urls,
    )
    connection.execute(
        """
        DELETE FROM candidates
        WHERE canonical_url IN (
            SELECT canonical_url
            FROM wsj_legacy_date_hydration
            WHERE status='no-date'
        )
        """
    )
    connection.commit()


def process_wsj_legacy_dates(
    connection: sqlite3.Connection,
    *,
    http_client: httpx.Client,
    maximum: int = WSJ_LEGACY_DATE_HYDRATIONS_PER_RUN,
    minimum_request_interval: float = 0.0,
) -> dict[str, object]:
    """Replace capture-time guesses with dates embedded in legacy WSJ pages."""
    if maximum < 1:
        raise ValueError("maximum must be positive")
    initialize_wsj_legacy_date_schema(connection)
    rows = connection.execute(
        """
        SELECT hydration.canonical_url, candidate.timestamp,
               candidate.original_url
        FROM wsj_legacy_date_hydration AS hydration
        JOIN candidates AS candidate
          ON candidate.canonical_url=hydration.canonical_url
        WHERE hydration.status IN ('pending', 'retry')
          AND hydration.attempts < 3
          AND candidate.rowid=(
              SELECT selected.rowid
              FROM candidates AS selected
              WHERE selected.canonical_url=hydration.canonical_url
              ORDER BY selected.rank_score, selected.timestamp
              LIMIT 1
          )
        ORDER BY hydration.attempts, hydration.updated_at,
                 hydration.canonical_url
        LIMIT ?
        """,
        (maximum,),
    ).fetchall()
    limiter = GlobalRateLimiter(minimum_request_interval)
    found = 0
    rejected = 0
    errors: list[str] = []
    window = dict(
        connection.execute(
            """
            SELECT key, value FROM discovery_metadata
            WHERE key IN ('from_year', 'to_year')
            """
        )
    )
    for canonical_url, timestamp, original_url in rows:
        snapshot_url = (
            f"https://web.archive.org/web/{timestamp}id_/{original_url}"
        )
        status = "retry"
        published_at = None
        error = None
        try:
            limiter.wait()
            response = http_client.get(snapshot_url)
            response.raise_for_status()
            published_at = extract_wsj_legacy_published_at(response.text)
            if published_at is None:
                status = "no-date"
                rejected += 1
            else:
                status = "complete"
                found += 1
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            errors.append(f"{canonical_url}: {error}")
        with connection:
            connection.execute(
                """
                UPDATE wsj_legacy_date_hydration
                SET status=?, attempts=attempts+1, published_at=?,
                    last_error=?, updated_at=?
                WHERE canonical_url=?
                """,
                (
                    status,
                    published_at,
                    error,
                    _now_iso(),
                    canonical_url,
                ),
            )
            if published_at is not None:
                candidate_rows = connection.execute(
                    """
                    SELECT timestamp, digest FROM candidates
                    WHERE canonical_url=?
                    """,
                    (canonical_url,),
                ).fetchall()
                connection.executemany(
                    """
                    UPDATE candidates SET published_at=?, rank_score=?
                    WHERE canonical_url=? AND timestamp=? AND digest=?
                    """,
                    [
                        (
                            published_at,
                            candidate_rank(
                                str(candidate_timestamp),
                                published_at=published_at,
                            ),
                            canonical_url,
                            candidate_timestamp,
                            digest,
                        )
                        for candidate_timestamp, digest in candidate_rows
                    ],
                )
                if not (
                    f"{int(window['from_year']):04d}-01-01"
                    <= published_at
                    < f"{int(window['to_year']) + 1:04d}-01-01"
                ):
                    connection.execute(
                        "DELETE FROM candidates WHERE canonical_url=?",
                        (canonical_url,),
                    )
            elif status == "no-date":
                # A capture timestamp is not evidence of publication time.
                # Keeping this row would silently place an undated legacy
                # article in the year when Wayback happened to crawl it.
                connection.execute(
                    "DELETE FROM candidates WHERE canonical_url=?",
                    (canonical_url,),
                )
    remaining = connection.execute(
        """
        SELECT COUNT(*) FROM wsj_legacy_date_hydration
        WHERE status IN ('pending', 'retry') AND attempts < 3
        """
    ).fetchone()[0]
    return {
        "attempted": len(rows),
        "found": found,
        "noDate": rejected,
        "remaining": int(remaining),
        "errors": errors,
    }


def wsj_legacy_date_summary(
    connection: sqlite3.Connection,
) -> dict[str, int] | None:
    if not _table_exists(connection, "wsj_legacy_date_hydration"):
        return None
    row = connection.execute(
        """
        SELECT
            COUNT(*),
            SUM(status='complete'),
            SUM(status='no-date'),
            SUM(status IN ('pending', 'retry') AND attempts < 3)
        FROM wsj_legacy_date_hydration
        """
    ).fetchone()
    return {
        "total": int(row[0] or 0),
        "complete": int(row[1] or 0),
        "noDate": int(row[2] or 0),
        "remaining": int(row[3] or 0),
    }


def extract_wsj_legacy_published_at(html: str) -> str | None:
    patterns = (
        r"""publicationDate\s*[:=]\s*['"]([^'"]+)""",
        r"""property=['"]article:published_time['"][^>]*content=['"]([^'"]+)""",
        r"""name=['"]article\.published['"][^>]*content=['"]([^'"]+)""",
        r"""["']datePublished["']\s*:\s*["']([^"']+)""",
    )
    for pattern in patterns:
        match = re.search(pattern, html, flags=re.IGNORECASE)
        if match is None:
            continue
        value = _parse_iso_datetime(match.group(1))
        if value is not None and 1900 <= value.year <= 2100:
            return value.isoformat()
    return None


def initialize_wsj_bluesky_schema(
    connection: sqlite3.Connection,
) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS wsj_bluesky_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            cursor TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            pages INTEGER NOT NULL DEFAULT 0,
            posts_seen INTEGER NOT NULL DEFAULT 0,
            urls_accepted INTEGER NOT NULL DEFAULT 0,
            oldest_at TEXT,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wsj_bluesky_articles (
            canonical_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            post_uri TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    connection.execute(
        """
        INSERT OR IGNORE INTO wsj_bluesky_state(
            singleton,
            updated_at
        ) VALUES (1, ?)
        """,
        (_now_iso(),),
    )
    connection.execute(
        """
        UPDATE wsj_bluesky_state
        SET status='running',
            last_error='interrupted before completion',
            updated_at=?
        WHERE singleton=1 AND status='processing'
        """,
        (_now_iso(),),
    )
    connection.commit()


def initialize_wsj_rss_schema(
    connection: sqlite3.Connection,
) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS wsj_rss_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            polls INTEGER NOT NULL DEFAULT 0,
            feeds_checked INTEGER NOT NULL DEFAULT 0,
            items_seen INTEGER NOT NULL DEFAULT 0,
            urls_accepted INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wsj_rss_articles (
            canonical_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            feed_url TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    connection.execute(
        """
        INSERT OR IGNORE INTO wsj_rss_state(
            singleton,
            updated_at
        ) VALUES (1, ?)
        """,
        (_now_iso(),),
    )
    connection.commit()


def initialize_wsj_google_news_schema(
    connection: sqlite3.Connection,
) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS wsj_google_news_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            status TEXT NOT NULL DEFAULT 'pending',
            polls INTEGER NOT NULL DEFAULT 0,
            items_seen INTEGER NOT NULL DEFAULT 0,
            decodes_attempted INTEGER NOT NULL DEFAULT 0,
            urls_accepted INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wsj_google_news_articles (
            canonical_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            google_news_url TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    connection.execute(
        """
        INSERT OR IGNORE INTO wsj_google_news_state(
            singleton,
            updated_at
        ) VALUES (1, ?)
        """,
        (_now_iso(),),
    )
    connection.commit()


def wsj_google_news_should_continue(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
    minimum_catalog: int = WSJ_GOOGLE_NEWS_MINIMUM_CATALOG,
) -> bool:
    initialize_wsj_google_news_schema(connection)
    if (
        _wsj_google_news_target_year(
            connection,
            from_year=from_year,
            to_year=to_year,
            minimum_catalog=minimum_catalog,
        )
        is None
    ):
        with connection:
            connection.execute(
                """
                UPDATE wsj_google_news_state
                SET status='complete-target-met',
                    last_error=NULL,
                    updated_at=?
                WHERE singleton=1
                """,
                (_now_iso(),),
            )
        return False
    # A previous release may have persisted complete-target-met after filling
    # only one historical year. Reopen until every supported gap year has the
    # parser-QA reserve.
    return True


def wsj_google_news_is_only_catalog_gap(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
    minimum_catalog: int = WSJ_GOOGLE_NEWS_MINIMUM_CATALOG,
) -> bool:
    gap_years = {
        year
        for year in range(from_year, to_year + 1)
        if wsj_catalog_count_for_year(connection, year) < minimum_catalog
    }
    return bool(gap_years) and gap_years.issubset(WSJ_GOOGLE_NEWS_YEARS)


def process_wsj_google_news_feed(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    http_client: httpx.Client,
    from_year: int,
    to_year: int,
    maximum_decodes: int = WSJ_GOOGLE_NEWS_MAXIMUM_DECODES,
    minimum_catalog: int = WSJ_GOOGLE_NEWS_MINIMUM_CATALOG,
) -> dict[str, object]:
    if spec.publisher != "wsj":
        raise ValueError("Google News discovery is only supported for WSJ")
    if maximum_decodes < 1:
        raise ValueError("maximum_decodes must be positive")
    initialize_wsj_google_news_schema(connection)
    polls = int(
        connection.execute(
            "SELECT polls FROM wsj_google_news_state WHERE singleton=1"
        ).fetchone()[0]
    )
    target_year = _wsj_google_news_target_year(
        connection,
        from_year=from_year,
        to_year=to_year,
        minimum_catalog=minimum_catalog,
    )
    if target_year is None:
        return {
            "status": "complete-target-met",
            "targetYear": None,
            "itemsSeen": 0,
            "decodesAttempted": 0,
            "accepted": 0,
            "catalogCount": None,
            "errors": [],
        }
    month = polls % 12 + 1
    window_start = f"{target_year:04d}-{month:02d}-01"
    if month == 12:
        window_end = f"{target_year + 1:04d}-01-01"
    else:
        window_end = f"{target_year:04d}-{month + 1:02d}-01"
    query = (
        "site:wsj.com/articles "
        f"after:{window_start} before:{window_end}"
    )
    response = http_client.get(
        GOOGLE_NEWS_RSS_ENDPOINT,
        params={
            "q": query,
            "hl": "en-US",
            "gl": "US",
            "ceid": "US:en",
        },
    )
    response.raise_for_status()
    root = ElementTree.fromstring(response.content)
    items = root.findall("./channel/item")
    rows: list[tuple[str, str, str, str]] = []
    errors: list[str] = []
    decodes_attempted = 0
    for item in items:
        if decodes_attempted >= maximum_decodes:
            break
        published_at = _parse_rss_datetime(item.findtext("pubDate"))
        if (
            published_at is None
            or published_at.year != target_year
            or not from_year <= published_at.year <= to_year
        ):
            continue
        google_news_url = (item.findtext("link") or "").strip()
        if not google_news_url:
            continue
        decodes_attempted += 1
        try:
            original_url = _decode_google_news_url(
                http_client,
                google_news_url,
            )
            canonical_url = normalize_article_url(spec, original_url)
            if canonical_url is None:
                raise ValueError("decoded URL is not a WSJ article")
            rows.append(
                (
                    canonical_url,
                    published_at.isoformat(),
                    google_news_url,
                    _now_iso(),
                )
            )
        except Exception as exc:
            errors.append(f"{type(exc).__name__}: {exc}")
    with connection:
        before = connection.total_changes
        connection.executemany(
            """
            INSERT INTO wsj_google_news_articles(
                canonical_url,
                published_at,
                google_news_url,
                updated_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(canonical_url) DO UPDATE SET
                published_at=MIN(
                    wsj_google_news_articles.published_at,
                    excluded.published_at
                ),
                google_news_url=excluded.google_news_url,
                updated_at=excluded.updated_at
            """,
            rows,
        )
        accepted = connection.total_changes - before
        catalog_count = wsj_catalog_count_for_year(
            connection,
            target_year,
        )
        status = (
            "complete-target-met"
            if _wsj_google_news_target_year(
                connection,
                from_year=from_year,
                to_year=to_year,
                minimum_catalog=minimum_catalog,
            )
            is None
            else "partial"
        )
        connection.execute(
            """
            UPDATE wsj_google_news_state
            SET status=?,
                polls=polls+1,
                items_seen=items_seen+?,
                decodes_attempted=decodes_attempted+?,
                urls_accepted=urls_accepted+?,
                last_error=?,
                updated_at=?
            WHERE singleton=1
            """,
            (
                status,
                len(items),
                decodes_attempted,
                accepted,
                "; ".join(errors[-5:]) if errors else None,
                _now_iso(),
            ),
        )
    return {
        "status": status,
        "targetYear": target_year,
        "itemsSeen": len(items),
        "decodesAttempted": decodes_attempted,
        "accepted": accepted,
        "catalogCount": catalog_count,
        "errors": errors,
    }


def _wsj_google_news_target_year(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
    minimum_catalog: int,
) -> int | None:
    years = [
        year
        for year in WSJ_GOOGLE_NEWS_YEARS
        if from_year <= year <= to_year
        and wsj_catalog_count_for_year(connection, year) < minimum_catalog
    ]
    if not years:
        return None
    return min(
        years,
        key=lambda year: (wsj_catalog_count_for_year(connection, year), year),
    )


def process_wsj_rss_feeds(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    http_client: httpx.Client,
    from_year: int,
    to_year: int,
    feed_urls: Iterable[str] = WSJ_RSS_ENDPOINTS,
) -> dict[str, object]:
    if spec.publisher != "wsj":
        raise ValueError("RSS discovery is only supported for WSJ")
    initialize_wsj_rss_schema(connection)
    rows: list[tuple[str, str, str, str]] = []
    feeds_checked = 0
    items_seen = 0
    errors: list[str] = []
    for feed_url in feed_urls:
        try:
            response = http_client.get(feed_url)
            response.raise_for_status()
            root = ElementTree.fromstring(response.content)
            items = root.findall("./channel/item")
            feeds_checked += 1
            items_seen += len(items)
            for item in items:
                original_url = (
                    (item.findtext("link") or "").strip()
                    or (item.findtext("guid") or "").strip()
                )
                canonical_url = normalize_article_url(spec, original_url)
                if canonical_url is None:
                    continue
                published_at = _parse_rss_datetime(
                    item.findtext("pubDate")
                )
                if published_at is None:
                    continue
                if not from_year <= published_at.year <= to_year:
                    continue
                rows.append(
                    (
                        canonical_url,
                        published_at.isoformat(),
                        feed_url,
                        _now_iso(),
                    )
                )
        except Exception as exc:
            errors.append(
                f"{feed_url}: {type(exc).__name__}: {exc}"
            )
    with connection:
        before = connection.total_changes
        connection.executemany(
            """
            INSERT OR IGNORE INTO wsj_rss_articles(
                canonical_url,
                published_at,
                feed_url,
                updated_at
            ) VALUES (?, ?, ?, ?)
            """,
            rows,
        )
        accepted = connection.total_changes - before
        connection.execute(
            """
            UPDATE wsj_rss_state
            SET polls=polls+1,
                feeds_checked=feeds_checked+?,
                items_seen=items_seen+?,
                urls_accepted=urls_accepted+?,
                last_error=?,
                updated_at=?
            WHERE singleton=1
            """,
            (
                feeds_checked,
                items_seen,
                accepted,
                "; ".join(errors) if errors else None,
                _now_iso(),
            ),
        )
    return {
        "feedsChecked": feeds_checked,
        "itemsSeen": items_seen,
        "accepted": accepted,
        "errors": errors,
    }


def wsj_bluesky_should_continue(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
) -> bool:
    initialize_wsj_bluesky_schema(connection)
    first_year = max(from_year, WSJ_BLUESKY_START_YEAR)
    last_year = min(to_year, datetime.now(timezone.utc).year)
    if first_year > last_year:
        return False
    if all(
        wsj_catalog_count_for_year(connection, year)
        >= WSJ_CATALOG_TARGET_PER_YEAR
        for year in range(first_year, last_year + 1)
    ):
        with connection:
            connection.execute(
                """
                UPDATE wsj_bluesky_state
                SET status='complete-target-met',
                    last_error=NULL,
                    updated_at=?
                WHERE singleton=1
                """,
                (_now_iso(),),
            )
        return False
    status = connection.execute(
        "SELECT status FROM wsj_bluesky_state WHERE singleton=1"
    ).fetchone()[0]
    return not str(status).startswith("complete")


def process_wsj_bluesky_page(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    http_client: httpx.Client,
    from_year: int,
    to_year: int,
) -> dict[str, object]:
    if spec.publisher != "wsj":
        raise ValueError("Bluesky discovery is only supported for WSJ")
    initialize_wsj_bluesky_schema(connection)
    cursor = connection.execute(
        "SELECT cursor FROM wsj_bluesky_state WHERE singleton=1"
    ).fetchone()[0]
    with connection:
        connection.execute(
            """
            UPDATE wsj_bluesky_state
            SET status='processing',
                last_error=NULL,
                updated_at=?
            WHERE singleton=1
            """,
            (_now_iso(),),
        )
    try:
        parameters = {
            "actor": "wsj.com",
            "limit": "100",
            "filter": "posts_with_links",
        }
        if cursor:
            parameters["cursor"] = str(cursor)
        response = http_client.get(
            WSJ_BLUESKY_ENDPOINT,
            params=parameters,
        )
        response.raise_for_status()
        payload = response.json()
        feed = payload.get("feed")
        if not isinstance(feed, list):
            raise ValueError("WSJ Bluesky response has no feed list")
        next_cursor = payload.get("cursor")
        rows: list[tuple[str, str, str, str]] = []
        post_dates: list[datetime] = []
        for item in feed:
            if not isinstance(item, dict):
                continue
            post = item.get("post")
            if not isinstance(post, dict):
                continue
            record = post.get("record")
            if not isinstance(record, dict):
                continue
            created_at = _parse_iso_datetime(record.get("createdAt"))
            if created_at is None:
                continue
            post_dates.append(created_at)
            embed = post.get("embed")
            if not isinstance(embed, dict):
                continue
            external = embed.get("external")
            if not isinstance(external, dict):
                continue
            original_url = external.get("uri")
            if not isinstance(original_url, str):
                continue
            canonical_url = normalize_article_url(spec, original_url)
            if canonical_url is None:
                continue
            if not from_year <= created_at.year <= to_year:
                continue
            post_uri = str(post.get("uri") or "")
            rows.append(
                (
                    canonical_url,
                    created_at.isoformat(),
                    post_uri,
                    _now_iso(),
                )
            )
        with connection:
            before = connection.total_changes
            connection.executemany(
                """
                INSERT INTO wsj_bluesky_articles(
                    canonical_url,
                    published_at,
                    post_uri,
                    updated_at
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(canonical_url) DO UPDATE SET
                    published_at=MIN(
                        wsj_bluesky_articles.published_at,
                        excluded.published_at
                    ),
                    post_uri=excluded.post_uri,
                    updated_at=excluded.updated_at
                """,
                rows,
            )
            accepted = connection.total_changes - before
            oldest = min(post_dates).isoformat() if post_dates else None
            first_year = max(from_year, WSJ_BLUESKY_START_YEAR)
            exhausted = (
                not feed
                or not next_cursor
                or (
                    bool(post_dates)
                    and min(post_dates).year < first_year
                )
            )
            status = "complete-history" if exhausted else "running"
            connection.execute(
                """
                UPDATE wsj_bluesky_state
                SET cursor=?,
                    status=?,
                    pages=pages+1,
                    posts_seen=posts_seen+?,
                    urls_accepted=urls_accepted+?,
                    oldest_at=COALESCE(?, oldest_at),
                    last_error=NULL,
                    updated_at=?
                WHERE singleton=1
                """,
                (
                    str(next_cursor) if next_cursor else None,
                    status,
                    len(feed),
                    accepted,
                    oldest,
                    _now_iso(),
                ),
            )
        target_met = not wsj_bluesky_should_continue(
            connection,
            from_year=from_year,
            to_year=to_year,
        )
        return {
            "status": (
                "complete-target-met"
                if target_met and not exhausted
                else status
            ),
            "seen": len(feed),
            "accepted": accepted,
            "oldestAt": oldest,
            "hasMore": not exhausted and not target_met,
        }
    except Exception as exc:
        with connection:
            connection.execute(
                """
                UPDATE wsj_bluesky_state
                SET status='error',
                    last_error=?,
                    updated_at=?
                WHERE singleton=1
                """,
                (f"{type(exc).__name__}: {exc}", _now_iso()),
            )
        raise


def wsj_catalog_count_for_year(
    connection: sqlite3.Connection,
    year: int,
    *,
    spec: ArchiveSourceSpec | None = None,
) -> int:
    hydration_filter = (
        """
          AND canonical_url NOT IN (
              SELECT canonical_url FROM archived_date_hydration
              WHERE status != 'complete'
          )
        """
        if _table_exists(connection, "archived_date_hydration")
        else ""
    )
    selects = [
        f"""
        SELECT canonical_url
        FROM candidates
        WHERE substr(published_at, 1, 4)=?
        {hydration_filter}
        """
    ]
    parameters: list[object] = [str(year)]
    for table in (
        "wsj_bluesky_articles",
        "wsj_rss_articles",
        "wsj_google_news_articles",
    ):
        if not _table_exists(connection, table):
            continue
        selects.append(
            f"""
            SELECT canonical_url
            FROM {table}
            WHERE substr(published_at, 1, 4)=?
            """
        )
        parameters.append(str(year))
    if _table_exists(connection, "wsj_syndication_articles"):
        selects.append(
            """
            SELECT canonical_url
            FROM wsj_syndication_articles
            WHERE resolution_status='resolved'
              AND canonical_url IS NOT NULL
              AND substr(published_at, 1, 4)=?
            """
        )
        parameters.append(str(year))
    if _table_exists(connection, "wsj_infini_articles"):
        selects.append(
            """
            SELECT canonical_url
            FROM wsj_infini_articles
            WHERE substr(published_at, 1, 4)=?
            """
        )
        parameters.append(str(year))
    effective_spec = spec or archive_source_spec("wsj")
    return sum(
        normalize_article_url(effective_spec, str(canonical_url))
        == str(canonical_url)
        for (canonical_url,) in connection.execute(
            f"""
            SELECT DISTINCT canonical_url
            FROM (
                {" UNION ".join(selects)}
            )
            """,
            parameters,
        )
    )


def wsj_catalog_ready_for_capture(
    connection: sqlite3.Connection,
    *,
    from_year: int,
    to_year: int,
    minimum_catalog: int = PARSER_VALIDATION_CATALOG_MINIMUM_PER_YEAR,
    spec: ArchiveSourceSpec | None = None,
) -> bool:
    return all(
        wsj_catalog_count_for_year(connection, year, spec=spec)
        >= minimum_catalog
        for year in range(from_year, to_year + 1)
    )


def _wsj_external_articles(
    connection: sqlite3.Connection,
) -> dict[str, str]:
    result: dict[str, str] = {}
    for table in (
        "wsj_bluesky_articles",
        "wsj_rss_articles",
        "wsj_google_news_articles",
    ):
        if not _table_exists(connection, table):
            continue
        for canonical_url, published_at in connection.execute(
            f"""
            SELECT canonical_url, published_at
            FROM {table}
            ORDER BY canonical_url
            """
        ):
            previous = result.get(str(canonical_url))
            if previous is None or str(published_at) < previous:
                result[str(canonical_url)] = str(published_at)
    for canonical_url, article in wsj_syndication_articles(
        connection
    ).items():
        published_at = article["publishedAt"]
        previous = result.get(canonical_url)
        if previous is None or published_at < previous:
            result[canonical_url] = published_at
    for canonical_url, published_at in wsj_infini_articles(
        connection
    ).items():
        previous = result.get(canonical_url)
        if previous is None or published_at < previous:
            result[canonical_url] = published_at
    return result


def _wsj_syndication_candidate(
    article: dict[str, str],
) -> dict[str, object]:
    return {
        "provider": "other",
        "snapshotUrl": article["partnerUrl"],
        "expectedHeadline": article["expectedHeadline"],
    }
