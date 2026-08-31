from __future__ import annotations

from jojo_news_archive.capture.primitives import same_article_url as _same_article_url
from jojo_news_archive.models import CaptureCandidate, CaptureProvider
from jojo_news_archive.sources.capture_contracts import SourceCaptureHooks


def candidate_target_rejection(
    candidate: CaptureCandidate, *, canonical_url: str, final_url: str
) -> str | None:
    if (
        candidate.provider == CaptureProvider.LIVE_ORIGIN
        and not _same_article_url(final_url, canonical_url)
    ):
        return "live-origin:target-mismatch"
    return None


def completed_rejection_reason(capture, *, content: bytes, signals: dict[str, object]) -> str | None:
    del content, signals
    rejection = candidate_target_rejection(
        capture.selected_candidate,
        canonical_url=capture.canonical_url,
        final_url=capture.final_url,
    )
    return "zaobao-live-origin-target-mismatch" if rejection else None


def raw_shell_signals(
    *,
    sampled_content: bytes,
    prefix: bytes,
    final_url: str,
    has_article_marker: bool,
    has_strong_body_marker: bool,
) -> dict[str, object]:
    del sampled_content, has_article_marker, has_strong_body_marker
    microtransaction = bool(
        "zaobao.com.sg/" in final_url.casefold()
        and b"article-microtransaction" in prefix
        and b"js-cta-microtransaction" in prefix
    )
    return {
        "subscriptionShell": microtransaction,
        "zaobaoMicrotransactionShell": microtransaction,
        "penalize": microtransaction,
    }


CAPTURE = SourceCaptureHooks(
    publisher="zaobao",
    candidate_target_rejection=candidate_target_rejection,
    raw_shell_signals=raw_shell_signals,
    completed_rejection_reason=completed_rejection_reason,
)

__all__ = ["CAPTURE"]
