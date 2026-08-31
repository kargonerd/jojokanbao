from __future__ import annotations

from jojo_news_archive.models import ArticleStatus, ContentType
from jojo_news_archive.sources.registry import archive_source_spec, normalize_article_url
from jojo_news_archive.sources.capture_contracts import (
    CandidateAssessment,
    SourceCaptureHooks,
)


def normalize_manifest_url(value: str) -> str | None:
    return normalize_article_url(archive_source_spec("npr"), value)


def assess_candidate(candidate, *, content: bytes, canonical_url: str, final_url: str, quality_score: int, signals: dict[str, object]) -> CandidateAssessment:
    del candidate, final_url
    if not signals["looksLikeHtml"]:
        return CandidateAssessment(quality_score, signals)
    usable, evidence = _npr_capture_parser_evidence(content, canonical_url=canonical_url)
    return CandidateAssessment(quality_score, signals | evidence, () if usable else ("npr-parser-unusable",))


def completed_rejection_reason(capture, *, content: bytes, signals: dict[str, object]) -> str | None:
    del signals
    usable, _ = _npr_capture_parser_evidence(content, canonical_url=capture.canonical_url)
    return None if usable else "npr-capture-parser-incomplete"

def _npr_capture_parser_evidence(
    content: bytes,
    *,
    canonical_url: str,
) -> tuple[bool, dict[str, object]]:
    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="npr",
            canonical_url=canonical_url,
            allow_generic_syndication=False,
        )
    except Exception as exc:
        return False, {
            "nprCaptureParserUsable": False,
            "nprCaptureParserError": type(exc).__name__,
        }
    nontext = article.content_type in {
        ContentType.INTERACTIVE,
        ContentType.VIDEO,
        ContentType.AUDIO,
        ContentType.GALLERY,
    }
    usable = article.quality.status == ArticleStatus.COMPLETE or nontext
    return usable, {
        "nprCaptureParserUsable": usable,
        "nprCaptureExtractionStatus": article.quality.status.value,
        "nprCaptureContentType": article.content_type.value,
        "nprCaptureBodyCharacters": article.quality.body_characters,
    }


CAPTURE = SourceCaptureHooks(
    publisher="npr",
    normalize_manifest_url=normalize_manifest_url,
    assess_candidate=assess_candidate,
    completed_rejection_reason=completed_rejection_reason,
)

__all__ = ["CAPTURE"]
