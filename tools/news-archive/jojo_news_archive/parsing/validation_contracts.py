from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from bs4 import BeautifulSoup

from jojo_news_archive.models import JojoArticle, RawCapture


@dataclass(frozen=True)
class ValidationContext:
    capture: RawCapture
    article: JojoArticle
    html_bytes: bytes
    document: BeautifulSoup
    raw_text: str
    sample_year: int
    text_blocks: tuple[str, ...]
    normalized_blocks: tuple[str, ...]
    publisher_blocks: tuple[str, ...]
    nontext_content: bool
    repeated_text_within_block: bool
    canonical_url_is_normalized: bool
    validation_candidate: bool


def has_terminal_tandem_repeat(value: str) -> bool:
    """Return whether a long punctuated suffix is repeated back-to-back."""

    normalized = " ".join(value.split())
    punctuation = set("，,；;：:。！？.!?")
    for length in range(len(normalized) // 2, 23, -1):
        repeated = normalized[-length:]
        if (
            normalized[-2 * length : -length] == repeated
            and repeated[-1:] in punctuation
            and sum(character in punctuation for character in repeated) >= 2
        ):
            return True
    return False


@dataclass(frozen=True)
class ExistingSampleContext:
    canonical_url: str
    sample_year: int


@dataclass(frozen=True)
class SampleCandidateContext:
    canonical_url: str
    sample_year: int
    direct_provider: str | None
    candidates: tuple[Mapping[str, Any], ...]


SamplingMode = Literal["actionable-gap", "provider-target"]
SamplingSummary = Literal["direct", "exact-wayback"]


@dataclass(frozen=True)
class PreferredSamplingPass:
    provider: str
    mode: SamplingMode
    summary: SamplingSummary


@dataclass(frozen=True)
class CapturePriorityContext:
    canonical_url: str
    sample_year: int
    status: str
    last_error: str
    candidates_json: str
    candidates: tuple[Mapping[str, Any], ...]

    def has_provider(self, provider: str) -> bool:
        return any(
            str(candidate.get("provider") or "") == provider
            for candidate in self.candidates
        )

    def has_exact_wayback(self) -> bool:
        return any(
            str(candidate.get("provider") or "") == "wayback"
            and candidate.get("digest") is not None
            and candidate.get("capturedAt") is not None
            for candidate in self.candidates
        )

    def maximum_byte_count(self) -> int:
        values: list[int] = []
        for candidate in self.candidates:
            try:
                values.append(int(candidate.get("byteCount") or 0))
            except (TypeError, ValueError):
                continue
        return max(values, default=0)


SourceIssueHook = Callable[[ValidationContext], tuple[str, ...]]
ArticleIdentityHook = Callable[[ValidationContext], str | None]
InterfaceNoiseHook = Callable[[ValidationContext], bool]
ExistingSampleHook = Callable[[ExistingSampleContext], bool]
SampleCandidateHook = Callable[[SampleCandidateContext], bool]
CapturePriorityHook = Callable[[CapturePriorityContext], tuple[int, int, int, int]]


def no_source_issues(context: ValidationContext) -> tuple[str, ...]:
    return ()


def no_source_identity(context: ValidationContext) -> str | None:
    return None


def no_source_interface_noise(context: ValidationContext) -> bool:
    return False


def accept_existing_sample(context: ExistingSampleContext) -> bool:
    return True


def accept_sample_candidate(context: SampleCandidateContext) -> bool:
    return True


def default_capture_priority(
    context: CapturePriorityContext,
) -> tuple[int, int, int, int]:
    status_priority = (
        1
        if context.status == "pending"
        else 0
        if "server-placeholder-shell" in context.last_error
        else 2
    )
    archive_priority = (
        0
        if context.has_exact_wayback() or context.has_provider("infini-news")
        else 1
        if context.has_provider("other")
        else 2
    )
    return status_priority, 1, 0, archive_priority


@dataclass(frozen=True)
class SourceValidationHooks:
    issues: SourceIssueHook = no_source_issues
    post_issues: SourceIssueHook = no_source_issues
    article_identity: ArticleIdentityHook = no_source_identity
    interface_noise: InterfaceNoiseHook = no_source_interface_noise
    allow_editorial_read_more: bool = False
    reject_article_buttons: bool = False
    existing_sample_valid: ExistingSampleHook = accept_existing_sample
    sample_candidate_valid: SampleCandidateHook = accept_sample_candidate
    preferred_sampling_passes: tuple[PreferredSamplingPass, ...] = ()
    capture_priority: CapturePriorityHook = default_capture_priority


def with_capture_priority(
    context: CapturePriorityContext,
    *,
    status: int | None = None,
    provider: int | None = None,
    quality: int | None = None,
    archive: int | None = None,
) -> tuple[int, int, int, int]:
    values = list(default_capture_priority(context))
    for index, replacement in enumerate((status, provider, quality, archive)):
        if replacement is not None:
            values[index] = replacement
    return tuple(values)  # type: ignore[return-value]
