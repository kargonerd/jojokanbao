from __future__ import annotations

import re
from urllib.parse import unquote, urlsplit


def generic_image_identity(url: str) -> str:
    """Unwrap archive delivery URLs without applying source semantics."""

    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    archive_image = None
    if host in {"arquivo.pt", "www.arquivo.pt"}:
        archive_image = re.match(
            r"^/(?:noFrame/)?replay/\d{14}(?:[a-z_]+)?/"
            r"(?P<url>https?://.+)$",
            parts.path,
            flags=re.IGNORECASE,
        )
    elif host == "web.archive.org":
        archive_image = re.match(
            r"^/web/\d{14}(?:[a-z_]+)?/(?P<url>https?://.+)$",
            parts.path,
            flags=re.IGNORECASE,
        )
    if archive_image is None:
        return url
    nested_url = archive_image.group("url")
    if parts.query:
        nested_url = f"{nested_url}?{parts.query}"
    return generic_image_identity(nested_url)


def is_placeholder_image_url(url: str) -> bool:
    decoded = unquote(url).casefold()
    path_leaf = urlsplit(decoded).path.rstrip("/").rsplit("/", 1)[-1]
    if path_leaf in {
        "10x10.gif",
        "null",
        "none",
        "social-share.png",
        "transparent.gif",
        "transparent.png",
        "undefined",
    }:
        return True
    return any(
        marker in decoded
        for marker in (
            "/defaultshareimage",
            "/default-share-image",
            "/default_social",
            "/default-social",
            "social-default",
            "yahoo_default_logo",
            "yahoo-finance-default-logo",
            "/img/social/opengraph/ij-social-default-",
            "/social/breaking-news.png",
            "/include/images/facebook-default.jpg",
            "add-the-print-as-a-trusted-source-",
            "google_preferred_source_badge",
        )
    )
