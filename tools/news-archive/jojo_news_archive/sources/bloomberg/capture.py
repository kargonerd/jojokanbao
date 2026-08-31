from __future__ import annotations

import re
from urllib.parse import unquote, urlsplit
from bs4 import BeautifulSoup
from jojo_news_archive.capture.primitives import (
    discover_syndication_candidates as _discover_syndication_candidates,
    expected_date_visible as _expected_date_visible,
    headline_text_overlap as _headline_text_overlap,
    parse_iso_datetime as _parse_iso_datetime,
    short_parsed_paywall_shell as _short_parsed_paywall_shell,
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


BLOOMBERG_SYNDICATION_MINIMUM_BODY_CHARACTERS = 400


def clean_syndication_search_title(value: str) -> str:
    cleaned = re.sub(
        r"\s+(?:[-|]\s*)?Bloomberg(?:\s+News)?\s*$",
        "",
        value.strip(),
        flags=re.IGNORECASE,
    ).strip()
    return re.sub(r"\s*(?:…|\.\.\.)\s*$", "", cleaned).strip()


def assess_candidate(candidate, *, content: bytes, canonical_url: str, final_url: str, quality_score: int, signals: dict[str, object]) -> CandidateAssessment:
    del candidate, final_url
    if not signals["looksLikeHtml"]:
        return CandidateAssessment(quality_score, signals)
    usable, evidence = _bloomberg_origin_parser_evidence(content, canonical_url=canonical_url)
    return CandidateAssessment(quality_score, signals | evidence, () if usable else ("bloomberg-parser-unusable",))


def completed_rejection_reason(capture, *, content: bytes, signals: dict[str, object]) -> str | None:
    del signals
    usable, _ = _bloomberg_origin_parser_evidence(content, canonical_url=capture.canonical_url)
    if not usable:
        return "bloomberg-origin-parser-incomplete"
    if capture.selected_candidate.provider != CaptureProvider.OTHER:
        return None
    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="bloomberg",
            canonical_url=capture.canonical_url,
            allow_generic_syndication=True,
        )
    except Exception:
        return None
    if _short_parsed_paywall_shell(
        body_characters=article.quality.body_characters,
        plain_text=article.plain_text,
    ):
        return "bloomberg-syndication-paywall-shell"
    return None


def validate_candidate_response(session, candidate: CaptureCandidate, response):
    if candidate.provider != CaptureProvider.OTHER:
        return response, None
    if session.state.get("syndication_mode"):
        valid, evidence = _validate_bloomberg_syndication_response(
            session.item,
            content=response[2],
            final_url=response[3],
        )
        if not valid:
            return None, "bloomberg-syndication:validation:" + str(
                evidence.get("reason") or "failed"
            )
        return (*response[:6], response[6] | evidence), None
    if _is_bnn_wayback_candidate(candidate.snapshot_url):
        valid, evidence = _validate_bloomberg_bnn_response(
            session.item,
            expected_headline=candidate.expected_headline,
            content=response[2],
            final_url=response[3],
        )
        label = "bloomberg-bnn"
    elif candidate.expected_headline:
        valid, evidence = _validate_bloomberg_partner_archive_response(
            session.item,
            expected_headline=candidate.expected_headline,
            content=response[2],
            final_url=response[3],
        )
        label = "bloomberg-partner"
    else:
        return response, None
    if not valid:
        return None, f"{label}:validation:{evidence.get('reason') or 'failed'}"
    return (*response[:6], response[6] | evidence), None


def timemap_items(session):
    urls = archive_discovery_urls(session.item.canonical_url)
    published = _parse_iso_datetime(session.item.published_at)
    if published is None or published.year > 2015:
        urls = tuple(reversed(urls))
    return tuple(
        ManifestItem(
            publisher=session.item.publisher,
            canonical_url=url,
            published_at=session.item.published_at,
            section=session.item.section,
            candidates=session.item.candidates,
        )
        for url in urls
    )


def run_capture(session) -> None:
    manifest_only = bool(
        session.source_options.get("bloomberg_manifest_candidates_only")
    )
    published = _parse_iso_datetime(session.item.published_at)
    timemap_candidates = timemap_items(session)
    if (
        not manifest_only
        and session.enable_wayback_timemap_fallback
        and published is not None
        and published.year <= 2015
        and len(timemap_candidates) > 1
    ):
        session.discover_wayback(timemap_candidates[0], label="wayback-legacy-timemap")
    if session.best_response is None:
        session.consider(session.item.candidates)
    if manifest_only:
        return
    session.consider_common_crawl()
    if (
        session.best_response is None
        and session.enable_wayback_timemap_fallback
        and not session.wayback_timemap_attempted
    ):
        for item in timemap_candidates:
            if session.best_response is not None:
                break
            session.discover_wayback(item)
    if session.best_response is None:
        try:
            candidates = discover_bloomberg_syndication_candidates(
                session.item,
                archive_client=session.archive_client,
            )
        except Exception as exc:
            session.fail("bloomberg-syndication", exc)
            candidates = ()
        session.state["syndication_mode"] = True
        session.consider(session.add_candidates(candidates))
        session.state["syndication_mode"] = False
    session.consider_arquivo()


def archive_match_path(host: str, path: str) -> str:
    del host
    legacy = re.fullmatch(
        r"/news/(?P<date>\d{4}-\d{2}-\d{2})/(?P<slug>[^/]+)\.html",
        path,
    )
    if legacy is not None:
        return f"/news/{legacy.group('date')}/{legacy.group('slug')}"
    current = re.fullmatch(
        r"/news/articles/(?P<date>\d{4}-\d{2}-\d{2})/(?P<slug>[^/]+)",
        path,
    )
    if current is not None:
        return f"/news/{current.group('date')}/{current.group('slug')}"
    return path


def archive_discovery_urls(canonical_url: str) -> tuple[str, ...]:
    parsed = urlsplit(canonical_url)
    match = re.fullmatch(
        r"/news/articles/(?P<date>\d{4}-\d{2}-\d{2})/(?P<slug>[^/]+)",
        parsed.path.rstrip("/"),
    )
    if match is None:
        return (canonical_url,)
    return (
        f"https://www.bloomberg.com/news/{match.group('date')}/{match.group('slug')}.html",
        canonical_url,
    )


def raw_shell_signals(
    *,
    sampled_content: bytes,
    prefix: bytes,
    final_url: str,
    has_article_marker: bool,
    has_strong_body_marker: bool,
) -> dict[str, object]:
    del sampled_content, has_article_marker
    decoded_url = unquote(final_url.casefold())
    teaser = bool(
        "bloomberg.com/" in decoded_url
        and (
            b"teaser-body__" in prefix
            or (b"body-content" in prefix and b"teaser-content__" in prefix)
        )
    )
    subscription = bool(
        not has_strong_body_marker
        and (
            (
                b"already a subscriber" in prefix
                and b"log in to keep reading" in prefix
                and b"bloomberg" in prefix
            )
            or b"join over 300,000 finance professionals" in prefix
            or b"discover all the plans currently available in your country" in prefix
        )
    )
    return {
        "subscriptionShell": subscription,
        "bloombergTeaserShell": teaser,
        "penalize": subscription or teaser,
    }


def _is_bnn_wayback_candidate(value: str) -> bool:
    return (
        re.match(
            r"^https?://web\.archive\.org/web/\d{14}"
            r"(?:id_|im_|js_|cs_)?/https?://"
            r"(?:www\.)?bnnbloomberg\.ca/",
            value,
            flags=re.IGNORECASE,
        )
        is not None
    )


def _bnn_mirrored_slug_matches(
    partner_url: str,
    canonical_url: str,
) -> bool:
    partner = urlsplit(partner_url)
    canonical = urlsplit(canonical_url)
    partner_match = re.fullmatch(
        r"/bloomberg/(20\d{2})/(\d{2})/(\d{2})/"
        r"([a-z0-9][a-z0-9-]*)/?",
        partner.path,
        flags=re.IGNORECASE,
    )
    if (
        partner_match is None
        or (partner.hostname or "").casefold()
        not in {"bnnbloomberg.ca", "www.bnnbloomberg.ca"}
        or (canonical.hostname or "").casefold()
        not in {"bloomberg.com", "www.bloomberg.com"}
    ):
        return False
    expected_path = (
        "/news/articles/"
        f"{partner_match.group(1)}-{partner_match.group(2)}-"
        f"{partner_match.group(3)}/{partner_match.group(4)}"
    )
    return canonical.path.rstrip("/").casefold() == expected_path.casefold()


def bloomberg_syndication_search_url(item: ManifestItem) -> str:
    return _syndication_search_url(item, publisher_label="Bloomberg")


def discover_bloomberg_syndication_candidates(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
) -> tuple[CaptureCandidate, ...]:
    return _discover_syndication_candidates(
        item,
        archive_client=archive_client,
        search_url=bloomberg_syndication_search_url(item),
        excluded_publisher="bloomberg",
    )


def _validate_bloomberg_syndication_response(
    item: ManifestItem,
    *,
    content: bytes,
    final_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="bloomberg",
            canonical_url=item.canonical_url,
            allow_generic_syndication=True,
        )
    except Exception as exc:
        return False, {
            "reason": f"parser-{type(exc).__name__}",
            "bloombergSyndicationValidated": False,
        }
    headline_overlap = _syndication_headline_overlap(
        item.canonical_url,
        article.headline or "",
    )
    soup = BeautifulSoup(content, "html.parser")
    visible_text = soup.get_text(" ", strip=True)
    author_text = " ".join(author.name for author in article.authors)
    attribution_text = (
        author_text
        + "\n"
        + visible_text[:10_000]
        + "\n"
        + article.plain_text[-1_000:]
    )
    attributed = re.search(
        r"(?i)(?:^|\W)bloomberg(?:\s+(?:news|opinion))?(?:\W|$)",
        attribution_text,
    ) is not None
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
    paywall_shell = _short_parsed_paywall_shell(
        body_characters=body_characters,
        plain_text=article.plain_text,
    )
    title_matches = headline_overlap >= 0.75
    valid = (
        article.quality.status == ArticleStatus.COMPLETE
        and body_characters
        >= BLOOMBERG_SYNDICATION_MINIMUM_BODY_CHARACTERS
        and not paywall_shell
        and attributed
        and title_matches
        and date_matches
    )
    if article.quality.status != ArticleStatus.COMPLETE:
        reason = f"parser-{article.quality.status.value}"
    elif body_characters < BLOOMBERG_SYNDICATION_MINIMUM_BODY_CHARACTERS:
        reason = "body-too-short"
    elif paywall_shell:
        reason = "suspected-paywall-shell"
    elif not attributed:
        reason = "missing-bloomberg-attribution"
    elif not title_matches:
        reason = "headline-mismatch"
    elif not date_matches:
        reason = "publication-date-mismatch"
    else:
        reason = None
    return valid, {
        "reason": reason,
        "bloombergSyndicationValidated": valid,
        "syndicationFinalUrl": final_url,
        "syndicationHeadlineOverlap": round(headline_overlap, 4),
        "syndicationBodyCharacters": body_characters,
        "syndicationPaywallShell": paywall_shell,
        "syndicationBloombergAttributed": attributed,
        "syndicationDateDeltaDays": date_delta_days,
        "syndicationExpectedDateVisible": date_visible,
    }


def _validate_bloomberg_bnn_response(
    item: ManifestItem,
    *,
    expected_headline: str | None,
    content: bytes,
    final_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    partner_match = re.match(
        r"^https?://web\.archive\.org/web/\d{14}"
        r"(?:id_|im_|js_|cs_)?/(https?://.+)$",
        final_url,
        flags=re.IGNORECASE,
    )
    archived_partner_url = (
        unquote(partner_match.group(1)) if partner_match else ""
    )
    archived_partner = urlsplit(archived_partner_url)
    partner_validated = (
        archived_partner.scheme in {"http", "https"}
        and (archived_partner.hostname or "").casefold()
        in {"bnnbloomberg.ca", "www.bnnbloomberg.ca"}
    )
    if not partner_validated:
        return False, {
            "reason": "unexpected-bnn-archive-url",
            "bloombergBnnValidated": False,
            "syndicationFinalUrl": final_url,
            "syndicationPartnerHostValidated": False,
        }
    if not expected_headline:
        return False, {
            "reason": "missing-original-headline",
            "bloombergBnnValidated": False,
            "syndicationFinalUrl": final_url,
            "syndicationPartnerHostValidated": True,
        }
    try:
        article = parse_article(
            content,
            publisher="bloomberg",
            canonical_url=item.canonical_url,
            allow_generic_syndication=True,
        )
    except Exception as exc:
        return False, {
            "reason": f"parser-{type(exc).__name__}",
            "bloombergBnnValidated": False,
            "syndicationFinalUrl": final_url,
            "syndicationPartnerHostValidated": True,
        }
    soup = BeautifulSoup(content, "html.parser")
    visible_text = soup.get_text(" ", strip=True)
    author_text = " ".join(author.name for author in article.authors)
    attributed = re.search(
        r"(?i)(?:^|\W)bloomberg(?:\s+news)?(?:\W|$)",
        author_text + "\n" + visible_text[:5_000],
    ) is not None
    expected_date = _parse_iso_datetime(item.published_at)
    copyright_attributed = (
        expected_date is not None
        and re.search(
            rf"(?i)(?:©|\(c\)|copyright)\s*{expected_date.year}\s+"
            r"bloomberg\s+l\.p\.",
            visible_text,
        )
        is not None
    )
    decoded_html = content.decode(
        "utf-8",
        errors="ignore",
    ).replace("\\/", "/")
    canonical_linked = (
        item.canonical_url.rstrip("/").casefold()
        in decoded_html.casefold()
    )
    mirrored_slug_validated = _bnn_mirrored_slug_matches(
        archived_partner_url,
        item.canonical_url,
    )
    canonical_provenance_validated = (
        canonical_linked or mirrored_slug_validated
    )
    headline_overlap = _headline_text_overlap(
        expected_headline,
        article.headline or "",
    )
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
        and body_characters
        >= BLOOMBERG_SYNDICATION_MINIMUM_BODY_CHARACTERS
        and attributed
        and copyright_attributed
        and canonical_provenance_validated
        and headline_overlap >= 0.8
        and date_matches
    )
    if article.quality.status != ArticleStatus.COMPLETE:
        reason = f"parser-{article.quality.status.value}"
    elif body_characters < BLOOMBERG_SYNDICATION_MINIMUM_BODY_CHARACTERS:
        reason = "body-too-short"
    elif not attributed:
        reason = "missing-bloomberg-attribution"
    elif not copyright_attributed:
        reason = "missing-bloomberg-copyright"
    elif not canonical_provenance_validated:
        reason = "missing-original-url-provenance"
    elif headline_overlap < 0.8:
        reason = "headline-mismatch"
    elif not date_matches:
        reason = "publication-date-mismatch"
    else:
        reason = None
    return valid, {
        "reason": reason,
        "bloombergBnnValidated": valid,
        "syndicationFinalUrl": final_url,
        "syndicationHeadlineOverlap": round(headline_overlap, 4),
        "syndicationBodyCharacters": body_characters,
        "syndicationBloombergAttributed": attributed,
        "syndicationBloombergCopyrightAttributed": copyright_attributed,
        "syndicationCanonicalArticleLinked": canonical_linked,
        "syndicationMirroredSlugValidated": mirrored_slug_validated,
        "syndicationDateDeltaDays": date_delta_days,
        "syndicationExpectedDateVisible": date_visible,
        "syndicationOriginalHeadline": expected_headline,
        "syndicationPartnerHostValidated": partner_validated,
        "syndicationPartnerUrl": archived_partner_url,
    }


def _validate_bloomberg_partner_archive_response(
    item: ManifestItem,
    *,
    expected_headline: str,
    content: bytes,
    final_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    partner_match = re.match(
        r"^https?://web\.archive\.org/web/\d{14}"
        r"(?:id_|im_|js_|cs_)?/(https?://.+)$",
        final_url,
        flags=re.IGNORECASE,
    )
    archived_partner_url = (
        unquote(partner_match.group(1)) if partner_match else ""
    )
    archived_partner = urlsplit(archived_partner_url)
    partner_host = (archived_partner.hostname or "").casefold()
    partner_validated = (
        archived_partner.scheme in {"http", "https"}
        and bool(partner_host)
        and partner_host not in {"bloomberg.com", "www.bloomberg.com"}
    )
    if not partner_validated:
        return False, {
            "reason": "unexpected-partner-archive-url",
            "bloombergPartnerValidated": False,
            "syndicationFinalUrl": final_url,
            "syndicationPartnerHostValidated": False,
        }
    try:
        article = parse_article(
            content,
            publisher="bloomberg",
            canonical_url=item.canonical_url,
            allow_generic_syndication=True,
        )
    except Exception as exc:
        return False, {
            "reason": f"parser-{type(exc).__name__}",
            "bloombergPartnerValidated": False,
            "syndicationFinalUrl": final_url,
            "syndicationPartnerHostValidated": True,
        }
    soup = BeautifulSoup(content, "html.parser")
    visible_text = soup.get_text(" ", strip=True)
    author_text = " ".join(author.name for author in article.authors)
    attributed = re.search(
        r"(?i)(?:^|\W)bloomberg(?:\s+news)?(?:\W|$)",
        author_text + "\n" + visible_text[:5_000],
    ) is not None
    expected_date = _parse_iso_datetime(item.published_at)
    copyright_attributed = (
        expected_date is not None
        and re.search(
            rf"(?i)(?:©|\(c\)|copyright)\s*{expected_date.year}\s+"
            r"bloomberg\s+l\.p\.",
            visible_text,
        )
        is not None
    )
    headline_overlap = _headline_text_overlap(
        expected_headline,
        article.headline or "",
    )
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
        and body_characters
        >= BLOOMBERG_SYNDICATION_MINIMUM_BODY_CHARACTERS
        and attributed
        and copyright_attributed
        and headline_overlap >= 0.8
        and date_matches
    )
    if article.quality.status != ArticleStatus.COMPLETE:
        reason = f"parser-{article.quality.status.value}"
    elif body_characters < BLOOMBERG_SYNDICATION_MINIMUM_BODY_CHARACTERS:
        reason = "body-too-short"
    elif not attributed:
        reason = "missing-bloomberg-attribution"
    elif not copyright_attributed:
        reason = "missing-bloomberg-copyright"
    elif headline_overlap < 0.8:
        reason = "headline-mismatch"
    elif not date_matches:
        reason = "publication-date-mismatch"
    else:
        reason = None
    return valid, {
        "reason": reason,
        "bloombergPartnerValidated": valid,
        "syndicationFinalUrl": final_url,
        "syndicationHeadlineOverlap": round(headline_overlap, 4),
        "syndicationBodyCharacters": body_characters,
        "syndicationBloombergAttributed": attributed,
        "syndicationBloombergCopyrightAttributed": copyright_attributed,
        "syndicationDateDeltaDays": date_delta_days,
        "syndicationExpectedDateVisible": date_visible,
        "syndicationOriginalHeadline": expected_headline,
        "syndicationPartnerHostValidated": partner_validated,
        "syndicationPartnerUrl": archived_partner_url,
    }


def _bloomberg_origin_parser_evidence(
    content: bytes,
    *,
    canonical_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="bloomberg",
            canonical_url=canonical_url,
            allow_generic_syndication=True,
        )
    except Exception as exc:
        return False, {
            "bloombergOriginParserUsable": False,
            "bloombergOriginParserError": type(exc).__name__,
        }
    nontext = article.content_type in {
        ContentType.INTERACTIVE,
        ContentType.VIDEO,
        ContentType.AUDIO,
        ContentType.GALLERY,
    }
    usable = article.quality.status == ArticleStatus.COMPLETE or nontext
    return usable, {
        "bloombergOriginParserUsable": usable,
        "bloombergOriginExtractionStatus": article.quality.status.value,
        "bloombergOriginContentType": article.content_type.value,
        "bloombergOriginBodyCharacters": article.quality.body_characters,
    }


CAPTURE = SourceCaptureHooks(
    publisher="bloomberg",
    validate_candidate_response=validate_candidate_response,
    timemap_items=timemap_items,
    run_capture=run_capture,
    assess_candidate=assess_candidate,
    clean_syndication_search_title=clean_syndication_search_title,
    archive_match_path=archive_match_path,
    archive_discovery_urls=archive_discovery_urls,
    raw_shell_signals=raw_shell_signals,
    completed_rejection_reason=completed_rejection_reason,
)

__all__ = ["CAPTURE"]
