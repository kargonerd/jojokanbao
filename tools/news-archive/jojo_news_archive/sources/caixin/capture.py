from __future__ import annotations

from jojo_news_archive.models import ArticleStatus
from jojo_news_archive.sources.capture_contracts import (
    CandidateAssessment,
    SourceCaptureHooks,
)


def assess_candidate(candidate, *, content: bytes, canonical_url: str, final_url: str, quality_score: int, signals: dict[str, object]) -> CandidateAssessment:
    del candidate, final_url
    if not signals["looksLikeHtml"]:
        return CandidateAssessment(quality_score, signals)
    usable, evidence = _caixin_capture_parser_evidence(content, canonical_url=canonical_url)
    return CandidateAssessment(quality_score, signals | evidence, () if usable else ("caixin-parser-unusable",))


def completed_rejection_reason(capture, *, content: bytes, signals: dict[str, object]) -> str | None:
    del signals
    usable, _ = _caixin_capture_parser_evidence(content, canonical_url=capture.canonical_url)
    return None if usable else "caixin-capture-parser-incomplete"

def _caixin_capture_parser_evidence(
    content: bytes,
    *,
    canonical_url: str,
) -> tuple[bool, dict[str, object]]:
    """Reject archived Caixin shells that contain metadata but no full body."""

    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="caixin",
            canonical_url=canonical_url,
            allow_generic_syndication=False,
        )
    except Exception as exc:
        return False, {
            "caixinCaptureParserUsable": False,
            "caixinCaptureParserError": type(exc).__name__,
        }
    # Non-text formats still have to be complete. Archived Caixin photo
    # stories frequently preserve only the first page of a multi-page gallery,
    # while legacy video pages can be empty player shells. Content type alone
    # therefore cannot admit a capture to a parser-validation cohort.
    usable = article.quality.status == ArticleStatus.COMPLETE
    return usable, {
        "caixinCaptureParserUsable": usable,
        "caixinCaptureExtractionStatus": article.quality.status.value,
        "caixinCaptureContentType": article.content_type.value,
        "caixinCaptureBodyCharacters": article.quality.body_characters,
    }


CAPTURE = SourceCaptureHooks(
    publisher="caixin",
    assess_candidate=assess_candidate,
    completed_rejection_reason=completed_rejection_reason,
)

__all__ = ["CAPTURE"]
