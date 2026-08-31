from __future__ import annotations

from jojo_news_archive.parsing.validation_contracts import (
    SourceValidationHooks,
    ValidationContext,
)

def has_interface_noise(blocks: tuple[str, ...]) -> bool:
    return "." in blocks


def interface_noise(context: ValidationContext) -> bool:
    return has_interface_noise(context.publisher_blocks)


HOOKS = SourceValidationHooks(
    interface_noise=interface_noise,
    reject_article_buttons=True,
)
