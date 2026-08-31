from __future__ import annotations

import re
from collections.abc import Callable
from urllib.parse import urlsplit

from bs4 import BeautifulSoup, NavigableString, Tag

from jojo_news_archive.models import CaptureProvider, RawCapture
from jojo_news_archive.parsing.limits import MINIMUM_SYNDICATED_BODY_CHARACTERS
from jojo_news_archive.parsing.parser_contracts import ParseContext
from jojo_news_archive.parsing.primitives import (
    clean_text,
    first_text,
    meta_content,
    tag_attribute,
)


def generic_syndication_allowed(context: ParseContext) -> bool:
    return bool(
        context.allow_generic_syndication
        or (
            context.raw_capture is not None
            and context.raw_capture.selected_candidate.provider
            == CaptureProvider.OTHER
        )
    )


def is_yahoo_syndication(
    soup: BeautifulSoup,
    *,
    raw_capture: RawCapture | None,
) -> bool:
    if raw_capture is not None:
        host = (urlsplit(raw_capture.final_url).hostname or "").casefold()
        if host == "yahoo.com" or host.endswith(".yahoo.com"):
            return True
    site_name = meta_content(soup, "property", "og:site_name")
    return bool(site_name and "yahoo" in site_name.casefold())


def yahoo_syndication_body(
    soup: BeautifulSoup,
    *,
    stop_at_reporting_by: bool,
    skipped_list_headings: frozenset[str] = frozenset(),
) -> Tag | None:
    primary_article = soup.select_one("article")
    if primary_article is None:
        return None
    paragraphs = [
        paragraph
        for paragraph in primary_article.select("p")
        if paragraph.find_parent("article") is primary_article
    ]
    if not paragraphs:
        return None
    wrapper_document = BeautifulSoup(
        "<div data-jojo-source='yahoo-syndication'></div>",
        "html.parser",
    )
    wrapper = wrapper_document.select_one("div")
    if wrapper is None:
        return None
    skipping_list_section = False
    for paragraph in paragraphs:
        paragraph_text = clean_text(paragraph.get_text(" ", strip=True))
        if paragraph_text.casefold() in skipped_list_headings:
            skipping_list_section = True
            continue
        if skipping_list_section:
            if paragraph.find_parent(("ul", "ol")) is not None:
                continue
            skipping_list_section = False
        ancestor_classes = " ".join(
            " ".join(parent.get("class", []))
            for parent in paragraph.parents
            if isinstance(parent, Tag)
        ).casefold()
        if (
            paragraph.find_parent(("header", "button", "nav", "footer"))
            or paragraph.select_one("button") is not None
            or any(
                marker in ancestor_classes
                for marker in ("key-takeaway", "yahoo-scout")
            )
        ):
            continue
        copy = BeautifulSoup(str(paragraph), "html.parser").select_one("p")
        if copy is not None:
            wrapper.append(copy)
        if stop_at_reporting_by and re.match(
            r"^\s*\((?:additional )?reporting by\b",
            paragraph_text,
            re.IGNORECASE,
        ):
            break
    return wrapper if wrapper.select_one("p") is not None else None


def generic_syndication_body(
    soup: BeautifulSoup,
    *,
    partner_noise_cleaner: Callable[[Tag, BeautifulSoup], None] | None = None,
) -> Tag | None:
    partner_url = first_text(
        meta_content(soup, "property", "og:url"),
        tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    partner_hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if (
        partner_hostname == "mql5.com"
        or partner_hostname.endswith(".mql5.com")
    ):
        # MQL5 wraps navigation, recommendations, and both sidebars in the
        # outer article element. Only this nested content node is the
        # syndicated report.
        node = soup.select_one(
            ".postContent.view > .container > .content"
        )
        if isinstance(node, Tag):
            document = BeautifulSoup(str(node), "html.parser")
            copy = document.select_one(".content")
            if isinstance(copy, Tag) and len(
                clean_text(copy.get_text(" ", strip=True))
            ) >= MINIMUM_SYNDICATED_BODY_CHARACTERS:
                for link in list(copy.select("a[href*='/signals/']")):
                    link.decompose()
                # MQL5 stores each prose paragraph as a direct child ``div``.
                # Normalize those nodes so the common block extractor keeps
                # their text and any inline article image.
                for child in copy.find_all("div", recursive=False):
                    child.name = "p"
                return copy
    if (
        partner_hostname == "investinglive.com"
        or partner_hostname.endswith(".investinglive.com")
    ):
        # Migrated InvestingLive URLs can retain the historical headline and
        # publication date while omitting the old article body entirely. The
        # remaining ``article`` element is then only current "Most Popular"
        # and broker-advertising chrome, which must not be accepted as the
        # historical report.
        for node in soup.select(
            "[class*='articleContent' i], [class*='expandedContent' i]"
        ):
            document = BeautifulSoup(str(node), "html.parser")
            copy = document.find(node.name)
            if not isinstance(copy, Tag):
                continue
            paragraphs = [
                clean_text(paragraph.get_text(" ", strip=True))
                for paragraph in copy.select("p")
            ]
            if (
                len([value for value in paragraphs if value]) >= 2
                and sum(len(value) for value in paragraphs)
                >= MINIMUM_SYNDICATED_BODY_CHARACTERS
            ):
                return copy
        placeholder = BeautifulSoup(
            "<div data-jojo-source='investinglive-empty-migration'></div>",
            "html.parser",
        )
        return placeholder.div
    selectors = (
        "[itemprop='articleBody']",
        ".news__body__center__article",
        ".article-text",
        ".post-content",
        ".article-content",
        ".entry-content",
        ".article-body",
        ".story-body",
        "[class*='article-body' i]",
        "[class*='story-body' i]",
        "article",
        "main",
    )
    for selector in selectors:
        for node in soup.select(selector):
            document = BeautifulSoup(str(node), "html.parser")
            copy = document.select_one(selector)
            if copy is None:
                copy = document.find(node.name)
            if not isinstance(copy, Tag):
                continue
            if (
                partner_hostname == "blogspot.com"
                or partner_hostname.endswith(".blogspot.com")
            ):
                # Blogger permits substantive prose as a direct text node
                # after a blockquote. The common block extractor intentionally
                # ignores loose text, so normalize only substantial direct
                # nodes into paragraphs before extracting the licensed copy.
                for child in list(copy.children):
                    if not isinstance(child, NavigableString):
                        continue
                    if len(clean_text(str(child))) < 40:
                        continue
                    paragraph = document.new_tag("p")
                    child.wrap(paragraph)
            for noise in copy.select(
                "aside, header, nav, footer, form, button, "
                "[class*='recommend' i], [class*='related' i], "
                "[class*='newsletter' i], [class*='advert' i], "
                "[class*='subscription' i], [class*='get-app' i], "
                "[class*='whatsapp-group' i], "
                "[class*='content-loader' i], .lazy-widgets, "
                ".watchOrListen-bottom-section-v3, .liveEventMain_widget, "
                ".primeSWrapper, .ts-dots, .bottomTopics, "
                ".topicListContainer, .topicListTitle, .tags, "
                "[id^='views-bootstrap-article-node-view-block-'], "
                "[data-animation-role='button'], "
                "[data-content-field='tags']"
            ):
                noise.decompose()
            for control in list(copy.select("[role='button']")):
                if control.name == "a" and control.select_one("img") is not None:
                    control.unwrap()
                else:
                    control.decompose()
            if partner_noise_cleaner is not None:
                partner_noise_cleaner(copy, soup)
            paragraphs = [
                clean_text(paragraph.get_text(" ", strip=True))
                for paragraph in copy.select("p")
            ]
            body_characters = sum(
                len(paragraph) for paragraph in paragraphs if paragraph
            )
            if len([value for value in paragraphs if value]) >= 2 and (
                body_characters
                >= MINIMUM_SYNDICATED_BODY_CHARACTERS
            ):
                return copy
    return None




def postmedia_syndication_body(soup: BeautifulSoup) -> Tag | None:
    """Join Postmedia's paragraph-per-section body without page widgets."""
    paragraphs = soup.select(
        "article.story-v2-article-content-story "
        ".story-v2-content-element-inline > p"
    )
    substantive = [
        paragraph
        for paragraph in paragraphs
        if clean_text(paragraph.get_text(" ", strip=True))
    ]
    if len(substantive) < 2 or sum(
        len(clean_text(paragraph.get_text(" ", strip=True)))
        for paragraph in substantive
    ) < MINIMUM_SYNDICATED_BODY_CHARACTERS:
        return None
    document = BeautifulSoup(
        "<div data-jojo-source='postmedia-syndication'></div>",
        "html.parser",
    )
    wrapper = document.select_one("div")
    if not isinstance(wrapper, Tag):
        return None
    for paragraph in substantive:
        copy = BeautifulSoup(str(paragraph), "html.parser").select_one("p")
        if isinstance(copy, Tag):
            wrapper.append(copy)
    return wrapper
