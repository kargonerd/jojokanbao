from __future__ import annotations

import json
import re
from typing import Any

from bs4 import BeautifulSoup, Tag

from jojo_news_archive.parsing.primitives import (
    clean_text,
    first_text,
    json_ld_objects,
    string_or_none,
    walk_json_objects,
)


def find_video_object_json(soup: BeautifulSoup) -> dict[str, Any]:
    """Return the primary structured video package, when one is present."""

    for item in json_ld_objects(soup):
        types = item.get("@type")
        if isinstance(types, str):
            types = [types]
        if isinstance(types, list) and "VideoObject" in types:
            return item
    return {}


def structured_article_body(
    news_article: dict[str, Any],
) -> Tag | None:
    value = news_article.get("articleBody")
    if not isinstance(value, str):
        return None
    raw_paragraphs = [
        paragraph
        for paragraph in re.split(r"\n\s*\n", value)
        if clean_text(paragraph)
    ]
    if not raw_paragraphs:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for raw_paragraph in raw_paragraphs:
        image_match = re.match(
            r"^\s*\[(https?://[^\]\s]+)\]\s*(.*)$",
            raw_paragraph,
            flags=re.DOTALL | re.IGNORECASE,
        )
        if image_match is not None:
            figure = document.new_tag("figure")
            image = document.new_tag("img")
            image["src"] = image_match.group(1)
            figure.append(image)
            article.append(figure)
            paragraph = clean_text(image_match.group(2))
            if not paragraph:
                continue
        else:
            paragraph = clean_text(raw_paragraph)
        node = document.new_tag("p")
        node.string = paragraph
        article.append(node)
    return article


def structured_image_gallery(soup: BeautifulSoup) -> Tag | None:
    for script in soup.select('script[type="application/ld+json"]'):
        value = script.string or script.get_text()
        if not value.strip():
            continue
        try:
            payload = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            continue
        for item in walk_json_objects(payload):
            types = item.get("@type")
            if isinstance(types, str):
                types = [types]
            if not (
                isinstance(types, list)
                and "ImageGallery" in types
            ):
                continue
            media = item.get("associatedMedia")
            if not isinstance(media, list):
                continue
            rows: list[tuple[str, str, str | None]] = []
            for image in media:
                if not isinstance(image, dict):
                    continue
                image_url = first_text(
                    string_or_none(image.get("contentUrl")),
                    string_or_none(image.get("url")),
                )
                caption = string_or_none(image.get("caption"))
                if not image_url or not caption:
                    continue
                creator = image.get("creator")
                credit = (
                    string_or_none(creator.get("name"))
                    if isinstance(creator, dict)
                    else string_or_none(creator)
                )
                rows.append((image_url, caption, credit))
            if len(rows) < 3:
                continue
            document = BeautifulSoup("<article></article>", "html.parser")
            article = document.article
            if not isinstance(article, Tag):
                return None
            for image_url, caption, credit in rows:
                figure = document.new_tag("figure")
                image_node = document.new_tag("img")
                image_node["src"] = image_url
                image_node["alt"] = caption
                figure.append(image_node)
                figcaption = document.new_tag("figcaption")
                figcaption.string = (
                    f"{caption} Photographer: {credit}"
                    if credit
                    else caption
                )
                figure.append(figcaption)
                article.append(figure)
            return article
    return None
