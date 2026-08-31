from __future__ import annotations

import re
from urllib.parse import urlencode, urlsplit
from jojo_news_archive.capture.primitives import (
    SYNDICATION_SEARCH_ENDPOINT,
    fetch_syndication_search_results as _fetch_syndication_search_results,
    headline_text_overlap as _headline_text_overlap,
    parse_iso_datetime as _parse_iso_datetime,
    rank_syndication_candidates as _rank_syndication_candidates,
    same_article_url as _same_article_url,
    significant_tokens as _significant_tokens,
    syndication_headline_overlap as _syndication_headline_overlap,
    syndication_search_url as _syndication_search_url,
)
from jojo_news_archive.discovery.client import ArchiveClient
from jojo_news_archive.models import ArticleStatus, CaptureCandidate, CaptureProvider, ContentType
from jojo_news_archive.sources.capture_contracts import (
    CandidateAssessment,
    ManifestItem,
    SourceCaptureHooks,
)


REUTERS_SYNDICATION_MAXIMUM_CANDIDATES = 8


SYNDICATION_MAXIMUM_CANDIDATES = REUTERS_SYNDICATION_MAXIMUM_CANDIDATES


def syndication_search_slug(slug: str) -> str:
    return re.sub(r"-20\d{2}-\d{2}-\d{2}$", "", slug)


def syndication_candidate_priority(value: str) -> int:
    return _reuters_syndication_url_priority(value)


def clean_syndication_search_title(value: str) -> str:
    cleaned = re.sub(
        r"\s+(?:[-|]\s*)?Reuters(?:\s+News)?\s*$",
        "",
        value.strip(),
        flags=re.IGNORECASE,
    ).strip()
    return re.sub(r"\s*(?:…|\.\.\.)\s*$", "", cleaned).strip()


REUTERS_SYNDICATION_MINIMUM_BODY_CHARACTERS = 400


def assess_candidate(candidate, *, content: bytes, canonical_url: str, final_url: str, quality_score: int, signals: dict[str, object]) -> CandidateAssessment:
    del candidate, final_url
    if not signals["looksLikeHtml"]:
        return CandidateAssessment(quality_score, signals)
    usable, evidence = _reuters_capture_parser_evidence(content, canonical_url=canonical_url)
    return CandidateAssessment(quality_score, signals | evidence, () if usable else ("reuters-parser-unusable",))


def completed_rejection_reason(capture, *, content: bytes, signals: dict[str, object]) -> str | None:
    del signals
    usable, _ = _reuters_capture_parser_evidence(content, canonical_url=capture.canonical_url)
    return None if usable else "reuters-capture-parser-incomplete"


def validate_candidate_response(session, candidate: CaptureCandidate, response):
    if candidate.provider != CaptureProvider.OTHER:
        return response, None
    valid, evidence = _validate_reuters_syndication_response(
        session.item,
        expected_headline=candidate.expected_headline,
        content=response[2],
        final_url=response[3],
    )
    if not valid:
        return None, "reuters-syndication:validation:" + str(evidence.get("reason") or "failed")
    return (*response[:6], response[6] | evidence), None


def run_capture(session) -> None:
    session.consider(session.item.candidates)
    session.consider_common_crawl()
    if session.best_response is None:
        try:
            candidates = discover_reuters_syndication_candidates(
                session.item,
                archive_client=session.archive_client,
            )
        except Exception as exc:
            session.fail("reuters-syndication", exc)
            candidates = ()
        session.consider(session.add_candidates(candidates))
    session.consider_wayback()
    session.consider_arquivo()


REUTERS_SYNDICATION_STOP_WORDS = {
    "a",
    "after",
    "an",
    "and",
    "as",
    "at",
    "by",
    "for",
    "from",
    "in",
    "of",
    "on",
    "s",
    "the",
    "to",
    "with",
}


def reuters_syndication_search_url(item: ManifestItem) -> str:
    return _syndication_search_url(item, publisher_label="Reuters")


def reuters_syndication_title_search_url(expected_headline: str) -> str:
    return SYNDICATION_SEARCH_ENDPOINT + "?" + urlencode(
        {"p": f'"{expected_headline}" Reuters'}
    )


def discover_reuters_syndication_candidates(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
) -> tuple[CaptureCandidate, ...]:
    initial_results = _fetch_syndication_search_results(
        item,
        archive_client=archive_client,
        search_url=reuters_syndication_search_url(item),
    )
    expected_headline = next(
        (
            title
            for _, title, candidate_url in initial_results
            if title and _same_article_url(candidate_url, item.canonical_url)
        ),
        None,
    )
    all_results = list(initial_results)
    if (
        expected_headline
        and len(_significant_tokens(expected_headline)) >= 4
    ):
        try:
            title_results = _fetch_syndication_search_results(
                item,
                archive_client=archive_client,
                search_url=reuters_syndication_title_search_url(
                    expected_headline
                ),
            )
        except ValueError:
            title_results = []
        if title_results:
            offset = len(all_results)
            all_results.extend(
                (offset + position, title, candidate_url)
                for position, title, candidate_url in title_results
            )
    return _rank_syndication_candidates(
        all_results,
        excluded_publisher="reuters",
        expected_headline=expected_headline,
    )


def _reuters_syndication_url_priority(value: str) -> int:
    parsed = urlsplit(value)
    host = (parsed.hostname or "").casefold()
    path = parsed.path.casefold()
    if host == "yahoo.com" or host.endswith(".yahoo.com"):
        return 0
    if (
        "/wires/reuters/" in path
        or "/news/reuters" in path
        or "reuters.com" in path
    ):
        return 1
    return 2


def _validate_reuters_syndication_response(
    item: ManifestItem,
    *,
    expected_headline: str | None = None,
    content: bytes,
    final_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="reuters",
            canonical_url=item.canonical_url,
            allow_generic_syndication=True,
        )
    except Exception as exc:
        return False, {
            "reason": f"parser-{type(exc).__name__}",
            "reutersSyndicationValidated": False,
        }
    headline_overlap = _reuters_syndication_headline_overlap(
        item.canonical_url,
        article.headline or "",
    )
    if expected_headline:
        headline_overlap = max(
            headline_overlap,
            _headline_text_overlap(
                expected_headline,
                article.headline or "",
            ),
        )
    author_text = " ".join(author.name for author in article.authors)
    attribution_text = (
        author_text + "\n" + article.plain_text[:1_000]
        + "\n" + article.plain_text[-1_000:]
    )
    attributed = re.search(
        r"(?i)(?:^|\W)reuters(?:\W|$)",
        attribution_text,
    ) is not None
    date_delta_days: int | None = None
    expected_date = _parse_iso_datetime(item.published_at)
    if expected_date is not None and article.published_at is not None:
        date_delta_days = abs(
            (article.published_at.date() - expected_date.date()).days
        )
    date_matches = date_delta_days is not None and date_delta_days <= 2
    title_matches = headline_overlap >= 0.6 or (
        date_matches and headline_overlap >= 0.35
    )
    body_characters = article.quality.body_characters
    valid = (
        article.quality.status == ArticleStatus.COMPLETE
        and body_characters >= REUTERS_SYNDICATION_MINIMUM_BODY_CHARACTERS
        and attributed
        and title_matches
    )
    if article.quality.status != ArticleStatus.COMPLETE:
        reason = f"parser-{article.quality.status.value}"
    elif body_characters < REUTERS_SYNDICATION_MINIMUM_BODY_CHARACTERS:
        reason = "body-too-short"
    elif not attributed:
        reason = "missing-reuters-attribution"
    elif not title_matches:
        reason = "headline-mismatch"
    else:
        reason = None
    return valid, {
        "reason": reason,
        "reutersSyndicationValidated": valid,
        "syndicationFinalUrl": final_url,
        "syndicationHeadlineOverlap": round(headline_overlap, 4),
        "syndicationBodyCharacters": body_characters,
        "syndicationReutersAttributed": attributed,
        "syndicationDateDeltaDays": date_delta_days,
        "syndicationExpectedHeadline": expected_headline,
    }


def _reuters_syndication_headline_overlap(
    canonical_url: str,
    headline: str,
) -> float:
    return _syndication_headline_overlap(
        canonical_url,
        headline,
        strip_iso_date_suffix=True,
    )


def _reuters_capture_parser_evidence(
    content: bytes,
    *,
    canonical_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="reuters",
            canonical_url=canonical_url,
            allow_generic_syndication=True,
        )
    except Exception as exc:
        return False, {
            "reutersCaptureParserUsable": False,
            "reutersCaptureParserError": type(exc).__name__,
        }
    nontext = article.content_type in {
        ContentType.INTERACTIVE,
        ContentType.VIDEO,
        ContentType.AUDIO,
        ContentType.GALLERY,
    }
    usable = article.quality.status == ArticleStatus.COMPLETE or nontext
    return usable, {
        "reutersCaptureParserUsable": usable,
        "reutersCaptureExtractionStatus": article.quality.status.value,
        "reutersCaptureContentType": article.content_type.value,
        "reutersCaptureBodyCharacters": article.quality.body_characters,
    }


CAPTURE = SourceCaptureHooks(
    publisher="reuters",
    validate_candidate_response=validate_candidate_response,
    run_capture=run_capture,
    assess_candidate=assess_candidate,
    syndication_search_slug=syndication_search_slug,
    clean_syndication_search_title=clean_syndication_search_title,
    syndication_candidate_priority=syndication_candidate_priority,
    syndication_maximum_candidates=SYNDICATION_MAXIMUM_CANDIDATES,
    completed_rejection_reason=completed_rejection_reason,
)

__all__ = ["CAPTURE"]
