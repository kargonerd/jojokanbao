from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
import hashlib
from typing import Any, Protocol, TypeAlias

from jojo_news_archive.models import (
    CaptureCandidate,
    DependentResource,
    RawCapture,
)


@dataclass(frozen=True)
class ManifestItem:
    """Publisher-neutral input consumed by the shared capture engine."""

    publisher: str
    canonical_url: str
    published_at: str | None
    section: str | None
    candidates: tuple[CaptureCandidate, ...]

    @property
    def article_id(self) -> str:
        digest = hashlib.sha256(self.canonical_url.encode("utf-8")).hexdigest()
        return f"{self.publisher}:{digest}"


@dataclass(frozen=True)
class ArchiveFallbackPolicy:
    """Retry-stage switches selected by one source capture policy."""

    wayback_timemap: bool
    common_crawl: bool
    arquivo_pt: bool


@dataclass(frozen=True)
class CandidateAssessment:
    """A source hook's additions to the shared transport/HTML assessment."""

    quality_score: int
    signals: dict[str, object]
    rejection_reasons: tuple[str, ...] = ()


class CaptureSessionProtocol(Protocol):
    """Narrow structural API available to vertical source strategies.

    The concrete session belongs to the shared raw-capture engine.  Source
    modules use this protocol only for typing, which keeps policy ownership in
    ``sources/<publisher>/capture.py`` without importing another publisher.
    """

    item: object
    best_response: tuple | None
    candidates_considered: list[CaptureCandidate]

    def consider(self, candidates: tuple[CaptureCandidate, ...] | list[CaptureCandidate]) -> None: ...

    def discover_wayback(self, item: object | None = None, *, maximum_candidates: int | None = None, label: str = "wayback-timemap") -> tuple[CaptureCandidate, ...]: ...

    def discover_common_crawl(self, url: str) -> tuple[CaptureCandidate, ...]: ...

    def discover_arquivo(self, item: object) -> tuple[CaptureCandidate, ...]: ...


CandidateResponse: TypeAlias = tuple[
    CaptureCandidate,
    int,
    bytes,
    str,
    str,
    int,
    dict[str, object],
]


@dataclass(frozen=True)
class SourceCaptureHooks:
    """Typed, explicit capture extension points owned by one publisher.

    Every ``sources/<publisher>/capture.py`` exports one ``CAPTURE`` value.
    The shared engine consumes this contract directly instead of probing a
    module with magic-string ``getattr`` calls.
    """

    publisher: str
    normalize_manifest_url: Callable[[str], str | None] | None = None
    observe_candidate_response: Callable[..., None] | None = None
    should_skip_candidate: Callable[..., bool] | None = None
    validate_candidate_response: Callable[..., tuple[CandidateResponse | None, str | None]] | None = None
    timemap_items: Callable[..., Iterable[ManifestItem]] | None = None
    rank_manifest_candidates: Callable[..., tuple[CaptureCandidate, ...]] | None = None
    capture_dependent_resources: Callable[..., list[DependentResource]] | None = None
    run_capture: Callable[[CaptureSessionProtocol], None] | None = None
    archive_fallback_policy: Callable[..., ArchiveFallbackPolicy] | None = None
    infini_minimum_body_characters: Callable[[str], int] | None = None
    skip_candidate: Callable[[CaptureCandidate], bool] | None = None
    fetch_candidate: Callable[..., Any] | None = None
    supports_infini_news: bool = False
    candidate_target_rejection: Callable[..., str | None] | None = None
    assess_candidate: Callable[..., CandidateAssessment] | None = None
    timemap_companion_urls: Callable[[str], tuple[str, ...]] | None = None
    select_timemap_candidates: Callable[..., tuple[CaptureCandidate, ...]] | None = None
    syndication_search_slug: Callable[[str], str] | None = None
    clean_syndication_search_title: Callable[[str], str] | None = None
    normalize_syndication_candidate_url: Callable[[str], str] | None = None
    syndication_candidate_priority: Callable[[str], int] | None = None
    syndication_maximum_candidates: int = 8
    archive_match_path: Callable[[str, str], str] | None = None
    archive_discovery_urls: Callable[[str], tuple[str, ...]] | None = None
    raw_shell_signals: Callable[..., dict[str, object]] | None = None
    completed_rejection_reason: Callable[..., str | None] | None = None
    preserve_removed_infini_candidate: Callable[[dict[str, object]], bool] | None = None

    def __post_init__(self) -> None:
        if not self.publisher:
            raise ValueError("capture hooks publisher must not be empty")
        if self.syndication_maximum_candidates < 1:
            raise ValueError("syndication maximum candidates must be positive")


def default_archive_fallback_policy(
    *,
    parser_validation_enabled: bool,
    prior_attempts: int,
) -> ArchiveFallbackPolicy:
    del parser_validation_enabled, prior_attempts
    return ArchiveFallbackPolicy(
        wayback_timemap=True,
        common_crawl=True,
        arquivo_pt=True,
    )


def default_candidate_assessment(
    *,
    quality_score: int,
    signals: dict[str, object],
) -> CandidateAssessment:
    return CandidateAssessment(quality_score=quality_score, signals=signals)


def default_completed_capture_rejection_reason(
    capture: RawCapture,
    *,
    content: bytes,
    signals: dict[str, object],
) -> str | None:
    del capture, content, signals
    return None
