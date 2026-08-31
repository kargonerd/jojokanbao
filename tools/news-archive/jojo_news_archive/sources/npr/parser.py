from __future__ import annotations

import copy
import json
import re
from urllib.parse import parse_qsl, unquote, urlsplit
from bs4 import BeautifulSoup, Tag
from jojo_news_archive.models import BlockType, ContentBlock, ContentType, ImageCandidate
from jojo_news_archive.parsing.primitives import (
    caption_credit as _caption_credit,
    clean_text as _clean_text,
    first_text as _first_text,
    meta_content as _meta_content,
    normalized_url as _normalized_url,
    tag_text as _tag_text,
)
from jojo_news_archive.parsing.limits import (
    MINIMUM_BODY_CHARACTERS as _MINIMUM_BODY_CHARACTERS,
)


def _promote_npr_image_candidates(candidates: list[str]) -> list[str]:
    """Prefer NPR's full ``data-original`` asset over legacy crops."""
    indexed = list(enumerate(candidates))
    indexed.sort(
        key=lambda item: (
            bool(
                re.search(
                    r"-s\d+-c\d+(?=\.(?:gif|jpe?g|png|webp)$)",
                    urlsplit(item[1]).path,
                    flags=re.IGNORECASE,
                )
            ),
            item[0],
        )
    )
    return [url for _, url in indexed]


def _npr_audio_story_nodes(soup: BeautifulSoup) -> list[Tag]:
    """Return story-level players without matching NPR's global live audio."""
    result: list[Tag] = []
    for node in soup.select(
        "#primaryaudio, #headlineaudio, article.resaudio, .audio-module, "
        "#storyspan02 .bucketwrap.primary"
    ):
        if not isinstance(node, Tag):
            continue
        legacy_primary = (
            "bucketwrap" in {
                str(value).casefold()
                for value in (node.get("class") or [])
            }
            and node.find_parent(id="storyspan02") is not None
        )
        if legacy_primary and (
            node.select_one(".avcontent.listen") is None
            or node.select_one(
                ".avcontent.listen a[href*='NPR.Player.openPlayer'], "
                ".audiotools a.download[href]"
            )
            is None
        ):
            continue
        result.append(node)
    return result


def _npr_legacy_transcript_body(
    soup: BeautifulSoup,
    *,
    selected_body: Tag | None,
) -> Tag | None:
    """Prefer NPR's complete legacy transcript over its short teaser."""
    transcript = soup.select_one(".transcript")
    if not isinstance(transcript, Tag) or transcript.select_one("p") is None:
        return None
    transcript_characters = len(
        _clean_text(transcript.get_text(" ", strip=True))
    )
    selected_characters = len(
        _clean_text(selected_body.get_text(" ", strip=True))
        if selected_body is not None
        else ""
    )
    if (
        transcript_characters < _MINIMUM_BODY_CHARACTERS
        or transcript_characters < selected_characters + 250
        or transcript_characters < selected_characters * 2
    ):
        return None
    return transcript


def _npr_legacy_election_results_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Preserve AP-backed result feeds from NPR's 2010 election pages."""
    scripts = [
        node
        for node in soup.select(
            "#storyspan03 .elexResultsTable "
            "script[src*='hosted.ap.org/dynamic/files/elections/' i]"
        )
        if isinstance(node, Tag)
    ]
    if not scripts:
        return None
    document = BeautifulSoup(
        "<article data-jojo-source='npr-legacy-election-results'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None
    for selector in ("#storytext p", "#storyspan03 .listtext p"):
        for paragraph in soup.select(selector):
            copy = BeautifulSoup(str(paragraph), "html.parser").find()
            if isinstance(copy, Tag):
                article.append(copy)
    previous_heading = ""
    for index, script in enumerate(scripts, start=1):
        heading = script.find_previous("h2")
        heading_text = _clean_text(
            heading.get_text(" ", strip=True)
            if isinstance(heading, Tag)
            else "Election"
        )
        if heading_text and heading_text != previous_heading:
            heading_copy = document.new_tag("h2")
            heading_copy.string = heading_text
            article.append(heading_copy)
            previous_heading = heading_text
        source_url = _normalized_url(
            str(script.get("src") or ""),
            base_url=canonical_url,
        )
        if not source_url:
            continue
        embed = document.new_tag("iframe")
        embed["src"] = source_url
        embed["title"] = f"{heading_text or 'Election'} results data {index}"
        embed["data-interactive-provider"] = "npr-ap-election-results"
        article.append(embed)
    return article if article.select_one("iframe[src]") is not None else None


def _npr_legacy_book_list_body(
    soup: BeautifulSoup,
    *,
    selected_body: Tag | None,
) -> Tag | None:
    """Recover reviews stored outside #storytext by NPR's book template."""
    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    source = soup.select_one("#storyspan03 .bucketwrap.booklist")
    if (
        "tmplbookstory" not in body_classes
        or not isinstance(source, Tag)
        or len(source.select(".booklistitem")) < 2
    ):
        return None
    source_characters = len(_clean_text(source.get_text(" ", strip=True)))
    selected_characters = len(
        _clean_text(selected_body.get_text(" ", strip=True))
        if selected_body is not None
        else ""
    )
    if source_characters < 500 or source_characters < selected_characters * 2:
        return None
    document = BeautifulSoup(
        "<article data-jojo-source='npr-legacy-book-list'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None
    if selected_body is not None:
        for paragraph in selected_body.select("p"):
            copy = BeautifulSoup(str(paragraph), "html.parser").find()
            if isinstance(copy, Tag):
                article.append(copy)
    book_list = BeautifulSoup(str(source), "html.parser").find()
    if not isinstance(book_list, Tag):
        return None
    for noise in book_list.select(
        ".ecommercepop, .purchaseLink, .internallink, h5, a[name]"
    ):
        noise.decompose()
    for edition in book_list.select(".bookedition"):
        edition.name = "p"
    for bullet in book_list.select(".bull"):
        bullet.decompose()
    article.append(book_list)
    return article


def _npr_legacy_gallery_body(soup: BeautifulSoup) -> Tag | None:
    """Recover the archived lead image from NPR's pre-HTML5 slideshows."""
    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    if "tmplnewsmultimedia" not in body_classes:
        return None
    slideshow = soup.select_one("div[id^='slideshow']")
    if (
        not isinstance(slideshow, Tag)
        or slideshow.select_one("img[src]") is None
    ):
        return None
    return slideshow


def _npr_legacy_flash_interactive_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Normalize NPR's pre-HTML5 Flash interactive and live-video pages."""
    story = soup.select_one("#storytext")
    supplemental = soup.select_one(
        "#supplementarycontent .bucketwrap.statichtml"
    )
    legacy_embed = (
        supplemental.select_one("object embed[src], embed[src]")
        if isinstance(supplemental, Tag)
        else None
    )
    story_characters = len(
        _clean_text(story.get_text(" ", strip=True))
        if isinstance(story, Tag)
        else ""
    )
    if (
        isinstance(story, Tag)
        and isinstance(legacy_embed, Tag)
        and 20 <= story_characters <= 500
    ):
        swf_url = _normalized_url(
            str(legacy_embed.get("src") or ""),
            base_url=canonical_url,
        )
        if swf_url:
            document = BeautifulSoup(
                "<article data-jojo-source='npr-legacy-flash-video'></article>",
                "html.parser",
            )
            article = document.article
            if isinstance(article, Tag):
                for child in list(story.contents):
                    copy = BeautifulSoup(str(child), "html.parser").find()
                    if isinstance(copy, Tag):
                        article.append(copy)
                iframe = document.new_tag("iframe")
                iframe["src"] = swf_url
                iframe["title"] = "Archived NPR live video"
                iframe["data-interactive-provider"] = "npr-flash-video"
                article.append(iframe)
                return article

    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    if not body_classes.intersection(
        {"tmplmusicmultimedia", "tmplnewsmultimedia"}
    ):
        return None
    source = soup.select_one(
        "#storyspan03 .bucketwrap[class*='graphic' i] > .bucket"
        if "tmplmusicmultimedia" in body_classes
        else ".bucketwrap.interactive[class*='graphic' i] > .bucket"
    )
    if not isinstance(source, Tag):
        return None
    graphic = source.select_one(".graphicwrapper")
    if not isinstance(graphic, Tag) or graphic.select_one("img[src]") is None:
        return None
    swf_url: str | None = None
    for script in source.select("script"):
        payload = script.string or script.get_text()
        if "SWFObject" not in payload or "theswf" not in payload:
            continue
        match = re.search(
            r"(?i)addVariable\(\s*['\"]theswf['\"]\s*,\s*"
            r"['\"]([^'\"]+\.swf(?:\?[^'\"]*)?)['\"]",
            payload,
        )
        if match:
            swf_url = _normalized_url(
                match.group(1),
                base_url=canonical_url,
            )
            break
    if not swf_url:
        return None

    document = BeautifulSoup(
        "<article data-jojo-source='npr-legacy-flash-interactive'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None
    description = next(
        (
            child
            for child in source.find_all("p", recursive=False)
            if _clean_text(child.get_text(" ", strip=True))
        ),
        None,
    )
    if isinstance(description, Tag):
        article.append(
            BeautifulSoup(str(description), "html.parser").find()
        )
    fallback = graphic.select_one("img[src]")
    if isinstance(fallback, Tag):
        figure = document.new_tag("figure")
        figure.append(BeautifulSoup(str(fallback), "html.parser").find())
        article.append(figure)
    iframe = document.new_tag("iframe")
    iframe["src"] = swf_url
    iframe["title"] = _first_text(
        _tag_text(source.select_one("h3")),
        "Archived NPR interactive",
    )
    iframe["data-interactive-provider"] = "npr-flash"
    article.append(iframe)
    credit = source.select_one(":scope > .footer p")
    if isinstance(credit, Tag):
        article.append(BeautifulSoup(str(credit), "html.parser").find())
    return article


def _npr_legacy_iframe_interactive_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Recover iframe-led interactives from NPR's legacy multimedia page."""
    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    if "tmplnewsmultimedia" not in body_classes:
        return None
    source = soup.select_one("#storyspan03 .bucketwrap.statichtml")
    iframe = (
        source.select_one("iframe[src]")
        if isinstance(source, Tag)
        else None
    )
    if not isinstance(source, Tag) or not isinstance(iframe, Tag):
        return None
    embed_url = _normalized_url(
        str(iframe.get("src") or ""),
        base_url=canonical_url,
    )
    if not embed_url:
        return None

    document = BeautifulSoup(
        "<article data-jojo-source='npr-legacy-iframe-interactive'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None
    description = _first_text(
        _tag_text(soup.select_one("#storytext p")),
        _meta_content(soup, "name", "description"),
    )
    if description:
        paragraph = document.new_tag("p")
        paragraph.string = description
        article.append(paragraph)
    embed = document.new_tag("iframe")
    embed["src"] = embed_url
    embed["title"] = _first_text(
        _tag_text(soup.select_one(".storytitle h1")),
        "Archived NPR interactive",
    )
    embed["data-interactive-provider"] = "npr-legacy-iframe"
    article.append(embed)
    for selector in (":scope > .notes", ":scope > .footer"):
        node = source.select_one(selector)
        if isinstance(node, Tag):
            copy = BeautifulSoup(str(node), "html.parser").find()
            if isinstance(copy, Tag):
                article.append(copy)
    return article


def _npr_legacy_inline_interactive_body(
    soup: BeautifulSoup,
) -> Tag | None:
    """Recover pre-HTML5 NPR graphics and script-driven inline packages."""

    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    if "tmplnewsmultimedia" not in body_classes:
        return None

    graphic = soup.select_one(
        "#storyspan02 .bucketwrap[class*='graphic' i] > .bucket"
    )
    source: Tag | None = None
    if (
        isinstance(graphic, Tag)
        and graphic.select_one("img[src]") is not None
        and len(_clean_text(graphic.get_text(" ", strip=True))) >= 80
    ):
        source = graphic

    scripted = soup.select_one("#storyspan03 .bucketwrap.statichtml")
    if (
        source is None
        and isinstance(scripted, Tag)
        and scripted.select_one(
            "#pmPoll, .pmVideo, .pmPollWidget, script[src*='polldaddy' i]"
        )
        is not None
        and len(_clean_text(scripted.get_text(" ", strip=True))) >= 80
    ):
        source = scripted
    if source is None:
        return None

    document = BeautifulSoup(
        "<article data-jojo-source='npr-legacy-inline-interactive'></article>",
        "html.parser",
    )
    article = document.article
    copy = BeautifulSoup(str(source), "html.parser").find()
    if not isinstance(article, Tag) or not isinstance(copy, Tag):
        return None
    # These packages commonly use an H1 for essential directions inside the
    # graphic. Normal article extraction treats H1 as duplicate page chrome,
    # so normalize it to body prose before block extraction.
    for heading in copy.select("h1"):
        heading.name = "p"
    article.append(copy)
    return article


def _npr_legacy_cartoon_body(
    soup: BeautifulSoup,
    *,
    selected_body: Tag | None,
) -> Tag | None:
    """Join NPR's short Double Take teaser with its two primary cartoons."""
    selected_characters = len(
        _clean_text(selected_body.get_text(" ", strip=True))
        if selected_body is not None
        else ""
    )
    cartoons = [
        node
        for node in soup.select("div.bucketwrap.photo624")
        if isinstance(node, Tag) and node.select_one("img[src]") is not None
    ]
    page_title = _clean_text(
        soup.title.get_text(" ", strip=True) if soup.title is not None else ""
    ).casefold()
    double_take_page = bool(
        "double take" in page_title
        or soup.select_one(
            ".contentheader[data-metrics-category*='Double Take' i]"
        )
    )
    if len(cartoons) < 2 and double_take_page:
        cartoons = [
            node
            for node in soup.select(
                "#supplementarycontent > div.bucketwrap.image"
            )
            if isinstance(node, Tag)
            and node.select_one(".imagewrap img[src]") is not None
        ]
    if selected_characters >= 200 or len(cartoons) < 2:
        return None
    document = BeautifulSoup(
        "<div data-jojo-source='npr-legacy-cartoon'></div>",
        "html.parser",
    )
    wrapper = document.select_one("div")
    if not isinstance(wrapper, Tag):
        return None
    if selected_body is not None:
        for node in selected_body.select("p, h2, h3, h4"):
            if node.find_parent(("p", "h2", "h3", "h4")) is not None:
                continue
            copy = BeautifulSoup(str(node), "html.parser").find()
            if isinstance(copy, Tag):
                wrapper.append(copy)
    for cartoon in cartoons:
        copy = BeautifulSoup(str(cartoon), "html.parser").find()
        if isinstance(copy, Tag):
            wrapper.append(copy)
    return wrapper


def _npr_non_editorial_image_url(url: str) -> bool:
    path = urlsplit(url).path.casefold()
    return (
        "/chrome/news/nprlogo" in path
        or "/chrome/news/pbs_logo" in path
        or "/images/zag.gif" in path
        or "/include/images/facebook-default-wide" in path
        or "/chrome/news/video_generic_" in path
        or "/music/calendar/concert_calendar_" in path
        # Life Kit playlist artwork is a product/UI icon, not an image from
        # the story itself.  NPR occasionally exposes it through the article
        # image metadata (for example the 2024 "Boring Phone" story), where
        # the generic asset filters above cannot distinguish it from editorial
        # photography.
        or (
            "lifekit" in path
            and "playlist" in path
            and "icon" in path
        )
    )


def _remove_npr_body_chrome(soup: BeautifulSoup) -> None:
    """Remove controls embedded in NPR's legacy story-text container."""
    # The 2016-era ``#storytext`` stream interleaves two-column related-story
    # cards with the article paragraphs.  Their section slug, linked headline
    # and thumbnail otherwise become canonical body blocks/images (for
    # example ``Politics`` followed by a different story headline).
    for node in list(soup.select(".bucketwrap.internallink")):
        node.decompose()
    for bucket in list(soup.select(".bucketwrap.image")):
        image = bucket.select_one("img")
        if isinstance(image, Tag):
            caption, credit = _npr_caption_credit(bucket)
            if caption:
                image["data-jojo-npr-caption"] = caption
            if credit:
                image["data-jojo-npr-credit"] = credit
        for node in list(
            bucket.select(
                ".credit-caption, .enlarge_html, .captionwrap, "
                ".caption-wrap, .creditwrap"
            )
        ):
            node.decompose()
    for node in list(
        soup.select(
            ".dateblock, .textsize, [id^='featuredCommentsMain']"
        )
    ):
        node.decompose()
    # NPR's 2010-era story wrapper nests player menus, embed-code dialogs,
    # podcast subscription buttons and retailer forms alongside the prose.
    # Preserve editorial audio/book copy, but never serialize browser controls
    # into the canonical article body.
    for node in list(
        soup.select(
            ".audio-module-tools, .audio-embed-overlay, .audiotools, "
            "li.subscribe, .bucketwrap.ecommerce, .ecommerce, .ecomm_body, "
            "form, button, input"
        )
    ):
        node.decompose()
    for add_control in list(
        soup.select("a[href*='NPR.Player.Action.ADD_TO_PLAYLIST']")
    ):
        # Some 2010 templates omit the ``audiotools`` class.  Their otherwise
        # anonymous list contains only Add/Download/Transcript player actions.
        tool_list = add_control.find_parent("ul")
        if isinstance(tool_list, Tag):
            tool_list.decompose()
        else:
            add_control.decompose()
    # Older NPR story wrappers place podcast subscription links in list items
    # (and, in a few captures, an otherwise empty div) rather than paragraphs.
    # Inspect those leaf-like containers too so interface CTAs cannot survive
    # into the canonical article body.
    for node in list(soup.select("p, li, span, div, h3, a")):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if (
            node.name in {"p", "li", "span"}
            and re.fullmatch(r"[-–—]{8,}", text)
        ) or text == "read more" or (
            text == "read more:"
            and not (
                node.name in {"h3", "strong"}
                and node.find_parent(class_="container") is not None
            )
        ) or (
            node.name in {"p", "li", "span"}
            and text.startswith("copyright ©")
            and "npr. all rights reserved" in text
        ) or text.startswith(
            "listen to yesterday's song of the day"
        ) or (
            text.startswith("sign up for the all songs considered newsletter")
            and "new music features" in text
        ) or text.startswith(
            "register with the npr.org community"
        ) or text.startswith(
            "contact us with your questions and comments"
        ) or text.startswith(
            "all rights reserved. no part of this excerpt may be reproduced"
        ) or (
            node.name in {"p", "li", "span"}
            and
            text.startswith(
                "npr transcripts are created on a rush deadline by verb8tm"
            )
            and "authoritative record of npr" in text
        ) or text.startswith(
            "sign up for our limited-run newsletter to receive more tips on sleep"
        ) or re.fullmatch(
            r"sign up for the dry january newsletter series here\b.*",
            text,
        ) or text == "terms and conditions may apply" or re.fullmatch(
            r"for more tiny desk concerts,\s*"
            r"subscribe to our podcast\s*[.!?]?",
            text,
        ) or re.fullmatch(
            r"subscribe to (?:the )?.+ podcast\s*[.!?]?",
            text,
        ) or (
            text.startswith("subscribe to our show on ")
            and ("podcast" in text or "npr one" in text)
        ) or re.fullmatch(
            r"subscribe to (?:the )?npr(?: .+)? newsletter\s*[.!?]?",
            text,
        ) or re.fullmatch(
            r"subscribe to (?:the )?(?:newsletter|podcast)\b.*",
            text,
        ) or re.fullmatch(
            r"subscribe to (?:the |our )?newsletter\b.*",
            text,
        ) or re.fullmatch(
            r"subscribe to (?:the |our )?.*?\bpodcast"
            r"(?:\s+here)?\s*[.!?]?",
            text,
        ) or (
            text.startswith("subscribe to the podcast")
            and any(
                marker in text
                for marker in (
                    "like us on facebook",
                    "follow us on twitter",
                    "sign up to our newsletter",
                )
            )
        ) or re.fullmatch(
            r"sign up for (?:the )?.+\bchallenge\b.*",
            text,
        ) or re.fullmatch(
            r"sign up for the newsletter\b.*\bsubscribe here\s*[.!?]?",
            text,
        ) or re.fullmatch(
            r"sign up for (?:our|the) newsletter(?: here)?\s*[.!?]?",
            text,
        ) or re.fullmatch(
            r"sign up for the planet money newsletter\b.*",
            text,
        ) or re.fullmatch(
            r"subscribe to the life kit newsletter\b.*",
            text,
        ) or re.fullmatch(
            r"sign up for the pod club newsletter\b.*",
            text,
        ) or (
            text.startswith("sign up for our ")
            and " newsletter" in text
            and "share it with a friend" in text
        ):
            node.decompose()
    # A modern NPR audio-story template can place a bare ``RELATED`` marker
    # inside ``#storytext`` followed by a related-program card and the show's
    # subscription/music chrome.  It has no class or heading hook, so the
    # generic container cleanup above cannot see it.  Once this exact marker
    # appears in the story body, everything after it is presentation chrome,
    # not part of the article transcript.
    for marker in list(soup.select("#storytext > p")):
        if _clean_text(marker.get_text(" ", strip=True)).casefold() != "related":
            continue
        for sibling in list(marker.find_next_siblings()):
            sibling.decompose()
        marker.decompose()
    for container in list(soup.select(".container")):
        header = container.select_one(":scope > .conheader")
        header_text = _clean_text(
            header.get_text(" ", strip=True) if header is not None else ""
        ).casefold()
        if header_text in {
            "read more",
            "read more:",
            "related stories",
            "related npr stories",
        }:
            container.decompose()


def _npr_short_audio_story(
    soup: BeautifulSoup,
    *,
    body: Tag | None,
) -> bool:
    body_characters = len(
        _clean_text(body.get_text(" ", strip=True)) if body is not None else ""
    )
    body_classes = {
        str(value).casefold()
        for value in (soup.body.get("class") or [])
    } if soup.body is not None else set()
    dacs_audio_only = {
        "is-dacs-only",
        "no-transcript",
    }.issubset(body_classes)
    return body_characters < 200 and (
        bool(_npr_audio_story_nodes(soup)) or dacs_audio_only
    )


def _npr_legacy_metadata_audio_story(
    soup: BeautifulSoup,
    *,
    body: Tag | None,
) -> bool:
    """Recognize complete short descriptions from NPR's legacy audio pages."""
    body_characters = len(
        _clean_text(body.get_text(" ", strip=True)) if body is not None else ""
    )
    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    story_text = soup.select_one("#storytext")
    medium = _clean_text(
        _meta_content(soup, "name", "medium") or ""
    ).casefold()
    return bool(
        medium == "audio"
        and bool(
            body_classes & {"tmplnewsstory", "tmplmusicstory"}
        )
        and isinstance(story_text, Tag)
        and story_text.select_one("p") is not None
        and soup.select_one(".transcript") is None
        and 1 <= body_characters < 200
    )


def _npr_legacy_unavailable_audio_story(
    soup: BeautifulSoup,
    *,
    body: Tag | None,
) -> bool:
    """Recognize legacy radio segments captured before audio publication."""
    body_characters = len(
        _clean_text(body.get_text(" ", strip=True)) if body is not None else ""
    )
    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    story_text = soup.select_one("#storytext")
    unavailable = soup.select_one(
        "#storyspan02 .bucketwrap.primary.unavailable .avcontent.listen"
    )
    unavailable_text = _clean_text(
        unavailable.get_text(" ", strip=True)
        if isinstance(unavailable, Tag)
        else ""
    ).casefold()
    return bool(
        "tmplnewsstory" in body_classes
        and isinstance(story_text, Tag)
        and story_text.select_one("p") is not None
        and isinstance(unavailable, Tag)
        and unavailable.select_one("p") is not None
        and unavailable_text.startswith("audio for this story from ")
        and " will be available " in unavailable_text
        and soup.select_one(".transcript") is None
        and 1 <= body_characters < 200
    )


def _npr_legacy_named_audio_story(
    soup: BeautifulSoup,
    *,
    body: Tag | None,
    canonical_url: str,
) -> bool:
    """Recover a narrowly identified legacy Morning Edition audio series."""
    body_characters = len(
        _clean_text(body.get_text(" ", strip=True)) if body is not None else ""
    )
    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    path = urlsplit(canonical_url).path.casefold().rstrip("/")
    story_text = soup.select_one("#storytext")
    return bool(
        "tmplnewsstory" in body_classes
        and re.search(r"/(?:the-)?last-word-in-business$", path)
        and isinstance(story_text, Tag)
        and story_text.select_one("p") is not None
        and soup.select_one(".transcript") is None
        and 1 <= body_characters < 200
    )


def _npr_story_audio_url(
    soup: BeautifulSoup,
    *,
    base_url: str,
) -> str | None:
    nodes = _npr_audio_story_nodes(soup)
    for container in nodes:
        for link in container.select("a[href]"):
            url = _normalized_url(link.get("href"), base_url=base_url)
            if url and re.search(
                r"(?i)\.(?:aac|m4a|mp3|wav)(?:[?#]|$)",
                url,
            ):
                return url
        for player in container.select("[data-audio]"):
            payload = player.get("data-audio")
            if not isinstance(payload, str):
                continue
            try:
                decoded = json.loads(payload)
            except json.JSONDecodeError:
                decoded = None
            if isinstance(decoded, dict):
                url = _normalized_url(
                    decoded.get("audioUrl"),
                    base_url=base_url,
                )
                if url:
                    return url
    return None


def _npr_caption_credit(container: Tag) -> tuple[str | None, str | None]:
    """Separate legacy NPR cartoon captions from adjacent credit spans."""
    annotated_image = container.select_one("img[data-jojo-npr-caption]")
    if isinstance(annotated_image, Tag):
        return (
            _clean_text(annotated_image.get("data-jojo-npr-caption", ""))
            or None,
            _clean_text(annotated_image.get("data-jojo-npr-credit", ""))
            or None,
        )
    caption_node = container.select_one(
        ".captionwrap .caption, .caption-wrap .caption, figcaption, "
        "[class*='caption' i]"
    )
    caption: str | None = None
    if isinstance(caption_node, Tag):
        copy = BeautifulSoup(str(caption_node), "html.parser").find()
        if isinstance(copy, Tag):
            for hidden in copy.select(
                ".hide-caption, .toggle-caption, .credit"
            ):
                hidden.decompose()
            caption = _clean_text(copy.get_text(" ", strip=True)) or None
    credit_parts: list[str] = []
    seen_credit: set[str] = set()
    for credit_node in container.select(".creditwrap, .credit"):
        value = _clean_text(credit_node.get_text(" ", strip=True))
        key = value.casefold()
        if value and key not in seen_credit:
            credit_parts.append(value)
            seen_credit.add(key)
    credit = " / ".join(credit_parts) or None
    if caption is None and credit is None:
        return _caption_credit(container)
    return caption, credit


from jojo_news_archive.parsing.parser_contracts import (
    BaseSourceParser,
    ImageParseContext,
    ParseContext,
)


def _npr_image_identity(url: str) -> str | None:
    parts = urlsplit(url)
    if (parts.hostname or "").casefold() not in {"media.npr.org", "media.npr.com"}:
        return None
    directory, separator, filename = unquote(parts.path).rpartition("/")
    rendition = re.fullmatch(
        r"(.+?)(?:_(?:wide|sq|custom))?-[0-9a-f]{40}"
        r"(?:-s\d+)?\.[a-z0-9]+",
        filename,
        flags=re.IGNORECASE,
    )
    if separator and rendition is not None:
        return (
            "npr-image:"
            f"{directory.casefold()}/{rendition.group(1).casefold()}"
        )
    delivery_query = parse_qsl(parts.query, keep_blank_values=False)
    if not delivery_query or all(
        key.casefold() in {"s", "t"} for key, _ in delivery_query
    ):
        return f"npr-image:{unquote(parts.path).casefold()}"
    return None


class NprParser(BaseSourceParser):
    def select_body(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.body import (
            select_default_body as _select_default_body,
        )

        body = _select_default_body(context)
        interactive = (
            _npr_legacy_election_results_body(
                context.soup,
                canonical_url=context.canonical_url,
            )
            or _npr_legacy_iframe_interactive_body(
                context.soup,
                canonical_url=context.canonical_url,
            )
            or _npr_legacy_flash_interactive_body(
                context.soup,
                canonical_url=context.canonical_url,
            )
            or _npr_legacy_inline_interactive_body(context.soup)
        )
        if interactive is not None:
            body = interactive
            context.source_data["legacy_interactive_selected"] = True
        else:
            gallery = _npr_legacy_gallery_body(context.soup)
            if gallery is not None:
                body = gallery
                context.source_data["legacy_gallery_selected"] = True
            else:
                cartoon = _npr_legacy_cartoon_body(
                    context.soup,
                    selected_body=body,
                )
                if cartoon is not None:
                    body = cartoon
                    context.source_data["legacy_gallery_selected"] = True
                else:
                    book_list = _npr_legacy_book_list_body(
                        context.soup,
                        selected_body=body,
                    )
                    if book_list is not None:
                        body = book_list
                    else:
                        transcript = _npr_legacy_transcript_body(
                            context.soup,
                            selected_body=body,
                        )
                        if transcript is not None:
                            body = transcript
                            context.source_data["legacy_transcript_selected"] = True
        context.body = body

    def clean_body_before_noise(self, context: ParseContext) -> None:
        if context.clean_body is not None:
            _remove_npr_body_chrome(context.clean_body)

    def is_noise_node(
        self,
        context: ParseContext,
        node: Tag,
        text: str,
    ) -> bool:
        classes = {
            str(value).casefold() for value in (node.get("class") or [])
        }
        normalized = text.replace("’", "'").replace("‘", "'")
        return bool(
            (len(text) >= 2 and set(text) == {"_"})
            or (
                "disclaimer" in classes
                and "for personal, noncommercial use only" in text
            )
            or (
                text.startswith(
                    "npr transcripts are created on a rush deadline"
                )
                and "authoritative record of npr's programming is the audio"
                in normalized
            )
        )

    def extract_metadata(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            meta_content as _meta_content,
            parse_datetime as _parse_datetime,
        )

        if context.headline:
            context.headline = re.sub(
                r"(?i)\s*:\s*NPR\s*$",
                "",
                context.headline,
            ).strip()
        if context.published_at is None:
            context.published_at = _parse_datetime(
                _meta_content(context.soup, "name", "date")
            )

    def classify_content(self, context: ParseContext) -> None:
        if context.source_data.get("legacy_interactive_selected"):
            context.content_type = ContentType.INTERACTIVE
        elif context.source_data.get("legacy_gallery_selected"):
            context.content_type = ContentType.GALLERY
        elif context.source_data.get("legacy_transcript_selected"):
            context.content_type = ContentType.TRANSCRIPT
        body = context.clean_body
        if body is None:
            return
        metadata_audio = _npr_legacy_metadata_audio_story(
            context.soup,
            body=body,
        )
        unavailable_audio = _npr_legacy_unavailable_audio_story(
            context.soup,
            body=body,
        )
        named_audio = _npr_legacy_named_audio_story(
            context.soup,
            body=body,
            canonical_url=context.canonical_url,
        )
        context.source_data.update(
            legacy_metadata_audio=metadata_audio,
            legacy_unavailable_audio=unavailable_audio,
            legacy_named_audio=named_audio,
        )
        if (
            not context.source_data.get("legacy_interactive_selected")
            and (
                metadata_audio
                or unavailable_audio
                or named_audio
                or _npr_short_audio_story(context.soup, body=body)
            )
        ):
            context.content_type = ContentType.AUDIO
            context.source_data["audio_url"] = _npr_story_audio_url(
                context.soup,
                base_url=context.canonical_url,
            )

    def accept_lead_image(self, context: ParseContext, url: str) -> bool:
        return not (
            context.source_data.get("legacy_gallery_selected")
            or _npr_non_editorial_image_url(url)
        )

    def accept_body_image(
        self,
        context: ParseContext,
        image: ImageCandidate,
    ) -> bool:
        return not _npr_non_editorial_image_url(image.original_url)

    def prepare_image(self, context: ImageParseContext) -> None:
        context.candidates = _promote_npr_image_candidates(context.candidates)
        bucket = context.image_node.find_parent(
            "div",
            class_=lambda value: value
            and "bucketwrap" in str(value).casefold(),
        )
        if isinstance(bucket, Tag):
            context.container = bucket
        context.caption, context.credit = _npr_caption_credit(
            context.container
        )
        original_url = context.candidates[0]
        filename = urlsplit(original_url).path.rpartition("/")[2]
        if not re.search(r"(?i)(?:^|[_.-])avatar(?:[_.-]|$)", filename):
            filename = re.sub(r"(?i)avatar", "", filename)
        context.noise_context = context.image_context.replace(
            original_url,
            filename,
        )

    def image_identity(self, url: str) -> str | None:
        return _npr_image_identity(url)

    def postprocess_blocks(self, context: ParseContext) -> None:
        audio_url = context.source_data.get("audio_url")
        if not isinstance(audio_url, str) or not audio_url:
            return
        if any(
            block.type == BlockType.EMBED and block.embed_url == audio_url
            for block in context.blocks
        ):
            return
        context.blocks.append(
            ContentBlock(
                type=BlockType.EMBED,
                position=max(
                    (block.position for block in context.blocks),
                    default=-1,
                )
                + 1,
                embed_url=audio_url,
            )
        )

    def accepts_short_body(self, context: ParseContext) -> bool:
        return bool(
            super().accepts_short_body(context)
            or context.source_data.get("legacy_metadata_audio")
            or context.source_data.get("legacy_unavailable_audio")
            or context.source_data.get("legacy_named_audio")
        )


PARSER: NprParser = NprParser()
