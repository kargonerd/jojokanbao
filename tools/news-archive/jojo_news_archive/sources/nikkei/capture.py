from __future__ import annotations

from jojo_news_archive.capture.primitives import (
    common_crawl_first_candidate_sort_key as _common_crawl_first_candidate_sort_key,
    largest_distinct_timemap_candidates as _largest_distinct_timemap_candidates,
)
from jojo_news_archive.models import ArticleStatus, CaptureCandidate, ContentType
from jojo_news_archive.sources.capture_contracts import (
    ArchiveFallbackPolicy,
    CandidateAssessment,
    SourceCaptureHooks,
)


def archive_fallback_policy(
    *, parser_validation_enabled: bool, prior_attempts: int
) -> ArchiveFallbackPolicy:
    if not parser_validation_enabled:
        return ArchiveFallbackPolicy(True, True, True)
    return ArchiveFallbackPolicy(
        wayback_timemap=True,
        common_crawl=prior_attempts >= 1,
        arquivo_pt=prior_attempts >= 2,
    )


select_timemap_candidates = _largest_distinct_timemap_candidates


def assess_candidate(candidate, *, content: bytes, canonical_url: str, final_url: str, quality_score: int, signals: dict[str, object]) -> CandidateAssessment:
    del candidate, final_url
    if not signals["looksLikeHtml"]:
        return CandidateAssessment(quality_score, signals)
    usable, evidence = _nikkei_capture_parser_evidence(content, canonical_url=canonical_url)
    return CandidateAssessment(quality_score, signals | evidence, () if usable else ("nikkei-parser-unusable",))


def completed_rejection_reason(capture, *, content: bytes, signals: dict[str, object]) -> str | None:
    del signals
    usable, _ = _nikkei_capture_parser_evidence(content, canonical_url=capture.canonical_url)
    return None if usable else "nikkei-capture-parser-incomplete"


def _nikkei_candidate_sort_key(
    candidate: CaptureCandidate,
    *,
    published_at: str | None,
) -> tuple[bool, bool, int, tuple[float, str]]:
    """Backward-compatible alias for the Nikkei capture policy."""
    return _common_crawl_first_candidate_sort_key(
        candidate,
        published_at=published_at,
    )


def _nikkei_capture_parser_evidence(
    content: bytes,
    *,
    canonical_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="nikkei",
            canonical_url=canonical_url,
            allow_generic_syndication=False,
        )
    except Exception as exc:
        return False, {
            "nikkeiCaptureParserUsable": False,
            "nikkeiCaptureParserError": type(exc).__name__,
        }
    nontext = article.content_type in {
        ContentType.INTERACTIVE,
        ContentType.VIDEO,
        ContentType.AUDIO,
        ContentType.GALLERY,
    }
    usable = article.quality.status == ArticleStatus.COMPLETE or nontext
    return usable, {
        "nikkeiCaptureParserUsable": usable,
        "nikkeiCaptureExtractionStatus": article.quality.status.value,
        "nikkeiCaptureContentType": article.content_type.value,
        "nikkeiCaptureBodyCharacters": article.quality.body_characters,
    }


CAPTURE = SourceCaptureHooks(
    publisher="nikkei",
    archive_fallback_policy=archive_fallback_policy,
    assess_candidate=assess_candidate,
    select_timemap_candidates=select_timemap_candidates,
    completed_rejection_reason=completed_rejection_reason,
)

__all__ = ["CAPTURE"]
