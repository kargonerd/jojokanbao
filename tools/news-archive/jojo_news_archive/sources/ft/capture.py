from __future__ import annotations

from datetime import timezone
from email.utils import parsedate_to_datetime
import json
import re
from threading import Lock
from typing import Iterable
from urllib.parse import parse_qs, unquote, urlencode, urlsplit, urlunsplit
from xml.etree import ElementTree
from bs4 import BeautifulSoup
from jojo_news_archive.capture.primitives import (
    SYNDICATION_SEARCH_ENDPOINT,
    SYNDICATION_SEARCH_MAXIMUM_BYTES,
    clean_syndication_search_title as _clean_syndication_search_title,
    expected_date_visible as _expected_date_visible,
    fetch_limited_archive as _fetch_limited_archive,
    fetch_syndication_search_results as _fetch_syndication_search_results,
    headline_slug as _headline_slug,
    headline_text_overlap as _headline_text_overlap,
    is_archive_today_candidate_url as _is_archive_today_candidate_url,
    is_public_syndication_url as _is_public_syndication_url,
    nearest_visible_date_delta_days as _nearest_visible_date_delta_days,
    parse_iso_datetime as _parse_iso_datetime,
    rank_syndication_candidates as _rank_syndication_candidates,
    same_article_url as _same_article_url,
    significant_tokens as _significant_tokens,
)
from jojo_news_archive.discovery.client import ArchiveClient
from jojo_news_archive.models import ArticleStatus, CaptureCandidate, CaptureProvider, ContentType
from jojo_news_archive.sources.capture_contracts import (
    ArchiveFallbackPolicy,
    CandidateAssessment,
    ManifestItem,
    SourceCaptureHooks,
)
from jojo_news_archive.sources.ft.discovery.infini_news import is_ft_subscription_headline
from jojo_news_archive.discovery.ghostarchive import (
    discover_ghostarchive_candidates,
    is_ghostarchive_candidate_url,
)


FT_SYNDICATION_MINIMUM_BODY_CHARACTERS = 400


SUPPORTS_INFINI_NEWS = True


SYNDICATION_MAXIMUM_CANDIDATES = 8


def normalize_syndication_candidate_url(value: str) -> str:
    return _normalize_ft_syndication_candidate_url(value)


def _clean_syndication_search_title(value: str) -> str:
    cleaned = re.sub(
        r"\s+(?:[-|]\s*)?(?:Financial\s+Times|FT\.com)\s*$",
        "",
        value.strip(),
        flags=re.IGNORECASE,
    ).strip()
    return re.sub(r"\s*(?:…|\.\.\.)\s*$", "", cleaned).strip()


clean_syndication_search_title = _clean_syndication_search_title


def infini_minimum_body_characters(source_url: str) -> int:
    return 1_000 if _is_ft_origin_url(source_url) else FT_SYNDICATION_MINIMUM_BODY_CHARACTERS


def skip_candidate(candidate: CaptureCandidate) -> bool:
    return bool(
        candidate.provider == CaptureProvider.INFINI_NEWS
        and is_ft_subscription_headline(candidate.expected_headline)
    )


def fetch_candidate(candidate: CaptureCandidate, *, archive_client: ArchiveClient, maximum_html_bytes: int, canonical_url: str):
    del canonical_url
    if candidate.provider != CaptureProvider.WAYBACK:
        return None
    configured_attempts = int(getattr(archive_client, "attempts", 2))
    configured_timeout = float(getattr(archive_client, "timeout", 30.0))
    return _fetch_limited_archive(
        archive_client,
        candidate.snapshot_url,
        maximum_bytes=maximum_html_bytes,
        attempts=max(1, min(2, configured_attempts)),
        timeout=max(1.0, min(30.0, configured_timeout)),
    )


def assess_candidate(candidate, *, content: bytes, canonical_url: str, final_url: str, quality_score: int, signals: dict[str, object]) -> CandidateAssessment:
    del candidate, final_url
    if not signals["looksLikeHtml"]:
        return CandidateAssessment(quality_score, signals)
    usable, evidence = _ft_capture_parser_evidence(content, canonical_url=canonical_url)
    reasons = []
    if signals.get("ftTruncatedArticleShell"):
        reasons.append("ft-truncated-shell")
    if not usable:
        reasons.append("ft-parser-unusable")
    return CandidateAssessment(quality_score, signals | evidence, tuple(reasons))


def completed_rejection_reason(capture, *, content: bytes, signals: dict[str, object]) -> str | None:
    if signals.get("ftTruncatedArticleShell"):
        return "ft-truncated-article-shell"
    usable, _ = _ft_capture_parser_evidence(content, canonical_url=capture.canonical_url)
    return None if usable else "ft-capture-parser-incomplete"


def observe_candidate_response(session, candidate: CaptureCandidate, *, content: bytes, final_url: str) -> None:
    if session.state.get("original_headline") or candidate.provider == CaptureProvider.OTHER:
        return
    session.state["original_headline"] = _extract_ft_original_headline(
        content,
        expected_published_at=session.item.published_at,
        final_url=final_url,
    )


def should_skip_candidate(session, candidate: CaptureCandidate) -> bool:
    return bool(
        candidate.provider == CaptureProvider.INFINI_NEWS
        and (
            session.state.get("raw_partner_validated")
            or session.state.get("origin_validated")
        )
    )


def validate_candidate_response(session, candidate: CaptureCandidate, response):
    if candidate.provider not in {CaptureProvider.OTHER, CaptureProvider.INFINI_NEWS}:
        return response, None
    direct_origin = bool(
        candidate.provider == CaptureProvider.INFINI_NEWS
        and _is_ft_origin_url(candidate.source_url)
    )
    ghost_origin = bool(
        candidate.provider == CaptureProvider.OTHER
        and is_ghostarchive_candidate_url(candidate.snapshot_url)
    )
    archive_origin = bool(
        candidate.provider == CaptureProvider.OTHER
        and _is_archive_today_candidate_url(candidate.snapshot_url)
        and _is_ft_origin_url(candidate.source_url)
    )
    official_chinese = bool(
        candidate.provider == CaptureProvider.OTHER
        and _is_ftchinese_full_view_url(candidate.snapshot_url)
    )
    jina_origin = bool(
        candidate.provider == CaptureProvider.OTHER
        and _is_jina_ft_reader_url(candidate.snapshot_url)
        and _is_ft_origin_url(candidate.source_url)
    )
    if ghost_origin or archive_origin:
        valid, evidence = _validate_ft_ghostarchive_response(
            session.item,
            expected_headline=candidate.expected_headline,
            content=response[2],
            final_url=response[3],
        )
        label = "ft-archive-origin"
    elif direct_origin or jina_origin:
        valid, evidence = _validate_ft_infini_origin_response(
            session.item,
            expected_source_url=candidate.source_url or "",
            expected_headline=candidate.expected_headline,
            content=response[2],
            final_url=candidate.source_url or "" if jina_origin else response[3],
        )
        label = "ft-infini-origin"
    else:
        valid, evidence = _validate_ft_syndication_response(
            session.item,
            expected_partner_url=candidate.source_url or candidate.snapshot_url,
            expected_headline=candidate.expected_headline,
            content=response[2],
            final_url=response[3],
        )
        label = "ft-syndication"
    if not valid:
        return None, f"{label}:validation:{evidence.get('reason') or 'failed'}"
    origin_validated = direct_origin or jina_origin or ghost_origin or archive_origin
    if origin_validated:
        session.state["origin_validated"] = True
    elif candidate.provider == CaptureProvider.OTHER:
        session.state["raw_partner_validated"] = True
    score = 100 if (origin_validated or official_chinese) else response[5]
    signals = response[6] | evidence
    if official_chinese:
        signals["ftChineseOfficialMirrorValidated"] = True
    return (*response[:5], score, signals), None


def run_capture(session) -> None:
    """Execute FT's source-owned archive and licensed-copy fallback order."""

    session.state["original_headline"] = next(
        (candidate.expected_headline for candidate in session.item.candidates if candidate.expected_headline),
        None,
    )
    state = session.state

    def title_index() -> None:
        if session.best_response is not None or state.get("title_index_attempted"):
            return
        lookup = session.source_options.get("ft_syndication_lookup")
        headline = state.get("original_headline")
        if not callable(lookup) or not headline:
            return
        state["title_index_attempted"] = True
        try:
            candidates = lookup(session.item, str(headline))
        except Exception as exc:
            session.fail("ft-title-index", exc)
            return
        session.consider(session.add_candidates(candidates))

    def dynamic_syndication() -> None:
        if session.best_response is not None or state.get("dynamic_syndication_attempted"):
            return
        headline_was_known = bool(state.get("original_headline"))
        state["dynamic_syndication_attempted"] = True
        try:
            candidates = discover_ft_syndication_candidates(
                session.item,
                archive_client=session.archive_client,
                expected_headline=state.get("original_headline"),
            )
        except Exception as exc:
            session.fail("ft-syndication", exc)
            candidates = ()
        if not candidates and not headline_was_known:
            state["dynamic_syndication_attempted"] = False
        fresh = session.add_candidates(candidates)
        session.consider(fresh)
        if session.best_response is not None or not fresh:
            return
        fallback_headline = next(
            (candidate.expected_headline for candidate in fresh if candidate.expected_headline),
            state.get("original_headline"),
        )
        try:
            additional = discover_ft_syndication_candidates(
                session.item,
                archive_client=session.archive_client,
                expected_headline=fallback_headline,
                skip_title_search=True,
                exhaustive=True,
            )
        except Exception as exc:
            session.fail("ft-syndication-additional", exc)
            additional = ()
        session.consider(session.add_candidates(additional))

    def ghostarchive() -> None:
        published = _parse_iso_datetime(session.item.published_at)
        if (
            session.best_response is not None
            or state.get("ghostarchive_attempted")
            or published is None
            or published.year < 2022
        ):
            return
        state["ghostarchive_attempted"] = True
        try:
            candidates = discover_ghostarchive_candidates(
                session.item.canonical_url,
                archive_client=session.archive_client,
                expected_headline=state.get("original_headline"),
            )
        except Exception as exc:
            session.fail("ghostarchive-index", exc)
            candidates = ()
        session.consider(session.add_candidates(candidates))

    direct_origins = tuple(
        candidate
        for candidate in session.item.candidates
        if candidate.provider == CaptureProvider.INFINI_NEWS
        and _is_ft_origin_url(candidate.source_url)
    )
    session.consider(direct_origins)
    published = _parse_iso_datetime(session.item.published_at)
    if (
        published is not None
        and published.year >= 2024
        and session.item.candidates
        and all(candidate.provider == CaptureProvider.WAYBACK for candidate in session.item.candidates)
    ):
        dynamic_syndication()
    ghostarchive()

    if session.enable_wayback_timemap_fallback:
        if session.best_response is None or session.best_response[5] < 100:
            session.discover_wayback(
                maximum_candidates=8,
                label="wayback-timemap",
            )
        if not state.get("origin_validated") and (
            session.best_response is None or session.best_response[5] < 100
        ):
            session.consider(session.item.candidates)
    elif not state.get("origin_validated") and (
        session.best_response is None or session.best_response[5] < 100
    ):
        session.consider(session.item.candidates[:1])

    title_index()
    dynamic_syndication()
    if not state.get("origin_validated"):
        session.consider_common_crawl()
    title_index()
    dynamic_syndication()
    session.consider_arquivo()


def archive_discovery_urls(canonical_url: str) -> tuple[str, ...]:
    """Return exact archive keys for legacy bare/www and HTTP/HTTPS rows."""

    parsed = urlsplit(canonical_url)
    hostname = (parsed.hostname or "").casefold()
    if hostname not in {"ft.com", "www.ft.com"}:
        return (canonical_url,)
    alternate_host = "ft.com" if hostname == "www.ft.com" else "www.ft.com"
    variants = [canonical_url]
    for scheme, host in (
        ("https", hostname),
        ("http", hostname),
        ("https", alternate_host),
        ("http", alternate_host),
    ):
        candidate = urlunsplit((scheme, host, parsed.path, parsed.query, ""))
        if candidate not in variants:
            variants.append(candidate)
    return tuple(variants)


def timemap_companion_urls(canonical_url: str) -> tuple[str, ...]:
    parsed = urlsplit(canonical_url)
    if (
        parsed.hostname in {"ft.com", "www.ft.com"}
        and parsed.path.startswith("/content/")
    ):
        return (f"https://amp.ft.com{parsed.path}",)
    return ()


def raw_shell_signals(
    *,
    sampled_content: bytes,
    prefix: bytes,
    final_url: str,
    has_article_marker: bool,
    has_strong_body_marker: bool,
) -> dict[str, object]:
    body_characters, body_images = _ft_article_body_evidence(
        sampled_content, final_url=final_url
    )
    explicit_truncation = all(
        marker in sampled_content
        for marker in (
            "您已阅读".encode(),
            "剩余".encode(),
            "订阅以继续探索完整内容".encode(),
        )
    )
    truncated = bool(
        explicit_truncation
        or (
            body_characters is not None
            and has_article_marker
            and has_strong_body_marker
            and body_characters < FT_CAPTURE_MINIMUM_BODY_CHARACTERS
            and body_images < FT_IMAGE_LED_MINIMUM_IMAGES
        )
    )
    decoded_url = unquote(final_url.casefold())
    legacy_barrier = any(
        marker in decoded_url
        for marker in (
            "authorised=false",
            "iab=barrier-app",
            "classification=conditional_standard",
        )
    )
    subscription = bool(
        legacy_barrier
        or (
            not has_strong_body_marker
            and any(
                marker in prefix
                for marker in (
                    b"<title>become an ft subscriber to read",
                    b"<title>subscribe to a slice of the ft",
                    b"<title>try ft for free",
                    b"window.zephr.outcomes['paywall']",
                    b"during your trial you will have complete digital access to ft.com",
                )
            )
        )
    )
    return {
        "subscriptionShell": subscription,
        "ftLegacyBarrierUrl": legacy_barrier,
        "ftTruncatedArticleShell": truncated,
        "ftExplicitTruncationNotice": explicit_truncation,
        "ftBodyCharacters": body_characters,
        "ftBodyImages": body_images,
        "penalize": subscription or truncated,
    }


def archive_fallback_policy(
    *, parser_validation_enabled: bool, prior_attempts: int
) -> ArchiveFallbackPolicy:
    if not parser_validation_enabled:
        return ArchiveFallbackPolicy(True, True, True)
    # Exact Timemap selection is deliberately staged after the cheap manifest
    # pass; secondary indexes remain useful on every validation attempt.
    return ArchiveFallbackPolicy(
        wayback_timemap=prior_attempts >= 1,
        common_crawl=True,
        arquivo_pt=True,
    )


FT_CAPTURE_MINIMUM_BODY_CHARACTERS = 100


FT_IMAGE_LED_MINIMUM_IMAGES = 3


FTCHINESE_SEARCH_ENDPOINT = "https://m.ftchinese.com/search/"


FT_GOOGLE_NEWS_RSS_ENDPOINT = "https://news.google.com/rss/search"


FT_GOOGLE_NEWS_MAXIMUM_PARTNER_SOURCES = 3


FT_GOOGLE_NEWS_MAXIMUM_DATE_DELTA_DAYS = 2


FT_SYNDICATION_MAXIMUM_DATE_DELTA_DAYS = 2


FT_ADVISORSTREAM_MAXIMUM_DATE_DELTA_DAYS = 14


FT_KNOWN_PARTNER_SITEMAPS = (
    (
        "https://www.davidruler.com",
        "https://www.davidruler.com/sitemap.xml",
    ),
)


_ft_known_partner_urls: dict[str, str] | None = None


_ft_known_partner_urls_lock = Lock()


def ftchinese_title_search_url(expected_headline: str) -> str:
    return FTCHINESE_SEARCH_ENDPOINT + "?" + urlencode(
        {
            "keys": expected_headline,
            "type": "name",
        }
    )


def _discover_ftchinese_candidates(
    *,
    archive_client: ArchiveClient,
    expected_headline: str,
    attempts: int = 2,
    timeout: float = 30.0,
) -> tuple[CaptureCandidate, ...]:
    search_url = ftchinese_title_search_url(expected_headline)
    status_code, headers, content, final_url = _fetch_limited_archive(
        archive_client,
        search_url,
        maximum_bytes=SYNDICATION_SEARCH_MAXIMUM_BYTES,
        attempts=attempts,
        timeout=timeout,
    )
    content_type = headers.get("content-type", "").casefold()
    final_host = (urlsplit(final_url).hostname or "").casefold()
    if (
        status_code != 200
        or final_host != "m.ftchinese.com"
        or (
            "html" not in content_type
            and not content.lstrip().startswith(b"<")
        )
    ):
        return ()
    soup = BeautifulSoup(content, "html.parser")
    candidates: list[CaptureCandidate] = []
    seen_ids: set[str] = set()
    for anchor in soup.select("a[href]"):
        href = anchor.get("href")
        if not isinstance(href, str):
            continue
        parsed = urlsplit(href)
        if parsed.hostname not in {None, "m.ftchinese.com"}:
            continue
        match = re.fullmatch(
            r"/interactive/(\d+)(?:/en)?/?",
            parsed.path,
            flags=re.IGNORECASE,
        )
        if match is None or match.group(1) in seen_ids:
            continue
        seen_ids.add(match.group(1))
        candidates.append(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=(
                    "https://m.ftchinese.com/interactive/"
                    f"{match.group(1)}/en?full=y"
                ),
                expected_headline=expected_headline,
            )
        )
        if len(candidates) >= 3:
            break
    return tuple(candidates)


def _is_ftchinese_full_view_url(value: str) -> bool:
    parsed = urlsplit(value)
    query = parse_qs(parsed.query, keep_blank_values=True)
    return bool(
        parsed.scheme == "https"
        and (parsed.hostname or "").casefold() == "m.ftchinese.com"
        and re.fullmatch(
            r"/interactive/\d+/en/?",
            parsed.path,
            flags=re.IGNORECASE,
        )
        and query.get("full") == ["y"]
    )


def ft_syndication_search_url(item: ManifestItem) -> str:
    return SYNDICATION_SEARCH_ENDPOINT + "?" + urlencode(
        {"p": item.canonical_url}
    )


def ft_syndication_title_search_url(expected_headline: str) -> str:
    return SYNDICATION_SEARCH_ENDPOINT + "?" + urlencode(
        {"p": f'"{expected_headline}" "Financial Times"'}
    )


def ft_syndication_broad_title_search_url(
    expected_headline: str,
) -> str:
    return SYNDICATION_SEARCH_ENDPOINT + "?" + urlencode(
        {"p": expected_headline}
    )


def ft_google_news_headline_search_url(item: ManifestItem) -> str:
    article_identifier = (
        urlsplit(item.canonical_url).path.rstrip("/").rsplit("/", 1)[-1]
    )
    return FT_GOOGLE_NEWS_RSS_ENDPOINT + "?" + urlencode(
        {
            "q": f'"{article_identifier}"',
            "hl": "en-US",
            "gl": "US",
            "ceid": "US:en",
        }
    )


def ft_google_news_partner_search_url(
    expected_headline: str,
) -> str:
    return FT_GOOGLE_NEWS_RSS_ENDPOINT + "?" + urlencode(
        {
            "q": f'"{expected_headline}"',
            "hl": "en-US",
            "gl": "US",
            "ceid": "US:en",
        }
    )


def ft_syndication_partner_site_search_url(
    expected_headline: str,
    source_host: str,
) -> str:
    return SYNDICATION_SEARCH_ENDPOINT + "?" + urlencode(
        {"p": f'"{expected_headline}" site:{source_host}'}
    )


def _discover_ft_known_partner_candidates(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
    expected_headline: str,
) -> tuple[CaptureCandidate, ...]:
    expected_date = _parse_iso_datetime(item.published_at)
    if expected_date is None or expected_date.year != 2026:
        return ()
    slug = _headline_slug(expected_headline)
    if not slug:
        return ()
    partner_url = _load_ft_known_partner_urls(archive_client).get(slug)
    if not partner_url:
        return ()
    return (
        CaptureCandidate(
            provider=CaptureProvider.OTHER,
            snapshot_url=partner_url,
            expected_headline=expected_headline,
        ),
    )


def _load_ft_known_partner_urls(
    archive_client: ArchiveClient,
) -> dict[str, str]:
    global _ft_known_partner_urls
    with _ft_known_partner_urls_lock:
        if _ft_known_partner_urls is not None:
            return _ft_known_partner_urls
        discovered: dict[str, str] = {}
        for public_origin, sitemap_url in FT_KNOWN_PARTNER_SITEMAPS:
            try:
                status_code, headers, content, _ = archive_client.fetch(
                    sitemap_url,
                    maximum_bytes=SYNDICATION_SEARCH_MAXIMUM_BYTES,
                )
                content_type = headers.get("content-type", "").casefold()
                if (
                    status_code != 200
                    or not content
                    or (
                        "xml" not in content_type
                        and not content.lstrip().startswith(b"<?xml")
                    )
                ):
                    continue
                root = ElementTree.fromstring(content.lstrip())
            except Exception:
                continue
            for location in root.findall(".//{*}loc"):
                source_url = (location.text or "").strip()
                source_path = urlsplit(source_url).path.rstrip("/")
                prefix = "/resources/articles/"
                if not source_path.startswith(prefix):
                    continue
                candidate_slug = source_path.removeprefix(prefix)
                if not candidate_slug or "/" in candidate_slug:
                    continue
                discovered.setdefault(
                    candidate_slug.casefold(),
                    public_origin.rstrip("/") + source_path,
                )
        _ft_known_partner_urls = discovered
        return _ft_known_partner_urls


def discover_ft_syndication_candidates(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
    expected_headline: str | None = None,
    skip_title_search: bool = False,
    exhaustive: bool = False,
) -> tuple[CaptureCandidate, ...]:
    initial_results: list[tuple[int, str, str]] = []
    if not expected_headline:
        try:
            initial_results = _fetch_syndication_search_results(
                item,
                archive_client=archive_client,
                search_url=ft_syndication_search_url(item),
            )
        except Exception:
            initial_results = []
        expected_headline = next(
            (
                title
                for _, title, candidate_url in initial_results
                if title
                and _same_article_url(candidate_url, item.canonical_url)
            ),
            None,
        )
    if not expected_headline:
        try:
            expected_headline = (
                _discover_ft_headline_from_google_news(
                    item,
                    archive_client=archive_client,
                )
            )
        except Exception:
            expected_headline = None
    if (
        not expected_headline
        or len(_significant_tokens(expected_headline)) < 4
    ):
        return ()
    ftchinese_ranked: tuple[CaptureCandidate, ...] = ()
    if not exhaustive:
        try:
            ftchinese_ranked = _discover_ftchinese_candidates(
                archive_client=archive_client,
                expected_headline=expected_headline,
            )
        except Exception:
            ftchinese_ranked = ()
        if ftchinese_ranked:
            return ftchinese_ranked
    title_results: list[tuple[int, str, str]] = []
    if not skip_title_search:
        try:
            title_results = _fetch_syndication_search_results(
                item,
                archive_client=archive_client,
                search_url=ft_syndication_title_search_url(
                    expected_headline
                ),
            )
        except ValueError:
            title_results = []
    offset = len(initial_results)
    all_results = initial_results + [
        (offset + position, title, candidate_url)
        for position, title, candidate_url in title_results
    ]
    ranked = _rank_syndication_candidates(
        all_results,
        excluded_publisher="ft",
        expected_headline=expected_headline,
    )
    if ranked and not exhaustive:
        return ranked
    try:
        broad_results = _fetch_syndication_search_results(
            item,
            archive_client=archive_client,
            search_url=ft_syndication_broad_title_search_url(
                expected_headline
            ),
        )
    except Exception:
        broad_results = []
    offset = len(all_results)
    all_results.extend(
        (offset + position, title, candidate_url)
        for position, title, candidate_url in broad_results
    )
    ranked = _rank_syndication_candidates(
        all_results,
        excluded_publisher="ft",
        expected_headline=expected_headline,
    )
    if ranked and not exhaustive:
        return ranked
    if exhaustive:
        try:
            ftchinese_ranked = _discover_ftchinese_candidates(
                archive_client=archive_client,
                expected_headline=expected_headline,
            )
        except Exception:
            ftchinese_ranked = ()
    try:
        google_news_ranked = (
            _discover_ft_partner_candidates_from_google_news(
                item,
                archive_client=archive_client,
                expected_headline=expected_headline,
            )
        )
    except Exception:
        google_news_ranked = ()
    if not exhaustive:
        return google_news_ranked
    try:
        known_partner_ranked = _discover_ft_known_partner_candidates(
            item,
            archive_client=archive_client,
            expected_headline=expected_headline,
        )
    except Exception:
        known_partner_ranked = ()
    combined: list[CaptureCandidate] = []
    seen_urls: set[str] = set()
    for candidate in (
        *known_partner_ranked,
        *google_news_ranked,
        *ftchinese_ranked,
        *ranked,
    ):
        if candidate.snapshot_url in seen_urls:
            continue
        seen_urls.add(candidate.snapshot_url)
        combined.append(candidate)
    return tuple(combined)


def _discover_ft_partner_candidates_from_google_news(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
    expected_headline: str,
) -> tuple[CaptureCandidate, ...]:
    expected_date = _parse_iso_datetime(item.published_at)
    if expected_date is None:
        return ()
    search_url = ft_google_news_partner_search_url(expected_headline)
    status_code, headers, content, _ = archive_client.fetch(
        search_url,
        maximum_bytes=SYNDICATION_SEARCH_MAXIMUM_BYTES,
    )
    content_type = headers.get("content-type", "").casefold()
    if status_code != 200 or not content:
        raise ValueError(
            f"FT Google News partner search returned HTTP {status_code}"
        )
    if (
        "xml" not in content_type
        and not content.lstrip().startswith((b"<?xml", b"<rss"))
    ):
        raise ValueError("FT Google News partner search did not return XML")
    root = ElementTree.fromstring(content.lstrip())
    source_hosts: list[str] = []
    seen_hosts: set[str] = set()
    for result in root.findall("./channel/item"):
        result_title = _clean_syndication_search_title(
            result.findtext("title") or ""
        )
        if (
            _headline_text_overlap(expected_headline, result_title)
            < 0.8
        ):
            continue
        try:
            published_at = parsedate_to_datetime(
                result.findtext("pubDate") or ""
            )
        except (TypeError, ValueError, OverflowError):
            continue
        if published_at.tzinfo is None:
            published_at = published_at.replace(tzinfo=timezone.utc)
        if (
            abs(
                (
                    published_at.astimezone(timezone.utc).date()
                    - expected_date.date()
                ).days
            )
            > FT_GOOGLE_NEWS_MAXIMUM_DATE_DELTA_DAYS
        ):
            continue
        source = result.find("source")
        source_url = (
            source.attrib.get("url", "").strip()
            if source is not None
            else ""
        )
        source_host = (urlsplit(source_url).hostname or "").casefold()
        if (
            not source_host
            or source_host in seen_hosts
            or not _is_public_syndication_url(
                source_url,
                excluded_publisher="ft",
            )
        ):
            continue
        seen_hosts.add(source_host)
        source_hosts.append(source_host)
        if (
            len(source_hosts)
            >= FT_GOOGLE_NEWS_MAXIMUM_PARTNER_SOURCES
        ):
            break
    all_results: list[tuple[int, str, str]] = []
    for source_host in source_hosts:
        try:
            results = _fetch_syndication_search_results(
                item,
                archive_client=archive_client,
                search_url=ft_syndication_partner_site_search_url(
                    expected_headline,
                    source_host,
                ),
            )
        except Exception:
            continue
        offset = len(all_results)
        all_results.extend(
            (offset + position, title, candidate_url)
            for position, title, candidate_url in results
        )
    return _rank_syndication_candidates(
        all_results,
        excluded_publisher="ft",
        expected_headline=expected_headline,
    )


def _discover_ft_headline_from_google_news(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
) -> str | None:
    search_url = ft_google_news_headline_search_url(item)
    status_code, headers, content, _ = archive_client.fetch(
        search_url,
        maximum_bytes=SYNDICATION_SEARCH_MAXIMUM_BYTES,
    )
    content_type = headers.get("content-type", "").casefold()
    if status_code != 200 or not content:
        raise ValueError(
            f"FT Google News search returned HTTP {status_code}"
        )
    if (
        "xml" not in content_type
        and not content.lstrip().startswith((b"<?xml", b"<rss"))
    ):
        raise ValueError("FT Google News search did not return XML")
    root = ElementTree.fromstring(content.lstrip())
    expected_date = _parse_iso_datetime(item.published_at)
    if expected_date is None:
        return None
    ranked: list[tuple[int, int, str]] = []
    for position, result in enumerate(root.findall("./channel/item")):
        source = result.find("source")
        source_name = (source.text or "").strip() if source is not None else ""
        source_url = (
            source.attrib.get("url", "").strip()
            if source is not None
            else ""
        )
        source_host = (urlsplit(source_url).hostname or "").casefold()
        if (
            source_name.casefold() != "financial times"
            and source_host not in {"ft.com", "www.ft.com"}
        ):
            continue
        try:
            published_at = parsedate_to_datetime(
                result.findtext("pubDate") or ""
            )
        except (TypeError, ValueError, OverflowError):
            continue
        if published_at.tzinfo is None:
            published_at = published_at.replace(tzinfo=timezone.utc)
        date_delta = abs(
            (
                published_at.astimezone(timezone.utc).date()
                - expected_date.date()
            ).days
        )
        if date_delta > 2:
            continue
        cleaned = _clean_syndication_search_title(
            result.findtext("title") or ""
        )
        if len(_significant_tokens(cleaned)) < 4:
            continue
        ranked.append((date_delta, position, cleaned))
    if not ranked:
        return None
    ranked.sort()
    return ranked[0][2]


def _normalize_ft_syndication_candidate_url(value: str) -> str:
    parsed = urlsplit(value)
    host = (parsed.hostname or "").casefold().rstrip(".")
    if (
        host
        not in {
            "ftchinese.com",
            "www.ftchinese.com",
            "m.ftchinese.com",
            "cn.ft.com",
        }
        or not re.fullmatch(
            r"/interactive/\d+(?:/en)?/?",
            parsed.path,
            flags=re.IGNORECASE,
        )
    ):
        return value
    query = parse_qs(parsed.query, keep_blank_values=True)
    query["full"] = ["y"]
    return urlunsplit(
        (
            "https",
            "m.ftchinese.com",
            parsed.path,
            urlencode(query, doseq=True),
            "",
        )
    )


def _is_jina_ft_reader_url(value: str) -> bool:
    parsed = urlsplit(value)
    return bool(
        parsed.scheme == "https"
        and (parsed.hostname or "").casefold() == "r.jina.ai"
        and re.fullmatch(
            r"/https://(?:www\.)?ft\.com/content/"
            r"[0-9a-f-]+/?",
            parsed.path,
            flags=re.IGNORECASE,
        )
    )


def _validate_ft_syndication_response(
    item: ManifestItem,
    *,
    expected_partner_url: str,
    expected_headline: str | None,
    content: bytes,
    final_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    expected_host = (
        urlsplit(expected_partner_url).hostname or ""
    ).casefold().removeprefix("www.")
    final_host = (
        urlsplit(final_url).hostname or ""
    ).casefold().removeprefix("www.")
    partner_host_validated = (
        bool(expected_host)
        and final_host == expected_host
        and final_host not in {"ft.com"}
    )
    if not partner_host_validated:
        return False, {
            "reason": "unexpected-partner-url",
            "ftSyndicationValidated": False,
            "syndicationFinalUrl": final_url,
            "syndicationPartnerHostValidated": False,
        }
    if not expected_headline:
        return False, {
            "reason": "missing-original-headline",
            "ftSyndicationValidated": False,
            "syndicationFinalUrl": final_url,
            "syndicationPartnerHostValidated": True,
        }
    try:
        article = parse_article(
            content,
            publisher="ft",
            canonical_url=item.canonical_url,
            allow_generic_syndication=True,
        )
    except Exception as exc:
        return False, {
            "reason": f"parser-{type(exc).__name__}",
            "ftSyndicationValidated": False,
            "syndicationFinalUrl": final_url,
            "syndicationPartnerHostValidated": True,
        }
    soup = BeautifulSoup(content, "html.parser")
    visible_text = soup.get_text(" ", strip=True)
    copyright_attributed = re.search(
        r"(?i)(?:copyright|©|\(c\))\s*(?:20\d{2}\s+)?"
        r"(?:the\s+)?financial\s+times\s+(?:limited|ltd\.?)"
        r"(?:\s+20\d{2})?",
        visible_text,
    ) is not None
    advisorstream_licensed = re.search(
        r"(?i)(?:this(?:\s+financial\s+times)?|financial\s+times)"
        r"\s+article\s+was\s+legally\s+licensed\s+"
        r"(?:by|through)\s+advisorstream",
        visible_text,
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
    visible_date_delta_days = _nearest_visible_date_delta_days(
        visible_text,
        expected_date=expected_date,
    )
    if visible_date_delta_days is not None and (
        date_delta_days is None
        or visible_date_delta_days < date_delta_days
    ):
        date_delta_days = visible_date_delta_days
    date_visible = _expected_date_visible(
        content,
        expected_date=expected_date,
    )
    maximum_date_delta_days = (
        FT_ADVISORSTREAM_MAXIMUM_DATE_DELTA_DAYS
        if advisorstream_licensed
        else FT_SYNDICATION_MAXIMUM_DATE_DELTA_DAYS
    )
    date_matches = (
        date_delta_days is not None
        and date_delta_days <= maximum_date_delta_days
    ) or date_visible
    body_characters = article.quality.body_characters
    valid = (
        article.quality.status == ArticleStatus.COMPLETE
        and body_characters >= FT_SYNDICATION_MINIMUM_BODY_CHARACTERS
        and copyright_attributed
        and headline_overlap >= 0.8
        and date_matches
    )
    if article.quality.status != ArticleStatus.COMPLETE:
        reason = f"parser-{article.quality.status.value}"
    elif body_characters < FT_SYNDICATION_MINIMUM_BODY_CHARACTERS:
        reason = "body-too-short"
    elif not copyright_attributed:
        reason = "missing-ft-copyright"
    elif headline_overlap < 0.8:
        reason = "headline-mismatch"
    elif not date_matches:
        reason = "publication-date-mismatch"
    else:
        reason = None
    return valid, {
        "reason": reason,
        "ftSyndicationValidated": valid,
        "syndicationFinalUrl": final_url,
        "syndicationHeadlineOverlap": round(headline_overlap, 4),
        "syndicationBodyCharacters": body_characters,
        "syndicationFtCopyrightAttributed": copyright_attributed,
        "syndicationAdvisorStreamLicensed": advisorstream_licensed,
        "syndicationDateDeltaDays": date_delta_days,
        "syndicationMaximumDateDeltaDays": maximum_date_delta_days,
        "syndicationExpectedDateVisible": date_visible,
        "syndicationOriginalHeadline": expected_headline,
        "syndicationPartnerHostValidated": partner_host_validated,
    }


def _validate_ft_infini_origin_response(
    item: ManifestItem,
    *,
    expected_source_url: str,
    expected_headline: str | None,
    content: bytes,
    final_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    origin_url_validated = (
        _same_ft_origin_article_url(expected_source_url, item.canonical_url)
        and _same_ft_origin_article_url(final_url, item.canonical_url)
    )
    if not origin_url_validated:
        return False, {
            "reason": "unexpected-origin-url",
            "ftInfiniOriginValidated": False,
            "infiniOriginUrlValidated": False,
            "infiniOriginFinalUrl": final_url,
        }
    if not expected_headline:
        return False, {
            "reason": "missing-original-headline",
            "ftInfiniOriginValidated": False,
            "infiniOriginUrlValidated": True,
            "infiniOriginFinalUrl": final_url,
        }
    try:
        article = parse_article(
            content,
            publisher="ft",
            canonical_url=item.canonical_url,
        )
    except Exception as exc:
        return False, {
            "reason": f"parser-{type(exc).__name__}",
            "ftInfiniOriginValidated": False,
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
        "ftInfiniOriginValidated": valid,
        "infiniOriginUrlValidated": origin_url_validated,
        "infiniOriginFinalUrl": final_url,
        "infiniOriginHeadlineOverlap": round(headline_overlap, 4),
        "infiniOriginBodyCharacters": body_characters,
        "infiniOriginDateDeltaDays": date_delta_days,
        "infiniOriginExpectedDateVisible": date_visible,
        "infiniOriginExpectedHeadline": expected_headline,
    }


def _validate_ft_ghostarchive_response(
    item: ManifestItem,
    *,
    expected_headline: str | None,
    content: bytes,
    final_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    origin_url_validated = _same_ft_origin_article_url(
        final_url,
        item.canonical_url,
    )
    if not origin_url_validated:
        return False, {
            "reason": "unexpected-origin-url",
            "ftGhostarchiveOriginValidated": False,
            "ghostarchiveOriginUrlValidated": False,
            "ghostarchiveOriginFinalUrl": final_url,
        }
    try:
        article = parse_article(
            content,
            publisher="ft",
            canonical_url=item.canonical_url,
        )
    except Exception as exc:
        return False, {
            "reason": f"parser-{type(exc).__name__}",
            "ftGhostarchiveOriginValidated": False,
            "ghostarchiveOriginUrlValidated": True,
            "ghostarchiveOriginFinalUrl": final_url,
        }
    parsed_headline = article.headline or ""
    headline_present = len(_significant_tokens(parsed_headline)) >= 4
    headline_overlap = (
        _headline_text_overlap(expected_headline, parsed_headline)
        if expected_headline
        else None
    )
    headline_matches = (
        headline_present
        and (
            headline_overlap is None
            or headline_overlap >= 0.8
        )
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
        date_delta_days is not None
        and date_delta_days <= FT_SYNDICATION_MAXIMUM_DATE_DELTA_DAYS
    ) or date_visible
    body_characters = article.quality.body_characters
    valid = (
        article.quality.status == ArticleStatus.COMPLETE
        and body_characters >= 1_000
        and headline_matches
        and date_matches
    )
    if article.quality.status != ArticleStatus.COMPLETE:
        reason = f"parser-{article.quality.status.value}"
    elif body_characters < 1_000:
        reason = "body-too-short"
    elif not headline_matches:
        reason = "headline-mismatch"
    elif not date_matches:
        reason = "publication-date-mismatch"
    else:
        reason = None
    return valid, {
        "reason": reason,
        "ftGhostarchiveOriginValidated": valid,
        "ghostarchiveOriginUrlValidated": origin_url_validated,
        "ghostarchiveOriginFinalUrl": final_url,
        "ghostarchiveOriginHeadline": parsed_headline,
        "ghostarchiveOriginHeadlineOverlap": (
            round(headline_overlap, 4)
            if headline_overlap is not None
            else None
        ),
        "ghostarchiveOriginBodyCharacters": body_characters,
        "ghostarchiveOriginDateDeltaDays": date_delta_days,
        "ghostarchiveOriginExpectedDateVisible": date_visible,
        "ghostarchiveOriginExpectedHeadline": expected_headline,
    }


def _extract_ft_original_headline(
    content: bytes,
    *,
    expected_published_at: str | None,
    final_url: str,
) -> str | None:
    decoded_url = unquote(final_url).casefold()
    if (
        "/content/" not in decoded_url
        or re.search(
            r"https?://(?:[^/?#]+\.)?ft\.com(?:[/?#]|$)",
            decoded_url,
        )
        is None
    ):
        return None
    soup = BeautifulSoup(content, "html.parser")
    expected_date = _parse_iso_datetime(expected_published_at)

    def structured_articles(value: object) -> Iterable[dict]:
        if isinstance(value, dict):
            article_type = value.get("@type")
            types = (
                {str(item).casefold() for item in article_type}
                if isinstance(article_type, list)
                else {str(article_type).casefold()}
            )
            if types & {"article", "newsarticle", "reportagenewsarticle"}:
                yield value
            for child in value.values():
                yield from structured_articles(child)
        elif isinstance(value, list):
            for child in value:
                yield from structured_articles(child)

    for script in soup.select('script[type="application/ld+json"]'):
        serialized = script.string or script.get_text()
        if not serialized.strip():
            continue
        try:
            payload = json.loads(serialized)
        except (json.JSONDecodeError, TypeError):
            continue
        for article in structured_articles(payload):
            headline = article.get("headline")
            if not isinstance(headline, str):
                continue
            published_at = _parse_iso_datetime(
                article.get("datePublished")
                if isinstance(article.get("datePublished"), str)
                else None
            )
            if (
                expected_date is not None
                and published_at is not None
                and abs(
                    (published_at.date() - expected_date.date()).days
                )
                > 2
            ):
                continue
            cleaned = _clean_syndication_search_title(
                BeautifulSoup(
                    headline,
                    "html.parser",
                ).get_text(" ", strip=True)
            )
            if len(_significant_tokens(cleaned)) >= 4:
                return cleaned

    for selector, attribute in (
        ("meta[property='og:title']", "content"),
        ("meta[name='twitter:title']", "content"),
    ):
        node = soup.select_one(selector)
        value = node.get(attribute) if node is not None else None
        if not isinstance(value, str):
            continue
        cleaned = _clean_syndication_search_title(value)
        if len(_significant_tokens(cleaned)) >= 4:
            return cleaned
    return None


def _is_ft_origin_url(value: str | None) -> bool:
    hostname = (urlsplit(value or "").hostname or "").casefold()
    return hostname == "ft.com" or hostname.endswith(".ft.com")


def _same_ft_origin_article_url(first: str, second: str) -> bool:
    first_parts = urlsplit(first)
    second_parts = urlsplit(second)
    return bool(
        _is_ft_origin_url(first)
        and _is_ft_origin_url(second)
        and first_parts.path.rstrip("/").casefold()
        == second_parts.path.rstrip("/").casefold()
    )


def _ft_article_body_evidence(
    content: bytes,
    *,
    final_url: str,
) -> tuple[int | None, int]:
    decoded_url = unquote(final_url).casefold()
    if (
        "/content/" not in decoded_url
        or re.search(
            r"https?://(?:[^/?#]+\.)?ft\.com(?:[/?#]|$)",
            decoded_url,
        )
        is None
    ):
        return None, 0

    soup = BeautifulSoup(content, "html.parser")
    body_nodes = soup.select(".article__content-body, .article-body")
    if not body_nodes:
        for selector in (
            "#article-body",
            "#storyContent",
            "[data-trackable='article-body']",
            "[data-testid='article-body']",
        ):
            body_nodes.extend(soup.select(selector))

    body_characters = 0
    body_images = 0
    for node in body_nodes:
        text = re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip()
        body_characters = max(body_characters, len(text))
        image_count = sum(
            bool(
                image.get("src")
                or image.get("data-src")
                or image.get("srcset")
            )
            for image in node.select("img")
        )
        body_images = max(body_images, image_count)

    def visit(value: object) -> None:
        nonlocal body_characters
        if isinstance(value, dict):
            article_body = value.get("articleBody")
            if isinstance(article_body, str):
                normalized = re.sub(r"\s+", " ", article_body).strip()
                body_characters = max(body_characters, len(normalized))
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    for script in soup.select('script[type="application/ld+json"]'):
        value = script.string or script.get_text()
        if not value.strip():
            continue
        try:
            visit(json.loads(value))
        except (json.JSONDecodeError, TypeError):
            continue
    return body_characters, body_images


def _ft_capture_parser_evidence(
    content: bytes,
    *,
    canonical_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="ft",
            canonical_url=canonical_url,
            allow_generic_syndication=True,
        )
    except Exception as exc:
        return False, {
            "ftCaptureParserUsable": False,
            "ftCaptureParserError": type(exc).__name__,
        }
    nontext = article.content_type in {
        ContentType.INTERACTIVE,
        ContentType.VIDEO,
        ContentType.AUDIO,
        ContentType.GALLERY,
    }
    usable = article.quality.status == ArticleStatus.COMPLETE or nontext
    return usable, {
        "ftCaptureParserUsable": usable,
        "ftCaptureExtractionStatus": article.quality.status.value,
        "ftCaptureContentType": article.content_type.value,
        "ftCaptureBodyCharacters": article.quality.body_characters,
    }


CAPTURE = SourceCaptureHooks(
    publisher="ft",
    observe_candidate_response=observe_candidate_response,
    should_skip_candidate=should_skip_candidate,
    validate_candidate_response=validate_candidate_response,
    run_capture=run_capture,
    archive_fallback_policy=archive_fallback_policy,
    infini_minimum_body_characters=infini_minimum_body_characters,
    skip_candidate=skip_candidate,
    fetch_candidate=fetch_candidate,
    supports_infini_news=SUPPORTS_INFINI_NEWS,
    assess_candidate=assess_candidate,
    timemap_companion_urls=timemap_companion_urls,
    normalize_syndication_candidate_url=normalize_syndication_candidate_url,
    syndication_maximum_candidates=SYNDICATION_MAXIMUM_CANDIDATES,
    archive_discovery_urls=archive_discovery_urls,
    raw_shell_signals=raw_shell_signals,
    completed_rejection_reason=completed_rejection_reason,
)

__all__ = ["CAPTURE"]
