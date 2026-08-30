from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

import httpx
from dateutil.parser import isoparse

from .archive_sources import (
    ArchiveSourceSpec,
    archive_source_spec,
    normalize_article_url,
)
from .bloomberg_archive_download import GlobalRateLimiter
from .ft_syndication_catalog import infini_news_row_url
from .wayback_manifest import (
    MANIFEST_FORMAT_VERSION,
    discovered_wayback_articles,
    infer_published_at,
    with_current_year_live_fallback,
)


SITEMAP_DISCOVERY_VERSION = "jojo-sitemap-discovery/1"
RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
_BARE_XML_AMPERSAND = re.compile(
    r"&(?!#\d+;|#x[0-9a-fA-F]+;|[A-Za-z_:][A-Za-z0-9_.:-]*;)"
)
_ILLEGAL_XML_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


@dataclass(frozen=True)
class SitemapSource:
    publisher: str
    index_url: str
    child_pattern: re.Pattern[str]
    supplemental_index_urls: tuple[str, ...] = ()
    daily_child_pattern: re.Pattern[str] | None = None


SITEMAP_SOURCES = {
    "ap": SitemapSource(
        publisher="ap",
        index_url="https://apnews.com/ap-sitemap.xml",
        child_pattern=re.compile(r"ap-sitemap-(20\d{2})(\d{2})\.xml$"),
    ),
    "bloomberg": SitemapSource(
        publisher="bloomberg",
        index_url="https://www.bloomberg.com/sitemaps/news/index.xml",
        child_pattern=re.compile(r"/(20\d{2})-(\d{1,2})\.xml$"),
    ),
    "nyt": SitemapSource(
        publisher="nyt",
        index_url="https://www.nytimes.com/sitemaps/new/sitemap.xml.gz",
        child_pattern=re.compile(r"sitemap-(20\d{2})-(\d{2})\.xml\.gz$"),
    ),
    "ft": SitemapSource(
        publisher="ft",
        index_url="https://www.ft.com/sitemaps/index.xml",
        child_pattern=re.compile(r"archive-(20\d{2})-(\d{1,2})\.xml$"),
    ),
    "axios": SitemapSource(
        publisher="axios",
        index_url="https://www.axios.com/sitemap.xml",
        # The index also contains hundreds of local-edition sitemaps. Those
        # use /sitemaps/<city>/<month>-<year>.xml and are intentionally kept
        # out of the national Axios corpus. Match only the root-level monthly
        # archive files.
        child_pattern=re.compile(
            r"^/sitemaps/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(20\d{2})\.xml$",
            re.IGNORECASE,
        ),
    ),
    "axios-local": SitemapSource(
        publisher="axios",
        index_url="https://www.axios.com/sitemap.xml",
        # Axios publishes one monthly sitemap per local newsroom. Keep this
        # high-volume corpus isolated from the national sitemap checkpoint so
        # either source can be audited and resumed independently.
        child_pattern=re.compile(
            r"^/sitemaps/[^/]+/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(20\d{2})\.xml$",
            re.IGNORECASE,
        ),
    ),
    "aljazeera": SitemapSource(
        publisher="aljazeera",
        index_url=(
            "https://www.aljazeera.com/sitemaps/article-archive.xml"
        ),
        child_pattern=re.compile(
            r"/article-archive/(20\d{2})/(\d{2})\.xml$"
        ),
        supplemental_index_urls=(
            "https://www.aljazeera.com/sitemaps/article-new.xml",
        ),
        daily_child_pattern=re.compile(
            r"/article-new/(\d{2})-(\d{2})-(20\d{2})\.xml$"
        ),
    ),
    "zaobao": SitemapSource(
        publisher="zaobao",
        index_url="https://www.zaobao.com.sg/sitemap.xml",
        child_pattern=re.compile(r"/sitemap-(20\d{2})(\d{2})\.xml$"),
    ),
    "scmp": SitemapSource(
        publisher="scmp",
        index_url="https://www.scmp.com/sitemap/archives-0.xml",
        # SCMP publishes one official archive sitemap per calendar month.
        # The month is a three-letter English name rather than a number.
        child_pattern=re.compile(
            r"/archives/articles/(20\d{2})_([a-z]{3})\.xml$",
            re.IGNORECASE,
        ),
    ),
}


_MONTH_NAME_TO_NUMBER = {
    name: index
    for index, name in enumerate(
        (
            "jan", "feb", "mar", "apr", "may", "jun",
            "jul", "aug", "sep", "oct", "nov", "dec",
        ),
        start=1,
    )
}


class SitemapClient:
    def __init__(
        self,
        *,
        minimum_interval: float = 1.0,
        timeout: float = 90.0,
        attempts: int = 5,
        client: httpx.Client | None = None,
    ) -> None:
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

    def fetch_xml(self, url: str) -> bytes:
        last_status: int | None = None
        for attempt in range(self.attempts):
            self.rate_limiter.wait()
            try:
                response = self._client.get(url)
                last_status = response.status_code
                if response.status_code in RETRYABLE_STATUS_CODES:
                    raise RuntimeError(f"retryable HTTP {response.status_code}")
                response.raise_for_status()
                content = response.content
                if content[:2] == b"\x1f\x8b":
                    content = gzip.decompress(content)
                return content
            except (httpx.HTTPError, OSError, RuntimeError):
                if attempt + 1 >= self.attempts:
                    break
                time.sleep(min(30.0, 2.0**attempt))
        raise RuntimeError(
            f"sitemap request failed after {self.attempts} attempts"
            + (f" (last HTTP status {last_status})" if last_status else "")
        )


def sitemap_source(publisher: str) -> SitemapSource:
    try:
        return SITEMAP_SOURCES[publisher]
    except KeyError as exc:
        supported = ", ".join(sorted(SITEMAP_SOURCES))
        raise ValueError(
            f"publisher {publisher!r} has no historical sitemap adapter; "
            f"expected one of: {supported}"
        ) from exc


def parse_sitemap_index(
    content: bytes,
    *,
    source: SitemapSource,
    from_year: int,
    to_year: int,
) -> list[tuple[str, int, int]]:
    root = _parse_sitemap_xml(content)
    result: list[tuple[str, int, int]] = []
    for node in root.iter():
        if _local_name(node.tag) != "loc" or not node.text:
            continue
        url = node.text.strip()
        match = source.child_pattern.search(urlsplit(url).path)
        if match:
            if source.publisher == "axios":
                month = _MONTH_NAME_TO_NUMBER[match.group(1).casefold()]
                year = int(match.group(2))
            elif source.publisher == "scmp":
                year = int(match.group(1))
                month = _MONTH_NAME_TO_NUMBER[match.group(2).casefold()]
            else:
                year = int(match.group(1))
                month = int(match.group(2))
        elif source.daily_child_pattern is not None:
            daily_match = source.daily_child_pattern.search(
                urlsplit(url).path
            )
            if daily_match is None:
                continue
            month = int(daily_match.group(2))
            year = int(daily_match.group(3))
        else:
            continue
        if from_year <= year <= to_year and 1 <= month <= 12:
            result.append((url, year, month))
    return sorted(set(result), key=lambda value: (value[1], value[2], value[0]))


def parse_url_sitemap(content: bytes) -> list[tuple[str, str | None]]:
    root = _parse_sitemap_xml(content)
    result: list[tuple[str, str | None]] = []
    for entry in root:
        fields = {
            _local_name(child.tag): (child.text or "").strip()
            for child in entry
        }
        url = fields.get("loc")
        if url:
            result.append((url, fields.get("lastmod") or None))
    return result


def _parse_sitemap_xml(content: bytes) -> ET.Element:
    try:
        return ET.fromstring(content)
    except ET.ParseError:
        # A few historical publisher sitemaps contain an unescaped ampersand
        # in a URL or an XML-forbidden control byte. Repair only those two
        # well-defined defects and reject every other malformed document.
        text = content.decode("utf-8", errors="replace")
        repaired = _ILLEGAL_XML_CONTROL.sub("", text)
        repaired = _BARE_XML_AMPERSAND.sub("&amp;", repaired)
        return ET.fromstring(repaired)


def initialize_sitemap_schema(
    connection: sqlite3.Connection,
    *,
    source: SitemapSource,
    from_year: int,
    to_year: int,
    sitemap_index: bytes,
    supplemental_sitemap_indexes: tuple[bytes, ...] = (),
) -> None:
    connection.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;

        CREATE TABLE IF NOT EXISTS sitemap_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sitemap_queries (
            sitemap_url TEXT PRIMARY KEY,
            year INTEGER NOT NULL,
            month INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            rows_seen INTEGER NOT NULL DEFAULT 0,
            rows_accepted INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sitemap_articles (
            canonical_url TEXT PRIMARY KEY,
            published_at TEXT,
            source_sitemap TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    fingerprint_payload: dict[str, object] = {
        "publisher": source.publisher,
        "indexUrl": source.index_url,
        "fromYear": from_year,
        "toYear": to_year,
    }
    if source.supplemental_index_urls:
        fingerprint_payload["supplementalIndexUrls"] = (
            source.supplemental_index_urls
        )
    fingerprint = hashlib.sha256(
        json.dumps(
            fingerprint_payload,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    existing = connection.execute(
        "SELECT value FROM sitemap_metadata WHERE key='fingerprint'"
    ).fetchone()
    if existing and existing[0] != fingerprint:
        raise ValueError(
            "sitemap state belongs to a different publisher or date window"
        )
    connection.executemany(
        """
        INSERT INTO sitemap_metadata(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        {
            "schema_version": SITEMAP_DISCOVERY_VERSION,
            "publisher": source.publisher,
            "from_year": str(from_year),
            "to_year": str(to_year),
            "fingerprint": fingerprint,
        }.items(),
    )
    children = sorted(
        {
            child
            for index_content in (
                sitemap_index,
                *supplemental_sitemap_indexes,
            )
            for child in parse_sitemap_index(
                index_content,
                source=source,
                from_year=from_year,
                to_year=to_year,
            )
        },
        key=lambda value: (value[1], value[2], value[0]),
    )
    connection.executemany(
        """
        INSERT OR IGNORE INTO sitemap_queries(
            sitemap_url,
            year,
            month,
            updated_at
        ) VALUES (?, ?, ?, ?)
        """,
        [(url, year, month, _now_iso()) for url, year, month in children],
    )
    connection.commit()


def next_sitemap_query(
    connection: sqlite3.Connection,
) -> tuple[str, int, int] | None:
    row = connection.execute(
        """
        SELECT sitemap_url, year, month
        FROM sitemap_queries
        WHERE status != 'complete'
        ORDER BY year, month, sitemap_url
        LIMIT 1
        """
    ).fetchone()
    return (row[0], row[1], row[2]) if row else None


def record_sitemap(
    connection: sqlite3.Connection,
    *,
    publisher_spec: ArchiveSourceSpec,
    sitemap_url: str,
    year: int,
    month: int,
    content: bytes,
) -> dict[str, int]:
    entries = parse_url_sitemap(content)
    rows: list[tuple[str, str | None, str, str]] = []
    for original_url, last_modified in entries:
        canonical_url = normalize_article_url(publisher_spec, original_url)
        if not canonical_url:
            continue
        published_at = infer_published_at(canonical_url)
        if not published_at:
            published_at = _published_from_sitemap(
                last_modified,
                year=year,
                month=month,
            )
        rows.append(
            (
                canonical_url,
                published_at,
                sitemap_url,
                _now_iso(),
            )
        )
    with connection:
        before = connection.total_changes
        connection.executemany(
            """
            INSERT INTO sitemap_articles(
                canonical_url,
                published_at,
                source_sitemap,
                updated_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(canonical_url) DO UPDATE SET
                published_at=COALESCE(
                    sitemap_articles.published_at,
                    excluded.published_at
                ),
                source_sitemap=excluded.source_sitemap,
                updated_at=excluded.updated_at
            """,
            rows,
        )
        accepted = connection.total_changes - before
        connection.execute(
            """
            UPDATE sitemap_queries
            SET status='complete',
                rows_seen=?,
                rows_accepted=?,
                updated_at=?
            WHERE sitemap_url=?
            """,
            (len(entries), accepted, _now_iso(), sitemap_url),
        )
    return {"seen": len(entries), "accepted": accepted}


def export_sitemap_manifest(
    connection: sqlite3.Connection,
    *,
    publisher: str,
    destination: Path,
    from_year: int,
    to_year: int,
) -> dict[str, object]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    opener = gzip.open if destination.suffix == ".gz" else open
    articles = 0
    candidates = 0
    has_nyt_syndication = (
        publisher == "nyt"
        and connection.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type='table' AND name='nyt_syndication_articles'
            """
        ).fetchone()
        is not None
    )
    has_ft_syndication = (
        publisher == "ft"
        and connection.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type='table' AND name='ft_syndication_articles'
            """
        ).fetchone()
        is not None
    )
    has_bloomberg_bnn = (
        publisher == "bloomberg"
        and connection.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type='table' AND name='bloomberg_bnn_articles'
            """
        ).fetchone()
        is not None
    )
    if has_nyt_syndication:
        article_rows = connection.execute(
            """
            SELECT
                sitemap.canonical_url,
                COALESCE(sitemap.published_at, syndication.published_at),
                syndication.syndicated_url,
                syndication.headline
            FROM sitemap_articles AS sitemap
            LEFT JOIN nyt_syndication_articles AS syndication
              ON syndication.canonical_url=sitemap.canonical_url
            UNION ALL
            SELECT
                syndication.canonical_url,
                syndication.published_at,
                syndication.syndicated_url,
                syndication.headline
            FROM nyt_syndication_articles AS syndication
            LEFT JOIN sitemap_articles AS sitemap
              ON sitemap.canonical_url=syndication.canonical_url
            WHERE sitemap.canonical_url IS NULL
            ORDER BY 1
            """
        )
    elif has_bloomberg_bnn:
        article_rows = connection.execute(
            """
            SELECT
                sitemap.canonical_url,
                COALESCE(partner.published_at, sitemap.published_at),
                partner.archive_url,
                partner.expected_headline
            FROM sitemap_articles AS sitemap
            LEFT JOIN bloomberg_bnn_articles AS partner
              ON partner.canonical_url=sitemap.canonical_url
            UNION ALL
            SELECT
                partner.canonical_url,
                partner.published_at,
                partner.archive_url,
                partner.expected_headline
            FROM bloomberg_bnn_articles AS partner
            LEFT JOIN sitemap_articles AS sitemap
              ON sitemap.canonical_url=partner.canonical_url
            WHERE sitemap.canonical_url IS NULL
            ORDER BY 1
            """
        )
    elif has_ft_syndication:
        article_rows = connection.execute(
            """
            SELECT
                sitemap.canonical_url,
                COALESCE(syndication.published_at, sitemap.published_at),
                syndication.partner_url,
                syndication.expected_headline,
                syndication.source_year,
                syndication.document_index,
                syndication.warc_source
            FROM sitemap_articles AS sitemap
            LEFT JOIN ft_syndication_articles AS syndication
              ON syndication.canonical_url=sitemap.canonical_url
            UNION ALL
            SELECT
                syndication.canonical_url,
                syndication.published_at,
                syndication.partner_url,
                syndication.expected_headline,
                syndication.source_year,
                syndication.document_index,
                syndication.warc_source
            FROM ft_syndication_articles AS syndication
            LEFT JOIN sitemap_articles AS sitemap
              ON sitemap.canonical_url=syndication.canonical_url
            WHERE sitemap.canonical_url IS NULL
            ORDER BY 1
            """
        )
    else:
        article_rows = connection.execute(
            """
            SELECT canonical_url, published_at, NULL, NULL
            FROM sitemap_articles
            ORDER BY canonical_url
            """
        )
    exact_wayback = discovered_wayback_articles(
        connection,
        from_year=from_year,
        to_year=to_year,
    )
    with opener(temporary, "wt", encoding="utf-8") as handle:
        for article_row in article_rows:
            (
                canonical_url,
                published_at,
                syndicated_url,
                expected_headline,
            ) = article_row[:4]
            source_year = article_row[4] if len(article_row) > 4 else None
            document_index = (
                article_row[5] if len(article_row) > 5 else None
            )
            warc_source = article_row[6] if len(article_row) > 6 else None
            exact = exact_wayback.pop(str(canonical_url), None)
            if exact is not None and not published_at:
                published_at = exact[0]
            candidate_rows = sitemap_wayback_candidates(
                publisher,
                canonical_url,
                published_at=published_at,
            )
            if exact is not None:
                candidate_rows = _merge_manifest_candidates(
                    exact[1],
                    candidate_rows,
                )
            if syndicated_url:
                partner_candidates = [
                    {
                        "provider": "other",
                        "snapshotUrl": syndicated_url,
                        **(
                            {"expectedHeadline": expected_headline}
                            if expected_headline
                            else {}
                        ),
                    }
                ]
                if source_year is not None and document_index is not None:
                    partner_candidates.append(
                        {
                            "provider": "infini-news",
                            "snapshotUrl": infini_news_row_url(
                                int(source_year),
                                int(document_index),
                            ),
                            "sourceUrl": syndicated_url,
                            **(
                                {"expectedHeadline": expected_headline}
                                if expected_headline
                                else {}
                            ),
                            **(
                                {"warcFilename": warc_source}
                                if warc_source
                                else {}
                            ),
                        }
                    )
                candidate_rows = _merge_manifest_candidates(
                    partner_candidates,
                    candidate_rows,
                )
            row = {
                "formatVersion": MANIFEST_FORMAT_VERSION,
                "publisher": publisher,
                "canonicalUrl": canonical_url,
                **({"publishedAt": published_at} if published_at else {}),
                "candidates": candidate_rows,
            }
            handle.write(
                json.dumps(row, ensure_ascii=False, separators=(",", ":"))
                + "\n"
            )
            articles += 1
            candidates += len(candidate_rows)
        for canonical_url, (
            published_at,
            exact_candidates,
        ) in sorted(exact_wayback.items()):
            candidate_rows = _merge_manifest_candidates(
                exact_candidates,
                sitemap_wayback_candidates(
                    publisher,
                    canonical_url,
                    published_at=published_at,
                ),
            )
            row = {
                "formatVersion": MANIFEST_FORMAT_VERSION,
                "publisher": publisher,
                "canonicalUrl": canonical_url,
                **({"publishedAt": published_at} if published_at else {}),
                "candidates": candidate_rows,
            }
            handle.write(
                json.dumps(row, ensure_ascii=False, separators=(",", ":"))
                + "\n"
            )
            articles += 1
            candidates += len(candidate_rows)
    temporary.replace(destination)
    incomplete = connection.execute(
        "SELECT COUNT(*) FROM sitemap_queries WHERE status != 'complete'"
    ).fetchone()[0]
    return {
        "publisher": publisher,
        "fromYear": from_year,
        "toYear": to_year,
        "complete": incomplete == 0,
        "shouldContinue": incomplete > 0,
        "remainingSitemaps": incomplete,
        "articles": articles,
        "candidates": candidates,
        "manifest": str(destination),
    }


def sitemap_summary(connection: sqlite3.Connection) -> dict[str, object]:
    counts = dict(
        connection.execute(
            "SELECT status, COUNT(*) FROM sitemap_queries GROUP BY status"
        ).fetchall()
    )
    totals = connection.execute(
        """
        SELECT
            COALESCE(SUM(rows_seen), 0),
            COALESCE(SUM(rows_accepted), 0)
        FROM sitemap_queries
        """
    ).fetchone()
    articles = connection.execute(
        "SELECT COUNT(*) FROM sitemap_articles"
    ).fetchone()[0]
    return {
        "sitemapsByStatus": counts,
        "rowsSeen": int(totals[0]),
        "rowsAccepted": int(totals[1]),
        "articles": int(articles),
        "shouldContinue": any(
            status != "complete" and count > 0
            for status, count in counts.items()
        ),
    }


def wayback_candidates(
    canonical_url: str,
    *,
    published_at: str | None,
) -> list[dict[str, object]]:
    if published_at:
        try:
            base = isoparse(published_at)
        except (TypeError, ValueError, OverflowError):
            base = None
    else:
        base = None
    if base is None:
        return [
            {
                "provider": "wayback",
                "snapshotUrl": (
                    "https://web.archive.org/web/2id_/" + canonical_url
                ),
            }
        ]
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    result: list[dict[str, object]] = []
    for delta in (timedelta(days=1), timedelta(days=7), timedelta(days=30)):
        requested = (base + delta).astimezone(timezone.utc)
        timestamp = requested.strftime("%Y%m%d%H%M%S")
        result.append(
            {
                "provider": "wayback",
                "snapshotUrl": (
                    f"https://web.archive.org/web/{timestamp}id_/"
                    f"{canonical_url}"
                ),
            }
        )
    return result


def sitemap_wayback_candidates(
    publisher: str,
    canonical_url: str,
    *,
    published_at: str | None,
) -> list[dict[str, object]]:
    source_urls: list[str] = []
    parsed = urlsplit(canonical_url)
    if (
        publisher == "ft"
        and parsed.hostname in {"ft.com", "www.ft.com"}
        and parsed.path.startswith("/content/")
    ):
        source_urls.append(f"https://amp.ft.com{parsed.path}")
    source_urls.append(canonical_url)

    result: list[dict[str, object]] = []
    seen: set[str] = set()
    for source_url in source_urls:
        for candidate in wayback_candidates(
            source_url,
            published_at=published_at,
        ):
            snapshot_url = str(candidate["snapshotUrl"])
            if snapshot_url in seen:
                continue
            seen.add(snapshot_url)
            result.append(candidate)
    if publisher == "ap":
        return [
            {
                "provider": "live-origin",
                "snapshotUrl": canonical_url,
            },
            *result,
        ]
    return with_current_year_live_fallback(
        result,
        canonical_url=canonical_url,
        published_at=published_at,
    )


def _merge_manifest_candidates(
    primary: list[dict[str, object]],
    secondary: list[dict[str, object]],
) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    seen: set[str] = set()
    for candidate in [*primary, *secondary]:
        snapshot_url = str(candidate.get("snapshotUrl") or "")
        if not snapshot_url or snapshot_url in seen:
            continue
        seen.add(snapshot_url)
        result.append(candidate)
    return result


def _published_from_sitemap(
    value: str | None,
    *,
    year: int,
    month: int,
) -> str:
    if value:
        try:
            parsed = isoparse(value)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            # Archive sitemap lastmod values can be refreshed long after
            # publication. Accept them only when they match the sitemap month.
            if parsed.year == year and parsed.month == month:
                return parsed.isoformat()
        except (TypeError, ValueError, OverflowError):
            pass
    return datetime(year, month, 15, 12, tzinfo=timezone.utc).isoformat()


def _local_name(value: str) -> str:
    return value.rsplit("}", 1)[-1]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
