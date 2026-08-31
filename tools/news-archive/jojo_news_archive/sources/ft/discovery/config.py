from __future__ import annotations

import re
import sqlite3
from urllib.parse import urlsplit

from jojo_news_archive.sources.discovery_contracts import (
    SitemapArticleRow,
    SitemapSource,
    SourceDiscoveryHooks,
    first_day_of_match,
    hostname_in,
)
from jojo_news_archive.sources.ft.discovery import ghostarchive
from jojo_news_archive.sources.ft.discovery.infini_news import (
    is_ft_subscription_headline,
)


def sitemap_rows(connection: sqlite3.Connection):
    has_partner = connection.execute(
        "SELECT 1 FROM sqlite_master "
        "WHERE type='table' AND name='ft_syndication_articles'"
    ).fetchone() is not None
    if not has_partner:
        for canonical_url, published_at in connection.execute(
            "SELECT canonical_url, published_at FROM sitemap_articles "
            "ORDER BY canonical_url"
        ):
            yield SitemapArticleRow(str(canonical_url), published_at)
        return
    for row in connection.execute(
        """
        SELECT sitemap.canonical_url,
               COALESCE(syndication.published_at, sitemap.published_at),
               syndication.partner_url, syndication.expected_headline,
               syndication.source_year, syndication.document_index,
               syndication.warc_source
        FROM sitemap_articles AS sitemap
        LEFT JOIN ft_syndication_articles AS syndication
          ON syndication.canonical_url=sitemap.canonical_url
        UNION ALL
        SELECT syndication.canonical_url, syndication.published_at,
               syndication.partner_url, syndication.expected_headline,
               syndication.source_year, syndication.document_index,
               syndication.warc_source
        FROM ft_syndication_articles AS syndication
        LEFT JOIN sitemap_articles AS sitemap
          ON sitemap.canonical_url=syndication.canonical_url
        WHERE sitemap.canonical_url IS NULL
        ORDER BY 1
        """
    ):
        yield SitemapArticleRow(*row)


def sitemap_source_urls(canonical_url: str) -> tuple[str, ...]:
    parsed = urlsplit(canonical_url)
    if (
        (parsed.hostname or "").casefold() in {"ft.com", "www.ft.com"}
        and parsed.path.startswith("/content/")
    ):
        return f"https://amp.ft.com{parsed.path}", canonical_url
    return (canonical_url,)


def sitemap_partner_candidates(
    row: SitemapArticleRow,
) -> list[dict[str, object]]:
    from jojo_news_archive.discovery.infini_news import infini_news_row_url

    if not row.partner_url:
        return []
    base = {
        "provider": "other",
        "snapshotUrl": row.partner_url,
        **(
            {"expectedHeadline": row.expected_headline}
            if row.expected_headline
            else {}
        ),
    }
    result: list[dict[str, object]] = [base]
    if row.source_year is not None and row.document_index is not None:
        result.append(
            {
                "provider": "infini-news",
                "snapshotUrl": infini_news_row_url(
                    row.source_year,
                    row.document_index,
                ),
                "sourceUrl": row.partner_url,
                **(
                    {"expectedHeadline": row.expected_headline}
                    if row.expected_headline
                    else {}
                ),
                **(
                    {"warcFilename": row.warc_source}
                    if row.warc_source
                    else {}
                ),
            }
        )
    return result


def preserve_hydration_order(
    connection: sqlite3.Connection,
    rows: list[tuple[object, ...]],
    from_year: int,
    to_year: int,
) -> list[tuple[object, ...]]:
    del connection, from_year, to_year
    return rows


HOOKS = SourceDiscoveryHooks(
    publisher="ft",
    owns_url=lambda value: hostname_in(value, "ft.com"),
    sitemap_sources=(
        SitemapSource(
            key="ft",
            publisher="ft",
            index_url="https://www.ft.com/sitemaps/index.xml",
            child_pattern=re.compile(r"archive-(20\d{2})-(\d{1,2})\.xml$"),
            child_date=first_day_of_match,
        ),
    ),
    prefix_hydration_order=preserve_hydration_order,
    ghostarchive_policy=ghostarchive,
    subscription_headline=is_ft_subscription_headline,
    sitemap_rows=sitemap_rows,
    sitemap_source_urls=sitemap_source_urls,
    sitemap_partner_candidates=sitemap_partner_candidates,
)
