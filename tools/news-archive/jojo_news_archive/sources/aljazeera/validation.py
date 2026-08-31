from __future__ import annotations

from jojo_news_archive.models import ArticleStatus, ContentType
from jojo_news_archive.parsing.validation_contracts import (
    SourceValidationHooks,
    ValidationContext,
)

def source_issues(context: ValidationContext) -> tuple[str, ...]:
    article = context.article
    issues: list[str] = []
    if (
        article.content_type == ContentType.LIVEBLOG
        and article.quality.status != ArticleStatus.COMPLETE
    ):
        issues.append("nonarticle-desk")
    if not context.validation_candidate:
        issues.append("nonarticle-desk")
    if (
        article.quality.body_characters < 300
        and article.plain_text.casefold().startswith(
            "al jazeera has removed this story"
        )
    ):
        issues.append("nonarticle-desk")
    if (
        article.content_type == ContentType.ARTICLE
        and article.quality.body_characters == 0
    ):
        issues.append("nonarticle-desk")
    if article.quality.body_characters < 100:
        text = article.plain_text.casefold()
        if "download a gif" in text and (
            "interactive" in text or "infographic" in text
        ):
            issues.append("nonarticle-desk")
        if (
            "view the historical context" in text
            or ("view the story" in text and "storify" in text)
            or "viewing this from your mobile" in text
            or (
                "al jazeera round table" in text
                and "expert commentary" in text
            )
        ):
            issues.append("nonarticle-desk")
        if (
            article.quality.status != ArticleStatus.COMPLETE
            and "nonarticle-desk" not in issues
        ):
            issues.append("nonarticle-desk")
    return tuple(issues)


HOOKS = SourceValidationHooks(
    issues=source_issues,
    allow_editorial_read_more=True,
)
