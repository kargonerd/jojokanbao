from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Iterable
from urllib.parse import urlencode, urlsplit
from bs4 import BeautifulSoup
from jojo_news_archive.capture.primitives import (
    SYNDICATION_SEARCH_ENDPOINT,
    decode_duckduckgo_search_result as _decode_duckduckgo_search_result,
    headline_text_overlap as _headline_text_overlap,
    is_public_syndication_url as _is_public_syndication_url,
    meta_tag_content as _meta_tag_content,
    parse_iso_datetime as _parse_iso_datetime,
    significant_tokens as _significant_tokens,
    walk_json_dicts as _walk_json_dicts,
    yahoo_search_results as _yahoo_search_results,
)
from jojo_news_archive.discovery.client import ArchiveClient
from jojo_news_archive.models import ArticleStatus, CaptureCandidate, CaptureProvider, ContentType
from jojo_news_archive.sources.capture_contracts import (
    CandidateAssessment,
    ManifestItem,
    SourceCaptureHooks,
)


@dataclass(frozen=True)
class ApSyndicationDiscovery:
    source_description: str | None
    source_keywords: tuple[str, ...]
    source_authors: tuple[str, ...]
    candidates: tuple[CaptureCandidate, ...]


_MINIMUM_AP_LIVE_ORIGIN_BODY_CHARACTERS = 100


def assess_candidate(candidate, *, content: bytes, canonical_url: str, final_url: str, quality_score: int, signals: dict[str, object]) -> CandidateAssessment:
    del final_url
    updated = signals
    reasons: tuple[str, ...] = ()
    if candidate.provider == CaptureProvider.LIVE_ORIGIN:
        evidence = _ap_live_origin_content_evidence(content)
        updated = updated | evidence
        if evidence["apThinLiveOrigin"]:
            quality_score = min(quality_score, 70)
    elif signals["looksLikeHtml"]:
        usable, evidence = _ap_capture_parser_evidence(content, canonical_url=canonical_url)
        updated = updated | evidence
        if not usable:
            reasons = ("ap-parser-unusable",)
    return CandidateAssessment(quality_score, updated, reasons)


def completed_rejection_reason(capture, *, content: bytes, signals: dict[str, object]) -> str | None:
    del signals
    usable, _ = _ap_capture_parser_evidence(content, canonical_url=capture.canonical_url)
    return None if usable else "ap-capture-parser-incomplete"


def validate_candidate_response(session, candidate: CaptureCandidate, response):
    discovery = session.state.get("syndication_discovery")
    if candidate.provider != CaptureProvider.OTHER or discovery is None:
        return response, None
    valid, evidence = _validate_ap_syndication_response(
        session.item,
        source_description=discovery.source_description,
        source_keywords=discovery.source_keywords,
        source_authors=discovery.source_authors,
        expected_headline=candidate.expected_headline,
        content=response[2],
        final_url=response[3],
    )
    if not valid:
        return None, "ap-syndication:validation:" + str(evidence.get("reason") or "failed")
    return (*response[:6], response[6] | evidence), None


def run_capture(session) -> None:
    session.consider(session.item.candidates)
    session.consider_common_crawl()
    if session.best_response is None or session.best_response[5] < 100:
        source_content = session.best_response[2] if session.best_response is not None else b""
        try:
            discovery = discover_ap_syndication_candidates(
                session.item,
                source_content=source_content,
                archive_client=session.archive_client,
            )
        except Exception as exc:
            session.fail("ap-syndication", exc)
            discovery = ApSyndicationDiscovery(None, (), (), ())
        session.state["syndication_discovery"] = discovery
        session.consider(session.add_candidates(discovery.candidates))
    session.consider_wayback()
    session.consider_arquivo()
    if (
        session.best_response is not None
        and session.best_response[0].provider == CaptureProvider.LIVE_ORIGIN
    ):
        usable, evidence = _ap_capture_parser_evidence(
            session.best_response[2], canonical_url=session.item.canonical_url
        )
        session.best_response = (*session.best_response[:6], session.best_response[6] | evidence)
        if not usable:
            session.failures.append("ap-live-origin-parser-incomplete")
            session.best_response = None


AP_SYNDICATION_SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/"


AP_SYNDICATION_SEARCH_MAXIMUM_BYTES = 2_000_000


AP_SYNDICATION_MAXIMUM_CANDIDATES = 6


AP_SYNDICATION_MINIMUM_BODY_CHARACTERS = 400


AP_KNOWN_SYNDICATION_COPIES = {
    (
        "https://apnews.com/united-states-government-"
        "617290f5b8324b808390f3a7263b17"
    ): (
        "https://www.theguardian.com/world/2013/oct/19/"
        "usforeignpolicy-pakistan",
        "US quietly releases $1.6bn in aid to Pakistan after thaw in relations",
    ),
}


def ap_syndication_search_url(source_description: str) -> str:
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9'’-]*", source_description)
    phrase = " ".join(words[:10])
    return AP_SYNDICATION_SEARCH_ENDPOINT + "?" + urlencode(
        {"q": f'"{phrase}"'}
    )


def _ap_syndication_search_urls(
    source_description: str | None,
    keywords: Iterable[str],
    authors: Iterable[str],
    published_at: str | None = None,
) -> tuple[str, ...]:
    keyword_values = tuple(keywords)
    queries: list[str] = []
    words = (
        re.findall(
            r"[A-Za-z0-9][A-Za-z0-9'’-]*",
            source_description.split(".", 1)[0],
        )
        if source_description
        else []
    )
    if words:
        queries.append(f'"{" ".join(words[:10])}"')
    if len(words) > 6:
        queries.append(f'"{" ".join(words[-8:])}"')
    for keyword in keyword_values:
        cleaned = re.sub(r"-+", " ", keyword).strip()
        if keyword.count("-") >= 2 and cleaned:
            queries.append(f'"{cleaned}" "Associated Press"')
            break
    author = next((value.strip() for value in authors if value.strip()), "")
    topic = next(
        (
            re.sub(r"-+", " ", value).strip()
            for value in keyword_values
            if value.count("-") >= 2
            and value.replace("-", " ").strip()
        ),
        "",
    )
    if author and topic:
        queries.append(f'"{author}" "{topic}" "Associated Press"')
        topic_tail = topic.split()[-1]
        related = [
            value
            for value in keyword_values
            if "-" not in value
            and value.casefold()
            not in {
                "general news",
                "united states",
                "united states government",
            }
        ][:2]
        year_match = re.match(r"(\d{4})", published_at or "")
        year = year_match.group(1) if year_match else ""
        queries.append(
            " ".join(
                [
                    f'"{author}"',
                    f'"{topic_tail}"',
                    *(f'"{value}"' for value in related),
                    year,
                    '"Associated Press"',
                ]
            ).strip()
        )
    urls: list[str] = []
    for query in dict.fromkeys(queries):
        urls.append(
            AP_SYNDICATION_SEARCH_ENDPOINT
            + "?"
            + urlencode({"q": query})
        )
        urls.append(
            SYNDICATION_SEARCH_ENDPOINT
            + "?"
            + urlencode({"p": query})
        )
    return tuple(urls)


def discover_ap_syndication_candidates(
    item: ManifestItem,
    *,
    source_content: bytes,
    archive_client: ArchiveClient,
) -> ApSyndicationDiscovery:
    soup = BeautifulSoup(source_content, "html.parser")
    descriptions = [
        value
        for value in (
            _meta_tag_content(soup, "property", "og:description"),
            _meta_tag_content(soup, "name", "description"),
        )
        if value
    ]
    keywords: list[str] = []
    authors: list[str] = []
    for script in soup.select('script[type="application/ld+json"]'):
        value = script.string or script.get_text()
        if not value.strip():
            continue
        try:
            payload = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            continue
        for row in _walk_json_dicts(payload):
            description = row.get("description")
            if isinstance(description, str) and description.strip():
                descriptions.append(description.strip())
            value = row.get("keywords")
            if isinstance(value, str):
                keywords.append(value)
            elif isinstance(value, list):
                keywords.extend(
                    keyword
                    for keyword in value
                    if isinstance(keyword, str)
                )
            author_value = row.get("author")
            for author in (
                author_value
                if isinstance(author_value, list)
                else [author_value]
            ):
                if isinstance(author, str) and author.strip():
                    authors.append(author.strip())
                elif isinstance(author, dict):
                    name = author.get("name")
                    if isinstance(name, str) and name.strip():
                        authors.append(name.strip())
    source_description = max(descriptions, key=len) if descriptions else None
    if (
        (
            not source_description
            or len(source_description)
            < _MINIMUM_AP_LIVE_ORIGIN_BODY_CHARACTERS
        )
        and not (authors and keywords)
    ):
        return ApSyndicationDiscovery(
            source_description=source_description,
            source_keywords=tuple(dict.fromkeys(keywords)),
            source_authors=tuple(dict.fromkeys(authors)),
            candidates=(),
        )
    candidates: list[CaptureCandidate] = []
    seen: set[str] = set()
    known_copy = AP_KNOWN_SYNDICATION_COPIES.get(item.canonical_url)
    if known_copy is not None:
        known_url, known_headline = known_copy
        candidates.append(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=known_url,
                expected_headline=known_headline,
            )
        )
        seen.add(known_url)
    search_urls = _ap_syndication_search_urls(
        source_description,
        keywords,
        authors,
        item.published_at,
    )
    for search_url in search_urls:
        try:
            status_code, headers, content, _ = archive_client.fetch(
                search_url,
                maximum_bytes=AP_SYNDICATION_SEARCH_MAXIMUM_BYTES,
            )
        except Exception:
            continue
        content_type = headers.get("content-type", "").casefold()
        if (
            status_code != 200
            or not content
            or (
                "html" not in content_type
                and b"<html" not in content[:1_000].lower()
            )
        ):
            continue
        search_soup = BeautifulSoup(content, "html.parser")
        if (urlsplit(search_url).hostname or "").endswith("yahoo.com"):
            search_results = [
                (candidate_url, title)
                for _, title, candidate_url in _yahoo_search_results(
                    search_soup
                )
            ]
        else:
            search_results = []
            for result in search_soup.select(".result"):
                anchor = result.select_one(".result__a")
                if anchor is None:
                    continue
                candidate_url = _decode_duckduckgo_search_result(
                    anchor.get("href")
                )
                if candidate_url is None:
                    continue
                search_results.append(
                    (
                        candidate_url,
                        _clean_ap_search_result_title(
                            anchor.get_text(" ", strip=True)
                        ),
                    )
                )
        accepted_this_search = 0
        for candidate_url, title in search_results:
            if (
                candidate_url in seen
                or not _is_public_syndication_url(
                    candidate_url,
                    excluded_publisher="ap",
                )
            ):
                continue
            seen.add(candidate_url)
            candidates.append(
                CaptureCandidate(
                    provider=CaptureProvider.OTHER,
                    snapshot_url=candidate_url,
                    expected_headline=title or None,
                )
            )
            accepted_this_search += 1
            if len(candidates) >= AP_SYNDICATION_MAXIMUM_CANDIDATES:
                break
            if accepted_this_search >= 2:
                break
        if len(candidates) >= AP_SYNDICATION_MAXIMUM_CANDIDATES:
            break
    return ApSyndicationDiscovery(
        source_description=source_description,
        source_keywords=tuple(dict.fromkeys(keywords)),
        source_authors=tuple(dict.fromkeys(authors)),
        candidates=tuple(candidates),
    )


def _clean_ap_search_result_title(value: str) -> str:
    return re.sub(
        r"\s+[-|]\s*[^-|]{1,60}$",
        "",
        value.strip(),
    ).strip()


def _validate_ap_syndication_response(
    item: ManifestItem,
    *,
    source_description: str | None,
    source_keywords: tuple[str, ...] = (),
    source_authors: tuple[str, ...] = (),
    expected_headline: str | None,
    content: bytes,
    final_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="ap",
            canonical_url=item.canonical_url,
            allow_generic_syndication=True,
        )
    except Exception as exc:
        return False, {
            "reason": f"parser-{type(exc).__name__}",
            "apSyndicationValidated": False,
        }
    normalized_body = re.sub(
        r"\s+",
        " ",
        article.plain_text,
    ).casefold()
    normalized_description = re.sub(
        r"\s+",
        " ",
        source_description or "",
    ).casefold()
    description_tokens = set(_significant_tokens(normalized_description))
    body_tokens = set(_significant_tokens(normalized_body))
    description_overlap = (
        len(description_tokens & body_tokens) / len(description_tokens)
        if description_tokens
        else 0.0
    )
    description_matches = bool(
        normalized_description
        and (
            normalized_description in normalized_body
            or description_overlap >= 0.75
        )
    )
    source_keyword_tokens = set(
        _significant_tokens(" ".join(source_keywords))
    )
    metadata_token_matches = len(source_keyword_tokens & body_tokens)
    metadata_overlap = (
        min(
            1.0,
            metadata_token_matches / min(12, len(source_keyword_tokens)),
        )
        if source_keyword_tokens
        else 0.0
    )
    headline_overlap = (
        _headline_text_overlap(expected_headline, article.headline or "")
        if expected_headline
        else 0.0
    )
    title_matches = not expected_headline or headline_overlap >= 0.55
    visible_text = BeautifulSoup(content, "html.parser").get_text(
        " ",
        strip=True,
    )
    author_text = " ".join(author.name for author in article.authors)
    normalized_authorship = (author_text + "\n" + visible_text).casefold()
    source_author_matches = any(
        author.casefold() in normalized_authorship
        for author in source_authors
        if len(author.strip()) >= 4
    )
    attributed = re.search(
        r"(?i)(?:^|\W)(?:the\s+)?associated\s+press(?:\W|$)|"
        r"(?:^|\W)AP(?:\W|$)",
        author_text + "\n" + visible_text,
    ) is not None
    expected_date = _parse_iso_datetime(item.published_at)
    date_delta_days: int | None = None
    if expected_date is not None and article.published_at is not None:
        date_delta_days = abs(
            (article.published_at.date() - expected_date.date()).days
        )
    date_matches = date_delta_days is None or date_delta_days <= 2
    metadata_matches = bool(
        not normalized_description
        and expected_headline
        and date_delta_days is not None
        and date_matches
        and metadata_token_matches >= 6
        and metadata_overlap >= 0.5
        and (source_author_matches or metadata_token_matches >= 8)
    )
    source_matches = description_matches or metadata_matches
    body_characters = article.quality.body_characters
    valid = bool(
        article.quality.status == ArticleStatus.COMPLETE
        and body_characters >= AP_SYNDICATION_MINIMUM_BODY_CHARACTERS
        and source_matches
        and title_matches
        and attributed
        and date_matches
    )
    if article.quality.status != ArticleStatus.COMPLETE:
        reason = f"parser-{article.quality.status.value}"
    elif body_characters < AP_SYNDICATION_MINIMUM_BODY_CHARACTERS:
        reason = "body-too-short"
    elif not source_matches:
        reason = (
            "metadata-mismatch"
            if not normalized_description
            else "description-mismatch"
        )
    elif not title_matches:
        reason = "headline-mismatch"
    elif not attributed:
        reason = "missing-ap-attribution"
    elif not date_matches:
        reason = "date-mismatch"
    else:
        reason = None
    return valid, {
        "reason": reason,
        "apSyndicationValidated": valid,
        "syndicationFinalUrl": final_url,
        "syndicationHeadlineOverlap": round(headline_overlap, 4),
        "syndicationDescriptionOverlap": round(description_overlap, 4),
        "syndicationMetadataOverlap": round(metadata_overlap, 4),
        "syndicationMetadataTokenMatches": metadata_token_matches,
        "syndicationSourceAuthorMatches": source_author_matches,
        "syndicationBodyCharacters": body_characters,
        "syndicationApAttributed": attributed,
        "syndicationDateDeltaDays": date_delta_days,
        "syndicationExpectedHeadline": expected_headline,
    }


def _ap_capture_parser_evidence(
    content: bytes,
    *,
    canonical_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="ap",
            canonical_url=canonical_url,
            allow_generic_syndication=True,
        )
    except Exception as exc:
        return False, {
            "apCaptureParserUsable": False,
            "apCaptureParserError": type(exc).__name__,
        }
    nontext = article.content_type in {
        ContentType.INTERACTIVE,
        ContentType.VIDEO,
        ContentType.AUDIO,
        ContentType.GALLERY,
    }
    usable = article.quality.status == ArticleStatus.COMPLETE or nontext
    return usable, {
        "apCaptureParserUsable": usable,
        "apCaptureExtractionStatus": article.quality.status.value,
        "apCaptureContentType": article.content_type.value,
        "apCaptureBodyCharacters": article.quality.body_characters,
    }


def _ap_live_origin_content_evidence(
    content: bytes,
) -> dict[str, object]:
    soup = BeautifulSoup(content, "html.parser")
    body_characters = 0
    for selector in (
        "[data-key='article']",
        ".RichTextStoryBody",
        "[data-testid='article-body']",
    ):
        for node in soup.select(selector):
            normalized = re.sub(
                r"\s+",
                " ",
                node.get_text(" ", strip=True),
            ).strip()
            body_characters = max(body_characters, len(normalized))
    carousel_slides = len(
        soup.select(
            ".Page-main .Carousel .Carousel-slide, "
            ".Page-main bsp-carousel .Carousel-slide"
        )
    )
    embedded_story_html = b'"storyHTML"' in content
    return {
        "apLiveOriginBodyCharacters": body_characters,
        "apLiveOriginCarouselSlides": carousel_slides,
        "apLiveOriginEmbeddedStoryHtml": embedded_story_html,
        "apThinLiveOrigin": bool(
            body_characters < _MINIMUM_AP_LIVE_ORIGIN_BODY_CHARACTERS
            and carousel_slides < 3
            and not embedded_story_html
        ),
    }


CAPTURE = SourceCaptureHooks(
    publisher="ap",
    validate_candidate_response=validate_candidate_response,
    run_capture=run_capture,
    assess_candidate=assess_candidate,
    completed_rejection_reason=completed_rejection_reason,
)

__all__ = ["CAPTURE"]
