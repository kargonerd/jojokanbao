from __future__ import annotations

from functools import lru_cache
from importlib import import_module

from jojo_news_archive.sources.capture_contracts import SourceCaptureHooks
from jojo_news_archive.sources.discovery_contracts import SourceDiscoveryHooks
from jojo_news_archive.sources.registry import source_module
from jojo_news_archive.parsing.parser_contracts import SourceParserHooks


@lru_cache(maxsize=None)
def parser_hooks(source_id: str) -> SourceParserHooks:
    """Load and validate one source's typed parser strategy lazily."""

    source_module(source_id)
    module = import_module(f"jojo_news_archive.sources.{source_id}.parser")
    hooks = module.PARSER
    if not isinstance(hooks, SourceParserHooks):
        raise TypeError(f"source {source_id!r} PARSER has an invalid type")
    return hooks


@lru_cache(maxsize=None)
def capture_hooks(source_id: str) -> SourceCaptureHooks:
    """Load and validate one source's typed capture extension points."""

    source_module(source_id)
    module = import_module(f"jojo_news_archive.sources.{source_id}.capture")
    hooks = module.CAPTURE
    if not isinstance(hooks, SourceCaptureHooks):
        raise TypeError(f"source {source_id!r} CAPTURE has an invalid type")
    if hooks.publisher != source_id:
        raise ValueError(
            f"capture hooks publisher {hooks.publisher!r} does not match "
            f"source id {source_id!r}"
        )
    return hooks


@lru_cache(maxsize=None)
def discovery_hooks(source_id: str) -> SourceDiscoveryHooks:
    """Load and validate one source's discovery extension points lazily."""

    source_module(source_id)
    module = import_module(
        f"jojo_news_archive.sources.{source_id}.discovery_hooks"
    )
    hooks = module.HOOKS
    if not isinstance(hooks, SourceDiscoveryHooks):
        raise TypeError(f"source {source_id!r} discovery HOOKS has an invalid type")
    if hooks.publisher != source_id:
        raise ValueError(
            f"discovery hooks publisher {hooks.publisher!r} does not match "
            f"source id {source_id!r}"
        )
    return hooks
