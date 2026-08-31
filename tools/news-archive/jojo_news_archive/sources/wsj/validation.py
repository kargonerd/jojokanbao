from __future__ import annotations

import re

from bs4 import Tag

from jojo_news_archive.models import ArticleStatus
from jojo_news_archive.parsing.validation_contracts import (
    CapturePriorityContext,
    ExistingSampleContext,
    SampleCandidateContext,
    SourceValidationHooks,
    ValidationContext,
    with_capture_priority,
)
from jojo_news_archive.sources.wsj.spec import ARCHIVE_SPEC, normalize_url


_PLACEHOLDER_IMAGE_MARKERS = (
    "wsj-social-share",
    "wsj_logo_black_social",
    "wsj_profile_lg",
    "wsjsection.",
)


def stable_article_identity(
    html_bytes: bytes,
    canonical_url: str,
) -> str | None:
    """Read WSJ's stable article id across slug and legacy URL aliases."""

    url_match = re.search(r"(?i)(?:^|[/=])(SB\d{20,})(?:$|[/?&#])", canonical_url)
    if url_match is not None:
        return "wsj:" + url_match.group(1).upper()
    for pattern in (
        rb'''(?i)data-articleid\s*=\s*["'](SB\d{20,})["']''',
        rb'''(?i)["']articleId["']\s*:\s*["'](SB\d{20,})["']''',
        rb"(?i)(?:[?&]|\b)articleid=(SB\d{20,})(?:&|[\"'])",
    ):
        match = re.search(pattern, html_bytes)
        if match is not None:
            return "wsj:" + match.group(1).decode("ascii").upper()
    return None


def article_identity(context: ValidationContext) -> str | None:
    return stable_article_identity(
        context.html_bytes,
        context.capture.canonical_url,
    )


def source_issues(context: ValidationContext) -> tuple[str, ...]:
    article = context.article
    raw_text = context.raw_text.casefold()
    issues: list[str] = []

    if (
        article.quality.body_characters < 200
        and "article not supported" in raw_text
        and "to read the full story" in raw_text
    ):
        issues.append("nonarticle-desk")

    if context.nontext_content and article.quality.body_characters < 200:
        issues.append("nonarticle-desk")

    if (
        article.quality.status != ArticleStatus.COMPLETE
        and "truncated-body" in article.quality.warnings
        and (
            "get the full story" in raw_text
            or "available to wsj.com subscribers" in raw_text
        )
        and (
            "subscribe or log in" in raw_text
            or "subscribe or sign in" in raw_text
        )
    ):
        issues.append("nonarticle-desk")

    legacy_article_panel = context.document.select_one(
        "#articleTabs_panel_article"
    )
    if (
        article.quality.status != ArticleStatus.COMPLETE
        and "truncated-body" in article.quality.warnings
        and isinstance(legacy_article_panel, Tag)
        and legacy_article_panel.select_one(".article.story") is None
        and "available to wsj.com subscribers" in raw_text
    ):
        issues.append("nonarticle-desk")

    article_template = context.document.select_one("meta[name='article.template']")
    if (
        article.quality.status != ArticleStatus.COMPLETE
        and "truncated-body" in article.quality.warnings
        and isinstance(article_template, Tag)
        and str(article_template.get("content", "")).casefold()
        in {"snippet", "preview"}
    ):
        issues.append("nonarticle-desk")

    if any(
        image.should_archive
        and any(
            marker in image.original_url.casefold()
            for marker in _PLACEHOLDER_IMAGE_MARKERS
        )
        for image in article.images
    ):
        issues.append("selected-placeholder-image")

    return tuple(issues)


def has_interface_noise(blocks: tuple[str, ...]) -> bool:
    if any(
        text.startswith(
            "buy side from wsj expert recommendations on products and services"
        )
        for text in blocks
    ):
        return True

    for index, text in enumerate(blocks):
        nearby = " ".join(blocks[index : index + 3])
        if (
            text == "stay informed"
            and "get a coronavirus briefing" in nearby
            and "sign up here" in nearby
        ):
            return True

    theme_navigation = {
        "free resources",
        "live updates",
        "daily video briefing",
    }
    if theme_navigation.issubset(set(blocks)):
        return True

    return any(
        (
            len(text) <= 300
            and text.startswith("sign up for our")
            and "sign up for our" in text
            and "newsletter" in text
        )
        or "save article log in to save subscribe to wsj" in text
        for text in blocks
    )


def interface_noise(context: ValidationContext) -> bool:
    return has_interface_noise(context.publisher_blocks)


def existing_sample_valid(context: ExistingSampleContext) -> bool:
    return normalize_url(ARCHIVE_SPEC, context.canonical_url) == context.canonical_url


def sample_candidate_valid(context: SampleCandidateContext) -> bool:
    return normalize_url(ARCHIVE_SPEC, context.canonical_url) == context.canonical_url


def capture_priority(
    context: CapturePriorityContext,
) -> tuple[int, int, int, int]:
    canonical_url = context.canonical_url.casefold()
    candidates_json = context.candidates_json.casefold()

    status_priority = (
        1
        if context.status == "pending"
        else 0
        if (
            "/articles/" in canonical_url
            or "server-placeholder-shell" in context.last_error.casefold()
        )
        else 2
    )

    provider_priority = (
        0
        if context.has_provider("infini-news")
        else 1
        if context.has_provider("arquivo-pt")
        else 2
        if context.has_provider("other")
        else 3
    )

    maximum_byte_count = context.maximum_byte_count()
    if "000000id_" in candidates_json:
        quality_priority = 0
    elif "tpl=" in candidates_json:
        quality_priority = 7 if context.sample_year >= 2018 else 5
    elif context.sample_year >= 2018:
        if maximum_byte_count >= 200_000:
            quality_priority = 0
        elif maximum_byte_count >= 100_000:
            quality_priority = 1
        elif "tesla=y" in candidates_json:
            quality_priority = 2
        elif maximum_byte_count >= 50_000:
            quality_priority = 3
        elif maximum_byte_count >= 30_000:
            quality_priority = 4
        elif maximum_byte_count >= 20_000:
            quality_priority = 5
        else:
            quality_priority = 6
    elif 30_000 <= maximum_byte_count < 50_000:
        quality_priority = 0
    elif "tesla=y" in candidates_json:
        quality_priority = 1
    elif maximum_byte_count >= 50_000:
        quality_priority = 2
    elif maximum_byte_count >= 20_000:
        quality_priority = 3
    else:
        quality_priority = 4

    return with_capture_priority(
        context,
        status=status_priority,
        provider=provider_priority,
        quality=quality_priority,
    )


HOOKS = SourceValidationHooks(
    issues=source_issues,
    article_identity=article_identity,
    interface_noise=interface_noise,
    reject_article_buttons=True,
    existing_sample_valid=existing_sample_valid,
    sample_candidate_valid=sample_candidate_valid,
    capture_priority=capture_priority,
)
