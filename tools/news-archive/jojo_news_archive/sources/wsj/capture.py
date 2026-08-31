from __future__ import annotations

import re
from urllib.parse import urlsplit, urlunsplit
from bs4 import BeautifulSoup
from jojo_news_archive.capture.primitives import (
    expected_date_visible as _expected_date_visible,
    headline_text_overlap as _headline_text_overlap,
    largest_distinct_timemap_candidates as _largest_distinct_timemap_candidates,
    parse_iso_datetime as _parse_iso_datetime,
    same_article_url as _same_article_url,
    timemap_candidate_sort_key as _timemap_candidate_sort_key,
)
from jojo_news_archive.models import ArticleStatus, CaptureCandidate, CaptureProvider, ContentType
from jojo_news_archive.sources.capture_contracts import (
    ArchiveFallbackPolicy,
    CandidateAssessment,
    ManifestItem,
    SourceCaptureHooks,
)


WSJ_SYNDICATION_MINIMUM_BODY_CHARACTERS = 400


SUPPORTS_INFINI_NEWS = True


def preserve_removed_infini_candidate(candidate: dict) -> bool:
    del candidate
    return False


def infini_minimum_body_characters(source_url: str) -> int:
    del source_url
    return 1_000


def _structured_subscription_article_usable(content: bytes, *, canonical_url: str, raw_capture=None) -> bool:
    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="wsj",
            canonical_url=canonical_url,
            raw_capture=raw_capture,
        )
    except Exception:
        return False
    prefix = article.plain_text[:1_500].casefold()
    suspected_paywall = (
        article.quality.body_characters < 1_000
        and any(
            phrase in prefix
            for phrase in (
                "subscribe to read",
                "subscribe to continue",
                "sign in to continue",
                "already a subscriber",
                "unlock this article",
            )
        )
    )
    return bool(
        article.quality.status.value == "complete"
        and article.headline
        and article.quality.body_characters >= 100
        and not suspected_paywall
    )


def assess_candidate(candidate, *, content: bytes, canonical_url: str, final_url: str, quality_score: int, signals: dict[str, object]) -> CandidateAssessment:
    del candidate, final_url
    if not signals["looksLikeHtml"]:
        return CandidateAssessment(quality_score, signals)
    usable, evidence = _wsj_capture_parser_evidence(content, canonical_url=canonical_url)
    structured = bool(
        signals["subscriptionShell"]
        and _structured_subscription_article_usable(content, canonical_url=canonical_url)
    )
    updated = signals | evidence
    if usable and signals["authenticationShell"]:
        updated["allowAuthenticationShell"] = True
    if structured:
        updated["structuredSubscriptionArticle"] = True
        updated["allowSubscriptionShell"] = True
        quality_score = min(100, quality_score + 60)
    return CandidateAssessment(quality_score, updated, () if usable else ("wsj-parser-unusable",))


def completed_rejection_reason(capture, *, content: bytes, signals: dict[str, object]) -> str | None:
    del signals
    usable, _ = _wsj_capture_parser_evidence(content, canonical_url=capture.canonical_url)
    return None if usable else "wsj-capture-parser-incomplete"


def validate_candidate_response(session, candidate: CaptureCandidate, response):
    if candidate.provider == CaptureProvider.INFINI_NEWS:
        valid, evidence = _validate_wsj_infini_origin_response(
            session.item,
            expected_source_url=candidate.source_url or "",
            expected_headline=candidate.expected_headline,
            content=response[2],
            final_url=response[3],
        )
        label = "wsj-infini-origin"
    elif candidate.provider == CaptureProvider.OTHER:
        valid, evidence = _validate_wsj_syndication_response(
            session.item,
            expected_headline=candidate.expected_headline,
            content=response[2],
            final_url=response[3],
        )
        label = "wsj-syndication"
    else:
        return response, None
    if not valid:
        return None, f"{label}:validation:{evidence.get('reason') or 'failed'}"
    return (*response[:6], response[6] | evidence), None


def rank_manifest_candidates(candidates, *, published_at: str | None):
    return tuple(
        sorted(
            candidates,
            key=lambda candidate: _wsj_candidate_sort_key(
                candidate, published_at=published_at
            ),
        )
    )


def run_capture(session) -> None:
    candidates = rank_manifest_candidates(
        session.item.candidates, published_at=session.item.published_at
    )
    if not session.enable_wayback_timemap_fallback:
        evidenced = tuple(
            candidate
            for candidate in candidates
            if candidate.digest or candidate.byte_count is not None
        )
        calendar = tuple(
            candidate
            for candidate in candidates
            if (
                "000000id_" in candidate.snapshot_url
                and not candidate.digest
                and candidate.byte_count is None
            )
        )
        candidates = (
            evidenced[:3] + calendar[:2]
            if evidenced or calendar
            else session.item.candidates[:1]
        )
    session.consider(candidates)
    if session.enable_wayback_timemap_fallback and (
        session.best_response is None or session.best_response[5] < 100
    ):
        session.discover_wayback(session.item)
        amp_url = _wsj_amp_article_url(session.item.canonical_url)
        if amp_url is not None and (
            session.best_response is None or session.best_response[5] < 100
        ):
            amp_item = ManifestItem(
                publisher=session.item.publisher,
                canonical_url=amp_url,
                published_at=session.item.published_at,
                section=session.item.section,
                candidates=session.item.candidates,
            )
            session.discover_wayback(amp_item, label="wayback-amp-timemap")
    session.consider_arquivo()
    session.consider_common_crawl()


select_timemap_candidates = _largest_distinct_timemap_candidates


def archive_discovery_urls(canonical_url: str) -> tuple[str, ...]:
    parsed = urlsplit(canonical_url)
    hostname = (parsed.hostname or "").casefold()
    variants = [canonical_url]
    if parsed.scheme == "https" and (
        hostname == "wsj.com" or hostname.endswith(".wsj.com")
    ):
        variants.append(urlunsplit(("http", parsed.netloc, parsed.path, parsed.query, "")))
    amp_url = _wsj_amp_article_url(canonical_url)
    if amp_url is not None:
        variants.extend((amp_url, amp_url.replace("https://", "http://", 1)))
    return tuple(dict.fromkeys(variants))


def raw_shell_signals(
    *,
    sampled_content: bytes,
    prefix: bytes,
    final_url: str,
    has_article_marker: bool,
    has_strong_body_marker: bool,
) -> dict[str, object]:
    del sampled_content, final_url, has_article_marker
    snippet = bool(
        b'"issnippetview":true' in prefix
        or (
            re.search(
                br'<meta[^>]+name=["\']article\.template["\']'
                br'[^>]+content=["\']snippet["\']',
                prefix,
            )
            and b"wsj-snippet-body" in prefix
        )
    )
    empty_article = bool(
        re.search(br'"headline"\s*:\s*""', prefix)
        and re.search(br'"datepublished"\s*:\s*""', prefix)
        and re.search(
            br'"url"\s*:\s*"https?://(?:www\.)?wsj\.com/articles/"',
            prefix,
        )
    )
    subscription = bool(
        snippet
        or empty_article
        or (
            not has_strong_body_marker
            and b"continue reading" in prefix
            and b"wsj subscription" in prefix
            and b"already a subscriber" in prefix
        )
        or (not has_strong_body_marker and b'class="wsj-snippet-login"' in prefix)
    )
    return {
        "subscriptionShell": subscription,
        "wsjEmptyArticleShell": empty_article,
        "penalize": subscription,
    }


def archive_fallback_policy(
    *, parser_validation_enabled: bool, prior_attempts: int
) -> ArchiveFallbackPolicy:
    if not parser_validation_enabled:
        return ArchiveFallbackPolicy(True, True, True)
    enabled = prior_attempts >= 1
    return ArchiveFallbackPolicy(enabled, enabled, enabled)


def _validate_wsj_syndication_response(
    item: ManifestItem,
    *,
    expected_headline: str | None,
    content: bytes,
    final_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    parsed_final_url = urlsplit(final_url)
    final_host = (parsed_final_url.hostname or "").casefold()
    partner_host_validated = (
        parsed_final_url.scheme == "https"
        and final_host in {"tovima.com", "www.tovima.com"}
        and parsed_final_url.path.startswith("/wsj/")
    )
    if not partner_host_validated:
        return False, {
            "reason": "unexpected-partner-url",
            "wsjSyndicationValidated": False,
            "syndicationFinalUrl": final_url,
            "syndicationPartnerHostValidated": False,
        }
    if not expected_headline:
        return False, {
            "reason": "missing-original-headline",
            "wsjSyndicationValidated": False,
            "syndicationFinalUrl": final_url,
            "syndicationPartnerHostValidated": True,
        }
    try:
        article = parse_article(
            content,
            publisher="wsj",
            canonical_url=item.canonical_url,
            allow_generic_syndication=True,
        )
    except Exception as exc:
        return False, {
            "reason": f"parser-{type(exc).__name__}",
            "wsjSyndicationValidated": False,
            "syndicationFinalUrl": final_url,
            "syndicationPartnerHostValidated": True,
        }
    soup = BeautifulSoup(content, "html.parser")
    visible_text = soup.get_text(" ", strip=True)
    author_text = " ".join(author.name for author in article.authors)
    attribution_text = author_text + "\n" + visible_text[:30_000]
    attributed = re.search(
        r"(?i)(?:the\s+)?wall\s+street\s+journal|(?:^|\W)WSJ(?:\W|$)",
        attribution_text,
    ) is not None
    headline_overlap = _headline_text_overlap(
        expected_headline,
        article.headline or "",
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
    body_characters = article.quality.body_characters
    valid = (
        article.quality.status == ArticleStatus.COMPLETE
        and body_characters >= WSJ_SYNDICATION_MINIMUM_BODY_CHARACTERS
        and attributed
        and headline_overlap >= 0.8
        and date_matches
    )
    if article.quality.status != ArticleStatus.COMPLETE:
        reason = f"parser-{article.quality.status.value}"
    elif body_characters < WSJ_SYNDICATION_MINIMUM_BODY_CHARACTERS:
        reason = "body-too-short"
    elif not attributed:
        reason = "missing-wsj-attribution"
    elif headline_overlap < 0.8:
        reason = "headline-mismatch"
    elif not date_matches:
        reason = "publication-date-mismatch"
    else:
        reason = None
    return valid, {
        "reason": reason,
        "wsjSyndicationValidated": valid,
        "syndicationFinalUrl": final_url,
        "syndicationHeadlineOverlap": round(headline_overlap, 4),
        "syndicationBodyCharacters": body_characters,
        "syndicationWsjAttributed": attributed,
        "syndicationDateDeltaDays": date_delta_days,
        "syndicationExpectedDateVisible": date_visible,
        "syndicationOriginalHeadline": expected_headline,
        "syndicationPartnerHostValidated": partner_host_validated,
    }


def _validate_wsj_infini_origin_response(
    item: ManifestItem,
    *,
    expected_source_url: str,
    expected_headline: str | None,
    content: bytes,
    final_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    origin_url_validated = bool(
        _is_wsj_origin_url(expected_source_url)
        and _is_wsj_origin_url(item.canonical_url)
        and _is_wsj_origin_url(final_url)
        and _same_article_url(expected_source_url, item.canonical_url)
        and _same_article_url(final_url, item.canonical_url)
    )
    if not origin_url_validated:
        return False, {
            "reason": "unexpected-origin-url",
            "wsjInfiniOriginValidated": False,
            "infiniOriginUrlValidated": False,
            "infiniOriginFinalUrl": final_url,
        }
    if not expected_headline:
        return False, {
            "reason": "missing-original-headline",
            "wsjInfiniOriginValidated": False,
            "infiniOriginUrlValidated": True,
            "infiniOriginFinalUrl": final_url,
        }
    try:
        article = parse_article(
            content,
            publisher="wsj",
            canonical_url=item.canonical_url,
        )
    except Exception as exc:
        return False, {
            "reason": f"parser-{type(exc).__name__}",
            "wsjInfiniOriginValidated": False,
            "infiniOriginUrlValidated": True,
            "infiniOriginFinalUrl": final_url,
        }
    headline_overlap = _headline_text_overlap(
        expected_headline,
        article.headline or "",
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
    body_characters = article.quality.body_characters
    valid = (
        article.quality.status == ArticleStatus.COMPLETE
        and body_characters >= 1_000
        and headline_overlap >= 0.8
        and date_matches
    )
    if article.quality.status != ArticleStatus.COMPLETE:
        reason = f"parser-{article.quality.status.value}"
    elif body_characters < 1_000:
        reason = "body-too-short"
    elif headline_overlap < 0.8:
        reason = "headline-mismatch"
    elif not date_matches:
        reason = "publication-date-mismatch"
    else:
        reason = None
    return valid, {
        "reason": reason,
        "wsjInfiniOriginValidated": valid,
        "infiniOriginUrlValidated": origin_url_validated,
        "infiniOriginFinalUrl": final_url,
        "infiniOriginHeadlineOverlap": round(headline_overlap, 4),
        "infiniOriginBodyCharacters": body_characters,
        "infiniOriginDateDeltaDays": date_delta_days,
        "infiniOriginExpectedDateVisible": date_visible,
        "infiniOriginExpectedHeadline": expected_headline,
    }


def _wsj_amp_article_url(value: str) -> str | None:
    parsed = urlsplit(value)
    hostname = (parsed.hostname or "").casefold()
    if hostname not in {"wsj.com", "www.wsj.com", "online.wsj.com"}:
        return None
    path = parsed.path.rstrip("/")
    if not path.casefold().startswith("/articles/"):
        return None
    return urlunsplit(("https", "www.wsj.com", "/amp" + path, "", ""))


def _is_wsj_origin_url(value: str | None) -> bool:
    hostname = (urlsplit(value or "").hostname or "").casefold()
    return hostname in {"wsj.com", "www.wsj.com", "online.wsj.com"}


def _wsj_candidate_sort_key(
    candidate: CaptureCandidate,
    *,
    published_at: str | None,
) -> tuple[int, bool, int, tuple[float, str]]:
    """Prefer the WSJ archive sources with the highest full-text yield."""

    provider_priority = {
        CaptureProvider.INFINI_NEWS: 0,
        CaptureProvider.WAYBACK: 1,
        CaptureProvider.COMMON_CRAWL: 2,
        CaptureProvider.ARQUIVO_PT: 3,
    }
    return (
        provider_priority.get(candidate.provider, 4),
        candidate.byte_count is None,
        -(candidate.byte_count or 0),
        _timemap_candidate_sort_key(
            candidate,
            published_at=published_at,
        ),
    )


def _wsj_capture_parser_evidence(
    content: bytes,
    *,
    canonical_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="wsj",
            canonical_url=canonical_url,
            allow_generic_syndication=False,
        )
    except Exception as exc:
        return False, {
            "wsjCaptureParserUsable": False,
            "wsjCaptureParserError": type(exc).__name__,
        }
    nontext = article.content_type in {
        ContentType.INTERACTIVE,
        ContentType.VIDEO,
        ContentType.AUDIO,
    }
    gallery_usable = (
        article.content_type == ContentType.GALLERY
        and article.quality.images_selected >= 3
    )
    usable = (
        gallery_usable
        if article.content_type == ContentType.GALLERY
        else article.quality.status == ArticleStatus.COMPLETE or nontext
    )
    return usable, {
        "wsjCaptureParserUsable": usable,
        "wsjCaptureExtractionStatus": article.quality.status.value,
        "wsjCaptureContentType": article.content_type.value,
        "wsjCaptureBodyCharacters": article.quality.body_characters,
        "wsjCaptureImagesSelected": article.quality.images_selected,
    }


CAPTURE = SourceCaptureHooks(
    publisher="wsj",
    validate_candidate_response=validate_candidate_response,
    rank_manifest_candidates=rank_manifest_candidates,
    run_capture=run_capture,
    archive_fallback_policy=archive_fallback_policy,
    infini_minimum_body_characters=infini_minimum_body_characters,
    supports_infini_news=SUPPORTS_INFINI_NEWS,
    assess_candidate=assess_candidate,
    select_timemap_candidates=select_timemap_candidates,
    archive_discovery_urls=archive_discovery_urls,
    raw_shell_signals=raw_shell_signals,
    completed_rejection_reason=completed_rejection_reason,
    preserve_removed_infini_candidate=preserve_removed_infini_candidate,
)

__all__ = ["CAPTURE"]
