from __future__ import annotations

import html as html_module
import re
from urllib.parse import unquote, urlsplit, urlunsplit
from bs4 import BeautifulSoup, Tag
from jojo_news_archive.parsing.primitives import (
    clean_text as _clean_text,
    first_text as _first_text,
    json_ld_objects as _json_ld_objects,
    meta_content as _meta_content,
    string_or_none as _string_or_none,
    tag_attribute as _tag_attribute,
)
from jojo_news_archive.parsing.limits import (
    MINIMUM_BODY_CHARACTERS as _MINIMUM_BODY_CHARACTERS,
)


def _promote_reuters_image_candidates(candidates: list[str]) -> list[str]:
    """Prefer a full-size rendition for Reuters' legacy lazy image endpoint."""
    promoted: list[str] = []
    for url in candidates:
        parts = urlsplit(url)
        if (
            parts.hostname
            and parts.hostname.casefold().endswith("reutersmedia.net")
            and parts.path == "/resources/r/"
        ):
            high_resolution = re.sub(
                r"([?&]w=)(?:[1-9]\d{0,2}|1[01]\d{2})(?=&|$)",
                r"\g<1>1200",
                url,
                flags=re.IGNORECASE,
            )
            if high_resolution != url and high_resolution not in promoted:
                promoted.append(high_resolution)
        if (
            (parts.hostname or "").casefold() == "img.ksl.com"
            and re.search(
                r"(?:^|&)filter=ksl/(?:\d+x\d+|100x100)(?:&|$)",
                parts.query,
                re.IGNORECASE,
            )
        ):
            full_size = urlunsplit(
                (parts.scheme, parts.netloc, parts.path, "", "")
            )
            if full_size not in promoted:
                promoted.append(full_size)
        if url not in promoted:
            promoted.append(url)
    return promoted


def _reuters_image_identity(url: str) -> str | None:
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    if host.endswith("reutersmedia.net") and parts.path == "/resources/r/":
        legacy_id = re.search(
            r"(?:^|&)i=(\d+)(?:&|$)",
            parts.query,
            flags=re.IGNORECASE,
        )
        if legacy_id is not None:
            return f"reuters-image:{legacy_id.group(1)}"
    if host == "img.ksl.com":
        return urlunsplit(
            (
                parts.scheme.casefold(),
                parts.netloc.casefold(),
                parts.path,
                "",
                "",
            )
        )
    return None


def _reuters_legacy_article_body(soup: BeautifulSoup) -> Tag | None:
    """Convert Reuters' pre-2011 BR-delimited articleText into paragraphs."""
    source = soup.select_one("#articleText")
    if not isinstance(source, Tag):
        return None
    if source.select_one("#div_with_disclaimer_id"):
        document = BeautifulSoup(str(source), "html.parser")
        cleaned_source = document.select_one("#articleText")
        if isinstance(cleaned_source, Tag):
            source = cleaned_source
            for disclaimer in source.select("#div_with_disclaimer_id"):
                disclaimer.decompose()
    text = _clean_text(source.get_text(" ", strip=True))
    if len(text) < _MINIMUM_BODY_CHARACTERS:
        return None
    if source.select_one("#bwbodyimg:has(img)"):
        document = BeautifulSoup(str(source), "html.parser")
        preserved = document.select_one("#articleText")
        if isinstance(preserved, Tag):
            return preserved
    fragments = re.split(
        r"(?:<br\s*/?>\s*){2,}",
        source.decode_contents(),
        flags=re.IGNORECASE,
    )
    paragraphs = [
        _clean_text(
            BeautifulSoup(fragment, "html.parser").get_text(" ")
            if "<" in fragment
            else html_module.unescape(fragment)
        )
        for fragment in fragments
    ]
    paragraphs = [
        paragraph
        for paragraph in paragraphs
        if paragraph
        and not re.fullmatch(
            r"(?i)(?:editing by|reporting by)\b.*",
            paragraph,
        )
    ]
    if not paragraphs:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for value in paragraphs:
        paragraph = document.new_tag("p")
        paragraph.string = value
        article.append(paragraph)
    return article


def _reuters_live_blog_body(soup: BeautifulSoup) -> Tag | None:
    posting = next(
        (
            value
            for value in _json_ld_objects(soup)
            if value.get("@type") == "LiveBlogPosting"
        ),
        None,
    )
    if posting is None:
        return None
    updates = posting.get("liveBlogUpdate")
    if not isinstance(updates, list):
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    seen: set[tuple[str, str]] = set()
    for update in updates:
        if not isinstance(update, dict):
            continue
        headline = _string_or_none(update.get("headline"))
        raw_body = _string_or_none(update.get("articleBody"))
        body_text = (
            _clean_text(
                BeautifulSoup(raw_body, "html.parser").get_text(" ")
            )
            if raw_body
            else None
        )
        if body_text:
            body_text = re.sub(
                r"(?<=[a-z0-9)])(?=[A-Z](?:[a-z]{2,}|['’][a-z]))",
                ". ",
                body_text,
            )
            body_text = re.sub(
                r"(?i)\s*Trouble viewing video posts\?.*cookie settings\s*$",
                "",
                body_text,
            ).strip()
        if not headline and not body_text:
            continue
        identity = (headline or "", body_text or "")
        if identity in seen:
            continue
        seen.add(identity)
        if headline:
            heading = document.new_tag("h2")
            heading.string = headline
            article.append(heading)
        if body_text:
            paragraph = document.new_tag("p")
            paragraph.string = body_text
            article.append(paragraph)
    return article if len(article.get_text(" ", strip=True)) >= 80 else None


def _remove_reuters_promos(soup: BeautifulSoup) -> None:
    """Remove Reuters registration UI and licensed-partner subscription tails."""
    # Reuters statbox/live-score templates occasionally leave a form control
    # inside the article body. It is interface chrome, not editorial content.
    for node in list(soup.select("input")):
        node.decompose()
    for node in list(
        soup.select(
            ".rich-share, [data-testid='rich-share'], "
            ".Image_expand-button, .Slideshow_expand-button, "
            "[aria-label='Expand Image Slideshow'], "
            ".share-icon-container, #jMore-PopUp"
        )
    ):
        node.decompose()

    for button in list(soup.select("button")):
        classes = " ".join(button.get("class") or []).casefold()
        if "socialtools" in classes:
            button.decompose()
        else:
            button.unwrap()

    for node in list(
        soup.select(
            "[class*='pagination-v2__container' i][role='button'], "
            "a[role='button']"
        )
    ):
        node.decompose()
    for node in list(soup.select("[role='button']")):
        node.attrs.pop("role", None)
        node.attrs.pop("tabindex", None)

    for marker in list(soup.select("[data-testid^='paragraph-']")):
        if _clean_text(marker.get_text(" ", strip=True)).casefold() != "read more:":
            continue
        candidates: list[Tag] = [marker]
        sibling = marker.find_next_sibling()
        boundary_found = False
        while isinstance(sibling, Tag) and len(candidates) <= 6:
            text = _clean_text(sibling.get_text(" ", strip=True)).casefold()
            if text.startswith(("reporting by ", "editing by ")):
                boundary_found = True
                break
            candidates.append(sibling)
            sibling = sibling.find_next_sibling()
        if not boundary_found:
            continue
        for node in candidates:
            node.decompose()

    for node in list(soup.select("p, div, span")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(r"[_^]{3,}", text):
            node.decompose()

    for node in list(soup.select("p, h2, h3, h4, h5, h6")):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if text in {"share this article", "whatsapp print pdf"}:
            node.decompose()
        elif text.startswith(
            "register now for free unlimited access to reuters.com"
        ) or text.startswith(
            "the company and law firm names shown above are generated "
            "automatically based on the text of the article"
        ) or re.fullmatch(
            r"subscribe to our channels on youtube\s*,\s*telegram\s*&\s*whatsapp\s*[.!]?",
            text,
        ):
            node.decompose()

    wire_copyright_suffix = re.compile(
        r"""(?ix)\s*(?:"""
        r"""copyright(?:\s+(?:19|20)\d{2})?\s*,?\s*"""
        r"""business\s+wire(?:\s+(?:19|20)\d{2})?"""
        r"""(?:\s*[,.:;-]\s*|\s+)"""
        r"""all\s+rights\s+reserved\.?\s*(?:-0-)?"""
        r"""|"""
        r"""copyright\s+business\s+wire\s+\d{4}"""
        r"""|"""
        r"""copyright\s+\d{4},\s*market\s+wire,\s*"""
        r"""all\s+rights\s+reserved\.\s*-0-"""
        r""")\s*$"""
    )
    for text_node in list(soup.find_all(string=wire_copyright_suffix)):
        cleaned = wire_copyright_suffix.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    legacy_legal_suffix = re.compile(
        r"""(?is)\s*(?:"""
        r"""(?:keywords:\s*)?[^\n]{0,500}?"""
        r"""\(c\)\s*reuters\s+(?:19|20)\d{2}\.\s*"""
        r"""all\s+rights\s+reserved\..*$"""
        r"""|"""
        r"""(?:copyright(?:\s+copyright)?|©|ï¿½)\s*(?:©\s*)?"""
        r"""(?:19|20)\d{2}[\s,.][^\n]{0,750}?"""
        r"""all\s+rights\s+reserved\.?.*$"""
        r""")\s*$"""
    )
    for text_node in list(soup.find_all(string=legacy_legal_suffix)):
        cleaned = legacy_legal_suffix.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    marker = next(
        (
            node
            for node in soup.select("p")
            if _clean_text(node.get_text(" ", strip=True))
            .casefold()
            .startswith("already a subscriber? log in")
        ),
        None,
    )
    if not isinstance(marker, Tag):
        return
    top = soup.find()
    if not isinstance(top, Tag):
        return
    tail = marker
    while isinstance(tail.parent, Tag):
        for sibling in list(tail.next_siblings):
            if isinstance(sibling, Tag):
                sibling.decompose()
            else:
                sibling.extract()
        if tail.parent is top:
            break
        tail = tail.parent
    marker.decompose()


def _trim_reuters_recirculation_tail(soup: BeautifulSoup) -> None:
    """Drop modern Reuters recommendation modules appended inside body."""
    markers = list(
        soup.select(
            "[data-testid='Latest Updates'], "
            "[data-variant-id='article-latest-updates'], "
            "[class*='read-next-mobile__container']"
        )
    )
    for node in soup.select("p, div"):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if text.startswith(
            "our standards: the thomson reuters trust principles"
        ):
            markers.append(node)
    for node in soup.select("p"):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(r"<\^{10,}", text):
            markers.append(node)
            continue
        if (
            text.casefold() != "read more:"
        ):
            continue
        following_paragraphs = [
            sibling
            for sibling in node.find_next_siblings("p")
            if _clean_text(sibling.get_text(" ", strip=True))
        ]
        if len(following_paragraphs) >= 2:
            markers.append(node)
    if not markers:
        return
    top = soup.find()
    if not isinstance(top, Tag):
        return
    marker_ids = {id(marker) for marker in markers}
    marker = next(
        (
            node
            for node in top.descendants
            if isinstance(node, Tag) and id(node) in marker_ids
        ),
        None,
    )
    if not isinstance(marker, Tag):
        return
    tail = marker
    while isinstance(tail.parent, Tag):
        for sibling in list(tail.next_siblings):
            if isinstance(sibling, Tag):
                sibling.decompose()
            else:
                sibling.extract()
        if tail.parent is top:
            break
        tail = tail.parent
    marker.decompose()


def _normalize_reuters_legacy_press_release_media(
    soup: BeautifulSoup,
) -> None:
    """Restore Business Wire media nested inside one legacy body paragraph."""
    for media in list(soup.select("p > #bwbodyimg:has(img)")):
        paragraph = media.parent
        if not isinstance(paragraph, Tag) or paragraph.name != "p":
            continue

        before = BeautifulSoup("<p></p>", "html.parser").p
        after = BeautifulSoup("<p></p>", "html.parser").p
        if not isinstance(before, Tag) or not isinstance(after, Tag):
            continue

        before_nodes = list(media.previous_siblings)
        after_nodes = list(media.next_siblings)
        for node in before_nodes:
            before.append(node.extract())
        for node in after_nodes:
            after.append(node.extract())

        media.extract()
        media.name = "figure"
        caption = media.find("p")
        if isinstance(caption, Tag):
            caption.name = "figcaption"
            caption_text = _clean_text(caption.get_text(" ", strip=True))
            parenthetical_credit = re.fullmatch(
                r"(.+?)\s*\(((?:photographer|photo|credit|"
                r"illustration|graphic)s?\s*:\s*.+)\)",
                caption_text,
                flags=re.IGNORECASE,
            )
            if parenthetical_credit is not None:
                caption.string = (
                    f"{parenthetical_credit.group(1)}\n"
                    f"{parenthetical_credit.group(2)}"
                )

        if _clean_text(before.get_text(" ", strip=True)):
            paragraph.insert_before(before)
        paragraph.insert_before(media)
        if _clean_text(after.get_text(" ", strip=True)):
            paragraph.insert_before(after)
        paragraph.decompose()


from jojo_news_archive.parsing.parser_contracts import (
    BaseSourceParser,
    ImageParseContext,
    ParseContext,
)


def _clean_reuters_syndication_partner_noise(
    body: Tag,
    source_document: BeautifulSoup,
) -> None:
    partner_url = _first_text(
        _meta_content(source_document, "property", "og:url"),
        _tag_attribute(
            source_document.select_one("link[rel='canonical']"),
            "href",
        ),
    )
    hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if hostname == "benzinga.com" or hostname.endswith(".benzinga.com"):
        marker = next(
            (
                node
                for node in body.select("p, h2, h3, h4")
                if re.match(
                    r"(?i)^(?:see also|read next)\s*:",
                    _clean_text(node.get_text(" ", strip=True)),
                )
            ),
            None,
        )
        if isinstance(marker, Tag):
            tail = marker
            while isinstance(tail.parent, Tag):
                for sibling in list(tail.next_siblings):
                    if isinstance(sibling, Tag):
                        sibling.decompose()
                    else:
                        sibling.extract()
                if tail.parent is body:
                    break
                tail = tail.parent
            marker.decompose()
    if hostname == "bnnbloomberg.ca" or hostname.endswith(
        ".bnnbloomberg.ca"
    ):
        for node in list(body.select("p, li, ul, ol")):
            if (
                _clean_text(node.get_text(" ", strip=True)).casefold()
                == "latest updates on company news here"
            ):
                node.decompose()
    if (
        hostname == "marketscreener.com"
        or hostname.endswith(".marketscreener.com")
        or hostname == "zonebourse.com"
        or hostname.endswith(".zonebourse.com")
    ):
        for node in list(body.select("p")):
            text = _clean_text(node.get_text(" ", strip=True))
            if not re.fullmatch(r"[.,;:!?]+", text):
                continue
            previous = node.find_previous_sibling("p")
            if not isinstance(previous, Tag):
                node.decompose()
                continue
            previous_text = _clean_text(previous.get_text(" ", strip=True)).rstrip()
            previous.clear()
            previous.append(f"{previous_text}{text}")
            node.decompose()


class ReutersParser(BaseSourceParser):
    def select_body(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.body import (
            select_default_body as _select_default_body,
        )
        from jojo_news_archive.parsing.syndication import (
            is_yahoo_syndication as _is_yahoo_syndication,
            yahoo_syndication_body as _yahoo_syndication_body,
        )

        body = None
        if _is_yahoo_syndication(context.soup, raw_capture=context.raw_capture):
            body = _yahoo_syndication_body(
                context.soup,
                stop_at_reporting_by=True,
            )
        body = _select_default_body(
            context,
            initial_body=body,
            partner_noise_cleaner=_clean_reuters_syndication_partner_noise,
        )
        live_blog = _reuters_live_blog_body(context.soup)
        if live_blog is not None:
            body = live_blog
        else:
            modern = context.soup.select_one(
                "#rcs-articleContent #article-text"
            )
            if isinstance(modern, Tag):
                body = modern
            legacy = _reuters_legacy_article_body(context.soup)
            if legacy is not None:
                body = legacy
        context.body = body

    def clean_body_before_noise(self, context: ParseContext) -> None:
        if context.clean_body is not None:
            _trim_reuters_recirculation_tail(context.clean_body)

    def is_noise_node(
        self,
        context: ParseContext,
        node: Tag,
        text: str,
    ) -> bool:
        return text in {
            "subscribe to gift this article",
            "gift 5 articles to anyone you choose each month when you subscribe.",
            "already a subscriber?",
            "read more",
            "fetching latest articles",
        }

    def clean_body_after_noise(self, context: ParseContext) -> None:
        if context.clean_body is None:
            return
        _remove_reuters_promos(context.clean_body)
        _normalize_reuters_legacy_press_release_media(context.clean_body)

    def prepare_image(self, context: ImageParseContext) -> None:
        context.candidates = _promote_reuters_image_candidates(
            context.candidates
        )
        if context.caption:
            context.caption = re.sub(
                r"(?i)\s*purchase\s+licensing\s+rights\s*,?\s*"
                r"opens\s+new\s+tab\s*$",
                "",
                context.caption,
            ).rstrip() or None

    def image_identity(self, url: str) -> str | None:
        return _reuters_image_identity(url)

    def transform_lead_image_urls(
        self,
        context: ParseContext,
        urls: list[str],
    ) -> list[str]:
        return _promote_reuters_image_candidates(urls)

    def is_placeholder_image_url(
        self,
        context: ParseContext,
        url: str,
    ) -> bool:
        decoded = unquote(url).casefold()
        return any(
            marker in decoded
            for marker in (
                # MarketScreener uses this generic social card for both
                # Bloomberg and Reuters syndication pages.
                "twitter_ms_fdnoir.png",
                "/defaultpromocrop.",
                "/rcom-default.png",
                "/reuters-default.png",
                "/r-generic-hdr.png",
                "/images/reuters.jpg",
                "twitter_ms_fdnoir.png",
            )
        )

    def accepts_short_body(self, context: ParseContext) -> bool:
        return bool(
            super().accepts_short_body(context)
            or self._structured_short_record(context)
        )

    def short_body_warning(self, context: ParseContext) -> str | None:
        return (
            "structured-short-record"
            if self._structured_short_record(context)
            else None
        )

    @staticmethod
    def _structured_short_record(context: ParseContext) -> bool:
        headline = context.headline
        if not headline:
            return False
        combined = f"{headline}\n{context.plain_text}".casefold()
        return bool(
            len(context.plain_text) >= 40
            and (
                headline.casefold().startswith("brief-")
                or re.match(r"(?i)^标题新闻[：:]", headline)
                or "路透中文快讯将暂不做进一步报导" in combined
            )
        )


PARSER: ReutersParser = ReutersParser()
