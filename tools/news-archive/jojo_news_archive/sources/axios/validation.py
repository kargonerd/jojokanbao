from __future__ import annotations

import re
from urllib.parse import urlsplit

from jojo_news_archive.models import ArticleStatus, ContentType
from jojo_news_archive.parsing.validation_contracts import (
    ExistingSampleContext,
    SampleCandidateContext,
    SourceValidationHooks,
    ValidationContext,
)
from jojo_news_archive.sources.axios.spec import ARCHIVE_SPEC, normalize_url


def is_internal_test_entry(
    canonical_url: str,
    headline: str | None,
) -> bool:
    """Identify confirmed Axios CMS fixtures without matching real test news."""

    slug = urlsplit(canonical_url).path.rstrip("/").rsplit("/", 1)[-1].casefold()
    normalized_headline = " ".join((headline or "").split()).casefold()
    known_fixtures = {
        "axios-generate-test": "axios generate test",
        "test-this-is-second-persons-post": "test: this is second person's post",
    }
    return any(
        normalized_headline == expected
        and re.fullmatch(rf"{re.escape(prefix)}-\d+", slug) is not None
        for prefix, expected in known_fixtures.items()
    )


def source_issues(context: ValidationContext) -> tuple[str, ...]:
    article = context.article
    issues: list[str] = []
    if context.nontext_content and article.quality.body_characters == 0:
        issues.append("empty-nontext-content")
    if is_internal_test_entry(context.capture.canonical_url, article.headline):
        issues.append("nonarticle-desk")
    if (
        article.content_type == ContentType.VIDEO
        and article.quality.body_characters < 200
    ):
        issues.append("nonarticle-desk")
    if re.search(
        r"(?i)(?:^|/)thank-you-for-subscribing(?:/|$)",
        urlsplit(context.capture.canonical_url).path,
    ):
        issues.append("nonarticle-desk")
    if (
        article.quality.body_characters < 100
        and "special report" in context.raw_text
        and "read the story" in context.raw_text
    ):
        issues.append("nonarticle-desk")
    if (
        article.quality.status != ArticleStatus.COMPLETE
        and article.quality.body_characters < 100
        and "nonarticle-desk" not in issues
    ):
        issues.append("nonarticle-desk")
    if not context.canonical_url_is_normalized:
        issues.append("nonarticle-desk")
    return tuple(issues)


def has_interface_noise(blocks: tuple[str, ...]) -> bool:
    return any(
        text.rstrip(":") == "more from axios"
        or text.startswith("subscribe to axios ")
        for text in blocks
    )


def interface_noise(context: ValidationContext) -> bool:
    return has_interface_noise(context.publisher_blocks)


def existing_sample_valid(context: ExistingSampleContext) -> bool:
    return normalize_url(ARCHIVE_SPEC, context.canonical_url) == context.canonical_url


def sample_candidate_valid(context: SampleCandidateContext) -> bool:
    return normalize_url(ARCHIVE_SPEC, context.canonical_url) == context.canonical_url


HOOKS = SourceValidationHooks(
    issues=source_issues,
    interface_noise=interface_noise,
    existing_sample_valid=existing_sample_valid,
    sample_candidate_valid=sample_candidate_valid,
)
