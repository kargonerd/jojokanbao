from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import re
import sqlite3
from typing import Any, Protocol
from urllib.parse import urlsplit

from jojo_news_archive.sources.contracts import ArchiveSourceSpec


DateMatchHook = Callable[[re.Match[str]], tuple[int, int]]
PublishedAtHook = Callable[[str], str | None]
ArchivedDateHook = Callable[[str], str | None]
PrefixPatternHook = Callable[[ArchiveSourceSpec, int, int], tuple[str, ...]]
PrefixPriorityHook = Callable[[str, str], int | None]
PrefixHydrationOrderHook = Callable[
    [sqlite3.Connection, list[tuple[Any, ...]], int, int],
    list[tuple[Any, ...]],
]
CommonCrawlIdentityHook = Callable[[str], str | None]


@dataclass(frozen=True)
class SitemapSource:
    """A publisher-owned sitemap adapter consumed by the shared XML engine."""

    key: str
    publisher: str
    index_url: str
    child_pattern: re.Pattern[str]
    child_date: DateMatchHook
    supplemental_index_urls: tuple[str, ...] = ()
    daily_child_pattern: re.Pattern[str] | None = None
    daily_child_date: DateMatchHook | None = None


@dataclass(frozen=True)
class SitemapArticleRow:
    canonical_url: str
    published_at: str | None
    partner_url: str | None = None
    expected_headline: str | None = None
    source_year: int | None = None
    document_index: int | None = None
    warc_source: str | None = None


class GhostarchiveUrlPolicy(Protocol):
    def is_article_url(self, value: str) -> bool: ...

    def same_article_url(self, first: str, second: str) -> bool: ...


SitemapRowsHook = Callable[
    [sqlite3.Connection], Iterable[SitemapArticleRow]
]
SitemapSourceUrlsHook = Callable[[str], tuple[str, ...]]
SitemapPartnerCandidatesHook = Callable[
    [SitemapArticleRow], list[dict[str, object]]
]
SitemapCandidateTransformHook = Callable[
    [str, str | None, list[dict[str, object]]], list[dict[str, object]]
]
WaybackManifestExporter = Callable[
    [sqlite3.Connection, ArchiveSourceSpec, Path, int, int, int],
    dict[str, int | bool | str | object],
]
WaybackSummaryHook = Callable[
    [sqlite3.Connection, dict[str, object]], dict[str, object]
]
WaybackQueryPriorityHook = Callable[[str, int, int], int]


@dataclass(frozen=True)
class SourceDiscoveryHooks:
    """One publisher's discovery policies and optional engine extensions."""

    publisher: str
    owns_url: Callable[[str], bool]
    sitemap_sources: tuple[SitemapSource, ...] = ()
    infer_published_at: PublishedAtHook | None = None
    archived_date_extractor: ArchivedDateHook | None = None
    prefix_patterns: PrefixPatternHook | None = None
    prefix_query_priority: PrefixPriorityHook | None = None
    prefix_hydration_order: PrefixHydrationOrderHook | None = None
    common_crawl_identity: CommonCrawlIdentityHook | None = None
    ghostarchive_policy: GhostarchiveUrlPolicy | None = None
    subscription_headline: Callable[[str | None], bool] | None = None
    sitemap_rows: SitemapRowsHook | None = None
    sitemap_source_urls: SitemapSourceUrlsHook | None = None
    sitemap_partner_candidates: SitemapPartnerCandidatesHook | None = None
    sitemap_candidate_transform: SitemapCandidateTransformHook | None = None
    wayback_manifest_exporter: WaybackManifestExporter | None = None
    wayback_summary: WaybackSummaryHook | None = None
    wayback_query_priority: WaybackQueryPriorityHook | None = None

    @property
    def supports_archived_date_hydration(self) -> bool:
        return self.archived_date_extractor is not None

    @property
    def supports_prefix_date_hydration(self) -> bool:
        return self.prefix_hydration_order is not None


def first_day_of_match(
    match: re.Match[str],
    *,
    year_group: int = 1,
    month_group: int = 2,
) -> tuple[int, int]:
    return int(match.group(year_group)), int(match.group(month_group))


def static_prefixes(
    *values: str,
) -> PrefixPatternHook:
    additions = tuple(values)

    def extend(
        spec: ArchiveSourceSpec,
        from_year: int,
        to_year: int,
    ) -> tuple[str, ...]:
        del spec, from_year, to_year
        return additions

    return extend


def hostname_in(value: str, *domains: str) -> bool:
    hostname = (urlsplit(value).hostname or "").casefold().removeprefix("www.")
    return hostname in {domain.casefold().removeprefix("www.") for domain in domains}


def infer_iso_date(
    value: str,
    *patterns: str,
) -> str | None:
    for pattern in patterns:
        match = re.search(pattern, value, flags=re.IGNORECASE)
        if match is None:
            continue
        try:
            parsed = datetime(
                int(match.group(1)),
                int(match.group(2)),
                int(match.group(3)),
                tzinfo=timezone.utc,
            )
        except ValueError:
            return None
        return parsed.isoformat()
    return None


def extract_structured_published_at(html: str) -> str | None:
    patterns = (
        r'''publicationDate\s*[:=]\s*['"]([^'"]+)''',
        r'''property=['"]article:published_time['"][^>]*content=['"]([^'"]+)''',
        r'''name=['"]article\.published['"][^>]*content=['"]([^'"]+)''',
        r'''["']datePublished["']\s*:\s*["']([^"']+)''',
    )
    for pattern in patterns:
        match = re.search(pattern, html, flags=re.IGNORECASE)
        if match is None:
            continue
        try:
            parsed = datetime.fromisoformat(
                match.group(1).strip().replace("Z", "+00:00")
            )
        except (TypeError, ValueError, OverflowError):
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        parsed = parsed.astimezone(timezone.utc)
        if 1900 <= parsed.year <= 2100:
            return parsed.isoformat()
    return None


__all__ = [
    "GhostarchiveUrlPolicy",
    "SitemapArticleRow",
    "SitemapSource",
    "SourceDiscoveryHooks",
    "first_day_of_match",
    "extract_structured_published_at",
    "hostname_in",
    "infer_iso_date",
    "static_prefixes",
]
