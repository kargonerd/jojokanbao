from __future__ import annotations

from jojo_news_archive.parsing.validation_contracts import (
    SourceValidationHooks,
    ValidationContext,
)


def source_issues(context: ValidationContext) -> tuple[str, ...]:
    markers = ("rcom-default.png", "r-generic-hdr.png")
    if any(
        image.should_archive
        and any(marker in image.original_url.casefold() for marker in markers)
        for image in context.article.images
    ):
        return ("selected-placeholder-image",)
    return ()


def has_interface_noise(blocks: tuple[str, ...]) -> bool:
    return any(
        "more from reuters sponsored content" in text
        or "our standards: the thomson reuters trust principles" in text
        or (
            len(text) <= 1_000
            and "all rights reserved" in text
            and any(
                marker in text
                for marker in (
                    "copyright",
                    "(c) reuters",
                    "marketwire",
                    "market wire",
                    "business wire",
                )
            )
        )
        or (
            len(text) <= 1_000
            and "republication or redistribution ofreuters content" in text
        )
        for text in blocks
    )


def interface_noise(context: ValidationContext) -> bool:
    return has_interface_noise(context.publisher_blocks)


HOOKS = SourceValidationHooks(
    issues=source_issues,
    interface_noise=interface_noise,
)
