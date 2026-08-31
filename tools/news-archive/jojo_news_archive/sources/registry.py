from __future__ import annotations

from types import MappingProxyType
from typing import Mapping

from jojo_news_archive.sources.aljazeera import SOURCE as ALJAZEERA_SOURCE
from jojo_news_archive.sources.ap import SOURCE as AP_SOURCE
from jojo_news_archive.sources.axios import SOURCE as AXIOS_SOURCE
from jojo_news_archive.sources.bloomberg import SOURCE as BLOOMBERG_SOURCE
from jojo_news_archive.sources.caixin import SOURCE as CAIXIN_SOURCE
from jojo_news_archive.sources.contracts import (
    ArchiveSourceSpec,
    PublisherSpec,
    SourceModule,
)
from jojo_news_archive.sources.ft import SOURCE as FT_SOURCE
from jojo_news_archive.sources.nikkei import SOURCE as NIKKEI_SOURCE
from jojo_news_archive.sources.npr import SOURCE as NPR_SOURCE
from jojo_news_archive.sources.nyt import SOURCE as NYT_SOURCE
from jojo_news_archive.sources.reuters import SOURCE as REUTERS_SOURCE
from jojo_news_archive.sources.scmp import SOURCE as SCMP_SOURCE
from jojo_news_archive.sources.url import normalize_default_article_url
from jojo_news_archive.sources.wsj import SOURCE as WSJ_SOURCE
from jojo_news_archive.sources.zaobao import SOURCE as ZAOBAO_SOURCE


_REGISTERED_SOURCES = (
    AP_SOURCE,
    WSJ_SOURCE,
    BLOOMBERG_SOURCE,
    NYT_SOURCE,
    REUTERS_SOURCE,
    FT_SOURCE,
    AXIOS_SOURCE,
    NPR_SOURCE,
    NIKKEI_SOURCE,
    ZAOBAO_SOURCE,
    ALJAZEERA_SOURCE,
    SCMP_SOURCE,
    CAIXIN_SOURCE,
)


def _build_registry(sources: tuple[SourceModule, ...]) -> Mapping[str, SourceModule]:
    modules: dict[str, SourceModule] = {}
    for source in sources:
        if source.id in modules:
            raise ValueError(f"duplicate archive source id: {source.id}")
        modules[source.id] = source
    return MappingProxyType(modules)


SOURCE_MODULES = _build_registry(_REGISTERED_SOURCES)

# Compatibility view for callers that previously inspected this constant.
# SourceModule remains the single registration record.
ARCHIVE_SOURCE_SPECS = MappingProxyType(
    {
        source_id: source.archive_spec
        for source_id, source in SOURCE_MODULES.items()
    }
)


def source_module(publisher: str) -> SourceModule:
    try:
        return SOURCE_MODULES[publisher]
    except KeyError as exc:
        supported = ", ".join(sorted(SOURCE_MODULES))
        raise ValueError(
            f"unsupported publisher {publisher!r}; expected one of: {supported}"
        ) from exc


def registered_sources(*, enabled_only: bool = False) -> tuple[SourceModule, ...]:
    sources = tuple(SOURCE_MODULES.values())
    if enabled_only:
        return tuple(source for source in sources if source.enabled)
    return sources


def archive_source_spec(publisher: str) -> ArchiveSourceSpec:
    return source_module(publisher).archive_spec


def publisher_spec(publisher: str) -> PublisherSpec:
    return source_module(publisher).parser_spec


def archive_source_variant(
    publisher: str,
    variant: str = "canonical",
) -> ArchiveSourceSpec:
    """Return an explicitly isolated discovery variant for a publisher."""

    module = source_module(publisher)
    if variant == "canonical":
        return module.archive_spec
    result = (
        module.archive_variant(module.archive_spec, variant)
        if module.archive_variant is not None
        else None
    )
    if result is None:
        raise ValueError(
            f"unsupported archive source variant {variant!r} "
            f"for publisher {publisher!r}"
        )
    return result


def normalize_article_url(
    spec: ArchiveSourceSpec,
    value: str,
) -> str | None:
    module = source_module(spec.publisher)
    if module.normalize_url is not None:
        return module.normalize_url(spec, value)
    return normalize_default_article_url(spec, value)


def is_parser_validation_candidate(
    spec: ArchiveSourceSpec,
    value: str,
) -> bool:
    """Return whether a canonical source URL may occupy a text QA slot."""

    normalized = normalize_article_url(spec, value)
    if normalized is None:
        return False
    hook = source_module(spec.publisher).validation_candidate
    return hook(normalized) if hook is not None else True


def article_deduplication_key(
    spec: ArchiveSourceSpec,
    value: str,
) -> str | None:
    """Return a stable story identity without changing its public URL."""

    normalized = normalize_article_url(spec, value)
    if normalized is None:
        return None
    hook = source_module(spec.publisher).deduplication_key
    return hook(normalized) if hook is not None else normalized


def article_url_publication_year(
    spec: ArchiveSourceSpec,
    value: str,
) -> int | None:
    normalized = normalize_article_url(spec, value)
    if normalized is None:
        return None
    hook = source_module(spec.publisher).publication_year
    return hook(normalized) if hook is not None else None


__all__ = [
    "ARCHIVE_SOURCE_SPECS",
    "SOURCE_MODULES",
    "ArchiveSourceSpec",
    "archive_source_spec",
    "archive_source_variant",
    "article_deduplication_key",
    "article_url_publication_year",
    "is_parser_validation_candidate",
    "normalize_article_url",
    "publisher_spec",
    "registered_sources",
    "source_module",
]
