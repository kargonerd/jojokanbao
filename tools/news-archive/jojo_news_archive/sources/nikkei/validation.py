from __future__ import annotations

from jojo_news_archive.parsing.validation_contracts import (
    CapturePriorityContext,
    SourceValidationHooks,
    with_capture_priority,
)


def capture_priority(
    context: CapturePriorityContext,
) -> tuple[int, int, int, int]:
    return with_capture_priority(
        context,
        archive=0 if context.has_provider("commoncrawl") else 1,
    )


HOOKS = SourceValidationHooks(capture_priority=capture_priority)
