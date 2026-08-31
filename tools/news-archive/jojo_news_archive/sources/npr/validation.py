from __future__ import annotations

from jojo_news_archive.models import ArticleStatus, ContentType
from jojo_news_archive.parsing.validation_contracts import (
    CapturePriorityContext,
    SampleCandidateContext,
    SourceValidationHooks,
    ValidationContext,
    with_capture_priority,
)
from jojo_news_archive.sources.npr.spec import ARCHIVE_SPEC, normalize_url


def source_issues(context: ValidationContext) -> tuple[str, ...]:
    article = context.article
    if (
        article.content_type == ContentType.AUDIO
        and article.quality.status != ArticleStatus.COMPLETE
        and article.quality.body_characters < 200
    ):
        return ("nonarticle-desk",)
    return ()


def sample_candidate_valid(context: SampleCandidateContext) -> bool:
    return normalize_url(ARCHIVE_SPEC, context.canonical_url) == context.canonical_url


def capture_priority(
    context: CapturePriorityContext,
) -> tuple[int, int, int, int]:
    return with_capture_priority(
        context,
        archive=0 if context.has_provider("commoncrawl") else 1,
    )


HOOKS = SourceValidationHooks(
    issues=source_issues,
    sample_candidate_valid=sample_candidate_valid,
    capture_priority=capture_priority,
)
