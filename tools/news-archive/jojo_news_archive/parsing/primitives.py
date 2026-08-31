from __future__ import annotations

from datetime import datetime, timezone
import html as html_module
import json
import re
from typing import Any, Iterable
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup, Tag
from dateutil.parser import isoparse

from jojo_news_archive.models import BlockType, ContentBlock
from jojo_news_archive.parsing.limits import MINIMUM_BODY_CHARACTERS


_SPACE_RE = re.compile(r"\s+")
_WINDOWS_1252_C1_TRANSLATION = {
    0x80: "€", 0x81: "", 0x82: "‚", 0x83: "ƒ", 0x84: "„",
    0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰",
    0x8A: "Š", 0x8B: "‹", 0x8C: "Œ", 0x8D: "", 0x8E: "Ž",
    0x8F: "", 0x90: "", 0x91: "‘", 0x92: "’", 0x93: "“",
    0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜",
    0x99: "™", 0x9A: "š", 0x9B: "›", 0x9C: "œ", 0x9D: "",
    0x9E: "ž", 0x9F: "Ÿ",
}
_CREDIT_RE = re.compile(
    r"(?i)(?:^|\s)(photographer|photo|credit|illustration|graphic|source)s?\s*:"
)


def walk_json_objects(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_json_objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_json_objects(child)


def json_ld_objects(soup: BeautifulSoup) -> Iterable[dict[str, Any]]:
    for script in soup.select('script[type="application/ld+json"]'):
        value = script.string or script.get_text()
        if not value.strip():
            continue
        try:
            payload = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            continue
        yield from walk_json_objects(payload)


def string_list(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def json_object_after_key(
    serialized: str,
    *,
    key: str,
) -> dict[str, Any] | None:
    match = re.search(rf'"{re.escape(key)}"\s*:\s*', serialized)
    if match is None:
        return None
    start = serialized.find("{", match.end())
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(serialized)):
        character = serialized[index]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                try:
                    value = json.loads(serialized[start:index + 1])
                except (json.JSONDecodeError, TypeError):
                    return None
                return value if isinstance(value, dict) else None
    return None


def terminal_tandem_repeat_length(value: str) -> int:
    """Return the length of a long exact suffix repeated back-to-back."""

    normalized = clean_text(value)
    punctuation = set("，,；;：:。！？.!?")
    for length in range(len(normalized) // 2, 23, -1):
        repeated = normalized[-length:]
        if (
            normalized[-2 * length : -length] == repeated
            and repeated[-1:] in punctuation
            and sum(character in punctuation for character in repeated) >= 2
        ):
            return length
    return 0


def deduplicate_blocks(
    blocks: list[ContentBlock],
) -> list[ContentBlock]:
    seen_text: set[str] = set()
    seen_assets: set[str] = set()
    unique: list[ContentBlock] = []
    for block in blocks:
        if block.text:
            normalized = normalize_block_text(block.text)
            if normalized and normalized in seen_text:
                continue
            if normalized:
                seen_text.add(normalized)
        if block.type == BlockType.IMAGE and block.asset_id:
            if block.asset_id in seen_assets:
                continue
            seen_assets.add(block.asset_id)
        block.position = len(unique)
        unique.append(block)
    return unique


def normalize_block_text(value: str) -> str:
    return clean_text(value).casefold()


def image_urls(image: Tag, *, base_url: str) -> list[str]:
    values: list[tuple[int, str]] = []
    for attribute in (
        "src",
        "data-src",
        "data-original",
        "data-image",
        "data-mediaviewer-src",
        "data-flickity-lazyload",
    ):
        normalized = normalized_url(image.get(attribute), base_url=base_url)
        if normalized and urlsplit(normalized).scheme != "data":
            values.append((0, normalized))
    for attribute in (
        "srcset",
        "data-srcset",
        "data-flickity-lazyload-srcset",
    ):
        raw = image.get(attribute)
        if not isinstance(raw, str):
            continue
        for entry in raw.split(","):
            parts = entry.strip().split()
            if not parts:
                continue
            normalized = normalized_url(parts[0], base_url=base_url)
            if not normalized or urlsplit(normalized).scheme == "data":
                continue
            score = 0
            if len(parts) > 1 and parts[1].endswith("w"):
                try:
                    score = int(parts[1][:-1])
                except ValueError:
                    score = 0
            values.append((score, normalized))
    values.sort(key=lambda item: item[0], reverse=True)
    result: list[str] = []
    for _, value in values:
        if value not in result:
            result.append(value)
    return result


def caption_credit(container: Tag) -> tuple[str | None, str | None]:
    caption_node = container.select_one("figcaption, [class*='caption' i]")
    if not caption_node:
        return None, None
    raw = dedupe_lines(caption_node.get_text("\n", strip=True))
    if not raw:
        return None, None
    match = _CREDIT_RE.search(raw)
    if not match:
        return raw, None
    caption = clean_text(raw[: match.start()]) or None
    credit = clean_text(raw[match.start() :]) or None
    if caption and credit and caption.casefold() == credit.casefold():
        caption = None
    return caption, credit


def dedupe_lines(value: str) -> str:
    result: list[str] = []
    seen: set[str] = set()
    for line in value.splitlines():
        clean = clean_text(line)
        key = clean.casefold()
        if clean and key not in seen:
            result.append(clean)
            seen.add(key)
    return "\n".join(result)


def looks_like_gallery(
    blocks: list[ContentBlock],
    *,
    allow_uncaptioned: bool = False,
) -> bool:
    image_blocks = [
        block for block in blocks if block.type == BlockType.IMAGE
    ]
    text_blocks = [
        block
        for block in blocks
        if block.type
        in {
            BlockType.PARAGRAPH,
            BlockType.HEADING,
            BlockType.QUOTE,
            BlockType.LIST,
            BlockType.TABLE,
        }
    ]
    caption_characters = sum(
        len(clean_text(block.caption or ""))
        for block in image_blocks
    )
    text_characters = sum(
        len(clean_text(block.text or ""))
        for block in text_blocks
    )
    if not image_blocks or len(text_blocks) > 2:
        return False
    if (
        allow_uncaptioned
        and len(image_blocks) >= 3
        and text_characters < MINIMUM_BODY_CHARACTERS
    ):
        return True
    return bool(
        caption_characters >= 100
        and caption_characters >= text_characters
    )


def block_plain_text(block: ContentBlock) -> str | None:
    if block.text and block.type in {
        BlockType.PARAGRAPH,
        BlockType.HEADING,
        BlockType.QUOTE,
        BlockType.LIST,
        BlockType.TABLE,
    }:
        return clean_text(block.text)
    if block.type == BlockType.IMAGE:
        parts: list[str] = []
        for value in (block.caption, block.credit):
            clean = clean_text(value or "")
            if clean and clean not in parts:
                parts.append(clean)
        return "\n".join(parts) or None
    return None


def document_language(soup: BeautifulSoup, *, default: str) -> str:
    node = soup.find("html")
    if isinstance(node, Tag):
        value = node.get("lang")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return default


def meta_content(
    soup: BeautifulSoup,
    attribute: str,
    value: str,
) -> str | None:
    node = soup.select_one(f'meta[{attribute}="{value}"]')
    if not isinstance(node, Tag):
        return None
    return string_or_none(node.get("content"))


def tag_text(node: Tag | None) -> str | None:
    return clean_text(node.get_text(" ", strip=True)) if node else None


def tag_attribute(node: Tag | None, attribute: str) -> str | None:
    if not isinstance(node, Tag):
        return None
    return string_or_none(node.get(attribute))


def parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        result = isoparse(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if result.tzinfo else result.replace(tzinfo=timezone.utc)


def first_text(*values: str | None) -> str | None:
    for value in values:
        clean = clean_text(value or "")
        if clean:
            return clean
    return None


def clean_text(value: str) -> str:
    unescaped = html_module.unescape(value)
    if re.search(r"[\x80-\x9f]", unescaped):
        unescaped = unescaped.translate(_WINDOWS_1252_C1_TRANSLATION)
    return _SPACE_RE.sub(" ", unescaped).strip()


def string_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def normalized_url(value: Any, *, base_url: str) -> str | None:
    if not isinstance(value, str):
        return None
    value = html_module.unescape(value.strip())
    if not value or value.startswith(("data:", "blob:", "javascript:")):
        return None
    if value.startswith("//"):
        value = "https:" + value
    value = urljoin(base_url, value)
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return value


def integer_attribute(node: Tag, name: str) -> int | None:
    value = node.get(name)
    if isinstance(value, int):
        return max(0, value)
    if isinstance(value, str):
        match = re.match(r"^\d+", value)
        if match:
            return int(match.group(0))
    return None


def absolute_image_dimension(node: Tag, name: str) -> int | None:
    """Read an absolute HTML image dimension without treating percent as px."""

    value = node.get(name)
    if isinstance(value, int):
        return max(0, value)
    if isinstance(value, str):
        match = re.fullmatch(r"\s*(\d+)(?:px)?\s*", value, flags=re.IGNORECASE)
        if match:
            return int(match.group(1))
    return None


def inner_html(soup: BeautifulSoup) -> str:
    root = soup.body or soup
    return "".join(str(child) for child in root.contents).strip()
