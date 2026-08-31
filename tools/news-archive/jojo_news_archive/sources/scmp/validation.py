from __future__ import annotations

import re
from urllib.parse import urlsplit

from bs4 import Tag

from jojo_news_archive.models import ArticleStatus, ContentType
from jojo_news_archive.parsing.validation_contracts import (
    SourceValidationHooks,
    ValidationContext,
)


def normalize_text(value: str | None) -> str:
    return " ".join((value or "").split()).casefold()


def stable_article_identity(canonical_url: str) -> str | None:
    article_id = re.search(
        r"(?i)(?:^|/)article/(\d+)(?:$|[/?#])",
        urlsplit(canonical_url).path,
    )
    if article_id is None:
        return None
    return "scmp:article:" + article_id.group(1)


def article_identity(context: ValidationContext) -> str | None:
    return stable_article_identity(context.capture.canonical_url)


def source_issues(context: ValidationContext) -> tuple[str, ...]:
    capture = context.capture
    article = context.article
    canonical_url = capture.canonical_url.casefold()
    scmp_path = urlsplit(capture.canonical_url).path.casefold()
    issues: list[str] = []

    if (
        article.quality.status
        in {ArticleStatus.UNSUPPORTED, ArticleStatus.PARTIAL}
        and (
            "/infographics/" in canonical_url
            or re.search(
                r"(?:^|[-/])gallery(?:$|[-/?])",
                canonical_url,
            )
            or article.quality.body_characters < 100
        )
    ):
        apollo_media_only = bool(
            re.search(
                rb'"displaySlideShow"\s*:\s*true',
                context.html_bytes,
                re.IGNORECASE,
            )
        )
        carousel_media_only = bool(
            re.search(
                rb'"carousel_slideshow_items"\s*:\s*"[1-9]',
                context.html_bytes,
                re.IGNORECASE,
            )
        )
        infographic_media_only = bool(
            article.quality.images_selected > 0
            and re.search(
                rb"\bthis\s+infographic\b",
                context.html_bytes,
                re.IGNORECASE,
            )
            and normalize_text(article.plain_text).startswith(
                "all information from "
            )
        )
        short_infographic_handoff = bool(
            article.quality.images_selected > 0
            and re.fullmatch(
                r"(?i)click to view the full-size infographic"
                r"(?: in high resolution)?\.?",
                normalize_text(article.plain_text),
            )
        )
        if (
            "/infographics/" in canonical_url
            or re.search(
                r"(?:^|[-/])gallery(?:$|[-/?])",
                canonical_url,
            )
            or apollo_media_only
            or carousel_media_only
            or infographic_media_only
            or short_infographic_handoff
        ):
            issues.append("nonarticle-desk")
        elif any(
            marker in context.raw_text.casefold()
            for marker in (
                "read full article",
                "sign in/up",
                "subscribe to read",
                "subscribe to continue",
            )
        ):
            issues.append("nonarticle-desk")

    if (
        scmp_path.startswith(("/about-us/", "/announcements/"))
        and "nonarticle-desk" not in issues
    ):
        issues.append("nonarticle-desk")

    if (
        article.quality.status
        in {ArticleStatus.UNSUPPORTED, ArticleStatus.PARTIAL}
        and "nonarticle-desk" not in issues
    ):
        empty_structured_body = context.document.select_one(
            "[class*='ArticleContent__StyledBody-']"
        )
        unrecoverable_empty_body = bool(
            isinstance(empty_structured_body, Tag)
            and not normalize_text(
                empty_structured_body.get_text(" ", strip=True)
            )
            and empty_structured_body.select_one(
                "img, picture, iframe, video, audio"
            )
            is None
        )
        series_label = context.document.select_one(
            ".subheadline, [class*='subheadline']"
        )
        series_package = bool(
            isinstance(series_label, Tag)
            and normalize_text(series_label.get_text(" ", strip=True))
            == "scmp series"
        )
        temporary_outage = bool(
            normalize_text(article.headline) == "sorry..."
            and "site will be unavailable for a short period"
            in context.raw_text.casefold()
        )
        subscription_campaign_redirect = bool(
            "subscribe.scmp.com/" in (capture.final_url or "").casefold()
        )
        og_type = context.document.select_one("meta[property='og:type']")
        redirected_topic_index = bool(
            "/article/" in scmp_path
            and "/topics/" in urlsplit(capture.final_url or "").path.casefold()
            and (
                context.document.select_one(
                    ".topic-view, .panel-content-topic, .section-topics"
                )
                is not None
                or (
                    isinstance(og_type, Tag)
                    and str(og_type.get("content", "")).casefold() == "website"
                )
            )
        )
        young_post_answer_key = bool(
            scmp_path.startswith("/yp/")
            and re.match(
                r"(?i)^(?:turbo english|listening|(?:news )?quiz) answers\b",
                article.headline or "",
            )
        )
        if (
            "/announcements/" in scmp_path
            or unrecoverable_empty_body
            or series_package
            or temporary_outage
            or subscription_campaign_redirect
            or redirected_topic_index
            or young_post_answer_key
        ):
            issues.append("nonarticle-desk")

    if (
        article.quality.body_characters < 100
        and "nonarticle-desk" not in issues
    ):
        marker_text = " ".join(
            value
            for value in (
                capture.canonical_url,
                article.headline,
                article.description,
            )
            if value
        )
        image_led_graphic = bool(
            article.content_type == ContentType.GALLERY
            and article.quality.images_selected > 0
            and re.search(r"(?i)\b(?:info)?graphic\b", marker_text)
        )
        branded_multimedia_shell = bool(
            article.quality.status != ArticleStatus.COMPLETE
            and scmp_path.startswith(("/native/", "/presented/"))
            and "multimedia.scmp.com" in (capture.final_url or "").casefold()
        )
        if image_led_graphic or branded_multimedia_shell:
            issues.append("nonarticle-desk")

    if (
        article.content_type == ContentType.LIVEBLOG
        and article.quality.status != ArticleStatus.COMPLETE
        and article.quality.body_characters < 200
    ):
        issues.append("nonarticle-desk")

    return tuple(issues)


HOOKS = SourceValidationHooks(
    issues=source_issues,
    article_identity=article_identity,
)
