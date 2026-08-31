from __future__ import annotations

from jojo_news_archive.parsing.validation_contracts import (
    SourceValidationHooks,
    ValidationContext,
)


def source_issues(context: ValidationContext) -> tuple[str, ...]:
    if context.capture.canonical_url.startswith(
        ("https://photos.caixin.com/", "https://video.caixin.com/")
    ):
        return ("nonarticle-desk",)
    return ()


HOOKS = SourceValidationHooks(issues=source_issues)
