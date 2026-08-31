from __future__ import annotations

from functools import lru_cache
from importlib import import_module

from jojo_news_archive.parsing.validation_contracts import SourceValidationHooks
from jojo_news_archive.sources.registry import source_module


@lru_cache(maxsize=None)
def source_validation_hooks(publisher: str) -> SourceValidationHooks:
    """Load one publisher's validation policy without registry import cycles."""

    source_module(publisher)
    module = import_module(
        f"jojo_news_archive.sources.{publisher}.validation"
    )
    hooks = getattr(module, "HOOKS", None)
    if not isinstance(hooks, SourceValidationHooks):
        raise TypeError(
            f"source {publisher!r} does not export SourceValidationHooks as HOOKS"
        )
    return hooks
