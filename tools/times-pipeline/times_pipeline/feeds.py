from __future__ import annotations

from dataclasses import dataclass, field


USER_AGENT = "JOJO-News-Archive/2.0 (+https://jojokanbao.cn)"


@dataclass(frozen=True, slots=True)
class Source:
    id: str
    name: str
    language: str
    route: str | None
    feed_url: str | None
    content_policy: str
    parser_id: str | None = None
    archive_pages: bool = True
    feed_urls: tuple[str, ...] = ()
    minimum_full_characters: int = 800
    minimum_full_paragraphs: int = 3


@dataclass(frozen=True, slots=True)
class Article:
    id: str
    title: str
    summary: str | None
    body: str
    content_status: str
    url: str
    published_at: str
    source: Source
    translations: dict[str, dict] = field(default_factory=dict)
    normalized: dict | None = None


@dataclass(frozen=True, slots=True)
class RawFeed:
    source_id: str
    body: bytes
    fetched_at: str
    content_type: str | None
    url: str = ""
    status_code: int = 200
    reason_phrase: str = "OK"
    request_headers: tuple[tuple[str, str], ...] = ()
    response_headers: tuple[tuple[str, str], ...] = ()
