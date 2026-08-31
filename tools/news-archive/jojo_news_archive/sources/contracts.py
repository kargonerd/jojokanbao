from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import re


@dataclass(frozen=True)
class ArchiveSourceSpec:
    publisher: str
    canonical_host: str
    wayback_patterns: tuple[str, ...]
    accepted_path_patterns: tuple[re.Pattern[str], ...]
    rejected_path_patterns: tuple[re.Pattern[str], ...] = ()
    alternate_hosts: tuple[str, ...] = ()
    preserve_normalized_hosts: tuple[str, ...] = ()

    def expanded_wayback_patterns(
        self,
        *,
        from_year: int,
        to_year: int,
    ) -> tuple[str, ...]:
        result: list[str] = []
        for pattern in self.wayback_patterns:
            if "{year}" in pattern:
                result.extend(
                    pattern.format(year=year)
                    for year in range(from_year, to_year + 1)
                )
            else:
                result.append(pattern)
        return tuple(result)


@dataclass(frozen=True)
class PublisherSpec:
    publisher: str
    parser_version: str
    domains: tuple[str, ...]
    default_language: str
    edition: str | None
    body_selectors: tuple[str, ...]
    remove_selectors: tuple[str, ...] = ()
    text_block_selectors: tuple[str, ...] = ()
    preferred_image_hosts: tuple[str, ...] = ()
    use_structured_article_body: bool = False
    embedded_html_body_keys: tuple[str, ...] = ()


NormalizeUrlHook = Callable[[ArchiveSourceSpec, str], str | None]
ArchiveVariantHook = Callable[[ArchiveSourceSpec, str], ArchiveSourceSpec | None]
ValidationCandidateHook = Callable[[str], bool]
DeduplicationKeyHook = Callable[[str], str]
PublicationYearHook = Callable[[str], int | None]
PrimaryValidationShardHook = Callable[[int], str]
SupplementalValidationShardsHook = Callable[[int], tuple[str, ...]]


@dataclass(frozen=True)
class SourceCatalogTargetSpec:
    """One source-owned historical catalog bootstrap target."""

    priority: int
    from_year: int
    to_year: int
    manifest_mode: str
    max_discovery_pages: int

    def __post_init__(self) -> None:
        if self.priority < 0:
            raise ValueError("catalog target priority must be non-negative")
        if self.from_year > self.to_year:
            raise ValueError("catalog target from_year must not exceed to_year")
        if self.max_discovery_pages < 1:
            raise ValueError("catalog target max_discovery_pages must be positive")


@dataclass(frozen=True)
class SourceModule:
    """One publisher's complete static archive contract and URL hooks.

    Parser and discovery adapters intentionally are not imported here. Their
    registries attach runtime hooks lazily, while this module remains safe to
    load from URL normalization, catalog discovery, and parser configuration.
    """

    id: str
    archive_spec: ArchiveSourceSpec
    parser_spec: PublisherSpec
    capture_policy_version: str
    qa_policy_revision: int
    minimum_validation_year: int
    primary_validation_shard: PrimaryValidationShardHook
    supplemental_validation_shards: SupplementalValidationShardsHook
    wayback_timemap_fallback: bool = False
    common_crawl_fallback: bool = False
    arquivo_pt_fallback: bool = False
    arquivo_pt_prefix_url: str | None = None
    enabled: bool = True
    unavailable_validation_years: frozenset[int] = frozenset()
    validation_priority: int = 100
    requires_independent_holdout: bool = False
    proven_rotated_validation_years: frozenset[int] = frozenset()
    allow_initial_capacity_reset: bool = False
    catalog_targets: tuple[SourceCatalogTargetSpec, ...] = ()
    normalize_url: NormalizeUrlHook | None = None
    archive_variant: ArchiveVariantHook | None = None
    validation_candidate: ValidationCandidateHook | None = None
    deduplication_key: DeduplicationKeyHook | None = None
    publication_year: PublicationYearHook | None = None

    def __post_init__(self) -> None:
        if self.archive_spec.publisher != self.id:
            raise ValueError(
                f"archive spec publisher {self.archive_spec.publisher!r} "
                f"does not match source id {self.id!r}"
            )
        if self.parser_spec.publisher != self.id:
            raise ValueError(
                f"parser spec publisher {self.parser_spec.publisher!r} "
                f"does not match source id {self.id!r}"
            )
        if not self.capture_policy_version.startswith(f"{self.id}-capture/"):
            raise ValueError(
                f"capture policy version {self.capture_policy_version!r} "
                f"does not belong to source {self.id!r}"
            )
        if self.qa_policy_revision < 0:
            raise ValueError("qa policy revision must be non-negative")
        if self.minimum_validation_year < 2010:
            raise ValueError("minimum validation year must be 2010 or later")
        if self.validation_priority < 0:
            raise ValueError("validation priority must be non-negative")
