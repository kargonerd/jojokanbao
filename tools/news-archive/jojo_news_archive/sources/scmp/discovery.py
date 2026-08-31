from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re

from bs4 import BeautifulSoup

from jojo_news_archive.sources.discovery_contracts import (
    SitemapSource,
    SourceDiscoveryHooks,
    extract_structured_published_at,
    hostname_in,
    infer_iso_date,
)

_MONTHS = {
    name: number
    for number, name in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"),
        start=1,
    )
}


def _child_date(match: re.Match[str]) -> tuple[int, int]:
    return int(match.group(1)), _MONTHS[match.group(2).casefold()]


def infer_published_at(value: str) -> str | None:
    if not hostname_in(value, "scmp.com"):
        return None
    return infer_iso_date(value, r"/(20\d{2})/(\d{2})/(\d{2})(?:/|$)")


def extract_archived_published_at(html: str) -> str | None:
    structured = extract_structured_published_at(html)
    if structured is not None:
        return structured
    soup = BeautifulSoup(html, "html.parser")
    node = soup.select_one(".pane-node-created .pane-content, .pane-node-created")
    value = " ".join(node.get_text(" ", strip=True).split()) if node else ""
    match = re.search(
        r"(?P<day>\d{1,2})\s+(?P<month>[A-Za-z]+),?\s+"
        r"(?P<year>20\d{2}),?\s+(?P<time>\d{1,2}:\d{2}\s*[ap]m)",
        value,
        flags=re.IGNORECASE,
    )
    if match is None:
        return None
    normalized = (
        f"{match.group('day')} {match.group('month')} "
        f"{match.group('year')} {match.group('time').replace(' ', '')}"
    )
    for format_string in ("%d %B %Y %I:%M%p", "%d %b %Y %I:%M%p"):
        try:
            parsed = datetime.strptime(normalized, format_string)
        except ValueError:
            continue
        return parsed.replace(tzinfo=timezone(timedelta(hours=8))).isoformat()
    return None


def preserve_hydration_order(connection, rows, from_year, to_year):
    del connection, from_year, to_year
    return rows


HOOKS = SourceDiscoveryHooks(
    publisher="scmp",
    owns_url=lambda value: hostname_in(value, "scmp.com"),
    sitemap_sources=(
        SitemapSource(
            key="scmp",
            publisher="scmp",
            index_url="https://www.scmp.com/sitemap/archives-0.xml",
            child_pattern=re.compile(
                r"/archives/articles/(20\d{2})_([a-z]{3})\.xml$",
                re.IGNORECASE,
            ),
            child_date=_child_date,
        ),
    ),
    infer_published_at=infer_published_at,
    archived_date_extractor=extract_archived_published_at,
    prefix_hydration_order=preserve_hydration_order,
)
