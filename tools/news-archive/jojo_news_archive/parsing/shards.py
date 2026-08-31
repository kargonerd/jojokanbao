from __future__ import annotations

from jojo_news_archive.sources.contracts import SourceModule
from jojo_news_archive.sources.registry import source_module


SUPPORTED_YEARS = range(2010, 2027)


def _validation_source(publisher: str) -> SourceModule:
    try:
        return source_module(publisher)
    except ValueError as exc:
        raise ValueError(f"unsupported parser publisher: {publisher}") from exc


def parser_source_manifest_shard(publisher: str, year: int) -> str:
    if year not in SUPPORTED_YEARS:
        raise ValueError("parser validation year must be between 2010 and 2026")
    source = _validation_source(publisher)
    if year < source.minimum_validation_year:
        raise ValueError(
            f"{publisher} validation is unavailable before "
            f"{source.minimum_validation_year}"
        )
    if year in source.unavailable_validation_years:
        raise ValueError(
            f"{publisher} full-text validation is unavailable for {year}"
        )
    return source.primary_validation_shard(year)


def parser_supplemental_manifest_shards(
    publisher: str,
    year: int,
) -> tuple[str, ...]:
    """Return source-owned catalog supplements for a validation cell."""

    parser_source_manifest_shard(publisher, year)
    return _validation_source(publisher).supplemental_validation_shards(year)
