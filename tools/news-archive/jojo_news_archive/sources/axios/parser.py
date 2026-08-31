from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import unquote, urlsplit
from bs4 import BeautifulSoup, NavigableString, Tag
from jojo_news_archive.models import ContentType, ImageRole
from jojo_news_archive.parsing.primitives import (
    clean_text as _clean_text,
    string_or_none as _string_or_none,
    walk_json_objects as _walk_json_objects,
)


def _axios_image_identity(url: str) -> str | None:
    parts = urlsplit(url)
    if (parts.hostname or "").casefold() != "images.axios.com":
        return None
    asset = re.search(
        r"/(\d{4}/\d{2}/\d{2}/[^/]+)$",
        parts.path,
        flags=re.IGNORECASE,
    )
    if asset is None:
        return None
    return f"axios-image:{asset.group(1).casefold()}"


def _axios_next_story(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> dict[str, Any] | None:
    """Return Axios's server-rendered story payload when it is present."""
    script = soup.select_one("script#__NEXT_DATA__")
    if not isinstance(script, Tag):
        return None
    try:
        payload = json.loads(script.string or script.get_text())
    except (json.JSONDecodeError, TypeError):
        return None
    target_path = unquote(urlsplit(canonical_url).path).rstrip("/").casefold()
    candidates: list[dict[str, Any]] = []
    for item in _walk_json_objects(payload):
        blocks = item.get("blocks")
        permalink = _string_or_none(item.get("permalink"))
        if (
            isinstance(item.get("headline"), str)
            and isinstance(blocks, dict)
            and isinstance(blocks.get("blocks"), list)
            and permalink
            and "axios.com/" in permalink.casefold()
            and any(
                key in item
                for key in ("published_date", "first_published", "last_published")
            )
        ):
            candidates.append(item)
            permalink_path = (
                unquote(urlsplit(permalink).path).rstrip("/").casefold()
            )
            if permalink_path == target_path:
                return item
    # A normal archived Axios page carries one structured story. Preserve
    # that recovery path even if its permalink was migrated after capture.
    # Multi-story deep dives must never silently select their first chapter:
    # each child URL has its own payload and is matched above.
    return candidates[0] if len(candidates) == 1 else None


def _axios_next_story_body(story: dict[str, Any]) -> Tag | None:
    """Restore Axios body HTML and media hidden in ``__NEXT_DATA__``.

    Axios's 2022-era shell sometimes server-renders an empty Draft.js wrapper
    even though the complete historical payload remains in ``bodyHtml`` and
    the structured Draft.js blocks.  Prefer the publisher's rendered HTML,
    then supplement media embeds whose visible text was stripped from it.
    """
    document = BeautifulSoup(
        "<article data-jojo-source='axios-next-story'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None

    body_html = story.get("bodyHtml")
    html_parts: list[str] = []
    if isinstance(body_html, str):
        html_parts.append(body_html)
    elif isinstance(body_html, dict):
        for key in ("beforeKeepReading", "keepReadingData", "afterKeepReading"):
            value = body_html.get(key)
            if isinstance(value, str):
                html_parts.append(value)
            elif isinstance(value, dict):
                html_parts.extend(
                    nested
                    for nested in value.values()
                    if isinstance(nested, str)
                )
    if html_parts:
        parsed = BeautifulSoup("".join(html_parts), "html.parser")
        for child in list((parsed.body or parsed).children):
            article.append(child)

    # Axios quote cards store the quote in ``blockquote`` and its complete
    # editorial attribution in an adjacent ``cite`` element. The generic
    # block extractor intentionally does not treat every page-level citation
    # as prose, so normalize only this publisher-owned structured body shape
    # into a paragraph. Otherwise a complete short quote card is measured
    # from the quote alone and incorrectly classified as truncated.
    for attribution in article.select("blockquote + cite"):
        attribution.name = "p"
        attribution["data-jojo-role"] = "quote-attribution"

    structured_blocks = story.get("blocks", {}).get("blocks", [])
    if not isinstance(structured_blocks, list):
        structured_blocks = []

    def append_fragment(value: str) -> None:
        parsed = BeautifulSoup(value, "html.parser")
        for node in parsed.select("script, style"):
            node.decompose()
        for child in list((parsed.body or parsed).children):
            article.append(child)

    existing_text = _clean_text(article.get_text(" ", strip=True)).casefold()
    existing_tokens = _axios_text_tokens(existing_text)
    existing_images = {
        _string_or_none(node.get("src"))
        for node in article.select("img[src]")
    }
    existing_images.discard(None)
    existing_embeds = {
        _string_or_none(node.get("src"))
        for node in article.select("iframe[src]")
    }
    existing_embeds.discard(None)
    has_rendered_text = bool(existing_text)

    for block in structured_blocks:
        if not isinstance(block, dict):
            continue
        block_type = _clean_text(str(block.get("type") or "")).casefold()
        text = _clean_text(str(block.get("text") or ""))
        data = block.get("data")
        if not isinstance(data, dict):
            data = {}

        if block_type == "image":
            source = _string_or_none(data.get("src"))
            if source and source not in existing_images:
                figure = document.new_tag("figure")
                image = document.new_tag("img", src=source)
                alt = _string_or_none(data.get("alt_text"))
                if alt:
                    image["alt"] = alt
                figure.append(image)
                article.append(figure)
                existing_images.add(source)
            continue

        if block_type == "embed":
            oembed = data.get("oembed")
            embed_html = (
                _string_or_none(oembed.get("html"))
                if isinstance(oembed, dict)
                else None
            )
            embed_text = (
                _clean_text(
                    BeautifulSoup(embed_html, "html.parser").get_text(
                        " ", strip=True
                    )
                )
                if embed_html
                else ""
            )
            embed_sources = (
                {
                    _string_or_none(node.get("src"))
                    for node in BeautifulSoup(
                        embed_html, "html.parser"
                    ).select("iframe[src]")
                }
                if embed_html
                else set()
            )
            embed_sources.discard(None)
            if embed_sources and embed_sources.issubset(existing_embeds):
                continue
            if embed_html and (
                not embed_text
                or embed_text.casefold() not in existing_text
            ):
                append_fragment(embed_html)
                existing_embeds.update(embed_sources)
                existing_text = _clean_text(
                    article.get_text(" ", strip=True)
                ).casefold()
            elif not embed_html:
                source = _string_or_none(data.get("url"))
                if source:
                    article.append(document.new_tag("iframe", src=source))
            continue

        block_tokens = _axios_text_tokens(text)
        if text and (
            not has_rendered_text
            or not block_tokens
            or block_tokens not in existing_tokens
        ):
            tag_name = (
                "blockquote"
                if "quote" in block_type
                else "h2"
                if block_type.startswith("header")
                else "li"
                if "list-item" in block_type
                else "p"
            )
            node = document.new_tag(tag_name)
            node.string = text
            article.append(node)
            existing_text = f"{existing_text} {text.casefold()}".strip()
            existing_tokens = _axios_text_tokens(existing_text)

    image_only = _axios_image_only_story(story)
    if image_only is not None and not article.select_one("img[src]"):
        source, alt, caption = image_only
        figure = document.new_tag("figure")
        image = document.new_tag("img", src=source)
        if alt:
            image["alt"] = alt
        figure.append(image)
        if caption:
            figcaption = document.new_tag("figcaption")
            figcaption.string = caption
            figure.append(figcaption)
        article.append(figure)

    if article.select_one(
        "p, h2, h3, h4, h5, h6, blockquote, li, table, iframe, img[src]"
    ):
        return article
    return None


def _axios_text_tokens(value: str) -> str:
    """Normalize rendered and Draft.js text for containment comparisons."""

    return " ".join(re.findall(r"[a-z0-9]+", value.casefold()))


def _remove_axios_body_chrome(soup: BeautifulSoup) -> None:
    """Remove publisher recirculation labels embedded in Axios story HTML."""

    for text_node in list(soup.find_all(string=True)):
        if (
            isinstance(text_node, NavigableString)
            and _clean_text(str(text_node)).casefold() == "go deeper"
        ):
            text_node.extract()
    for node in list(soup.select("p, li, h2, h3, h4, h5, h6")):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        # Older Axios Draft.js exports split the linked word ``here`` at the
        # anchor boundary (``h`` + ``ere``).  This leaves a newsletter/site
        # navigation CTA in the normalized prose unless the two forms are
        # compared after repairing that presentation artifact.
        compact_interface_text = re.sub(r"\bh\s+ere\b", "here", text)
        newsletter_signup = node.select_one(
            "a[href*='link.axios.com/join/'], "
            "a[href*='signup.axios.com/'], "
            "a[href*='/newsletter-signup'], "
            "a[href*='axios.com/newsletters/']"
        )
        if (
            text.startswith("sign up for our axios ")
            and " newsletter" in text
        ) or (
            re.match(r"^sign up for (?:the )?axios\b", text) is not None
            and " newsletter" in text
        ) or (
            re.match(r"^sign up for (?:the )?(?:new )?axios\b", text)
            is not None
            and " newsletter" in text
        ) or (
            text.startswith("sign up for the daily axios ")
            and " newsletter" in text
        ) or (
            text.startswith("subscribe to the axios ")
            and " newsletter" in text
        ) or text.startswith("subscribe to axios ") or (
            re.match(r"^subscribe to (?:the )?(?:weekly )?axios\b", text)
            is not None
            and " newsletter" in text
        ) or (
            text.startswith("sign up for ")
            and " newsletter" in text
            and (
                newsletter_signup is not None
                or re.fullmatch(
                    r"sign up for the daily [a-z0-9&'’ .-]+ "
                    r"financial newsletter here\s*\.?",
                    text,
                )
                is not None
            )
        ) or (
            text.startswith("subscribe to ")
            and " podcast" in text
        ) or re.fullmatch(
            r"subscribe to our youtube(?: channel)?\s*[.!]?", text
        ) or compact_interface_text in {
            "subscribe to our newsletters here and check out our news stream here.",
            "subscribe to our newsletters here and check out our news stream here",
        }:
            node.decompose()
            continue
        if text not in {
            "read more",
            "read more:",
            "go deeper",
            "go deeper:",
            "more from axios",
            "more from axios:",
            "more on axios",
            "more on axios:",
        } and not text.startswith("go deeper:"):
            continue
        following = node.find_next_sibling()
        if (
            text
            in {
                "read more",
                "read more:",
                "go deeper",
                "go deeper:",
                "more from axios",
                "more from axios:",
                "more on axios",
                "more on axios:",
            }
            and isinstance(following, Tag)
            and following.name in {"ul", "ol"}
        ):
            following.decompose()
        node.decompose()
    for listing in list(soup.select("ul, ol")):
        items = [
            _clean_text(item.get_text(" ", strip=True)).casefold()
            for item in listing.select(":scope > li")
        ]
        if items and all(
            item.startswith("go deeper:")
            or (
                item.startswith("subscribe to ")
                and " podcast" in item
            )
            for item in items
        ):
            listing.decompose()


def _axios_image_only_story(
    story: dict[str, Any] | None,
) -> tuple[str, str | None, str | None] | None:
    """Return publisher-authored media for a proven image-only Axios item."""

    if not isinstance(story, dict) or _axios_empty_newsletter_story(story):
        return None
    try:
        wordcount = int(story.get("wordcount"))
    except (TypeError, ValueError):
        return None
    blocks = story.get("blocks")
    values = blocks.get("blocks") if isinstance(blocks, dict) else None
    if wordcount != 0 or values != []:
        return None
    body_html = story.get("bodyHtml")
    fragments = (
        [body_html]
        if isinstance(body_html, str)
        else [
            value
            for value in body_html.values()
            if isinstance(value, str)
        ]
        if isinstance(body_html, dict)
        else []
    )
    if _clean_text(
        BeautifulSoup("".join(fragments), "html.parser").get_text(
            " ", strip=True
        )
    ):
        return None
    primary = story.get("primary_image")
    if not isinstance(primary, dict):
        return None
    source = _string_or_none(primary.get("base_image_url"))
    if source is None:
        crops = primary.get("crops")
        if isinstance(crops, dict):
            preferred = crops.get("16x9") or next(iter(crops.values()), None)
            if isinstance(preferred, dict):
                source = _string_or_none(preferred.get("url"))
    if source is None or not source.startswith(("http://", "https://")):
        return None
    alt = _string_or_none(primary.get("alt_text"))
    caption_data = primary.get("caption")
    caption_blocks = (
        caption_data.get("blocks") if isinstance(caption_data, dict) else None
    )
    caption = (
        _clean_text(
            " ".join(
                str(block.get("text") or "")
                for block in caption_blocks
                if isinstance(block, dict)
            )
        )
        if isinstance(caption_blocks, list)
        else None
    )
    return source, alt, caption or None


def _axios_empty_newsletter_story(story: dict[str, Any] | None) -> bool:
    """Identify exact recurring briefing records with no publisher body."""
    if not isinstance(story, dict):
        return False
    headline = _clean_text(str(story.get("headline") or ""))
    if not re.fullmatch(
        r"(?i)(?:"
        r"Axios\s+(?:AM|PM)(?:\s*\(beta\))?"
        r"|Today's\s+Trump\s+Top\s+5:\s+.+"
        r")",
        headline,
    ):
        return False
    if story.get("wordcount") not in {0, "0"}:
        return False
    blocks = story.get("blocks")
    if not isinstance(blocks, dict) or blocks.get("blocks") != []:
        return False
    body_html = story.get("bodyHtml")
    fragments: list[str] = []
    if isinstance(body_html, str):
        fragments.append(body_html)
    elif isinstance(body_html, dict):
        fragments.extend(
            value for value in body_html.values() if isinstance(value, str)
        )
    return not _clean_text(
        BeautifulSoup("".join(fragments), "html.parser").get_text(
            " ", strip=True
        )
    )


def _axios_short_newsletter_story(story: dict[str, Any] | None) -> bool:
    """Accept a complete publisher-authored short Axios AM test item.

    This deliberately requires the Axios AM subscription relationship and an
    exact agreement between the structured word count, Draft.js text, and
    rendered body. Ordinary short stories remain subject to the normal body
    threshold.
    """
    if not isinstance(story, dict):
        return False
    headline = _clean_text(str(story.get("headline") or ""))
    if not re.fullmatch(r"(?i)Axios\s+AM:\s+.+", headline):
        return False
    authors = story.get("authors")
    if not isinstance(authors, list) or not any(
        isinstance(author, dict)
        and isinstance(author.get("subscription"), dict)
        and _clean_text(
            str(author["subscription"].get("slug") or "")
        ).casefold()
        == "axios-am"
        for author in authors
    ):
        return False
    try:
        wordcount = int(story.get("wordcount"))
    except (TypeError, ValueError):
        return False
    if not 1 <= wordcount <= 50:
        return False
    blocks = story.get("blocks")
    values = blocks.get("blocks") if isinstance(blocks, dict) else None
    if not isinstance(values, list) or not values:
        return False
    block_text = _clean_text(
        " ".join(
            str(block.get("text") or "")
            for block in values
            if isinstance(block, dict)
        )
    )
    if not block_text or len(block_text.split()) != wordcount:
        return False
    body_html = story.get("bodyHtml")
    fragments = (
        [body_html]
        if isinstance(body_html, str)
        else [
            value
            for value in body_html.values()
            if isinstance(value, str)
        ]
        if isinstance(body_html, dict)
        else []
    )
    rendered_text = _clean_text(
        BeautifulSoup("".join(fragments), "html.parser").get_text(
            " ", strip=True
        )
    )
    return rendered_text == block_text


def _axios_next_story_content_type(
    story: dict[str, Any] | None,
) -> ContentType | None:
    if _axios_empty_newsletter_story(story) or _axios_short_newsletter_story(
        story
    ):
        return ContentType.NEWSLETTER
    if _axios_image_only_story(story) is not None:
        return ContentType.GALLERY
    if not isinstance(story, dict):
        return None
    blocks = story.get("blocks")
    values = blocks.get("blocks") if isinstance(blocks, dict) else None
    if not isinstance(values, list):
        return None
    embed_types = {
        _clean_text(str(data.get("type") or "")).casefold()
        for block in values
        if isinstance(block, dict)
        and block.get("type") == "embed"
        and isinstance((data := block.get("data")), dict)
    }
    if embed_types & {"video", "youtube", "vimeo", "jwplayer"}:
        return ContentType.VIDEO
    if embed_types:
        return ContentType.INTERACTIVE
    if values and all(
        isinstance(block, dict) and block.get("type") == "image"
        for block in values
    ):
        return ContentType.GALLERY
    return None


def _axios_embedded_content_type(body: Tag) -> ContentType | None:
    """Classify Axios pages whose entire editorial payload is an embed.

    Old Axios URLs are now served by a newer Next.js shell.  Some of them are
    nevertheless genuine, deliberately non-text pieces: their selected
    Draft.js body contains a player/chart iframe and, at most, a short CTA.
    Treating those as truncated articles discards the useful embed and makes
    an article-only quality heuristic report a false parser failure.
    """
    # Axios's historical React markup often keeps iframe URLs in a lazy-load
    # data attribute.  Restore that attribute before block extraction so the
    # archived article keeps a usable embed rather than an empty shell.
    for iframe in body.select("iframe[data-src]:not([src])"):
        iframe["src"] = iframe.get("data-src")
    text = _clean_text(
        " ".join(
            node.get_text(" ", strip=True)
            for node in body.select("p, li, blockquote, h2, h3, h4")
        )
    )
    # A normal reported article may include a player.  Only classify a page
    # as embed-led when there is no substantive surrounding editorial text.
    if len(text) > 220:
        return None
    # Axios also publishes chart-led visual explainers as server-rendered SVG
    # rather than an iframe.  Their legacy archive shell exposes the visual
    # through these fallback classes and contains only a chart credit/caption;
    # it is an interactive item, not a truncated text article.
    if body.select_one(
        ".axios-visual-apple-fallback-image, "
        ".axios-visual-newsletter-fallback-image"
    ):
        return ContentType.INTERACTIVE
    iframes = body.select("iframe[src]")
    if not iframes:
        return None
    sources = " ".join(
        str(iframe.get("src") or "").casefold()
        for iframe in iframes
    )
    if any(
        marker in sources
        for marker in (
            "jwplatform.",
            "youtube.com/",
            "youtu.be/",
            "vimeo.com/",
            "brightcove.",
        )
    ):
        return ContentType.VIDEO
    return ContentType.INTERACTIVE


from jojo_news_archive.parsing.parser_contracts import (
    BaseSourceParser,
    ImageParseContext,
    ParseContext,
)


class AxiosParser(BaseSourceParser):
    def preprocess(self, context: ParseContext) -> None:
        context.source_data["next_story"] = _axios_next_story(
            context.soup,
            canonical_url=context.canonical_url,
        )

    def select_body(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.body import (
            select_default_body as _select_default_body,
        )

        story = context.source_data.get("next_story")
        body = _axios_next_story_body(story) if isinstance(story, dict) else None
        context.body = _select_default_body(context, initial_body=body)

    def clean_body_before_noise(self, context: ParseContext) -> None:
        if context.clean_body is not None:
            _remove_axios_body_chrome(context.clean_body)

    def is_noise_node(
        self,
        context: ParseContext,
        node: Tag,
        text: str,
    ) -> bool:
        return len(text) >= 2 and set(text) == {"_"}

    def extract_metadata(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            first_text as _first_text,
            parse_datetime as _parse_datetime,
            string_or_none as _string_or_none,
        )

        story = context.source_data.get("next_story")
        if not isinstance(story, dict):
            return
        context.headline = _first_text(
            _string_or_none(story.get("headline")),
            context.headline,
        )
        context.description = _first_text(
            _string_or_none(story.get("og_description")),
            context.description,
        )
        published = _parse_datetime(_string_or_none(story.get("published_date")))
        if published is not None:
            context.published_at = published

    def classify_content(self, context: ParseContext) -> None:
        story_type = _axios_next_story_content_type(
            context.source_data.get("next_story")
        )
        if story_type is not None:
            context.content_type = story_type
        if context.clean_body is not None:
            embedded_type = _axios_embedded_content_type(context.clean_body)
            if embedded_type is not None:
                context.content_type = embedded_type

    def prepare_image(self, context: ImageParseContext) -> None:
        if any(
            marker in context.image_context.casefold()
            for marker in (
                "axios-visual-apple-fallback-image",
                "axios-visual-newsletter-fallback-image",
            )
        ):
            context.forced_role = ImageRole.CHART
            context.reasons.append("axios-visual-fallback")

    def image_identity(self, url: str) -> str | None:
        return _axios_image_identity(url)

    def is_placeholder_image_url(
        self,
        context: ParseContext,
        url: str,
    ) -> bool:
        return "axios-placeholder-" in unquote(url).casefold()

    def accepts_short_body(self, context: ParseContext) -> bool:
        return bool(
            super().accepts_short_body(context)
            or self._structured_short_record(context)
            or _axios_empty_newsletter_story(
                context.source_data.get("next_story")
            )
            or _axios_short_newsletter_story(
                context.source_data.get("next_story")
            )
            or (
                context.content_type == ContentType.INTERACTIVE
                and context.clean_body is not None
                and context.clean_body.select_one(
                    ".axios-visual-apple-fallback-image, "
                    ".axios-visual-newsletter-fallback-image"
                )
                is not None
            )
        )

    def short_body_warning(self, context: ParseContext) -> str | None:
        story = context.source_data.get("next_story")
        if _axios_empty_newsletter_story(story):
            return "structured-empty-newsletter"
        if _axios_short_newsletter_story(story):
            return "structured-short-newsletter"
        if self._structured_short_record(context):
            return "structured-short-record"
        return None

    @staticmethod
    def _structured_short_record(context: ParseContext) -> bool:
        if not context.headline:
            return False
        plain_text = context.plain_text
        page_text = _clean_text(
            context.soup.get_text(" ", strip=True)
        ).casefold()
        return bool(
            15 <= len(plain_text) < 100
            and context.news_article
            and page_text.count("axios on facebook") >= 2
            and "go deeper" in page_text
            and not re.search(r"(?:\.\.\.|…)\s*$", plain_text)
        )


PARSER: AxiosParser = AxiosParser()
