from __future__ import annotations

from jojo_news_archive.sources.registry import SOURCE_MODULES


CONTENT_AUDIT_FORMAT_VERSION = "jojo-parser-validation-content-audit/6"


def qa_policy_revision(publisher: str) -> int:
    """Return the source-owned QA contract revision.

    Unknown publishers retain the historical zero revision so callers can
    inspect legacy audit metadata without first registering the source.
    """

    source = SOURCE_MODULES.get(publisher)
    return source.qa_policy_revision if source is not None else 0
