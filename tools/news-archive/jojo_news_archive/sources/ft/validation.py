from __future__ import annotations

import re

from jojo_news_archive.parsing.validation_contracts import (
    CapturePriorityContext,
    ExistingSampleContext,
    PreferredSamplingPass,
    SampleCandidateContext,
    SourceValidationHooks,
    ValidationContext,
    with_capture_priority,
)
from jojo_news_archive.sources.ft.discovery.infini_news import (
    is_ft_subscription_headline,
)
from jojo_news_archive.sources.ft.spec import ft_content_uuid_creation_year


def _uuid_year_valid(canonical_url: str, sample_year: int) -> bool:
    created_year = ft_content_uuid_creation_year(canonical_url)
    return created_year is None or sample_year - 1 <= created_year <= sample_year


def source_issues(context: ValidationContext) -> tuple[str, ...]:
    article = context.article
    document = context.document
    issues: list[str] = []
    title = (
        " ".join(document.title.get_text(" ", strip=True).split()).casefold()
        if document.title
        else ""
    )
    if title == "subscribe to read | financial times" and (
        not article.headline or is_ft_subscription_headline(article.headline)
    ):
        issues.append("nonarticle-desk")
    if re.search(
        r"(?i)https?://(?:www\.)?ft\.com/video/",
        context.capture.final_url or "",
    ):
        issues.append("nonarticle-desk")
    has_photo_diary_link = document.select_one(
        "a[href='/photo-diary'], a[href='https://www.ft.com/photo-diary']"
    ) is not None
    if (
        has_photo_diary_link and article.quality.body_characters <= 250
    ) or re.fullmatch(
        r"(?i)ft weekend quiz solutions",
        " ".join((article.headline or "").split()),
    ):
        issues.append("nonarticle-desk")
    placeholder_markers = (
        "og-ft-logo",
        "social-default",
        "/__assets/creatives/brand-ft/icons/v2/open-graph.png",
    )
    if any(
        image.should_archive
        and any(
            marker in image.original_url.casefold()
            for marker in placeholder_markers
        )
        for image in article.images
    ):
        issues.append("selected-placeholder-image")
    return tuple(issues)


def has_interface_noise(blocks: tuple[str, ...]) -> bool:
    return any(
        "stay briefed with our coronavirus newsletter" in text
        or "copyright the financial times limited" in text
        or "this content requires an adobe flash plugin" in text
        or "your plugin is either missing or out of date" in text
        or "follow @financialtimesfashion on instagram" in text
        or "ft subscriber? sign up for the weekly working it newsletter" in text
        or "see acast.com/privacy for privacy and opt-out information" in text
        or text == "."
        or text.startswith(
            "subscribe to the rachman review wherever you get your podcasts"
        )
        or text == "sign up for the survey!"
        or (
            text.startswith("sign up for the britain")
            and "healthiest workplace survey" in text
        )
        or text.startswith("sign up for the financial times markets news channel")
        or re.match(r"^sign up for the ft(?:'|’)s due diligence newsletter\b", text)
        is not None
        or (
            text.startswith("sign up to scoreboard")
            and "must-read weekly briefing" in text
        )
        for text in blocks
    )


def interface_noise(context: ValidationContext) -> bool:
    return has_interface_noise(context.publisher_blocks)


def existing_sample_valid(context: ExistingSampleContext) -> bool:
    return _uuid_year_valid(context.canonical_url, context.sample_year)


def sample_candidate_valid(context: SampleCandidateContext) -> bool:
    if not _uuid_year_valid(context.canonical_url, context.sample_year):
        return False
    if context.direct_provider != "infini-news":
        return True
    return not any(
        str(candidate.get("provider") or "") == "infini-news"
        and is_ft_subscription_headline(candidate.get("expectedHeadline"))
        for candidate in context.candidates
    )


def capture_priority(
    context: CapturePriorityContext,
) -> tuple[int, int, int, int]:
    return with_capture_priority(
        context,
        provider=0 if context.has_provider("infini-news") else 1,
    )


HOOKS = SourceValidationHooks(
    issues=source_issues,
    interface_noise=interface_noise,
    existing_sample_valid=existing_sample_valid,
    sample_candidate_valid=sample_candidate_valid,
    preferred_sampling_passes=(
        PreferredSamplingPass(
            provider="infini-news",
            mode="provider-target",
            summary="direct",
        ),
    ),
    capture_priority=capture_priority,
)
