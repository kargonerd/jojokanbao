from __future__ import annotations

from jojo_news_archive.parsing.validation_contracts import (
    PreferredSamplingPass,
    SourceValidationHooks,
    ValidationContext,
)

def source_issues(context: ValidationContext) -> tuple[str, ...]:
    article = context.article
    prefix = article.plain_text[:1_500].casefold()
    if (
        article.quality.body_characters < 1_000
        and "bloomberg professional service subscriber" in prefix
    ):
        return ("suspected-paywall-shell",)
    return ()


def has_interface_noise(blocks: tuple[str, ...]) -> bool:
    return any(
        text == "watch this next"
        or text.rstrip(":") == "related stories"
        or (
            text.startswith("sign up to receive the brexit bulletin")
            and "departure from the eu" in text
        )
        or (
            text.startswith("subscribe to bloomberg benchmark")
            and ("pocketcast" in text or "itunes" in text)
        )
        or (
            "sign up to receive" in text
            and "green daily" in text
            and "newsletter" in text
        )
        or text.startswith("for even more: subscribe to bloomberg all access")
        or (
            text.startswith("want to receive this post in your inbox")
            and "sign up for" in text
            and "newsletter" in text
        )
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
            provider="wayback-exact",
            mode="actionable-gap",
            summary="exact-wayback",
        ),
    ),
)
