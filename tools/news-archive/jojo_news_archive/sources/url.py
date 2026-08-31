from __future__ import annotations

from dataclasses import dataclass
import re
from urllib.parse import urlsplit, urlunsplit

from jojo_news_archive.sources.contracts import ArchiveSourceSpec


_NON_ARTICLE_FILE_SUFFIX_RE = re.compile(
    r"\.(?:avif|bmp|css|gif|ico|jpe?g|js|mjs|pdf|png|svg|webp)$",
    re.IGNORECASE,
)


def patterns(*values: str) -> tuple[re.Pattern[str], ...]:
    return tuple(re.compile(value, re.IGNORECASE) for value in values)


@dataclass(frozen=True)
class ArticleUrlParts:
    original: str
    hostname: str
    path: str


def article_url_parts(
    spec: ArchiveSourceSpec,
    value: str,
) -> ArticleUrlParts | None:
    original = value.strip()
    parsed = urlsplit(original)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    hostname = parsed.hostname.casefold()
    allowed_hosts = {
        spec.canonical_host,
        spec.canonical_host.removeprefix("www."),
        f"www.{spec.canonical_host.removeprefix('www.')}",
        *spec.alternate_hosts,
    }
    if hostname not in allowed_hosts:
        return None
    return ArticleUrlParts(
        original=original,
        hostname=hostname,
        path=re.sub(r"/+", "/", parsed.path or "/"),
    )


def finalize_article_url(
    spec: ArchiveSourceSpec,
    parts: ArticleUrlParts,
    *,
    path: str | None = None,
    normalized_host: str | None = None,
    query: str = "",
) -> str | None:
    normalized_path = parts.path if path is None else path
    if _NON_ARTICLE_FILE_SUFFIX_RE.search(normalized_path):
        return None
    if any(pattern.search(normalized_path) for pattern in spec.rejected_path_patterns):
        return None
    if not any(pattern.search(normalized_path) for pattern in spec.accepted_path_patterns):
        return None
    if normalized_path != "/":
        normalized_path = normalized_path.rstrip("/")
    host = normalized_host or (
        parts.hostname
        if parts.hostname in spec.preserve_normalized_hosts
        else spec.canonical_host
    )
    return urlunsplit(("https", host, normalized_path, query, ""))


def normalize_default_article_url(
    spec: ArchiveSourceSpec,
    value: str,
) -> str | None:
    parts = article_url_parts(spec, value)
    if parts is None:
        return None
    return finalize_article_url(spec, parts)
