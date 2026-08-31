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
    infer_iso_date,
)


def infer_published_at(value: str) -> str | None:
    if not hostname_in(value, "bloomberg.com"):
        return None
    return infer_iso_date(
        value,
        r"/articles/(20\d{2})-(\d{2})-(\d{2})(?:/|$)",
        r"-(20\d{2})-(\d{2})-(\d{2})(?:/|$)",
    )


def common_crawl_identity(value: str) -> str | None:
    if not hostname_in(value, "bloomberg.com"):
        return None
    path = urlsplit(value).path.rstrip("/")
    legacy = re.fullmatch(
        r"/news/(?P<date>\d{4}-\d{2}-\d{2})/(?P<slug>[^/]+)\.html",
        path,
    )
    if legacy is not None:
        path = f"/news/{legacy.group('date')}/{legacy.group('slug')}"
    current = re.fullmatch(
        r"/news/articles/(?P<date>\d{4}-\d{2}-\d{2})/(?P<slug>[^/]+)",
        path,
    )
    if current is not None:
        path = f"/news/{current.group('date')}/{current.group('slug')}"
    return path


def sitemap_rows(
    connection: sqlite3.Connection,
):
    has_partner = connection.execute(
        "SELECT 1 FROM sqlite_master "
        "WHERE type='table' AND name='bloomberg_bnn_articles'"
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
               COALESCE(partner.published_at, sitemap.published_at),
               partner.archive_url, partner.expected_headline
        FROM sitemap_articles AS sitemap
        LEFT JOIN bloomberg_bnn_articles AS partner
          ON partner.canonical_url=sitemap.canonical_url
        UNION ALL
        SELECT partner.canonical_url, partner.published_at,
               partner.archive_url, partner.expected_headline
        FROM bloomberg_bnn_articles AS partner
        LEFT JOIN sitemap_articles AS sitemap
          ON sitemap.canonical_url=partner.canonical_url
        WHERE sitemap.canonical_url IS NULL
        ORDER BY 1
        """
    ):
        yield SitemapArticleRow(*row)


HOOKS = SourceDiscoveryHooks(
    publisher="bloomberg",
    owns_url=lambda value: hostname_in(value, "bloomberg.com"),
    sitemap_sources=(
        SitemapSource(
            key="bloomberg",
            publisher="bloomberg",
            index_url="https://www.bloomberg.com/sitemaps/news/index.xml",
            child_pattern=re.compile(r"/(20\d{2})-(\d{1,2})\.xml$"),
            child_date=first_day_of_match,
        ),
    ),
    infer_published_at=infer_published_at,
    common_crawl_identity=common_crawl_identity,
    sitemap_rows=sitemap_rows,
)
