from __future__ import annotations

import re
from urllib.parse import urlsplit


def same_article_url(first: str, second: str) -> bool:
    first_parts = urlsplit(first)
    second_parts = urlsplit(second)
    return bool(
        is_article_url(first)
        and is_article_url(second)
        and first_parts.path.rstrip("/").casefold()
        == second_parts.path.rstrip("/").casefold()
    )


def is_article_url(value: str) -> bool:
    parsed = urlsplit(value)
    hostname = (parsed.hostname or "").casefold()
    return bool(
        parsed.scheme in {"http", "https"}
        and (hostname == "ft.com" or hostname.endswith(".ft.com"))
        and re.fullmatch(
            r"/content/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
            r"[0-9a-f]{4}-[0-9a-f]{12}/?",
            parsed.path,
            flags=re.IGNORECASE,
        )
    )
