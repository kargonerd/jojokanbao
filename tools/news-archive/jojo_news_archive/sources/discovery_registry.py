from __future__ import annotations

from collections.abc import Iterator, Mapping
from functools import lru_cache

from jojo_news_archive.sources.discovery_contracts import (
    SitemapSource,
    SourceDiscoveryHooks,
)
from jojo_news_archive.sources.registry import registered_sources, source_module
from jojo_news_archive.sources.runtime import discovery_hooks


class _LazyDiscoveryHooks(Mapping[str, SourceDiscoveryHooks]):
    """Read-only view keyed by the single canonical source registry."""

    def __getitem__(self, publisher: str) -> SourceDiscoveryHooks:
        return source_discovery(publisher)

    def __iter__(self) -> Iterator[str]:
        return (source.id for source in registered_sources())

    def __len__(self) -> int:
        return len(registered_sources())


DISCOVERY_HOOKS: Mapping[str, SourceDiscoveryHooks] = _LazyDiscoveryHooks()


def source_discovery(publisher: str) -> SourceDiscoveryHooks:
    source_module(publisher)
    return discovery_hooks(publisher)


def source_discovery_for_url(value: str) -> SourceDiscoveryHooks | None:
    for source in registered_sources():
        hooks = discovery_hooks(source.id)
        if hooks.owns_url(value):
            return hooks
    return None


@lru_cache(maxsize=1)
def _sitemap_sources() -> dict[str, SitemapSource]:
    result: dict[str, SitemapSource] = {}
    for source in registered_sources():
        hooks = discovery_hooks(source.id)
        for sitemap in hooks.sitemap_sources:
            if sitemap.publisher != source.id:
                raise ValueError(
                    f"sitemap {sitemap.key!r} belongs to {sitemap.publisher!r}, "
                    f"not {source.id!r}"
                )
            if sitemap.key in result:
                raise ValueError(f"duplicate sitemap adapter: {sitemap.key}")
            result[sitemap.key] = sitemap
    return result


class _LazySitemapSources(Mapping[str, SitemapSource]):
    def __getitem__(self, source_id: str) -> SitemapSource:
        return sitemap_source(source_id)

    def __iter__(self) -> Iterator[str]:
        return iter(_sitemap_sources())

    def __len__(self) -> int:
        return len(_sitemap_sources())


SITEMAP_SOURCES: Mapping[str, SitemapSource] = _LazySitemapSources()


def sitemap_source(source_id: str) -> SitemapSource:
    try:
        return _sitemap_sources()[source_id]
    except KeyError as exc:
        supported = ", ".join(sorted(_sitemap_sources()))
        raise ValueError(
            f"source {source_id!r} has no historical sitemap adapter; "
            f"expected one of: {supported}"
        ) from exc


def infer_published_at(value: str) -> str | None:
    hooks = source_discovery_for_url(value)
    if hooks is None or hooks.infer_published_at is None:
        return None
    return hooks.infer_published_at(value)


__all__ = [
    "DISCOVERY_HOOKS",
    "SITEMAP_SOURCES",
    "infer_published_at",
    "sitemap_source",
    "source_discovery",
    "source_discovery_for_url",
]
