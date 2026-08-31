from __future__ import annotations

import re

from jojo_news_archive.models import ArticleStatus, ContentType
from jojo_news_archive.parsing.validation_contracts import (
    PreferredSamplingPass,
    SourceValidationHooks,
    ValidationContext,
)

def source_issues(context: ValidationContext) -> tuple[str, ...]:
    capture = context.capture
    article = context.article
    issues: list[str] = []
    canonical_url = capture.canonical_url
    if re.search(
        r"(?i)^https://(?:www\.)?nytimes\.com/20\d{2}/\d{2}/\d{2}/(?:"
        r"pageoneplus/(?:(?:no-)?corrections|quotation-of-the-day)"
        r"(?:-|\.)|"
        r"todayspaper/quotation-of-the-day(?:-|\.))",
        canonical_url,
    ):
        issues.append("nonarticle-desk")
    if not context.validation_candidate:
        issues.append("nonarticle-desk")
    if (
        re.search(
            r"(?i)^https://(?:www\.)?nytimes\.com/"
            r"(?:interactive/)?20\d{2}/\d{2}/\d{2}/admin/",
            canonical_url,
        )
        and article.quality.body_characters < 200
    ):
        issues.append("nonarticle-desk")
    if article.quality.body_characters < 200 and (
        article.content_type == ContentType.LIVEBLOG
        or re.search(
            r"(?i)/opinion/editorial-cartoon(?:\.html)?$",
            canonical_url,
        )
        or (
            article.headline
            and article.headline.casefold().strip()
            in {"editors' note", "editors’ note"}
        )
    ):
        issues.append("nonarticle-desk")
    if (
        "/interactive/" in canonical_url.casefold()
        and article.content_type in {ContentType.ARTICLE, ContentType.OPINION}
        and article.quality.body_characters < 100
    ):
        issues.append("nonarticle-desk")
    if (
        article.content_type == ContentType.INTERACTIVE
        and article.quality.status == ArticleStatus.PARTIAL
        and article.quality.body_characters < 100
    ):
        issues.append("nonarticle-desk")
    if (
        article.quality.status != ArticleStatus.COMPLETE
        and article.quality.body_characters < 200
        and "published prematurely" in article.plain_text.casefold()
        and "will be available" in article.plain_text.casefold()
    ):
        issues.append("nonarticle-desk")
    if (
        article.quality.status != ArticleStatus.COMPLETE
        and article.quality.body_characters < 200
    ):
        story = context.document.find("article", id="story")
        story_is_empty = story is not None and not " ".join(
            story.get_text(" ", strip=True).split()
        )
        opinion_footer_shell = (
            article.quality.body_characters < 100
            and "the times is committed to publishing a diversity of letters"
            in context.raw_text
            and "follow the new york times opinion section" in context.raw_text
        )
        metered_body_shell = (
            article.quality.body_characters < 200
            and context.document.select_one(
                "section[name='articleBody'].meteredContent"
            )
            is not None
        )
        if story_is_empty or opinion_footer_shell or metered_body_shell:
            issues.append("nonarticle-desk")
    return tuple(issues)


def has_interface_noise(blocks: tuple[str, ...]) -> bool:
    return any(
        text.startswith("sign up for weekly updates on ")
        and text.endswith(" from the times.")
        for text in blocks
    )


def interface_noise(context: ValidationContext) -> bool:
    return has_interface_noise(context.publisher_blocks)


HOOKS = SourceValidationHooks(
    issues=source_issues,
    interface_noise=interface_noise,
    reject_article_buttons=True,
    preferred_sampling_passes=(
        PreferredSamplingPass(
            provider="other",
            mode="actionable-gap",
            summary="direct",
        ),
    ),
)
