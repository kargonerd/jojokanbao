from __future__ import annotations

import json
import re
from collections.abc import Callable

from bs4 import BeautifulSoup, Tag

from jojo_news_archive.parsing.limits import MINIMUM_BODY_CHARACTERS
from jojo_news_archive.parsing.parser_contracts import ParseContext
from jojo_news_archive.parsing.primitives import clean_text, walk_json_objects
from jojo_news_archive.parsing.structured import structured_article_body
from jojo_news_archive.parsing.syndication import (
    generic_syndication_allowed,
    generic_syndication_body,
    postmedia_syndication_body,
)
from jojo_news_archive.sources.contracts import PublisherSpec


def select_default_body(
    context: ParseContext,
    *,
    initial_body: Tag | None = None,
    apply_structured: bool = True,
    force_structured: bool = False,
    partner_noise_cleaner: Callable[[Tag, BeautifulSoup], None] | None = None,
) -> Tag | None:
    """Publisher-neutral body fallback used by simple source strategies."""

    body = initial_body
    if body is None and generic_syndication_allowed(context):
        body = postmedia_syndication_body(context.soup)
        if body is None:
            body = generic_syndication_body(
                context.soup,
                partner_noise_cleaner=partner_noise_cleaner,
            )
    if body is None:
        body = select_body(context.soup, context.spec)
    if context.spec.embedded_html_body_keys and (
        body is None
        or body.select_one("p, h2, h3, h4, h5, h6, blockquote, ul, ol, table")
        is None
    ):
        embedded = embedded_html_body(
            context.soup,
            keys=context.spec.embedded_html_body_keys,
        )
        if embedded is not None:
            body = embedded
    if context.spec.use_structured_article_body and apply_structured:
        structured = structured_article_body(context.news_article)
        if body is None:
            body = structured
        elif structured is not None:
            body = prefer_structured_body_with_media(
                body,
                structured_body=structured,
                force=force_structured,
            )
    return body


def select_body(soup: BeautifulSoup, spec: PublisherSpec) -> Tag | None:
    for selector in spec.body_selectors:
        nodes = [node for node in soup.select(selector) if isinstance(node, Tag)]
        if nodes:
            return max(nodes, key=lambda node: len(node.get_text(" ", strip=True)))
    return None


def prefer_structured_body_with_media(
    body: Tag,
    *,
    structured_body: Tag,
    force: bool = False,
) -> Tag:
    body_text = clean_text(body.get_text(" ", strip=True))
    structured_text = clean_text(
        structured_body.get_text(" ", strip=True)
    )
    if (
        not force
        and (
            len(body_text) >= MINIMUM_BODY_CHARACTERS
            or len(structured_text) <= len(body_text)
        )
    ):
        return body

    media_source = body
    if force:
        editorial_body = body.select_one(
            ".article-content-container, #FineDining"
        )
        if isinstance(editorial_body, Tag):
            media_source = editorial_body
    media_nodes = list(media_source.select("figure"))
    media_nodes.extend(
        node
        for node in media_source.select("iframe")
        if node.find_parent("figure") is None
    )
    media_nodes.extend(
        node
        for node in media_source.select("img")
        if node.find_parent("figure") is None
    )
    for media in media_nodes:
        clone_document = BeautifulSoup(str(media), "html.parser")
        clone = clone_document.find(media.name)
        if not isinstance(clone, Tag):
            continue
        if media.name == "img":
            wrapper = clone_document.new_tag("figure")
            clone.extract()
            wrapper.append(clone)
            structured_body.append(wrapper)
        else:
            structured_body.append(clone)
    return structured_body


def embedded_html_body(
    soup: BeautifulSoup,
    *,
    keys: tuple[str, ...],
) -> Tag | None:
    decoder = json.JSONDecoder()
    quoted_keys = tuple(f'"{key}"' for key in keys)
    for script in soup.find_all("script"):
        value = script.string or script.get_text()
        if not value or not any(key in value for key in quoted_keys):
            continue
        starts = [
            match.end()
            for match in re.finditer(r"=\s*(?=\{)", value)
        ]
        if not starts:
            first_object = value.find("{")
            if first_object >= 0:
                starts.append(first_object)
        for start in starts:
            try:
                payload, _ = decoder.raw_decode(value[start:])
            except (json.JSONDecodeError, TypeError):
                continue
            for item in walk_json_objects(payload):
                for key in keys:
                    html_value = item.get(key)
                    if (
                        not isinstance(html_value, str)
                        or not html_value.strip()
                    ):
                        continue
                    document = BeautifulSoup(
                        f"<article>{html_value}</article>",
                        "html.parser",
                    )
                    article = document.article
                    if isinstance(article, Tag):
                        return article
    return None
