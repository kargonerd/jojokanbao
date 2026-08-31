from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re
import sqlite3

from bs4 import BeautifulSoup

from jojo_news_archive.sources.discovery_contracts import (
    SourceDiscoveryHooks,
    extract_structured_published_at,
    hostname_in,
)
from jojo_news_archive.sources.nikkei.discovery import _nikkei_article_year_hint


def extract_archived_published_at(html: str) -> str | None:
    structured = extract_structured_published_at(html)
    if structured is not None:
        return structured
    soup = BeautifulSoup(html, "html.parser")
    node = soup.select_one(".cmnc-publish")
    value = " ".join(node.get_text(" ", strip=True).split()) if node else ""
    match = re.search(
        r"(?P<year>20\d{2})\s*(?:/|年)\s*"
        r"(?P<month>\d{1,2})\s*(?:/|月)\s*"
        r"(?P<day>\d{1,2})(?:日)?",
        value,
    )
    if match is None:
        return None
    try:
        parsed = datetime(
            int(match.group("year")),
            int(match.group("month")),
            int(match.group("day")),
            tzinfo=timezone(timedelta(hours=9)),
        )
    except ValueError:
        return None
    return parsed.isoformat()


def order_prefix_hydration(
    connection: sqlite3.Connection,
    rows: list[tuple[object, ...]],
    from_year: int,
    to_year: int,
) -> list[tuple[object, ...]]:
    del connection
    midpoint = (from_year + to_year) // 2

    def key(row: tuple[object, ...]):
        year_hint = _nikkei_article_year_hint(str(row[0]))
        return (
            not (
                year_hint is not None
                and from_year <= year_hint <= to_year
            ),
            int(row[1]),
            abs(year_hint - midpoint) if year_hint is not None else 10_000,
        )

    return sorted(rows, key=key)


HOOKS = SourceDiscoveryHooks(
    publisher="nikkei",
    owns_url=lambda value: hostname_in(value, "nikkei.com"),
    archived_date_extractor=extract_archived_published_at,
    prefix_hydration_order=order_prefix_hydration,
)
