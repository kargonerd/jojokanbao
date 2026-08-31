from __future__ import annotations

import re
from jojo_news_archive.models import ArticleStatus, ContentType
from jojo_news_archive.sources.registry import archive_source_spec, normalize_article_url
from jojo_news_archive.sources.capture_contracts import (
    CandidateAssessment,
    SourceCaptureHooks,
)


def normalize_manifest_url(value: str) -> str | None:
    return normalize_article_url(archive_source_spec("axios"), value)


def assess_candidate(candidate, *, content: bytes, canonical_url: str, final_url: str, quality_score: int, signals: dict[str, object]) -> CandidateAssessment:
    del candidate, final_url
    if not signals["looksLikeHtml"]:
        return CandidateAssessment(quality_score, signals)
    usable, evidence = _axios_capture_parser_evidence(content, canonical_url=canonical_url)
    return CandidateAssessment(
        quality_score,
        signals | evidence,
        () if usable else ("axios-parser-unusable",),
    )


def completed_rejection_reason(capture, *, content: bytes, signals: dict[str, object]) -> str | None:
    del signals
    usable, _ = _axios_capture_parser_evidence(content, canonical_url=capture.canonical_url)
    return None if usable else "axios-capture-parser-incomplete"

def _axios_capture_parser_evidence(
    content: bytes,
    *,
    canonical_url: str,
) -> tuple[bool, dict[str, object]]:
    """Reject Axios captures that cannot supply the archived editorial item.

    Some archived Axios URLs hydrate a valid ``__NEXT_DATA__`` story object,
    but that object is merely a one-sentence hand-off to a separately hosted
    visual.  It is not the archived visual project and must not occupy one of
    the 800 article-validation slots.  Keep this deliberately narrower than a
    generic short-article rule because Axios also publishes legitimate briefs
    and image-led stories.
    """

    from jojo_news_archive.parsing.parser import parse_article

    try:
        article = parse_article(
            content,
            publisher="axios",
            canonical_url=canonical_url,
            allow_generic_syndication=False,
        )
    except Exception as exc:
        return True, {
            "axiosCaptureVisualRedirectStub": False,
            "axiosCaptureParserError": type(exc).__name__,
        }
    plain_text = " ".join(article.plain_text.split())
    visual_redirect_stub = bool(
        article.content_type == ContentType.ARTICLE
        and article.quality.status == ArticleStatus.PARTIAL
        and article.quality.body_characters <= 250
        and article.quality.images_selected <= 1
        and re.match(
            r"^See Axios Visuals(?:'|\N{RIGHT SINGLE QUOTATION MARK}) best ",
            plain_text,
            flags=re.IGNORECASE,
        )
    )
    empty_article_shell = bool(
        article.content_type == ContentType.ARTICLE
        and article.quality.status == ArticleStatus.PARTIAL
        and article.quality.body_characters == 0
        and article.quality.images_selected == 0
    )
    usable = not (visual_redirect_stub or empty_article_shell)
    return usable, {
        "axiosCaptureVisualRedirectStub": visual_redirect_stub,
        "axiosCaptureEmptyArticleShell": empty_article_shell,
        "axiosCaptureExtractionStatus": article.quality.status.value,
        "axiosCaptureContentType": article.content_type.value,
        "axiosCaptureBodyCharacters": article.quality.body_characters,
        "axiosCaptureImagesSelected": article.quality.images_selected,
    }


CAPTURE = SourceCaptureHooks(
    publisher="axios",
    normalize_manifest_url=normalize_manifest_url,
    assess_candidate=assess_candidate,
    completed_rejection_reason=completed_rejection_reason,
)

__all__ = ["CAPTURE"]
