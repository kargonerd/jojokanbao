from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import html
import re
import sqlite3
import time
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

from bs4 import BeautifulSoup
import httpx

from .archive_sources import ArchiveSourceSpec, normalize_article_url


TOVIMA_POSTS_ENDPOINT = "https://www.tovima.com/wp-json/wp/v2/posts"
TOVIMA_CATEGORY_ID = 261
TOVIMA_PAGE_SIZE = 30
YAHOO_SEARCH_ENDPOINT = "https://search.yahoo.com/search"
YAHOO_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36"
)
GOOGLE_NEWS_RSS_ENDPOINT = "https://news.google.com/rss/search"
GOOGLE_NEWS_MAXIMUM_DECODES_PER_TITLE = 3
GOOGLE_NEWS_MAXIMUM_DATE_DELTA_DAYS = 14
RESOLVER_VERSION = "browser-yahoo-google-v2"
DEFAULT_CATALOG_PAGES_PER_RUN = 5
DEFAULT_RESOLUTIONS_PER_RUN = 100
_SIGNIFICANT_TOKEN_RE = re.compile(r"[a-z0-9]+")
_STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "has",
    "have",
    "in",
    "is",
    "it",
    "its",
    "of",
    "on",
    "or",
    "s",
    "that",
    "the",
    "this",
    "to",
    "was",
    "were",
    "will",
    "with",
}


def initialize_wsj_syndication_schema(
    connection: sqlite3.Connection,
) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS wsj_syndication_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            catalog_status TEXT NOT NULL DEFAULT 'pending',
            next_catalog_page INTEGER NOT NULL DEFAULT 1,
            catalog_pages INTEGER NOT NULL DEFAULT 0,
            posts_seen INTEGER NOT NULL DEFAULT 0,
            posts_accepted INTEGER NOT NULL DEFAULT 0,
            resolutions_attempted INTEGER NOT NULL DEFAULT 0,
            resolutions_succeeded INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wsj_syndication_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wsj_syndication_articles (
            partner_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            expected_headline TEXT NOT NULL,
            canonical_url TEXT,
            resolution_status TEXT NOT NULL DEFAULT 'pending',
            resolution_attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_wsj_syndication_resolution
            ON wsj_syndication_articles(
                resolution_status,
                published_at DESC
            );
        CREATE INDEX IF NOT EXISTS idx_wsj_syndication_canonical
            ON wsj_syndication_articles(canonical_url);
        """
    )
    connection.execute(
        """
        INSERT OR IGNORE INTO wsj_syndication_state(
            singleton,
            updated_at
        ) VALUES (1, ?)
        """,
        (_now_iso(),),
    )
    resolver_version = connection.execute(
        """
        SELECT value
        FROM wsj_syndication_metadata
        WHERE key='resolver_version'
        """
    ).fetchone()
    if resolver_version is None or str(resolver_version[0]) != (
        RESOLVER_VERSION
    ):
        connection.execute(
            """
            UPDATE wsj_syndication_articles
            SET resolution_status='pending',
                resolution_attempts=0,
                last_error=NULL,
                updated_at=?
            WHERE resolution_status='not-found'
            """,
            (_now_iso(),),
        )
        connection.execute(
            """
            INSERT INTO wsj_syndication_metadata(key, value)
            VALUES ('resolver_version', ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """,
            (RESOLVER_VERSION,),
        )
    connection.commit()


def process_wsj_syndication_catalog(
    connection: sqlite3.Connection,
    *,
    http_client: httpx.Client,
    from_year: int,
    to_year: int,
    maximum_pages: int = DEFAULT_CATALOG_PAGES_PER_RUN,
    minimum_request_interval: float = 0.0,
) -> dict[str, object]:
    if maximum_pages < 1:
        raise ValueError("maximum_pages must be positive")
    initialize_wsj_syndication_schema(connection)
    state = connection.execute(
        """
        SELECT catalog_status, next_catalog_page
        FROM wsj_syndication_state
        WHERE singleton=1
        """
    ).fetchone()
    if str(state[0]) == "complete":
        return {
            "status": "complete",
            "pages": 0,
            "seen": 0,
            "accepted": 0,
        }

    next_page = int(state[1])
    pages = 0
    seen = 0
    accepted = 0
    status = "running"
    while pages < maximum_pages:
        response = http_client.get(
            TOVIMA_POSTS_ENDPOINT,
            params={
                "categories": str(TOVIMA_CATEGORY_ID),
                "per_page": str(TOVIMA_PAGE_SIZE),
                "page": str(next_page),
                "_fields": "id,date,date_gmt,link,slug,title",
            },
        )
        if response.status_code == 400 and (
            "rest_post_invalid_page_number" in response.text
        ):
            status = "complete"
            break
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, list):
            raise ValueError("To Vima WSJ catalog response is not a list")
        pages += 1
        seen += len(payload)
        rows: list[tuple[str, str, str, str, str]] = []
        for post in payload:
            parsed = _tovima_catalog_row(
                post,
                from_year=from_year,
                to_year=to_year,
            )
            if parsed is not None:
                rows.append((*parsed, _now_iso()))
        with connection:
            before = connection.total_changes
            connection.executemany(
                """
                INSERT INTO wsj_syndication_articles(
                    partner_url,
                    published_at,
                    expected_headline,
                    updated_at
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(partner_url) DO UPDATE SET
                    published_at=excluded.published_at,
                    expected_headline=excluded.expected_headline,
                    updated_at=excluded.updated_at
                """,
                rows,
            )
            accepted += connection.total_changes - before
        next_page += 1
        if len(payload) < TOVIMA_PAGE_SIZE:
            status = "complete"
            break
        if minimum_request_interval:
            time.sleep(minimum_request_interval)

    with connection:
        connection.execute(
            """
            UPDATE wsj_syndication_state
            SET catalog_status=?,
                next_catalog_page=?,
                catalog_pages=catalog_pages+?,
                posts_seen=posts_seen+?,
                posts_accepted=posts_accepted+?,
                last_error=NULL,
                updated_at=?
            WHERE singleton=1
            """,
            (
                status,
                next_page,
                pages,
                seen,
                accepted,
                _now_iso(),
            ),
        )
    return {
        "status": status,
        "pages": pages,
        "seen": seen,
        "accepted": accepted,
    }


def process_wsj_syndication_resolutions(
    connection: sqlite3.Connection,
    *,
    spec: ArchiveSourceSpec,
    http_client: httpx.Client,
    maximum: int = DEFAULT_RESOLUTIONS_PER_RUN,
    minimum_request_interval: float = 0.0,
) -> dict[str, object]:
    if spec.publisher != "wsj":
        raise ValueError("WSJ syndication resolution requires the WSJ spec")
    if maximum < 1:
        raise ValueError("maximum must be positive")
    initialize_wsj_syndication_schema(connection)
    rows = connection.execute(
        """
        SELECT partner_url, published_at, expected_headline
        FROM wsj_syndication_articles
        WHERE resolution_status='pending'
           OR (
                resolution_status='error'
                AND resolution_attempts < 3
           )
        ORDER BY published_at DESC, partner_url
        LIMIT ?
        """,
        (maximum,),
    ).fetchall()
    attempted = 0
    resolved = 0
    not_found = 0
    errors: list[str] = []
    for partner_url, published_at, expected_headline in rows:
        attempted += 1
        try:
            canonical_url = resolve_wsj_original_url(
                str(expected_headline),
                expected_published_at=str(published_at),
                spec=spec,
                http_client=http_client,
            )
            resolution_status = (
                "resolved" if canonical_url else "not-found"
            )
            error = None
            resolved += canonical_url is not None
            not_found += canonical_url is None
        except Exception as exc:
            canonical_url = None
            resolution_status = "error"
            error = f"{type(exc).__name__}: {exc}"
            errors.append(f"{partner_url}: {error}")
        with connection:
            connection.execute(
                """
                UPDATE wsj_syndication_articles
                SET canonical_url=?,
                    resolution_status=?,
                    resolution_attempts=resolution_attempts+1,
                    last_error=?,
                    updated_at=?
                WHERE partner_url=?
                """,
                (
                    canonical_url,
                    resolution_status,
                    error,
                    _now_iso(),
                    partner_url,
                ),
            )
        if minimum_request_interval:
            time.sleep(minimum_request_interval)

    with connection:
        connection.execute(
            """
            UPDATE wsj_syndication_state
            SET resolutions_attempted=resolutions_attempted+?,
                resolutions_succeeded=resolutions_succeeded+?,
                last_error=?,
                updated_at=?
            WHERE singleton=1
            """,
            (
                attempted,
                resolved,
                "; ".join(errors[-5:]) if errors else None,
                _now_iso(),
            ),
        )
    return {
        "attempted": attempted,
        "resolved": resolved,
        "notFound": not_found,
        "errors": errors,
    }


def resolve_wsj_original_url(
    expected_headline: str,
    *,
    expected_published_at: str | None = None,
    spec: ArchiveSourceSpec,
    http_client: httpx.Client,
) -> str | None:
    try:
        yahoo_result = _resolve_wsj_original_url_from_yahoo(
            expected_headline,
            spec=spec,
            http_client=http_client,
        )
    except httpx.HTTPError:
        yahoo_result = None
    if yahoo_result is not None:
        return yahoo_result
    if expected_published_at is None:
        return None
    return _resolve_wsj_original_url_from_google_news(
        expected_headline,
        expected_published_at=expected_published_at,
        spec=spec,
        http_client=http_client,
    )


def _resolve_wsj_original_url_from_yahoo(
    expected_headline: str,
    *,
    spec: ArchiveSourceSpec,
    http_client: httpx.Client,
) -> str | None:
    expected_tokens = _significant_tokens(expected_headline)
    if len(expected_tokens) < 4:
        return None
    response = http_client.get(
        YAHOO_SEARCH_ENDPOINT,
        params={"p": f'"{expected_headline}" site:wsj.com'},
        headers={"User-Agent": YAHOO_USER_AGENT},
    )
    response.raise_for_status()
    soup = BeautifulSoup(response.content, "html.parser")
    ranked: list[tuple[float, float, int, str]] = []
    seen: set[str] = set()
    for position, result in enumerate(soup.select("#web li")):
        anchor = (
            result.select_one(".compTitle > a")
            or result.select_one("h3 a")
            or result.select_one("a")
        )
        heading = result.select_one("h3")
        if anchor is None or heading is None:
            continue
        decoded = _decode_yahoo_result(anchor.get("href"))
        canonical_url = (
            normalize_article_url(spec, decoded) if decoded else None
        )
        if canonical_url is None or canonical_url in seen:
            continue
        seen.add(canonical_url)
        result_title = _clean_search_title(
            heading.get_text(" ", strip=True)
        )
        result_tokens = _significant_tokens(result_title)
        title_coverage = (
            len(expected_tokens & result_tokens) / len(expected_tokens)
            if result_tokens
            else 0.0
        )
        slug = urlsplit(canonical_url).path.rstrip("/").rsplit("/", 1)[-1]
        slug = re.sub(
            r"-(?:[0-9a-f]{7,10}|\d{9,13})$",
            "",
            slug,
            flags=re.IGNORECASE,
        )
        slug_tokens = _significant_tokens(slug.replace("-", " "))
        slug_coverage = (
            len(expected_tokens & slug_tokens) / len(expected_tokens)
            if slug_tokens
            else 0.0
        )
        shared_title_tokens = len(expected_tokens & result_tokens)
        shared_slug_tokens = len(expected_tokens & slug_tokens)
        if not (
            (title_coverage >= 0.6 and shared_title_tokens >= 4)
            or (slug_coverage >= 0.75 and shared_slug_tokens >= 5)
        ):
            continue
        ranked.append(
            (
                title_coverage,
                slug_coverage,
                -position,
                canonical_url,
            )
        )
    if not ranked:
        return None
    ranked.sort(reverse=True)
    return ranked[0][3]


def _resolve_wsj_original_url_from_google_news(
    expected_headline: str,
    *,
    expected_published_at: str,
    spec: ArchiveSourceSpec,
    http_client: httpx.Client,
) -> str | None:
    expected_date = _parse_tovima_datetime(expected_published_at)
    expected_tokens = _significant_tokens(expected_headline)
    if expected_date is None or len(expected_tokens) < 4:
        return None
    response = http_client.get(
        GOOGLE_NEWS_RSS_ENDPOINT,
        params={
            "q": f"{_clean_search_title(expected_headline)} site:wsj.com",
            "hl": "en-US",
            "gl": "US",
            "ceid": "US:en",
        },
        headers={"User-Agent": YAHOO_USER_AGENT},
    )
    response.raise_for_status()
    root = ElementTree.fromstring(response.content)
    ranked: list[tuple[float, float, int, str]] = []
    seen: set[str] = set()
    decodes_attempted = 0
    for position, item in enumerate(root.findall("./channel/item")):
        result_tokens = _significant_tokens(
            _clean_search_title(item.findtext("title") or "")
        )
        shared = len(expected_tokens & result_tokens)
        coverage = (
            shared / len(expected_tokens) if result_tokens else 0.0
        )
        if coverage < 0.8 or shared < 4:
            continue
        try:
            published_at = parsedate_to_datetime(
                item.findtext("pubDate") or ""
            )
        except (TypeError, ValueError, OverflowError):
            continue
        if published_at.tzinfo is None:
            published_at = published_at.replace(tzinfo=timezone.utc)
        date_delta_seconds = abs(
            (
                published_at.astimezone(timezone.utc) - expected_date
            ).total_seconds()
        )
        if date_delta_seconds > (
            GOOGLE_NEWS_MAXIMUM_DATE_DELTA_DAYS * 86_400
        ):
            continue
        google_news_url = (item.findtext("link") or "").strip()
        if not google_news_url:
            continue
        if decodes_attempted >= GOOGLE_NEWS_MAXIMUM_DECODES_PER_TITLE:
            break
        decodes_attempted += 1
        try:
            from .wayback_manifest import _decode_google_news_url

            decoded_url = _decode_google_news_url(
                http_client,
                google_news_url,
            )
        except (httpx.HTTPError, ValueError):
            continue
        canonical_url = normalize_article_url(spec, decoded_url)
        if canonical_url is None or canonical_url in seen:
            continue
        seen.add(canonical_url)
        ranked.append(
            (
                coverage,
                -date_delta_seconds,
                -position,
                canonical_url,
            )
        )
    if not ranked:
        return None
    ranked.sort(reverse=True)
    return ranked[0][3]


def wsj_syndication_articles(
    connection: sqlite3.Connection,
) -> dict[str, dict[str, str]]:
    if not _table_exists(connection, "wsj_syndication_articles"):
        return {}
    result: dict[str, dict[str, str]] = {}
    for (
        canonical_url,
        published_at,
        partner_url,
        expected_headline,
    ) in connection.execute(
        """
        SELECT
            canonical_url,
            published_at,
            partner_url,
            expected_headline
        FROM wsj_syndication_articles
        WHERE resolution_status='resolved'
          AND canonical_url IS NOT NULL
        ORDER BY canonical_url, published_at, partner_url
        """
    ):
        result.setdefault(
            str(canonical_url),
            {
                "publishedAt": str(published_at),
                "partnerUrl": str(partner_url),
                "expectedHeadline": str(expected_headline),
            },
        )
    return result


def wsj_syndication_count_for_year(
    connection: sqlite3.Connection,
    year: int,
) -> int:
    if not _table_exists(connection, "wsj_syndication_articles"):
        return 0
    return int(
        connection.execute(
            """
            SELECT COUNT(DISTINCT canonical_url)
            FROM wsj_syndication_articles
            WHERE resolution_status='resolved'
              AND canonical_url IS NOT NULL
              AND substr(published_at, 1, 4)=?
            """,
            (str(year),),
        ).fetchone()[0]
    )


def wsj_syndication_should_continue(
    connection: sqlite3.Connection,
) -> bool:
    if not _table_exists(connection, "wsj_syndication_state"):
        return False
    catalog_status = str(
        connection.execute(
            """
            SELECT catalog_status
            FROM wsj_syndication_state
            WHERE singleton=1
            """
        ).fetchone()[0]
    )
    unresolved = int(
        connection.execute(
            """
            SELECT COUNT(*)
            FROM wsj_syndication_articles
            WHERE resolution_status='pending'
               OR (
                    resolution_status='error'
                    AND resolution_attempts < 3
               )
            """
        ).fetchone()[0]
    )
    return catalog_status != "complete" or unresolved > 0


def wsj_syndication_summary(
    connection: sqlite3.Connection,
) -> dict[str, object] | None:
    if not _table_exists(connection, "wsj_syndication_state"):
        return None
    state = connection.execute(
        """
        SELECT
            catalog_status,
            next_catalog_page,
            catalog_pages,
            posts_seen,
            posts_accepted,
            resolutions_attempted,
            resolutions_succeeded,
            last_error
        FROM wsj_syndication_state
        WHERE singleton=1
        """
    ).fetchone()
    resolution_counts = dict(
        connection.execute(
            """
            SELECT resolution_status, COUNT(*)
            FROM wsj_syndication_articles
            GROUP BY resolution_status
            """
        ).fetchall()
    )
    return {
        "catalogStatus": str(state[0]),
        "nextCatalogPage": int(state[1]),
        "catalogPages": int(state[2]),
        "postsSeen": int(state[3]),
        "postsAccepted": int(state[4]),
        "resolutionsAttempted": int(state[5]),
        "resolutionsSucceeded": int(state[6]),
        "resolutionsByStatus": {
            str(key): int(value)
            for key, value in sorted(resolution_counts.items())
        },
        "lastError": state[7],
    }


def _tovima_catalog_row(
    value: object,
    *,
    from_year: int,
    to_year: int,
) -> tuple[str, str, str] | None:
    if not isinstance(value, dict):
        return None
    partner_url = str(value.get("link") or "").strip()
    parsed_url = urlsplit(partner_url)
    if (
        parsed_url.scheme != "https"
        or (parsed_url.hostname or "").casefold()
        not in {"tovima.com", "www.tovima.com"}
        or not parsed_url.path.startswith("/wsj/")
    ):
        return None
    raw_title = value.get("title")
    rendered_title = (
        raw_title.get("rendered")
        if isinstance(raw_title, dict)
        else None
    )
    if not isinstance(rendered_title, str):
        return None
    expected_headline = BeautifulSoup(
        html.unescape(rendered_title),
        "html.parser",
    ).get_text(" ", strip=True)
    if len(_significant_tokens(expected_headline)) < 4:
        return None
    published_at = _parse_tovima_datetime(
        value.get("date_gmt") or value.get("date")
    )
    if (
        published_at is None
        or not from_year <= published_at.year <= to_year
    ):
        return None
    return (
        partner_url,
        published_at.isoformat(),
        expected_headline,
    )


def _parse_tovima_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _decode_yahoo_result(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    match = re.search(r"/RU=([^/]+)/RK=", value)
    candidate_url = unquote(match.group(1)) if match else value
    parsed = urlsplit(candidate_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return candidate_url


def _clean_search_title(value: str) -> str:
    result = re.sub(
        r"\s+(?:[-|]\s*)?(?:The\s+)?Wall\s+Street\s+Journal\s*$",
        "",
        value.strip(),
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r"\s+(?:[-|]\s*)?WSJ(?:\.com)?\s*$",
        "",
        result,
        flags=re.IGNORECASE,
    )
    return re.sub(r"\s*(?:…|\.\.\.)\s*$", "", result).strip()


def _significant_tokens(value: str) -> set[str]:
    return {
        token
        for token in _SIGNIFICANT_TOKEN_RE.findall(value.casefold())
        if token not in _STOP_WORDS
    }


def _table_exists(
    connection: sqlite3.Connection,
    table: str,
) -> bool:
    return (
        connection.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type='table' AND name=?
            """,
            (table,),
        ).fetchone()
        is not None
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
