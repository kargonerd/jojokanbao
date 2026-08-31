from __future__ import annotations

import re
import sqlite3

from jojo_news_archive.sources.discovery_contracts import (
    SitemapArticleRow,
    SitemapSource,
    SourceDiscoveryHooks,
    first_day_of_match,
    hostname_in,
    infer_iso_date,
)

def infer_published_at(value: str) -> str | None:
    if not hostname_in(value, "nytimes.com"):
        return None
    return infer_iso_date(value, r"/(20\d{2})/(\d{2})/(\d{2})(?:/|$)")


def sitemap_rows(connection: sqlite3.Connection):
    has_partner = connection.execute(
        "SELECT 1 FROM sqlite_master "
        "WHERE type='table' AND name='nyt_syndication_articles'"
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
               COALESCE(sitemap.published_at, syndication.published_at),
               syndication.syndicated_url, syndication.headline
        FROM sitemap_articles AS sitemap
        LEFT JOIN nyt_syndication_articles AS syndication
          ON syndication.canonical_url=sitemap.canonical_url
        UNION ALL
        SELECT syndication.canonical_url, syndication.published_at,
               syndication.syndicated_url, syndication.headline
        FROM nyt_syndication_articles AS syndication
        LEFT JOIN sitemap_articles AS sitemap
          ON sitemap.canonical_url=syndication.canonical_url
        WHERE sitemap.canonical_url IS NULL
        ORDER BY 1
        """
    ):
        yield SitemapArticleRow(*row)


HOOKS = SourceDiscoveryHooks(
    publisher="nyt",
    owns_url=lambda value: hostname_in(value, "nytimes.com"),
    sitemap_sources=(
        SitemapSource(
            key="nyt",
            publisher="nyt",
            index_url="https://www.nytimes.com/sitemaps/new/sitemap.xml.gz",
            child_pattern=re.compile(
                r"sitemap-(20\d{2})-(\d{2})\.xml\.gz$"
            ),
            child_date=first_day_of_match,
        ),
    ),
    infer_published_at=infer_published_at,
    sitemap_rows=sitemap_rows,
)
