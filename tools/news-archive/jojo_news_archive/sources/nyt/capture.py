from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
import re
from urllib.parse import urlencode, urljoin, urlsplit
from bs4 import BeautifulSoup
from jojo_news_archive.capture.primitives import (
    SYNDICATION_SEARCH_ENDPOINT,
    expected_date_visible as _expected_date_visible,
    fetch_limited_archive as _fetch_limited_archive,
    headline_text_overlap as _headline_text_overlap,
    html_links_to_article as _html_links_to_article,
    is_public_syndication_url as _is_public_syndication_url,
    largest_distinct_timemap_candidates as _largest_distinct_timemap_candidates,
    parse_iso_datetime as _parse_iso_datetime,
    same_article_url as _same_article_url,
    significant_tokens as _significant_tokens,
    store_dependent_resource,
    yahoo_search_results as _yahoo_search_results,
)
from jojo_news_archive.discovery.client import ArchiveClient
from jojo_news_archive.models import ArticleStatus, CaptureCandidate, CaptureProvider, DependentResource
from jojo_news_archive.sources.capture_contracts import (
    ManifestItem,
    SourceCaptureHooks,
)


@dataclass(frozen=True)
class NytSyndicationDiscovery:
    expected_headline: str | None
    candidates: tuple[CaptureCandidate, ...]


select_timemap_candidates = _largest_distinct_timemap_candidates


def raw_shell_signals(
    *,
    sampled_content: bytes,
    prefix: bytes,
    final_url: str,
    has_article_marker: bool,
    has_strong_body_marker: bool,
) -> dict[str, object]:
    del sampled_content, final_url, has_strong_body_marker
    authentication = bool(
        not has_article_marker
        and (
            b'sourceapp" content="nyt-lire"' in prefix
            or b"/lire_ui/" in prefix
        )
    )
    redirect = b"<title>ny times advertisement</title>" in prefix
    return {
        "authenticationShell": authentication,
        "redirectShell": redirect,
        "penalize": authentication or redirect,
    }


def completed_rejection_reason(capture, *, content: bytes, signals: dict[str, object]) -> str | None:
    del signals
    if capture.selected_candidate.provider != CaptureProvider.OTHER:
        return None
    expected = capture.quality_signals.get("syndicationOriginalHeadline")
    valid, validation_signals = _validate_nyt_syndication_response(
        ManifestItem(
            publisher="nyt",
            canonical_url=capture.canonical_url,
            published_at=(capture.published_at.isoformat() if capture.published_at else None),
            section=capture.section,
            candidates=(),
        ),
        expected_headline=str(expected) if expected else None,
        content=content,
        final_url=capture.final_url,
    )
    if valid:
        return None
    return "nyt-syndication-" + str(
        validation_signals.get("reason") or "invalid-provenance"
    )


def validate_candidate_response(session, candidate: CaptureCandidate, response):
    if candidate.provider != CaptureProvider.OTHER:
        return response, None
    valid, evidence = _validate_nyt_syndication_response(
        session.item,
        expected_headline=candidate.expected_headline,
        content=response[2],
        final_url=response[3],
    )
    if not valid:
        return None, "nyt-syndication:validation:" + str(evidence.get("reason") or "failed")
    return (*response[:6], response[6] | evidence), None


def capture_dependent_resources(*args, **kwargs):
    return _capture_nyt_interactive_resources(*args, **kwargs)


def run_capture(session) -> None:
    synthetic_wayback_only = bool(
        session.enable_wayback_timemap_fallback
        and session.item.candidates
        and all(
            candidate.provider == CaptureProvider.WAYBACK
            for candidate in session.item.candidates
        )
        and not any(
            candidate.digest and candidate.captured_at is not None
            for candidate in session.item.candidates
        )
    )
    if synthetic_wayback_only:
        session.discover_wayback(session.item, maximum_candidates=8)
    if session.best_response is None:
        session.consider(session.item.candidates)
    session.consider_common_crawl()
    session.consider_wayback()
    if session.best_response is None:
        try:
            discovery = discover_nyt_syndication(
                session.item,
                archive_client=session.archive_client,
            )
        except Exception as exc:
            session.fail("nyt-syndication", exc)
            discovery = NytSyndicationDiscovery(None, ())
        candidates = tuple(
            candidate.model_copy(
                update={"expected_headline": candidate.expected_headline or discovery.expected_headline}
            )
            for candidate in discovery.candidates
        )
        session.consider(session.add_candidates(candidates))
    session.consider_arquivo()


NYT_SYNDICATION_SEARCH_ENDPOINT = SYNDICATION_SEARCH_ENDPOINT


NYT_SYNDICATION_SEARCH_MAXIMUM_BYTES = 2_000_000


NYT_SYNDICATION_MAXIMUM_CANDIDATES = 8


NYT_SYNDICATION_MINIMUM_BODY_CHARACTERS = 1_000


NYT_TRUSTED_WORDPRESS_ENDPOINTS = (
    "https://www.hawaiitribune-herald.com/wp-json/wp/v2/posts",
)


NYT_HEADLINE_WORDPRESS_ENDPOINTS = (
    "https://dnyuz.com/wp-json/wp/v2/posts",
)


def discover_nyt_syndication(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
) -> NytSyndicationDiscovery:
    for endpoint in NYT_TRUSTED_WORDPRESS_ENDPOINTS:
        try:
            trusted = _discover_nyt_trusted_wordpress_copy(
                item,
                endpoint=endpoint,
                archive_client=archive_client,
            )
        except Exception:
            trusted = None
        if trusted is not None:
            return trusted

    canonical_search_url = nyt_syndication_search_url(item)
    status_code, headers, content, _ = archive_client.fetch(
        canonical_search_url,
        maximum_bytes=NYT_SYNDICATION_SEARCH_MAXIMUM_BYTES,
    )
    content_type = headers.get("content-type", "").casefold()
    if status_code != 200 or not content:
        raise ValueError(
            f"NYT syndication search returned HTTP {status_code}"
        )
    if "html" not in content_type and b"<html" not in content[:1_000].lower():
        raise ValueError("NYT syndication search did not return HTML")

    soup = BeautifulSoup(content, "html.parser")
    expected_headline: str | None = None
    initial_results = _yahoo_search_results(
        soup, clean_title=_clean_nyt_search_result_title
    )
    for _, result_title, candidate_url in initial_results:
        if _same_article_url(candidate_url, item.canonical_url):
            if result_title:
                expected_headline = result_title
            break

    if (
        not expected_headline
        or len(_significant_tokens(expected_headline)) < 4
    ):
        return NytSyndicationDiscovery(
            expected_headline=None,
            candidates=(),
        )

    for endpoint in NYT_HEADLINE_WORDPRESS_ENDPOINTS:
        try:
            trusted = _discover_nyt_headline_wordpress_copy(
                item,
                expected_headline=expected_headline,
                endpoint=endpoint,
                archive_client=archive_client,
            )
        except Exception:
            trusted = None
        if trusted is not None:
            return trusted

    title_search_url = nyt_syndication_title_search_url(expected_headline)
    status_code, headers, content, _ = archive_client.fetch(
        title_search_url,
        maximum_bytes=NYT_SYNDICATION_SEARCH_MAXIMUM_BYTES,
    )
    content_type = headers.get("content-type", "").casefold()
    if status_code != 200 or not content:
        raise ValueError(
            f"NYT title search returned HTTP {status_code}"
        )
    if "html" not in content_type and b"<html" not in content[:1_000].lower():
        raise ValueError("NYT title search did not return HTML")
    title_results = _yahoo_search_results(
        BeautifulSoup(content, "html.parser"),
        clean_title=_clean_nyt_search_result_title,
    )

    ranked: list[tuple[float, int, str]] = []
    seen: set[str] = set()
    for position, result_title, candidate_url in (
        initial_results + title_results
    ):
        if (
            candidate_url in seen
            or not _is_public_syndication_url(
                candidate_url,
                excluded_publisher="nyt",
            )
        ):
            continue
        title_overlap = _headline_text_overlap(
            expected_headline,
            result_title,
        )
        if title_overlap < 0.55:
            continue
        seen.add(candidate_url)
        ranked.append((-title_overlap, position, candidate_url))
    ranked.sort()
    return NytSyndicationDiscovery(
        expected_headline=expected_headline,
        candidates=tuple(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=candidate_url,
            )
            for _, _, candidate_url in ranked[
                :NYT_SYNDICATION_MAXIMUM_CANDIDATES
            ]
        ),
    )


def _discover_nyt_trusted_wordpress_copy(
    item: ManifestItem,
    *,
    endpoint: str,
    archive_client: ArchiveClient,
) -> NytSyndicationDiscovery | None:
    search_url = nyt_trusted_wordpress_search_url(
        item,
        endpoint=endpoint,
    )
    status_code, headers, content, _ = _fetch_limited_archive(
        archive_client,
        search_url,
        maximum_bytes=NYT_SYNDICATION_SEARCH_MAXIMUM_BYTES,
        attempts=2,
        timeout=35.0,
    )
    content_type = headers.get("content-type", "").casefold()
    if status_code != 200 or not content:
        raise ValueError(
            f"trusted NYT syndication search returned HTTP {status_code}"
        )
    if "json" not in content_type and not content.lstrip().startswith(b"["):
        raise ValueError(
            "trusted NYT syndication search did not return JSON"
        )
    payload = json.loads(content)
    if not isinstance(payload, list):
        raise ValueError("trusted NYT syndication response is invalid")
    expected_date = _parse_iso_datetime(item.published_at)
    for row in payload:
        if not isinstance(row, dict):
            continue
        link = row.get("link")
        title_value = row.get("title")
        content_value = row.get("content")
        date_value = row.get("date_gmt") or row.get("date")
        if (
            not isinstance(link, str)
            or not _is_public_syndication_url(
                link,
                excluded_publisher="nyt",
            )
            or not isinstance(title_value, dict)
            or not isinstance(content_value, dict)
        ):
            continue
        rendered_title = title_value.get("rendered")
        rendered_content = content_value.get("rendered")
        if (
            not isinstance(rendered_title, str)
            or not isinstance(rendered_content, str)
            or not _html_links_to_article(
                rendered_content,
                item.canonical_url,
            )
        ):
            continue
        partner_date = _parse_iso_datetime(
            date_value if isinstance(date_value, str) else None
        )
        if (
            expected_date is not None
            and partner_date is not None
            and abs((partner_date.date() - expected_date.date()).days) > 2
        ):
            continue
        expected_headline = _clean_nyt_search_result_title(
            BeautifulSoup(
                rendered_title,
                "html.parser",
            ).get_text(" ", strip=True)
        )
        if len(_significant_tokens(expected_headline)) < 4:
            continue
        return NytSyndicationDiscovery(
            expected_headline=expected_headline,
            candidates=(
                CaptureCandidate(
                    provider=CaptureProvider.OTHER,
                    snapshot_url=link,
                ),
            ),
        )
    return None


def nyt_trusted_wordpress_search_url(
    item: ManifestItem,
    *,
    endpoint: str = NYT_TRUSTED_WORDPRESS_ENDPOINTS[0],
) -> str:
    slug = urlsplit(item.canonical_url).path.rstrip("/").rsplit("/", 1)[-1]
    slug = re.sub(r"\.html$", "", slug, flags=re.IGNORECASE)
    query = " ".join(part for part in slug.split("-") if part)
    return endpoint + "?" + urlencode(
        {
            "search": query,
            "per_page": 10,
            "_fields": "date,date_gmt,link,title,content",
        }
    )


def _discover_nyt_headline_wordpress_copy(
    item: ManifestItem,
    *,
    expected_headline: str,
    endpoint: str,
    archive_client: ArchiveClient,
) -> NytSyndicationDiscovery | None:
    search_url = nyt_headline_wordpress_search_url(
        expected_headline,
        endpoint=endpoint,
    )
    status_code, headers, content, _ = _fetch_limited_archive(
        archive_client,
        search_url,
        maximum_bytes=NYT_SYNDICATION_SEARCH_MAXIMUM_BYTES,
        attempts=2,
        timeout=35.0,
    )
    content_type = headers.get("content-type", "").casefold()
    if status_code != 200 or not content:
        raise ValueError(
            f"headline NYT syndication search returned HTTP {status_code}"
        )
    if "json" not in content_type and not content.lstrip().startswith(b"["):
        raise ValueError(
            "headline NYT syndication search did not return JSON"
        )
    payload = json.loads(content)
    if not isinstance(payload, list):
        raise ValueError("headline NYT syndication response is invalid")
    expected_date = _parse_iso_datetime(item.published_at)
    if expected_date is None:
        return None
    ranked: list[tuple[float, int, int, str]] = []
    for position, row in enumerate(payload):
        if not isinstance(row, dict):
            continue
        link = row.get("link")
        title_value = row.get("title")
        content_value = row.get("content")
        date_value = row.get("date_gmt") or row.get("date")
        if (
            not isinstance(link, str)
            or not _is_public_syndication_url(
                link,
                excluded_publisher="nyt",
            )
            or not isinstance(title_value, dict)
            or not isinstance(content_value, dict)
            or not isinstance(date_value, str)
        ):
            continue
        rendered_title = title_value.get("rendered")
        rendered_content = content_value.get("rendered")
        if (
            not isinstance(rendered_title, str)
            or not isinstance(rendered_content, str)
        ):
            continue
        candidate_headline = _clean_nyt_search_result_title(
            BeautifulSoup(
                rendered_title,
                "html.parser",
            ).get_text(" ", strip=True)
        )
        headline_overlap = _headline_text_overlap(
            expected_headline,
            candidate_headline,
        )
        if headline_overlap < 0.8:
            continue
        partner_date = _parse_iso_datetime(date_value)
        if partner_date is None:
            continue
        date_delta = abs(
            (partner_date.date() - expected_date.date()).days
        )
        if date_delta > 2:
            continue
        rendered_soup = BeautifulSoup(rendered_content, "html.parser")
        attribution = rendered_soup.get_text(" ", strip=True)
        if re.search(
            r"(?i)(?:the\s+)?new\s+york\s+times|nytimes\.com",
            attribution,
        ) is None:
            continue
        canonical_linked = _html_links_to_article(
            rendered_content,
            item.canonical_url,
        )
        ranked.append(
            (
                -headline_overlap,
                0 if canonical_linked else 1,
                date_delta * 100 + position,
                link,
            )
        )
    if not ranked:
        return None
    _, _, _, link = min(ranked)
    return NytSyndicationDiscovery(
        expected_headline=expected_headline,
        candidates=(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=link,
                expected_headline=expected_headline,
            ),
        ),
    )


def nyt_headline_wordpress_search_url(
    expected_headline: str,
    *,
    endpoint: str = NYT_HEADLINE_WORDPRESS_ENDPOINTS[0],
) -> str:
    return endpoint + "?" + urlencode(
        {
            "search": expected_headline,
            "per_page": 10,
            "_fields": "date,date_gmt,link,title,content",
        }
    )


def nyt_syndication_search_url(item: ManifestItem) -> str:
    return NYT_SYNDICATION_SEARCH_ENDPOINT + "?" + urlencode(
        {"p": item.canonical_url}
    )


def nyt_syndication_title_search_url(expected_headline: str) -> str:
    return NYT_SYNDICATION_SEARCH_ENDPOINT + "?" + urlencode(
        {"p": expected_headline}
    )


def _clean_nyt_search_result_title(value: str) -> str:
    cleaned = re.sub(
        r"\s+(?:[-|]\s*)?(?:The )?New York Times\s*$",
        "",
        value.strip(),
        flags=re.IGNORECASE,
    ).strip()
    return re.sub(r"\s*(?:…|\.\.\.)\s*$", "", cleaned).strip()


def _validate_nyt_syndication_response(
    item: ManifestItem,
    *,
    expected_headline: str | None,
    content: bytes,
    final_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="nyt",
            canonical_url=item.canonical_url,
            allow_generic_syndication=True,
        )
    except Exception as exc:
        return False, {
            "reason": f"parser-{type(exc).__name__}",
            "nytSyndicationValidated": False,
        }
    soup = BeautifulSoup(content, "html.parser")
    author_text = "\n".join(author.name for author in article.authors)
    # Attribution must prove republication, not merely mention the Times.
    # Independent coverage often says “the New York Times reported”, while
    # author bios and recommendation cards may mention past NYT work.  Only
    # an article/service byline, an NYT copyright notice, or an explicit
    # source/republication statement is accepted here.
    author_attributed = re.search(
        r"(?im)(?:^|,\s*)(?:the\s+)?new\s+york\s+times"
        r"(?:\s+news\s+service)?\s*$|"
        r"(?:nytimes|nyt)\s+news\s+service",
        author_text,
    ) is not None
    copyright_attributed = re.search(
        r"(?i)(?:copyright|©)\s*(?:©\s*)?(?:\d{4}\s*)?"
        r"(?:the\s+)?new\s+york\s+times",
        article.plain_text,
    ) is not None
    explicit_source_attributed = re.search(
        r"(?im)(?:^|\n)\s*(?:source|credit)\s*:\s*"
        r"(?:the\s+)?new\s+york\s+times\b|"
        r"(?:this\s+article|the\s+post)\s+"
        r"(?:originally\s+)?appeared\s+(?:first\s+)?(?:in|on)\s+"
        r"(?:the\s+)?new\s+york\s+times\b",
        article.plain_text,
    ) is not None
    attributed = bool(
        author_attributed
        or copyright_attributed
        or explicit_source_attributed
    )
    expected_date = _parse_iso_datetime(item.published_at)
    date_delta_days: int | None = None
    if expected_date is not None and article.published_at is not None:
        date_delta_days = abs(
            (article.published_at.date() - expected_date.date()).days
        )
    date_visible = _expected_date_visible(
        content,
        expected_date=expected_date,
    )
    date_matches = (
        date_delta_days is not None and date_delta_days <= 2
    ) or date_visible
    canonical_linked = _html_links_to_article(
        content.decode("utf-8", errors="ignore"),
        item.canonical_url,
    )
    has_provenance = bool(expected_headline) or canonical_linked
    headline_overlap = (
        _headline_text_overlap(
            expected_headline,
            article.headline or "",
        )
        if expected_headline
        else 1.0
        if canonical_linked
        else 0.0
    )
    body_characters = article.quality.body_characters
    title_matches = headline_overlap >= 0.75
    valid = (
        article.quality.status == ArticleStatus.COMPLETE
        and body_characters >= NYT_SYNDICATION_MINIMUM_BODY_CHARACTERS
        and attributed
        and has_provenance
        and title_matches
        and date_matches
    )
    if article.quality.status != ArticleStatus.COMPLETE:
        reason = f"parser-{article.quality.status.value}"
    elif body_characters < NYT_SYNDICATION_MINIMUM_BODY_CHARACTERS:
        reason = "body-too-short"
    elif not attributed:
        reason = "missing-nyt-attribution"
    elif not has_provenance:
        reason = "missing-original-headline"
    elif not title_matches:
        reason = "headline-mismatch"
    elif not date_matches:
        reason = "publication-date-mismatch"
    else:
        reason = None
    return valid, {
        "reason": reason,
        "nytSyndicationValidated": valid,
        "syndicationFinalUrl": final_url,
        "syndicationHeadlineOverlap": round(headline_overlap, 4),
        "syndicationBodyCharacters": body_characters,
        "syndicationNytAttributed": attributed,
        "syndicationNytAuthorAttributed": author_attributed,
        "syndicationNytCopyrightAttributed": copyright_attributed,
        "syndicationNytExplicitSourceAttributed": (
            explicit_source_attributed
        ),
        "syndicationDateDeltaDays": date_delta_days,
        "syndicationExpectedDateVisible": date_visible,
        "syndicationOriginalHeadline": expected_headline,
        "syndicationCanonicalArticleLinked": canonical_linked,
    }


def _capture_nyt_interactive_resources(
    item: ManifestItem,
    *,
    candidate: CaptureCandidate,
    html_bytes: bytes,
    archive_client: ArchiveClient,
    output_dir: Path,
) -> list[DependentResource]:
    if item.publisher != "nyt":
        return []
    timestamp_match = re.search(
        r"/web/(?P<timestamp>\d{14})(?:id_)?/",
        candidate.snapshot_url,
    )
    if timestamp_match is None:
        return []
    soup = BeautifulSoup(html_bytes, "html.parser")
    source_urls: list[str] = []
    for script in soup.select(
        "#adventure-project-container script[src], "
        "section.interactive-content script[src]"
    ):
        source = str(script.get("src") or "").strip()
        absolute = urljoin(item.canonical_url, source)
        parts = urlsplit(absolute)
        if (
            parts.scheme not in {"http", "https"}
            or (parts.hostname or "").casefold() != "int.nyt.com"
            or "/assets/adventure/js/" not in parts.path
            or absolute in source_urls
        ):
            continue
        source_urls.append(absolute)
        if len(source_urls) >= 3:
            break
    resources: list[DependentResource] = []
    timestamp = timestamp_match.group("timestamp")
    for source_url in source_urls:
        snapshot_url = (
            f"https://web.archive.org/web/{timestamp}id_/{source_url}"
        )
        try:
            status, headers, content, final_url = archive_client.fetch(
                snapshot_url,
                maximum_bytes=5_000_000,
            )
        except Exception:
            continue
        if status != 200 or not content:
            continue
        content_type = (
            headers.get("content-type")
            or headers.get("Content-Type")
            or "application/octet-stream"
        ).split(";", 1)[0].strip()
        resources.append(
            DependentResource(
                source_url=source_url,
                snapshot_url=final_url or snapshot_url,
                content_type=content_type,
                blob=store_dependent_resource(output_dir, content),
            )
        )
    return resources


CAPTURE = SourceCaptureHooks(
    publisher="nyt",
    validate_candidate_response=validate_candidate_response,
    capture_dependent_resources=capture_dependent_resources,
    run_capture=run_capture,
    select_timemap_candidates=select_timemap_candidates,
    raw_shell_signals=raw_shell_signals,
    completed_rejection_reason=completed_rejection_reason,
)

__all__ = ["CAPTURE"]
