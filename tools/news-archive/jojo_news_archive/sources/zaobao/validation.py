from __future__ import annotations

from jojo_news_archive.models import ArticleStatus, ContentType
from jojo_news_archive.parsing.validation_contracts import (
    SourceValidationHooks,
    ValidationContext,
)


def terminal_tandem_repeat_length(value: str) -> int:
    """Return the length of a long exact suffix repeated back-to-back."""

    normalized = " ".join(value.split())
    punctuation = set("，,；;：:。！？.!?")
    for length in range(len(normalized) // 2, 23, -1):
        repeated = normalized[-length:]
        if (
            normalized[-2 * length : -length] == repeated
            and repeated[-1:] in punctuation
            and sum(character in punctuation for character in repeated) >= 2
        ):
            return length
    return 0


def source_issues(context: ValidationContext) -> tuple[str, ...]:
    article = context.article
    final_url = (context.capture.final_url or "").casefold()
    canonical_url = context.capture.canonical_url.casefold()
    if (
        "interactive.zaobao.com.sg" in final_url
        or "/horse-racing/race-results/" in canonical_url
    ):
        return ("nonarticle-desk",)
    if (
        "/forum/" in canonical_url
        and article.quality.status
        in {ArticleStatus.UNSUPPORTED, ArticleStatus.PARTIAL}
        and article.quality.body_characters < 100
    ):
        return ("nonarticle-desk",)
    if (
        article.quality.status != ArticleStatus.COMPLETE
        and article.quality.body_characters < 100
        and (
            article.quality.body_characters == 0
            or "点击视频" in article.plain_text
            or "视频观看" in article.plain_text
        )
    ):
        return ("nonarticle-desk",)
    if (
        "/shorts/" in canonical_url
        and article.content_type == ContentType.VIDEO
        and article.quality.body_characters < 100
    ):
        return ("nonarticle-desk",)
    return ()


def post_issues(context: ValidationContext) -> tuple[str, ...]:
    if context.repeated_text_within_block:
        return ("repeated-text-within-block",)
    return ()


HOOKS = SourceValidationHooks(issues=source_issues, post_issues=post_issues)
