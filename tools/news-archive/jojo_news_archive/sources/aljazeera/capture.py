from __future__ import annotations

from jojo_news_archive.capture.primitives import (
    common_crawl_first_candidate_sort_key as _common_crawl_first_candidate_sort_key,
)
from jojo_news_archive.models import CaptureCandidate
from jojo_news_archive.sources.capture_contracts import SourceCaptureHooks


def rank_manifest_candidates(
    candidates: tuple[CaptureCandidate, ...], *, published_at: str | None
) -> tuple[CaptureCandidate, ...]:
    """Prefer larger WARC records over recurring archived membership shells."""

    return tuple(
        sorted(
            candidates,
            key=lambda candidate: _common_crawl_first_candidate_sort_key(
                candidate, published_at=published_at
            ),
        )
    )


CAPTURE = SourceCaptureHooks(
    publisher="aljazeera",
    rank_manifest_candidates=rank_manifest_candidates,
)

__all__ = ["CAPTURE"]
