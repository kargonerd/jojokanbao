from __future__ import annotations

import re
from urllib.parse import urlsplit
from bs4 import BeautifulSoup
from jojo_news_archive.sources.capture_contracts import (
    CandidateAssessment,
    SourceCaptureHooks,
)


def assess_candidate(candidate, *, content: bytes, canonical_url: str, final_url: str, quality_score: int, signals: dict[str, object]) -> CandidateAssessment:
    del candidate, final_url
    if not signals["looksLikeHtml"]:
        return CandidateAssessment(quality_score, signals)
    usable, evidence = _scmp_capture_parser_evidence(content, canonical_url=canonical_url)
    return CandidateAssessment(quality_score, signals | evidence, () if usable else ("scmp-parser-unusable",))


def completed_rejection_reason(capture, *, content: bytes, signals: dict[str, object]) -> str | None:
    del signals
    usable, _ = _scmp_capture_parser_evidence(content, canonical_url=capture.canonical_url)
    return None if usable else "scmp-capture-parser-incomplete"

def _scmp_capture_parser_evidence(
    content: bytes,
    *,
    canonical_url: str,
) -> tuple[bool, dict[str, object]]:
    """Reject legacy SCMP snapshots that archived only the document head."""

    soup = BeautifulSoup(content, "html.parser")
    visible_text = " ".join(soup.get_text(" ", strip=True).split())
    article_route = bool(
        re.search(r"/article/\d+(?:/|$)", urlsplit(canonical_url).path)
    )
    declares_news_article = bool(
        re.search(
            rb'(?i)["\']@type["\']\s*:\s*["\']NewsArticle["\']',
            content,
        )
    )
    recoverable_body_marker = soup.select_one(
        "body article, body main, body [itemprop='articleBody'], "
        "body .article-body, body .field-name-body, "
        "body [class*='ArticleContent__StyledBody-']"
    )
    head_only_article_shell = bool(
        article_route
        and declares_news_article
        and len(visible_text) < 300
        and recoverable_body_marker is None
    )
    usable = not head_only_article_shell
    return usable, {
        "scmpCaptureParserUsable": usable,
        "scmpCaptureHeadOnlyArticleShell": head_only_article_shell,
        "scmpCaptureVisibleCharacters": len(visible_text),
    }


CAPTURE = SourceCaptureHooks(
    publisher="scmp",
    assess_candidate=assess_candidate,
    completed_rejection_reason=completed_rejection_reason,
)

__all__ = ["CAPTURE"]
