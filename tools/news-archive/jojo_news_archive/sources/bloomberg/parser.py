from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
import re
from typing import Any
from urllib.parse import unquote, urlsplit
from bs4 import BeautifulSoup, Tag
from jojo_news_archive.models import (
    BlockType,
    ContentBlock,
    ContentType,
    ImageCandidate,
    ImageRole,
)
from jojo_news_archive.parsing.images import (
    generic_image_identity as _generic_image_identity,
)
from jojo_news_archive.parsing.primitives import (
    caption_credit as _caption_credit,
    clean_text as _clean_text,
    dedupe_lines as _dedupe_lines,
    first_text as _first_text,
    image_urls as _image_urls,
    meta_content as _meta_content,
    string_or_none as _string_or_none,
    tag_attribute as _tag_attribute,
    tag_text as _tag_text,
    walk_json_objects as _walk_json_objects,
)
from jojo_news_archive.parsing.limits import (
    MINIMUM_SYNDICATED_BODY_CHARACTERS as _MINIMUM_SYNDICATED_BODY_CHARACTERS,
)


def _bloomberg_source_image_identity(url: str) -> str | None:
    parts = urlsplit(url)
    if (parts.hostname or "").casefold() != "assets.bwbx.io":
        return None
    asset = re.fullmatch(
        r"(.+/v\d+)/[^/]+",
        parts.path,
        flags=re.IGNORECASE,
    )
    if asset is None:
        return None
    return f"bloomberg-image:{asset.group(1).casefold()}"


def _image_identity(url: str) -> str:
    generic = _generic_image_identity(url)
    return (
        _bloomberg_source_image_identity(url)
        or _bloomberg_source_image_identity(generic)
        or generic
    )


def _newsbreak_syndication_body(soup: BeautifulSoup) -> Tag | None:
    """Recover the licensed article payload without NewsBreak feed cards."""
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    if not partner_url or "newsbreak.com/" not in partner_url.casefold():
        return None
    script = soup.select_one("script#__NEXT_DATA__")
    if not isinstance(script, Tag):
        return None
    try:
        payload = json.loads(script.string or script.get_text())
    except (json.JSONDecodeError, TypeError):
        return None
    page = payload.get("props", {}).get("pageProps", {})
    content = page.get("content")
    authors = page.get("authors", [])
    if (
        not isinstance(content, str)
        or "bloomberg" not in " ".join(map(str, authors)).casefold()
    ):
        return None
    document = BeautifulSoup(content, "html.parser")
    body = document.body or document.find()
    if not isinstance(body, Tag):
        return None
    if len(_clean_text(body.get_text(" ", strip=True))) < 300:
        return None
    return body


def _bloomberg_partner_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    partner_host = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if (
        partner_host == "johnlothiannews.com"
        or partner_host.endswith(".johnlothiannews.com")
    ):
        slug = urlsplit(canonical_url).path.rstrip("/").rsplit("/", 1)[-1]
        target_tokens = {
            token
            for token in re.findall(r"[a-z0-9]+", slug.casefold())
            if not token.isdigit()
        }
        best: tuple[float, Tag] | None = None
        for paragraph in soup.select(".entry-content > p"):
            title = paragraph.select_one(":scope > strong")
            if not isinstance(title, Tag):
                continue
            title_tokens = set(
                re.findall(
                    r"[a-z0-9]+",
                    _clean_text(title.get_text(" ", strip=True)).casefold(),
                )
            )
            if not target_tokens or not title_tokens:
                continue
            score = len(target_tokens & title_tokens) / len(
                target_tokens | title_tokens
            )
            if best is None or score > best[0]:
                best = (score, paragraph)
        if best is not None and best[0] >= 0.75:
            paragraph = best[1]
            title = paragraph.select_one(":scope > strong")
            if isinstance(title, Tag):
                title.decompose()
            for line_break in list(paragraph.select("br")):
                line_break.replace_with("\n")
            lines = [
                _clean_text(line)
                for line in paragraph.get_text("\n", strip=True).splitlines()
                if _clean_text(line)
            ]
            reporting = [
                line
                for line in lines
                if line.casefold() != "bloomberg"
                and not re.fullmatch(r"https?://\S+", line)
            ]
            if reporting:
                document = BeautifulSoup(
                    "<article><p></p></article>",
                    "html.parser",
                )
                body = document.select_one("article")
                output = document.select_one("p")
                if isinstance(body, Tag) and isinstance(output, Tag):
                    output.string = " ".join(reporting)
                    return body
    if (
        partner_host == "arabamerica.com"
        or partner_host.endswith(".arabamerica.com")
    ):
        # Arab America places its navigation, audio player, trivia, poll, and
        # footer before the licensed article inside the page-level ``main``.
        # The print node contains only the syndicated report and its byline.
        source_body = soup.select_one(".content.single .content-in > .print")
        if isinstance(source_body, Tag):
            document = BeautifulSoup(str(source_body), "html.parser")
            arabamerica_body = document.select_one(".print")
            if isinstance(arabamerica_body, Tag):
                arabamerica_body["data-jojo-source"] = (
                    "bloomberg-arabamerica-syndication"
                )
                for noise in list(
                    arabamerica_body.select(
                        ".mailmunch-forms-before-post, "
                        ".mailmunch-forms-after-post, .paginationx"
                    )
                ):
                    noise.decompose()
                if len(arabamerica_body.select("p")) >= 2:
                    return arabamerica_body
    if (
        partner_host == "macdailynews.com"
        or partner_host.endswith(".macdailynews.com")
    ):
        source_body = soup.select_one(".entry-content")
        if isinstance(source_body, Tag):
            document = BeautifulSoup(str(source_body), "html.parser")
            macdailynews_body = document.select_one(".entry-content")
            if isinstance(macdailynews_body, Tag):
                truncate = False
                for child in list(macdailynews_body.children):
                    if not isinstance(child, Tag):
                        continue
                    if truncate:
                        child.decompose()
                        continue
                    text = _clean_text(child.get_text(" ", strip=True))
                    if re.match(
                        r"(?i)^read more in the full article here\b",
                        text,
                    ):
                        truncate = True
                        child.decompose()
                if len(macdailynews_body.select("p")) >= 2:
                    return macdailynews_body
    if (
        partner_host == "moneyweb.co.za"
        or partner_host.endswith(".moneyweb.co.za")
    ):
        source_body = soup.select_one("#storybody")
        if isinstance(source_body, Tag):
            document = BeautifulSoup(str(source_body), "html.parser")
            moneyweb_body = document.select_one("#storybody")
            if isinstance(moneyweb_body, Tag):
                for node in list(moneyweb_body.select("p")):
                    text = _clean_text(node.get_text(" ", strip=True))
                    if re.fullmatch(
                        r"(?i)(?:©|\(c\)|copyright)\s*\d{4}\s+"
                        r"bloomberg(?:\s+news|\s+l\.?p\.?)?\.?",
                        text,
                    ):
                        node.decompose()
                if len(moneyweb_body.select("p")) >= 2:
                    return moneyweb_body
    if (
        partner_host == "esmmagazine.com"
        or partner_host.endswith(".esmmagazine.com")
    ):
        # The outer ESM ``article`` also contains tags and a recommended
        # reading rail. The nested article is the licensed Bloomberg copy.
        source_body = soup.select_one(".article__content > article")
        if isinstance(source_body, Tag):
            document = BeautifulSoup(str(source_body), "html.parser")
            esm_body = document.select_one("article")
            if isinstance(esm_body, Tag):
                for node in list(esm_body.select("p")):
                    text = _clean_text(node.get_text(" ", strip=True))
                    if re.match(
                        r"(?i)^(?:news by bloomberg|bloomberg news)\s*,?\s*"
                        r"edited by esm\b",
                        text,
                    ):
                        node.decompose()
                if len(esm_body.select("p")) >= 2:
                    return esm_body
    if (
        partner_host == "mediapart.fr"
        or partner_host.endswith(".mediapart.fr")
    ):
        source_body = soup.select_one(".news__body__center__article")
        if isinstance(source_body, Tag):
            document = BeautifulSoup(str(source_body), "html.parser")
            mediapart_body = document.select_one(
                ".news__body__center__article"
            )
            if isinstance(mediapart_body, Tag):
                for duplicate_visual_text in list(
                    mediapart_body.select(
                        ".dropcap-wrapper > [aria-hidden='true']"
                    )
                ):
                    duplicate_visual_text.decompose()
                for node in list(mediapart_body.select("p")):
                    text = _clean_text(node.get_text(" ", strip=True))
                    if re.match(
                        r"(?i)^read more of this bloomberg report "
                        r"published by the\b",
                        text,
                    ):
                        node.decompose()
                if len(mediapart_body.select("p")) >= 2:
                    return mediapart_body
    if (
        partner_host == "parcelindustry.com"
        or partner_host.endswith(".parcelindustry.com")
    ):
        parcel_body = soup.select_one(
            "article.article .fulltext-txt, article.article #contentText"
        )
        if isinstance(parcel_body, Tag):
            teaser = re.sub(
                r"\s+Read more\s*!?\s*$",
                "",
                _clean_text(parcel_body.get_text(" ", strip=True)),
                flags=re.IGNORECASE,
            )
            document = BeautifulSoup("<article><p></p></article>", "html.parser")
            paragraph = document.select_one("p")
            article = document.select_one("article")
            if isinstance(paragraph, Tag) and isinstance(article, Tag):
                paragraph.string = teaser
                return article

    if (
        partner_host == "pv-magazine.com"
        or partner_host.endswith(".pv-magazine.com")
    ):
        pv_magazine_body = soup.select_one(".pvmagazine-post-content")
        if isinstance(pv_magazine_body, Tag):
            return pv_magazine_body
    if (
        partner_host == "eco-business.com"
        or partner_host.endswith(".eco-business.com")
    ):
        source_body = soup.select_one(
            ".eb-article__body-content"
        )
        if isinstance(source_body, Tag):
            document = BeautifulSoup(str(source_body), "html.parser")
            eco_business_body = document.select_one(
                ".eb-article__body-content"
            )
            if isinstance(eco_business_body, Tag):
                for node in list(
                    eco_business_body.select(
                        ".eb-article__eb-circle-banner"
                    )
                ):
                    node.decompose()
                return eco_business_body

    for node in soup.select("[class*='storyContent' i]"):
        paragraphs = [
            _clean_text(paragraph.get_text(" ", strip=True))
            for paragraph in node.select("p")
        ]
        substantial = [value for value in paragraphs if value]
        if (
            len(substantial) >= 2
            and sum(len(value) for value in substantial)
            >= _MINIMUM_SYNDICATED_BODY_CHARACTERS
        ):
            return node
    return None


def _bloomberg_parcel_industry_teaser(soup: BeautifulSoup) -> bool:
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if not (
        hostname == "parcelindustry.com"
        or hostname.endswith(".parcelindustry.com")
    ):
        return False
    return any(
        _tag_text(anchor).casefold() == "read more"
        for anchor in soup.select(
            "article.article .fulltext-txt a, article.article #contentText a"
        )
    )


def _bloomberg_pv_magazine_teaser(soup: BeautifulSoup) -> bool:
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if not (
        hostname == "pv-magazine.com"
        or hostname.endswith(".pv-magazine.com")
    ):
        return False
    body = soup.select_one(".pvmagazine-post-content")
    if not isinstance(body, Tag):
        return False
    text = _clean_text(body.get_text(" ", strip=True))
    return bool(
        re.search(
            r"\bclick\s+here\s+to\s+read\s+the\s+(?:rest|full\s+story)\b",
            text,
            re.IGNORECASE,
        )
    )


def _bloomberg_partner_full_story_teaser(soup: BeautifulSoup) -> bool:
    """Recognize partner copies that explicitly link to Bloomberg for the rest."""
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if hostname == "mediapart.fr" or hostname.endswith(".mediapart.fr"):
        if any(
            re.match(
                r"(?i)^read more of this bloomberg report "
                r"published by the\b",
                _clean_text(node.get_text(" ", strip=True)),
            )
            for node in soup.select(
                ".news__body__center__article p, "
                "[itemprop='articleBody'] p"
            )
        ):
            return True
    for node in soup.select("p, div"):
        text = _clean_text(node.get_text(" ", strip=True))
        explicit_full_story = re.match(
            r"(?i)^(?:"
            r"click\s+here\s+to\s+read\s+the\s+full\s+story|"
            r"read\s+(?:the\s+)?full\s+article\s+here\s+"
            r"(?:via|at|on)\s+bloomberg"
            r")\b",
            text,
        )
        excerpt_read_more = re.search(
            r"(?i)\bread\s+more\s+at\s+bloomberg\s*\.?\s*$",
            text,
        )
        if not explicit_full_story and not excerpt_read_more:
            continue
        if any(
            "bloomberg.com/" in str(anchor.get("href") or "").casefold()
            for anchor in node.select("a[href]")
        ):
            return True
    return False


def _bloomberg_macdailynews_excerpt(soup: BeautifulSoup) -> bool:
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if not (
        hostname == "macdailynews.com"
        or hostname.endswith(".macdailynews.com")
    ):
        return False
    return any(
        re.match(
            r"(?i)^read more in the full article here\b",
            _clean_text(node.get_text(" ", strip=True)),
        )
        for node in soup.select(".entry-content > p")
    )


def _bloomberg_origin_abrupt_quote_truncation(
    soup: BeautifulSoup,
) -> bool:
    """Detect archived Bloomberg bodies cut off inside their final quote."""
    page_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(page_url).hostname or "").casefold()
        if page_url
        else ""
    )
    if not (
        hostname == "bloomberg.com"
        or hostname.endswith(".bloomberg.com")
    ):
        return False
    for body in soup.select(
        ".body-copy-v2, .body-copy, .article-body__content, "
        "[data-component='article-body']"
    ):
        if body.select_one(".terminal-tout, .terminal-tout-v2") is None:
            continue
        paragraphs = body.select("p")
        if not paragraphs:
            continue
        tail = _clean_text(paragraphs[-1].get_text(" ", strip=True))
        if (
            len(tail) >= 80
            and tail.startswith("“")
            and tail.count("“") > tail.count("”")
        ):
            return True
    return False


def _bloomberg_origin_incomplete_for_more_tail(
    soup: BeautifulSoup,
) -> bool:
    """Detect legacy Bloomberg pages cut mid-sentence before a nav link."""
    page_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(page_url).hostname or "").casefold()
        if page_url
        else ""
    )
    if not (
        hostname == "bloomberg.com"
        or hostname.endswith(".bloomberg.com")
    ):
        return False
    for marker in soup.select("p"):
        if not re.fullmatch(
            r"For more,\s*click here\s*\.?",
            _clean_text(marker.get_text(" ", strip=True)),
            re.IGNORECASE,
        ):
            continue
        previous = marker.find_previous_sibling("p")
        if not isinstance(previous, Tag):
            continue
        tail = _clean_text(previous.get_text(" ", strip=True))
        if (
            len(tail) >= 30
            and len(re.findall(r"\b[\w’'-]+\b", tail)) >= 6
            and not re.search(r"""[.!?…:;)"'’”\]]$""", tail)
        ):
            return True
    return False


def _bloomberg_origin_trailing_heading_truncation(
    soup: BeautifulSoup,
) -> bool:
    """Detect an archived Bloomberg body ending at a section heading."""
    page_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(page_url).hostname or "").casefold()
        if page_url
        else ""
    )
    if not (
        hostname == "bloomberg.com"
        or hostname.endswith(".bloomberg.com")
    ):
        return False
    for body in soup.select(
        ".body-copy-v2, .body-copy, .article-body__content, "
        "[data-component='article-body']"
    ):
        meaningful = [
            child
            for child in body.find_all(recursive=False)
            if isinstance(child, Tag)
            and _clean_text(child.get_text(" ", strip=True))
        ]
        if not meaningful:
            continue
        while meaningful and (
            "terminal-tout" in (meaningful[-1].get("class") or [])
            or "terminal-tout-v2" in (meaningful[-1].get("class") or [])
        ):
            meaningful.pop()
        if meaningful and meaningful[-1].name in {
            "h1", "h2", "h3", "h4", "h5", "h6"
        }:
            return True
    return False


def _bloomberg_short_source_link_excerpt(
    soup: BeautifulSoup,
    *,
    plain_text: str,
) -> bool:
    """Recognize short partner summaries that only point to Bloomberg."""
    if len(plain_text) >= 1_000:
        return False
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if hostname == "bloomberg.com" or hostname.endswith(".bloomberg.com"):
        return False
    if any(
        re.search(
            r"(?i)bloomberg\.com/(?:news/)?(?:articles/)?\d{4}-\d{2}-\d{2}/",
            str(anchor.get("href") or ""),
        )
        for anchor in soup.select("a[href]")
    ):
        return True
    return bool(
        re.search(
            r"(?im)^https?://(?:www\.)?bloomberg\.com/"
            r"(?:news/)?(?:articles/)?\d{4}-\d{2}-\d{2}/\S+\s*$",
            plain_text,
        )
    )


def _bloomberg_embedded_article_body(soup: BeautifulSoup) -> Tag | None:
    candidates: list[Tag] = []
    for script in soup.select('script[type="application/json"]'):
        value = script.string or script.get_text()
        if not value.strip():
            continue
        try:
            payload = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            continue
        for item in _walk_json_objects(payload):
            document = item.get("body")
            if (
                not isinstance(document, dict)
                or document.get("type") != "document"
            ):
                continue
            rendered = _render_bloomberg_document(document)
            if rendered is not None:
                candidates.append(rendered)
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda node: len(node.get_text(" ", strip=True)),
    )


def _bloomberg_feature_landing_body(soup: BeautifulSoup) -> Tag | None:
    """Recover stories and editorial indexes from legacy feature templates."""
    story = soup.select_one(
        ".dvz-page-wrapper.dvz-feature .feature-wrapper"
    )
    if isinstance(story, Tag):
        paragraphs = [
            _clean_text(paragraph.get_text(" ", strip=True))
            for paragraph in story.select("p")
        ]
        substantive = [text for text in paragraphs if text]
        if (
            len(substantive) >= 3
            and sum(len(text) for text in substantive) >= 700
        ):
            return story

    container = soup.select_one(".dvz-content2")
    if not isinstance(container, Tag):
        return None
    intro = container.select_one(".intro, .introWrap")
    index = container.select_one(".index, .grid")
    if (
        not isinstance(intro, Tag)
        or len(_clean_text(intro.get_text(" ", strip=True))) < 300
        or not isinstance(index, Tag)
        or len(index.select("a[href]")) < 3
    ):
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    paragraph = document.new_tag("p")
    paragraph.string = _clean_text(intro.get_text(" ", strip=True))
    article.append(paragraph)
    seen_headings: set[str] = set()
    for anchor in index.select("a[href]"):
        text = _tag_text(anchor)
        if not text or text.casefold() in seen_headings:
            continue
        seen_headings.add(text.casefold())
        heading = document.new_tag("h2")
        heading.string = text
        article.append(heading)
    seen_images: set[str] = set()
    for source_image in container.select("img[src]"):
        source = _tag_attribute(source_image, "src")
        if not source:
            continue
        identity = _image_identity(source)
        if identity in seen_images:
            continue
        seen_images.add(identity)
        figure = document.new_tag("figure")
        image = document.new_tag("img")
        image["src"] = source
        alt = _tag_attribute(source_image, "alt")
        if alt:
            image["alt"] = alt
        figure.append(image)
        article.append(figure)
    return article


def _bloomberg_embedded_quiz_body(soup: BeautifulSoup) -> Tag | None:
    container = soup.select_one("#quiz-container")
    if not isinstance(container, Tag):
        return None
    questions = container.select("section.question[id^='Q']")
    if len(questions) < 3:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    seen_images: set[str] = set()
    for question in questions:
        identifier = _string_or_none(question.get("id"))
        prompt = _tag_text(question.select_one(":scope > h2"))
        options = [
            text
            for option in question.select(
                ":scope > ol.quiz-answers > li"
            )
            if (text := _tag_text(option))
        ]
        if not prompt or len(options) < 2:
            continue
        heading = document.new_tag("h2")
        heading.string = prompt
        article.append(heading)
        image = question.select_one(".quiz-question img[src]")
        if isinstance(image, Tag):
            source = _string_or_none(image.get("src"))
            if source and _image_identity(source) not in seen_images:
                seen_images.add(_image_identity(source))
                figure = document.new_tag("figure")
                image_copy = document.new_tag("img")
                image_copy["src"] = source
                caption = _tag_text(
                    question.select_one(".quiz-question .captionline")
                )
                if caption:
                    image_copy["alt"] = caption
                figure.append(image_copy)
                credit = _tag_text(
                    question.select_one(".quiz-question .creditline")
                )
                if caption or credit:
                    figcaption = document.new_tag("figcaption")
                    figcaption.string = " ".join(
                        value for value in (caption, credit) if value
                    )
                    figure.append(figcaption)
                article.append(figure)
        option_list = document.new_tag("ul")
        for option in options:
            item = document.new_tag("li")
            item.string = option
            option_list.append(item)
        article.append(option_list)
        answer = (
            container.select_one(f"section.answer#A{identifier[1:]}")
            if identifier and identifier[1:].isdigit()
            else None
        )
        if isinstance(answer, Tag):
            explanations = [
                (len(text), text)
                for node in answer.find_all("div", recursive=False)
                if (
                    "navbuttons" not in (node.get("class") or [])
                    and "thisresult" not in (node.get("class") or [])
                    and (text := _tag_text(node))
                )
            ]
            if explanations:
                explanation = document.new_tag("p")
                explanation.string = max(explanations)[1]
                article.append(explanation)
    return (
        article
        if len(article.select("h2")) >= 3
        and len(_clean_text(article.get_text(" ", strip=True))) >= 500
        else None
    )


def _render_bloomberg_document(document: dict[str, Any]) -> Tag | None:
    parsed = BeautifulSoup(
        "<div data-jojo-source='bloomberg-embedded-body'></div>",
        "html.parser",
    )
    wrapper = parsed.select_one("div")
    if wrapper is None:
        return None

    def text_content(value: object) -> str:
        if isinstance(value, dict):
            if value.get("type") == "text":
                return _string_or_none(value.get("value")) or ""
            children = value.get("content")
            if not isinstance(children, list):
                return ""
            return "".join(
                text_content(child) for child in children
            )
        if isinstance(value, list):
            return "".join(text_content(child) for child in value)
        return ""

    for block in document.get("content", []):
        if not isinstance(block, dict):
            continue
        block_type = _string_or_none(block.get("type")) or ""
        text = _clean_text(text_content(block))
        if block_type in {"paragraph", "blockquote"} and text:
            tag = parsed.new_tag("blockquote" if block_type == "blockquote" else "p")
            tag.string = text
            wrapper.append(tag)
        elif block_type == "heading" and text:
            level = block.get("data", {}).get("level", 2)
            level = level if isinstance(level, int) and 2 <= level <= 6 else 2
            tag = parsed.new_tag(f"h{level}")
            tag.string = text
            wrapper.append(tag)
        elif block_type in {"list", "unordered-list", "ordered-list"}:
            items = [
                _clean_text(text_content(child))
                for child in block.get("content", [])
                if isinstance(child, dict)
            ]
            items = [item for item in items if item]
            if items:
                list_tag = parsed.new_tag(
                    "ol" if block_type == "ordered-list" else "ul"
                )
                for item in items:
                    item_tag = parsed.new_tag("li")
                    item_tag.string = item
                    list_tag.append(item_tag)
                wrapper.append(list_tag)
        elif block_type == "tabularData":
            table = parsed.new_tag("table")
            definitions: list[dict[str, Any]] = []
            rows: list[dict[str, Any]] = []
            for child in block.get("content", []):
                if not isinstance(child, dict):
                    continue
                if child.get("type") == "columns":
                    data = child.get("data")
                    if isinstance(data, dict) and isinstance(
                        data.get("definitions"),
                        list,
                    ):
                        definitions = [
                            value
                            for value in data["definitions"]
                            if isinstance(value, dict)
                        ]
                elif child.get("type") == "row":
                    rows.append(child)
            if definitions:
                thead = parsed.new_tag("thead")
                heading_row = parsed.new_tag("tr")
                for definition in definitions:
                    cell = parsed.new_tag("th")
                    cell.string = (
                        _string_or_none(definition.get("title")) or ""
                    )
                    heading_row.append(cell)
                thead.append(heading_row)
                table.append(thead)
            if rows:
                tbody = parsed.new_tag("tbody")
                for row in rows:
                    row_tag = parsed.new_tag("tr")
                    for source_cell in row.get("content", []):
                        if not isinstance(source_cell, dict):
                            continue
                        cell = parsed.new_tag("td")
                        cell.string = _clean_text(text_content(source_cell))
                        row_tag.append(cell)
                    if row_tag.select_one("td") is not None:
                        tbody.append(row_tag)
                if tbody.select_one("tr") is not None:
                    table.append(tbody)
            if table.select_one("tr") is not None:
                wrapper.append(table)

        for child in _walk_json_objects(block):
            if child.get("type") == "embed":
                embed_url = _first_text(
                    _string_or_none(child.get("href")),
                    _string_or_none(
                        (child.get("iframeData") or {}).get("url")
                    )
                    if isinstance(child.get("iframeData"), dict)
                    else None,
                )
                if embed_url:
                    iframe = parsed.new_tag("iframe", src=embed_url)
                    wrapper.append(iframe)
            if child.get("type") == "media":
                data = child.get("data")
                if not isinstance(data, dict):
                    continue
                video = data.get("video")
                if isinstance(video, dict):
                    source = _string_or_none(video.get("src"))
                    if source:
                        iframe = parsed.new_tag("iframe", src=source)
                        wrapper.append(iframe)
    if wrapper.select_one(
        "p, h2, h3, h4, h5, h6, blockquote, ul, ol, table, iframe"
    ):
        return wrapper
    return None


def _bloomberg_john_lothian_summary(soup: BeautifulSoup) -> bool:
    """John Lothian newsletters carry short summaries, never full stories."""
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    return (
        hostname == "johnlothiannews.com"
        or hostname.endswith(".johnlothiannews.com")
    )


def _bloomberg_article_narration(soup: BeautifulSoup) -> bool:
    """Distinguish Bloomberg's text-to-speech player from an audio story."""
    for heading in soup.select("h1, h2, h3, h4, [role='heading']"):
        if _clean_text(heading.get_text(" ", strip=True)).casefold() in {
            "listen to article",
            "listen to this article",
        }:
            return True
    return bool(
        soup.select_one(
            "audio source[src*='assets.bwbx.io/s3/readings/'], "
            "audio[src*='assets.bwbx.io/s3/readings/']"
        )
    )


def _bloomberg_low_resolution_image(image: ImageCandidate) -> bool:
    return any(
        bool(
            re.search(
                r"/(?:60x-1|60x60)\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)",
                url,
                flags=re.IGNORECASE,
            )
        )
        for url in image.candidate_urls
    )


def _bloomberg_author_avatar_url(url: str) -> bool:
    return bool(
        re.search(
            r"(?i)/images/bview/columnists/"
            r"(?:\d+x\d+/)?[^/?#]+\.(?:gif|jpe?g|png|webp)(?:[?#]|$)",
            url,
        )
    )


def _bloomberg_legacy_lightbox_thumbnail_identities(
    soup: BeautifulSoup,
    *,
    base_url: str,
) -> set[str]:
    identities: set[str] = set()
    for thumbnail in soup.select(
        ".thumbnail_container.overlay_container > a.enlarge_image"
    ):
        overlay = thumbnail.find_next_sibling(
            "div",
            class_="simple_overlay",
        )
        image = thumbnail.find("img")
        if (
            not isinstance(overlay, Tag)
            or overlay.find("img") is None
            or not isinstance(image, Tag)
        ):
            continue
        identities.update(
            _image_identity(url)
            for url in _image_urls(image, base_url=base_url)
        )
    return identities


def _promote_bloomberg_image_candidates(candidates: list[str]) -> list[str]:
    """Prefer Bloomberg's lossless-aspect 1200px rendition over a 60px lazy image."""
    promoted: list[str] = []
    for url in candidates:
        parsed = urlsplit(url)
        if parsed.hostname in {"assets.bwbx.io", "assets.bwbx.com"}:
            high_resolution = re.sub(
                r"/60x-1(?=\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$))",
                "/1200x-1",
                url,
                flags=re.IGNORECASE,
            )
            if high_resolution != url and high_resolution not in promoted:
                promoted.append(high_resolution)
        if url not in promoted:
            promoted.append(url)
    return promoted


def _trim_bloomberg_subscription_tail(soup: BeautifulSoup) -> None:
    """Drop Bloomberg Professional subscription shells after real excerpts."""
    marker = next(
        (
            node
            for node in soup.select("p, div")
            if _clean_text(node.get_text(" ", strip=True))
            .casefold()
            .startswith(
                "to continue reading this article you must be a bloomberg "
                "professional service subscriber"
            )
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


def _remove_bloomberg_damaged_attribution(soup: BeautifulSoup) -> None:
    """Drop a standalone joint byline whose contributor was lost upstream."""
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(r"Bloomberg News\s+and", text, re.IGNORECASE):
            node.decompose()


def _remove_bloomberg_promos(soup: BeautifulSoup) -> None:
    # Food Safety News embeds a donation card after licensed Bloomberg
    # reporting. Its nested heading can survive text-level footer cleanup, so
    # remove the card as a unit.
    for node in list(soup.select("div")):
        text = _clean_text(node.get_text(" ", strip=True))
        if (
            "bg-blue-primary" in (node.get("class") or [])
            and
            "food safety news is nonprofit and reader-funded" in text.casefold()
            and "donate today" in text.casefold()
        ):
            node.decompose()

    for heading in list(soup.select("h1, h2, h3, h4, h5, h6")):
        next_tag = heading.find_next_sibling()
        if (
            isinstance(next_tag, Tag)
            and (
                "terminal-tout" in (next_tag.get("class") or [])
                or "terminal-tout-v2" in (next_tag.get("class") or [])
            )
        ):
            heading.decompose()

    # Business Times syndication pages place newsletter cards, feedback
    # prompts, and related-story grids inside the broad article wrapper. They
    # consistently mark these screen-only modules as ``no-print``.
    for node in list(soup.select(".no-print")):
        node.decompose()

    # Some 2015 article bodies append a single paragraph labelled
    # ``Related Story`` with several Bloomberg headlines and no reporting.
    for node in list(soup.select("p")):
        links = list(node.select("a[href]"))
        if (
            len(links) >= 2
            and re.match(
                r"Related Stor(?:y|ies)\s*:",
                _clean_text(node.get_text(" ", strip=True)),
                re.IGNORECASE,
            )
            and all(
                "bloomberg" in str(link.get("href") or "").casefold()
                for link in links
            )
        ):
            node.decompose()

    # WallStreetPit mirrors place their own affiliate disclosure inside the
    # same content column as the licensed Bloomberg copy.  Prefer the
    # structural class, with a narrowly worded text fallback for captures
    # where the wrapper was flattened.
    for node in list(soup.select(".entry-content > ul")):
        next_tag = node.find_next_sibling()
        if (
            isinstance(next_tag, Tag)
            and "adblock" in (next_tag.get("class") or [])
        ):
            node.decompose()
    for node in list(soup.select(".adblock")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"Disclaimer:\s*This page contains affiliate links\s*\.?\s*"
            r"If you choose to make a purchase after clicking a link,\s*"
            r"we may receive a commission at no additional cost to you\.\s*"
            r"Thank you for your support!",
            text,
            re.IGNORECASE,
        ):
            node.decompose()
    for node in list(soup.select(".entry-tags")):
        node.decompose()
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"Disclaimer:\s*This page contains affiliate links\s*\.?\s*"
            r"If you choose to make a purchase after clicking a link,\s*"
            r"we may receive a commission at no additional cost to you\.\s*"
            r"Thank you for your support!",
            text,
            re.IGNORECASE,
        ):
            node.decompose()

    # Bloomberg Businessweek occasionally published contributed education
    # tips with a final partner trial CTA inside the article container.
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"Plan on taking the SAT soon\?\s*Sign-?up for a trial "
            r"of Veritas Prep SAT 2400 on Demand\.?",
            text,
            re.IGNORECASE,
        ):
            node.decompose()

    # Gasgoo's current article template appends its supplier-services card,
    # copyright notice, and current-news grid inside the same article element
    # as licensed Bloomberg copy.  The paired service addresses and the two
    # distinct card titles make these safe, structural removals.
    for node in list(soup.select("div")):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if (
            "buyer-support@gasgoo.com" in text
            and "seller-support@gasgoo.com" in text
        ) or (
            "weekly highlights" in text
            and "[gasgoo express]" in text
            and "gasgoo.com" not in text
        ):
            node.decompose()
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"All Rights Reserved\. Do not reproduce, copy and use the "
            r"editorial content without permission\. Contact us: "
            r"autonews@gasgoo\.com",
            text,
            re.IGNORECASE,
        ):
            node.decompose()

    # Legacy terminal editions can pack a complete related-news navigation
    # module into one paragraph instead of separating its heading and links.
    # A few captured editions put the navigation after legitimate text (and
    # sometimes HTML escaped list markup), so retain that lead-in instead of
    # discarding the entire paragraph.
    terminal_related_news = re.compile(
        r"For Related (?:News\s*(?:&|and)\s*)?Information\s*:\s*.+"
        r"(?:<\s*GO\s*>|\{\s*[A-Z0-9 ]{2,80}\s*\})"
        r".*",
        re.IGNORECASE,
    )
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        match = terminal_related_news.search(text)
        if match is None:
            continue
        retained = re.sub(
            r"</?(?:ul|ol|li)\b[^>]*>",
            " ",
            text[: match.start()],
            flags=re.IGNORECASE,
        )
        retained = _clean_text(retained)
        if retained:
            node.clear()
            node.append(retained)
        else:
            node.decompose()

    # Some terminal table editions append a Bloomberg command code after an
    # otherwise useful source attribution.  Preserve the agency name while
    # dropping only the non-reader-facing command suffix.
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if not re.match(r"SOURCE\s*:", text, re.IGNORECASE):
            continue
        retained = re.sub(
            r"\s+\{\s*[A-Z0-9 ]{2,80}<\s*GO\s*>\s*\}\s*$",
            "",
            text,
            flags=re.IGNORECASE,
        )
        if retained != text:
            node.clear()
            node.append(retained)

    # Partner mirrors sometimes end an excerpt with a provenance link back to
    # the Bloomberg URL.  The canonical source is already retained in the
    # record, so do not leak this mirror wrapper into article text.
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"Read the full article at\s+https?://(?:www\.)?"
            r"bloomberg\.com/(?:news/)?(?:articles?/)?\S+",
            text,
            re.IGNORECASE,
        ):
            node.decompose()

    # Stem-cell partner captures append a large accordion of unrelated posts
    # inside the broadly selected content container.
    for node in list(soup.select(".accordion.ddop")):
        node.decompose()
    for node in list(soup.select(".relatedposttitle")):
        parent = node.parent
        if parent is not None and parent.name in {"div", "section", "aside"}:
            parent.decompose()
        else:
            node.decompose()

    # Zillow guest articles can append a home-search CTA, a labelled related
    # list, and an author recirculation bio inside Bloomberg's story body.
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"To find mid-size homes for sale near you, .{1,240}",
            text,
            re.IGNORECASE,
        ):
            node.decompose()
            continue
        if re.fullmatch(
            r"Related items from Zillow Blog\s*:?",
            text,
            re.IGNORECASE,
        ):
            related_list = node.find_next_sibling()
            if (
                related_list is not None
                and related_list.name in {"ul", "ol"}
            ):
                related_list.decompose()
            node.decompose()

    # Bloomberg View used a paragraph of tildes as a semantic section break.
    # Preserve it as the schema's divider block instead of emitting a
    # punctuation-only paragraph.
    for node in list(soup.select("p")):
        if re.fullmatch(
            r"(?:~{3,}|-{3,})",
            _clean_text(node.get_text(" ", strip=True)),
        ):
            node.clear()
            node.name = "hr"

    # Some licensed mirrors append a bold Bloomberg credit to the final
    # reporting paragraph. Remove the terminal credit without dropping the
    # preceding sentence.
    for credit in list(soup.select("p > b:last-child, p > strong:last-child")):
        if re.fullmatch(
            r"Bloomberg",
            _clean_text(credit.get_text(" ", strip=True)),
            re.IGNORECASE,
        ):
            credit.decompose()

    # Legacy Bloomberg pages can insert a labelled recirculation list in the
    # middle of the reporting. Remove only the heading and its immediately
    # following all-link list; later reporting must remain intact.
    for heading in list(soup.select("h1, h2, h3, h4, h5, h6")):
        heading_text = _clean_text(heading.get_text(" ", strip=True))
        if not re.fullmatch(
            r"For more on .{1,120},\s*read this next:?",
            heading_text,
            re.IGNORECASE,
        ):
            continue
        related_list = heading.find_next_sibling()
        if related_list is None or related_list.name not in {"ul", "ol"}:
            continue
        items = list(related_list.find_all("li", recursive=False))
        if not items:
            continue
        if not all(
            item.select_one("a[href]")
            and _clean_text(item.get_text(" ", strip=True))
            == _clean_text(
                " ".join(
                    link.get_text(" ", strip=True)
                    for link in item.select("a[href]")
                )
            )
            for item in items
        ):
            continue
        related_list.decompose()
        heading.decompose()

    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if (
            re.fullmatch(r"Bloomberg", text, re.IGNORECASE)
            or re.fullmatch(
                r"(?:FIFW\s+)?NSN\s+[A-Z0-9]{10,14}\s*"
                r"<\s*GO\s*>\s+.+",
                text,
                re.IGNORECASE,
            )
            or re.fullmatch(
                r"bc-[a-z0-9]+(?:-[a-z0-9]+)+"
                r"(?:\s+\([A-Z]{2,10}\))?",
                text,
                re.IGNORECASE,
            )
            or re.fullmatch(
                r"[A-Za-z][A-Za-z &'-]{2,100}\s*:\s*"
                r"NI\s+[A-Z0-9]{4,16}",
                text,
                re.IGNORECASE,
            )
            or re.fullmatch(
                r"Bill Rochelle is away\. For today['’]s U\.S\. bankruptcy "
                r"column and any updates, see \{\s*TNI\s+BCY\s+US\s+BN\s*"
                r"<\s*GO\s*>\s*\}\.?",
                text,
                re.IGNORECASE,
            )
            or re.fullmatch(
                r"Read more posts from .{1,100}\.",
                text,
                re.IGNORECASE,
            )
            or re.fullmatch(
                r"-0-\s+(?:[A-Za-z]{3}/\d{1,2}/\d{4}|\d{1,2}/\d{1,2}/\d{4})"
                r"\s+\d{1,2}:\d{2}\s+(?:GMT|UTC)\.?",
                text,
                re.IGNORECASE,
            )
            or re.fullmatch(
                r"\(Updated(?:\s+[A-Za-z]+\s+\d{1,2}(?:,?\s+\d{4})?)?\.?"
                r"\s*See\s+\{\s*[A-Z0-9 ]{2,80}<\s*GO\s*>\s*\}\.?\s*\)",
                text,
                re.IGNORECASE,
            )
            or re.fullmatch(
                r"For other Bloomberg coverage,\s*click here\s*\.?",
                text,
                re.IGNORECASE,
            )
        ):
            node.decompose()

    for text_node in list(
        soup.find_all(
            string=re.compile(
                r"For other Bloomberg coverage,\s*click here\s*\.?",
                re.IGNORECASE,
            )
        )
    ):
        cleaned = re.sub(
            r"\s*For other Bloomberg coverage,\s*click here\s*\.?",
            "",
            str(text_node),
            flags=re.IGNORECASE,
        )
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    # Legacy Bloomberg pages sometimes append a Terminal command inside an
    # otherwise useful reporting paragraph.  Keep the conference-call detail
    # or article introduction, but remove only the machine navigation.
    terminal_inline_commands = (
        re.compile(
            r"\s*See\s+[A-Z0-9]{1,12}(?:\s+[A-Z0-9]{1,16})?\s*"
            r"<\s*Equity\s*>\s+EVTS?\s*<\s*GO\s*>",
            re.IGNORECASE,
        ),
        re.compile(
            r"\s*See\s+NI\s+[A-Z0-9]{2,20}\s*<\s*GO\s*>"
            r"(?:\s+for\s+[^.]{1,240})?\.?",
            re.IGNORECASE,
        ),
        re.compile(
            r"\s*See\s+[A-Z0-9]{1,24}(?:\s+[A-Z0-9]{1,24})?\s*"
            r"<\s*Index\s*>\s*(?:[A-Z]{1,8}\s*){0,4}<\s*GO\s*>\.?",
            re.IGNORECASE,
        ),
    )
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        cleaned = text
        for command in terminal_inline_commands:
            cleaned = command.sub("", cleaned)
        cleaned = _clean_text(cleaned)
        # The command itself can end in a period after a sentence that already
        # ended before ``See``; preserve the closing parenthesis, not ``..``.
        cleaned = re.sub(r"\.\s*\.(?=\))", ".", cleaned)
        if cleaned == text:
            continue
        if cleaned:
            node.clear()
            node.append(cleaned)
        else:
            node.decompose()

    # Some 2015 Bloomberg pages append an unlabelled related-story paragraph
    # inside the story section. It contains only multiple Bloomberg article
    # links and no prose outside those anchors.
    for node in list(soup.select("p")):
        links = list(node.select("a[href]"))
        if len(links) < 2:
            continue
        if not all(
            re.search(
                r"(?:bloomberg(?:view)?\.com/)?(?:news/)?articles/",
                str(link.get("href") or ""),
                re.IGNORECASE,
            )
            for link in links
        ):
            continue
        paragraph_text = _clean_text(node.get_text(" ", strip=True))
        linked_text = _clean_text(
            " ".join(link.get_text(" ", strip=True) for link in links)
        )
        if paragraph_text == linked_text:
            node.decompose()

    # A malformed 2015 recirculation paragraph can lose the anchor around its
    # second headline, leaving one Bloomberg story link followed by another
    # headline as plain text.  Restrict this repair to the terminal paragraph
    # and headline-shaped residual text so linked reporting prose is kept.
    for node in list(soup.select("p")):
        links = list(node.select("a[href]"))
        if len(links) != 1 or not re.search(
            r"(?:bloomberg(?:view)?\.com/)?(?:news/)?articles/",
            str(links[0].get("href") or ""),
            re.IGNORECASE,
        ):
            continue
        following = [
            sibling
            for sibling in node.find_next_siblings()
            if isinstance(sibling, Tag) and _tag_text(sibling)
        ]
        if following:
            continue
        clone = BeautifulSoup(str(node), "html.parser")
        for link in clone.select("a"):
            link.decompose()
        residual = _clean_text(clone.get_text(" ", strip=True))
        words = re.findall(r"[A-Za-z][A-Za-z’'-]*", residual)
        title_words = sum(
            word[0].isupper()
            for word in words
            if word.casefold() not in {"a", "an", "and", "at", "for", "in",
                                       "of", "on", "the", "to", "with"}
        )
        if (
            4 <= len(words) <= 20
            and not re.search(r"[.!?]($|\s)", residual)
            and title_words >= max(3, len(words) // 2)
        ):
            node.decompose()

    # Some 2014 personal-finance stories append a topic recirculation heading
    # and a sibling list of Bloomberg links after the final reporting block.
    for heading in list(soup.select("p")):
        heading_text = _clean_text(heading.get_text(" ", strip=True))
        if not re.fullmatch(
            r"More on .{2,160}\s*:",
            heading_text,
            re.IGNORECASE,
        ):
            continue
        related_list = heading.find_next_sibling()
        if related_list is None or related_list.name not in {"ul", "ol"}:
            continue
        items = list(related_list.find_all("li", recursive=False))
        if not items or not all(
            item.select_one("a[href]")
            and _clean_text(item.get_text(" ", strip=True))
            == _clean_text(
                " ".join(
                    link.get_text(" ", strip=True)
                    for link in item.select("a[href]")
                )
            )
            for item in items
        ):
            continue
        related_list.decompose()
        heading.decompose()

    # Insurance Journal article tags and in-content subscription cards use
    # these structural classes. At this stage ``soup`` is the isolated body
    # clone and no longer contains partner-host metadata.
    for node in list(
        soup.select(
            "p.tagtag, .subscribe-banner, "
            "[class*='subscribe-banner' i], .story-tags"
        )
    ):
        node.decompose()

    # WordPress partner mirrors can leak their comment form into a broadly
    # selected story container.
    for node in list(
        soup.select(
            "#comments, #respond, .comment-respond, .comment-reply-title, "
            ".left_sidebar, .widget-area, section.widget, .post-navigation"
        )
    ):
        node.decompose()

    # CTRM Center's advertising and recirculation widgets can be nested inside
    # an unclosed story paragraph. Remove the widget nodes themselves so the
    # Bloomberg reporting around them remains intact.
    for node in list(
        soup.select(
            ".inPost, .gsfnura, .mostRecentPosts"
        )
    ):
        node.decompose()
    for text_node in list(
        soup.find_all(string=re.compile(r"(?i)sponsored\s+links\s*$"))
    ):
        cleaned = re.sub(
            r"(?i)\s*sponsored\s+links\s*$",
            "",
            str(text_node),
        )
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    # Some partner excerpts append ``Read more at Bloomberg`` to the final
    # reporting paragraph rather than placing the link in its own node. Keep
    # the useful excerpt, but remove the recirculation phrase.
    for node in list(soup.select("p")):
        text = _tag_text(node)
        if not re.search(
            r"(?i)\bread\s+more\s+at\s+bloomberg\s*\.?\s*$",
            text,
        ):
            continue
        if not any(
            "bloomberg.com/" in str(anchor.get("href") or "").casefold()
            for anchor in node.select("a[href]")
        ):
            continue
        for anchor in list(node.select("a[href]")):
            if "bloomberg.com/" in str(anchor.get("href") or "").casefold():
                anchor.decompose()
        for text_node in list(node.find_all(string=True)):
            cleaned = re.sub(
                r"(?i)\s*read\s+more\s+at\s*$",
                "",
                str(text_node),
            )
            if cleaned != str(text_node):
                if cleaned:
                    text_node.replace_with(cleaned)
                else:
                    text_node.extract()
        for text_node in list(node.find_all(string=True)):
            if re.fullmatch(r"\s*\.\s*", str(text_node)):
                text_node.extract()

    # The Daily Economy's older licensed copies append a Bloomberg source
    # link, a duplicate headline/byline/date, and an unrelated stock-image
    # credit after the final reporting sentence. The source marker shares the
    # paragraph with useful prose, so trim from its linked ``Read more`` text
    # onward instead of dropping the whole paragraph.
    for source_link in list(soup.select("p a[href]")):
        if not re.fullmatch(
            r"Read more",
            _tag_text(source_link),
            re.IGNORECASE,
        ):
            continue
        if "bloomberg.com/" not in str(
            source_link.get("href") or ""
        ).casefold():
            continue
        paragraph = source_link.find_parent("p")
        if not isinstance(paragraph, Tag):
            continue
        prior_text = _clean_text(
            "".join(str(item) for item in paragraph.contents).split(
                str(source_link),
                1,
            )[0]
        )
        if len(prior_text) < 120:
            continue
        for item in list(paragraph.contents)[
            list(paragraph.contents).index(source_link) :
        ]:
            if isinstance(item, Tag):
                item.decompose()
            else:
                item.extract()
        next_paragraph = paragraph.find_next_sibling("p")
        if (
            isinstance(next_paragraph, Tag)
            and re.fullmatch(
                r"Image by .{2,160}",
                _tag_text(next_paragraph),
                re.IGNORECASE,
            )
        ):
            next_paragraph.decompose()

    # Licensed CTRM Center copies place a republication disclaimer inside the
    # selected story container. Match both halves of its distinctive wording
    # so ordinary Bloomberg references to republication are preserved.
    for node in list(soup.select("p, span")):
        text = _tag_text(node).casefold()
        if (
            "republished on the ctrm center" in text
            and "if you have any issue with this post" in text
        ):
            node.decompose()

    # Legacy Bloomberg slideshows render the first image twice and keep both a
    # shortened ``Read More`` caption and a full ``Close`` caption in the DOM.
    # Retain each slide's full caption and image exactly once.
    for node in list(
        soup.select(
            ".slideshow_teaser, .slide_caption .cap_preview, "
            ".slider_close, .slider_controls, .slider_nav"
        )
    ):
        node.decompose()
    for anchor in list(soup.select(".slide_caption .cap_show a")):
        if _tag_text(anchor).casefold() == "close":
            anchor.decompose()
    # Older Bloomberg image attachments keep a hidden lightbox copy of the
    # title, credit, and caption next to the visible caption. Keep the
    # lightbox's larger image candidate, but discard its duplicate text.
    for node in list(
        soup.select(".simple_overlay .image_title, .simple_overlay .details")
    ):
        node.decompose()

    # Businessweek inline illustrations sometimes use the caption and image
    # alt text solely for issue promotion. Keep the illustration and its
    # credit, but do not expose the issue date or subscription call as a
    # descriptive caption.
    businessweek_image_promo = re.compile(
        r"Featured in Bloomberg Businessweek\s*,?\s*"
        r"[A-Z][a-z]{2,8}\.?\s+\d{1,2},\s+\d{4}\.\s*"
        r"Subscribe now\s*\.?",
        re.IGNORECASE,
    )
    for caption in list(soup.select(".inline-media__caption")):
        if businessweek_image_promo.fullmatch(_tag_text(caption)):
            caption.decompose()
    for image in list(soup.select("img[alt]")):
        if businessweek_image_promo.fullmatch(
            _clean_text(str(image.get("alt") or ""))
        ):
            image["alt"] = ""

    # Partner mirrors may place a five-star voting form inside the article
    # container. It is interactive site chrome, not Bloomberg story content.
    for node in list(soup.select("form.rating, form#articleVotesSubmit")):
        node.decompose()

    # Some licensed partner pages append a link back to Bloomberg for the full
    # story, followed by the partner's membership and related-content modules.
    # The reporting before this marker is useful but necessarily partial.
    full_story_marker = next(
        (
            node
            for node in soup.select("p, div")
            if re.match(
                r"(?i)^(?:"
                r"click\s+here\s+to\s+read\s+the\s+full\s+story|"
                r"read\s+(?:the\s+)?full\s+article\s+here\s+"
                r"(?:via|at|on)\s+bloomberg"
                r")\b",
                _tag_text(node),
            )
            and any(
                "bloomberg.com/" in str(anchor.get("href") or "").casefold()
                for anchor in node.select("a[href]")
            )
        ),
        None,
    )
    if isinstance(full_story_marker, Tag):
        tail = full_story_marker
        while isinstance(tail.parent, Tag):
            for sibling in list(tail.next_siblings):
                if isinstance(sibling, Tag):
                    sibling.decompose()
                else:
                    sibling.extract()
            if tail.parent is soup or tail.parent.name in {"article", "main"}:
                break
            tail = tail.parent
        full_story_marker.decompose()

    # Syndicated Bloomberg forecast summaries sometimes append this provider
    # signup sentence after the source-article link.
    for node in list(soup.select("p, div, li")):
        if _tag_text(node).casefold().startswith(
            "click here to receive free and immediate email alerts"
        ):
            node.decompose()

    # Some Yahoo syndication captures contain provider HTML with every opening
    # angle bracket stripped (``/pp``, ``br /``, ``nbsp;/pp``). Preserve the
    # reporting while removing the provider upload/recirculation tail.
    for text_node in list(soup.find_all(string=re.compile(r"(?:nbsp;)?/pp"))):
        malformed = str(text_node)
        malformed = re.split(
            r"(?i)(?:nbsp;)?/ppem\s*uploaded by\b",
            malformed,
            maxsplit=1,
        )[0]
        malformed = re.sub(r"(?i)(?:^|\s)br\s*/", "\n\n", malformed)
        malformed = re.sub(r"(?i)(?:nbsp;)?/pp", "\n\n", malformed)
        text_node.replace_with(malformed.strip())

    for text_node in list(
        soup.find_all(string=re.compile(r"(?i)always-superb editing by"))
    ):
        linkedin_copy = str(text_node)
        linkedin_copy = re.split(
            r"(?is)\s+with\s+.{1,160}?\s+and\s+"
            r"always-superb editing by\b",
            linkedin_copy,
            maxsplit=1,
        )[0]
        text_node.replace_with(linkedin_copy.strip())

    shell_text = _clean_text(soup.get_text(" ", strip=True))
    shell_folded = shell_text.casefold()
    if "abitech analysis" in shell_folded:
        for card in list(soup.select(".card")):
            card.decompose()
    if (
        len(shell_text) < 400
        and "bias rating" in shell_folded
        and "reliability" in shell_folded
        and "politician portrayal" in shell_folded
    ):
        soup.clear()
        return

    bias_shell = next(
        (
            node
            for node in soup.select("p, h2, h3, h4, div")
            if _clean_text(node.get_text(" ", strip=True)).casefold().startswith(
                (
                    "want to see the in-depth bias analytics",
                    "create your free account to see the in-depth bias analytics",
                )
            )
        ),
        None,
    )
    if isinstance(bias_shell, Tag):
        tail = bias_shell
        while isinstance(tail.parent, Tag):
            for sibling in list(tail.next_siblings):
                if isinstance(sibling, Tag):
                    sibling.decompose()
                else:
                    sibling.extract()
            if tail.parent is soup or tail.parent.name in {"article", "main"}:
                break
            tail = tail.parent
        bias_shell.decompose()
        remaining = _clean_text(soup.get_text(" ", strip=True))
        if len(remaining) < 400 and "bias rating" in remaining.casefold():
            soup.clear()
            return

    """Remove legacy recirculation and standardized article footers."""
    for node in list(
        soup.select(
            ".text-to-speech, .brokerboxarticle, .terminal-tout, "
            ".terminal-tout-v2, "
            ".article-audio-attachment, "
            ".email-form, .similarstoryslide, button.read-more-button, "
            ".inner-page-cta-section, .minimal-detailfull-width-section, "
            ".ipsEntry__signature, [data-role='memberSignature'], "
            ".commentWrapper, .comments, #story_tools_bottom, "
            ".share_list, .entry_sharing, "
            ".youMightAlsoLike, .Pbanner, "
            ".relatedKeywords, .waChannelCta, .b-share-bar, "
            ".liveEventMain_widget, .primeSWrapper, .ts-dots, "
            ".bottomTopics, .topicListContainer, .topicListTitle, .tags"
            ", [id^='views-bootstrap-article-node-view-block-']"
            ", .article-share, .sharedaddy, .sd-sharing"
            ", .ai_podcast_030825, .ai_podcast_bottom_sticky_player_241025"
            ", .popup_ai_pb_overlay, .td_module_wrap, .td_block_wrap"
            ", .news-detail-content-block.ai-post, #story-source-gallery"
            ", .xenforo-comment-widget, .cbcalc-wrap, .ai-block, .lf-funnel"
            ", .usstock_widget"
            ", [data-testid='headline-stack-promo-liner-test-id']"
            ", [data-testid='tags-test-id']"
            ", [class*='GooglePreferredSource_']"
            ", img[src*='groundnews.b-cdn.net']"
            ", [data-animation-role='button'], "
            "[data-content-field='tags']"
        )
    ):
        node.decompose()

    for control in list(soup.select("[role='button'], button")):
        if (
            control.name == "a"
            and control.select_one("img") is not None
            and not _clean_text(control.get_text(" ", strip=True))
        ):
            control.unwrap()
        else:
            control.decompose()

    embedded_most_read = re.compile(
        r"(?is)\s*most read from bloomberg(?: businessweek)?.*$"
    )
    for text_node in list(soup.find_all(string=embedded_most_read)):
        cleaned = embedded_most_read.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)

    australia_briefing = re.compile(
        r"(?is)(?:and\s+)?for\s+a\s+daily\s+wrap\s+of\s+the\s+business,"
        r"\s*finance\s+and\s+economic\s+stories\s+that\s+matter\s+to\s+"
        r"australians,?\s*from\s+"
        r"bloomberg(?:'s|’s)\s+reporters\s+around\s+the\s+globe,\s*"
        r"sign\s+up\s+to\s+our\s+free\s+australia\s+briefing\s+"
        r"newsletter\.\s*"
    )
    for text_node in list(soup.find_all(string=australia_briefing)):
        cleaned = australia_briefing.sub("", str(text_node)).strip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    inside_canada_subscription = re.compile(
        r"(?is)\s*to\s+subscribe\s+to\s+inside\s+canada,\s*"
        r"click\s+here,\s*"
        r"hit\s+[“\"]display\s*&\s*edit[”\"]\s+and\s+then\s+"
        r"[“\"]set alert delivery[”\"]\s*$"
    )
    for text_node in list(
        soup.find_all(string=inside_canada_subscription)
    ):
        cleaned = inside_canada_subscription.sub(
            "",
            str(text_node),
        ).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    # Legacy Bloomberg product press releases keep the substantive release
    # and a standardized Professional-service sales pitch in one ``pre``
    # text node. Truncate only at Bloomberg's distinctive boilerplate opener;
    # the following company profile and media contacts belong to the footer.
    professional_service_footer = re.compile(
        r"(?is)\s+the\s+bloomberg\s+professional(?:\^)?®\s+service\s+"
        r"delivers\s+reliable\s+access\s+to\s+the\s+latest\s+market\s+"
        r"data,\s+financial\s+news,\s+and\s+economic\s+information\s+"
        r"critical\s+to\s+the\s+investment\s+decision\s+process\..*$"
    )
    for text_node in list(
        soup.find_all(string=professional_service_footer)
    ):
        cleaned = professional_service_footer.sub(
            "",
            str(text_node),
        ).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    publisher_service_suffix = re.compile(
        r"(?is)\s+(?:\*\s*t\s+)?contributed via\s*:\s*"
        r"bloomberg publisher web service\s+provider id\s*:\s*"
        r"[0-9a-f]{32}\s*$"
    )
    for text_node in list(soup.find_all(string=publisher_service_suffix)):
        cleaned = publisher_service_suffix.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    # Bloomberg Sports product releases append a promotional link followed
    # by ``About`` profiles and press contacts as sibling blocks. Preserve
    # the preceding product announcement, but discard that standardized tail.
    for marker in list(soup.select("p")):
        if not re.fullmatch(
            r"For more information on Bloomberg Sports,\s*please visit "
            r"\S+ and follow us on Twitter\s*\(@BloombergSports\)\s*"
            r"and Facebook\.",
            _tag_text(marker),
            re.IGNORECASE,
        ):
            continue
        for sibling in list(marker.next_siblings):
            if isinstance(sibling, Tag):
                sibling.decompose()
            else:
                sibling.extract()
        marker.decompose()

    for marker in list(soup.select("h2, h3, h4, p")):
        if not re.fullmatch(
            r"(?i)contacts?\s+for\s+bloomberg\s*:?",
            _tag_text(marker),
        ):
            continue
        tail_start = marker
        previous = marker.find_previous_sibling()
        while isinstance(previous, Tag):
            if (
                previous.name in {"h2", "h3", "h4"}
                and re.fullmatch(
                    r"(?i)about\s+bloomberg",
                    _tag_text(previous),
                )
            ):
                tail_start = previous
                break
            if (
                previous.name == "p"
                and re.match(
                    r"(?i)^about\s+bloomberg\s+bloomberg,\s+"
                    r"the global business and financial information "
                    r"and news leader\b",
                    _tag_text(previous),
                )
            ):
                tail_start = previous
                break
            previous = previous.find_previous_sibling()
        for sibling in list(tail_start.next_siblings):
            if isinstance(sibling, Tag):
                sibling.decompose()
            else:
                sibling.extract()
        tail_start.decompose()

    embedded_recommendation = re.compile(
        r"(?is)\s*read (?:next:\s*\S.+|also:)\s*$"
    )
    for text_node in list(soup.find_all(string=embedded_recommendation)):
        cleaned = embedded_recommendation.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    maritime_tail = re.compile(
        r"(?is)\s*©\s*\d{4}\s+bloomberg\s+l\.p\.\s*"
        r"subscribe\s+for\s+daily\s+maritime\s+insights\b.*$"
    )
    for text_node in list(soup.find_all(string=maritime_tail)):
        cleaned = maritime_tail.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    for marker in list(soup.select("p, h2, h3, h4")):
        marker_text = (
            _clean_text(marker.get_text(" ", strip=True))
            .casefold()
            .rstrip(":")
        )
        if marker_text not in {
            "related stories",
            "most read from bloomberg",
            "most read from bloomberg businessweek",
            "did you miss?",
            "for more on equity markets",
            "see also",
            "read more",
        }:
            continue
        sibling = marker.find_next_sibling()
        if isinstance(sibling, Tag) and sibling.name in {"ul", "ol"}:
            sibling.decompose()
        marker.decompose()

    for marker in list(soup.select("p")):
        text = _clean_text(marker.get_text(" ", strip=True))
        if not re.search(
            r"(?i)more from bloomberg(?: opinion)?:\s*$",
            text,
        ):
            continue
        sibling = marker.find_next_sibling()
        if isinstance(sibling, Tag) and sibling.name in {"ul", "ol"}:
            sibling.decompose()
        for text_node in list(
            marker.find_all(
                string=re.compile(
                    r"(?i)more from bloomberg(?: opinion)?:\s*$"
                )
            )
        ):
            cleaned = re.sub(
                r"(?i)\s*more from bloomberg(?: opinion)?:\s*$",
                "",
                str(text_node),
            ).rstrip()
            if cleaned:
                text_node.replace_with(cleaned)
            else:
                text_node.extract()

    for text_node in list(
        soup.find_all(
            string=re.compile(
                r"(?i)for related news and information\s*:\s*$"
            )
        )
    ):
        parent = text_node.parent
        if (
            isinstance(parent, Tag)
            and parent.name == "p"
            and parent.find(
                "meta",
                attrs={
                    "itemprop": "type",
                    "content": "StoryLink",
                },
            )
            is not None
            and parent.find(
                "meta",
                attrs={
                    "itemprop": "type",
                    "content": "FunctionLink",
                },
            )
            is not None
        ):
            parent.decompose()
            continue
        cleaned = re.sub(
            r"(?i)\s*for related news and information\s*:\s*$",
            "",
            str(text_node),
        ).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    for marker in list(soup.select("h2, h3, h4, h5, h6, p")):
        marker_text = _clean_text(marker.get_text(" ", strip=True)).casefold()
        if marker_text not in {
            "more on this topic",
            "see more on",
            "prev post",
            "source link",
            "top tech stories",
        }:
            continue
        tail = marker
        while isinstance(tail.parent, Tag):
            for sibling in list(tail.next_siblings):
                if isinstance(sibling, Tag):
                    sibling.decompose()
                else:
                    sibling.extract()
            if tail.parent is soup or tail.parent.name in {"article", "main"}:
                break
            tail = tail.parent
        marker.decompose()

    for preformatted in list(soup.select("pre")):
        raw_text = preformatted.get_text("\n", strip=False)
        contact_match = re.search(
            r"(?i)(?:^|\n)\s*(?:--\s*bloomberg news\s*\n\s*)?"
            r"to contact (?:the (?:writers?|authors?|reporters?|editors?)|"
            r"bloomberg news)\b",
            raw_text,
        )
        if contact_match:
            retained = raw_text[: contact_match.start()].rstrip()
            if re.fullmatch(
                r"(?i)\s*(?:--|—|–)\s*"
                r"[^\W\d_][\w .,'’\-]{1,100}\s*",
                retained,
            ):
                retained = ""
            if retained:
                preformatted.clear()
                preformatted.append(retained)
            else:
                preformatted.decompose()

    for table in list(soup.select("table")):
        table_text = _clean_text(table.get_text(" ", strip=True))
        if re.match(
            r"(?i)^(?:read more(?:\s+on the topic)?\s*:?\s+\S|"
            r"take the mliv pulse survey\b)",
            table_text,
        ):
            table.decompose()
    footer_patterns = (
        re.compile(r"(?i)^©\s*\d{4}\s+bloomberg\s+l\.?p\.?$"),
        re.compile(r"(?i)^©\s*\d{4}\s+bloomberg$"),
        re.compile(r"(?i)^(?:--|—|–)\s*bloomberg news\.?$"),
        re.compile(
            r"(?i)^please enable javascript to view the comments "
            r"powered by disqus\.?$"
        ),
        re.compile(
            r"(?i)^tweet\s+more business exchange\s+buzz up!?\s+"
            r"digg\s+print\s+email$"
        ),
        re.compile(
            r"(?i)^(?:#<[^<>]{1,100}>#\s*)?-0-\s+"
            r"[a-z]{3}/\d{1,2}/\d{4}\s+"
            r"\d{2}:\d{2}\s+gmt$"
        ),
        re.compile(r"^#<[\d.]{3,100}>#$"),
        re.compile(
            r"(?i)^for more bloomberg multimedia see\s*"
            r"\{\s*av\s*<go>\s*\}\s*$"
        ),
        re.compile(
            r"(?i)^top stories\s*:\s*top\s+"
            r"top bond stories\s*:\s*top bon\s+"
            r"bloomberg billionaires index\s*:\s*rich\s*$"
        ),
        re.compile(
            r"(?i)^regional news\s*:\s*"
            r"(?:ni\s+[a-z]{2,3}\s+[\w .,'’&()-]+"
            r"(?:\s+|$)){1,12}$"
        ),
        re.compile(
            r"(?i)^(?:market news\s*:\s*)?"
            r"(?:commodity news\s*:\s*)?"
            r"(?:"
            r"(?:ni|cmdy)\s+[a-z0-9]{2,10}\s+[\w .,'’&()/-]+?"
            r")(?:\s+(?:ni|cmdy)\s+[a-z0-9]{2,10}\s+"
            r"[\w .,'’&()/-]+?){1,12}$"
        ),
        re.compile(r"(?i)^related tickers\s*:\s*.+$"),
        re.compile(r"(?i)^author$"),
        re.compile(r"(?i)^and yet equinor still\.*$"),
        re.compile(
            r"(?i)^https?://www\.gata\.org/sites/default/files/"
            r"gata-silver-round-front\.png$"
        ),
        re.compile(
            r"(?i)^get the latest nigerian news delivered to your inbox\.?$"
        ),
        re.compile(
            r"(?i)^food safety news is nonprofit and reader-funded\.\s*"
            r"your tax-free gift ensures ongoing coverage of outbreaks,\s*"
            r"recalls, and regulations for everyone\.?$"
        ),
        re.compile(r"(?i)^your support protects public health$"),
        re.compile(
            r"(?i)^follow .{1,100}(?:'|’)s business section "
            r"on twitter\.?$"
        ),
        re.compile(
            r"(?i)^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
            r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
            r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
        ),
        re.compile(r"(?i)^\*+\s*with bloomberg\.?$"),
        re.compile(
            r"(?i)^(?:(?:notice an issue\?\s*)?arabian post strives to "
            r"deliver the most accurate and reliable information to its "
            r"readers\.\s*)?if you believe you have identified an error "
            r"or inconsistency in this article\b.*$"
        ),
        re.compile(r"(?i)^follow arabian post$"),
        re.compile(
            r"(?i)^select arabian post as your preferred source on "
            r"google and msn news\b.*$"
        ),
        re.compile(
            r"(?i)^written by:\s*.+\s+—\s+with assistance from .+"
            r"@bloomberg$"
        ),
        re.compile(
            r"(?i)^(?:-{1,2}|—|–)\s*with assistance (?:from|by)\b.+"
            r"(?:\.\s*editors?\s*:.+)?$"
        ),
        re.compile(r"(?i)^with assistance (?:from|by)\b.+\.?$"),
        re.compile(
            r"(?i)^with assistance from\b.+\s+(?:--|—|–)\s*"
            r"editors?\s*:\s*.+$"
        ),
        re.compile(
            r"(?i)^for more articles like this,\s*"
            r"please visit us at bloomberg\.com\.?$"
        ),
        re.compile(
            r"(?i)^visit (?:https?://)?(?:www\.)?bloomberg\.com/"
            r"sustainability/? for the latest from bloomberg news about "
            r"energy,\s*natural resources and global business\.?$"
        ),
        re.compile(
            r"(?i)^for more about bloomberg bna,\s*click here\s*\.\s*"
            r"visit (?:https?://)?(?:www\.)?bloomberg\.com/"
            r"sustainability/? for the latest from bloomberg news about "
            r"energy,\s*natural resources and global business\.?$"
        ),
        re.compile(
            r"(?i)^visit the grid for the latest about energy,\s*"
            r"natural resources and global business\.?$"
        ),
        re.compile(
            r"(?i)^read more (?:opinion online|online opinion|online) "
            r"from bloomberg view\s*[:.]?$"
        ),
        re.compile(r"(?i)^read more bloomberg view op-eds\s*\.?$"),
        re.compile(r"(?i)^read more bloomberg view editorials\s*\.?$"),
        re.compile(r"(?i)^today(?:'|’)s highlights\s*:\s*.+$"),
        re.compile(
            r"(?i)^also,\s*the editors on\b.{1,800}"
            r"(?:;\s*.{1,200}){1,12}\.?$"
        ),
        re.compile(
            r"(?i)^read more opinion online from bloomberg view\s*\.\s*"
            r"subscribe to receive a daily e-?mail highlighting new view "
            r"(?:columns,\s*editorials|editorials,\s*columns) "
            r"and op-ed articles\.?$"
        ),
        re.compile(
            r"(?i)^for more quick commentary from bloomberg view,\s*"
            r"go to the ticker\s*\.?$"
        ),
        re.compile(
            r"(?i)^read more breaking commentary from bloomberg view "
            r"(?:(?:columnists|editors)(?:\s+and\s+(?:columnists|editors))?"
            r"\s+)?at the ticker\s*\.?$"
        ),
        re.compile(
            r"(?i)^read more breaking commentary from .{2,100} "
            r"and other bloomberg view columnists and editors "
            r"at the ticker\s*\.?$"
        ),
        re.compile(
            r"(?i)^for more,\s*read this quicktake\s*:\s*\S.+$"
        ),
        re.compile(r"(?i)^\*?\s*link to earlier story\s*:\s*\S.+$"),
        re.compile(r"(?i)^\*{3}\s*end of transcript\s*\*{3}$"),
        re.compile(r"(?i)^running time\s*:?\s*\d{1,3}:\d{2}$"),
        re.compile(r"^_{3,}$"),
        re.compile(r"(?i)^provider id\s*:\s*[0-9a-f]{32}$"),
        re.compile(
            r"(?i)^contributed via\s*:\s*"
            r"bloomberg publisher web service$"
        ),
        re.compile(
            r"(?i)^generated by bloomberg publisher web service$"
        ),
        re.compile(
            r"(?i)^.{2,250}\bcontributed to this report\.?$"
        ),
        re.compile(
            r"(?i)^.{2,250}\bcontributed to this story"
            r"(?:\s+from\s+.{2,100})?\.?$"
        ),
        re.compile(
            r"(?i)^to watch the video,\s*click here\s*\.?$"
        ),
        re.compile(
            r"(?i)^webrep\s+currentvote\s+norating\s+noweight$"
        ),
        re.compile(
            r"(?i)^(?:--|—|–)\s*[^\W\d_][\w .,'’\-]{1,100}$"
        ),
        re.compile(
            r"(?i)^to see the patent,\s*click\s*:\s*[\d,]+\.?$"
        ),
        re.compile(r"(?i)^to see the patent\s*:\s*[\d,]+\.?$"),
        re.compile(
            r"(?i)^to read the publisher(?:'|’)s web page on the book,\s*"
            r"https?://\S+\.?$"
        ),
        re.compile(
            r"(?i)^(?:to buy this book(?:\s+in\s+"
            r"(?:north america|the u\.?s\.?))?|"
            r"to order(?: this book)?\s+in\s+"
            r"(?:north america|the u\.?s\.?))\s*,\s*"
            r"click here\s*\.?$"
        ),
        re.compile(r"^(?:[•·]\s*){3,}$"),
        re.compile(
            r"(?i)^watch charlie rose on bloomberg tv weeknights\b.*$"
        ),
        re.compile(
            r"(?i)^(?:—|–|--?)\s*with\s+"
            r"[^\W\d_][\w .,'’\-]{1,100}$"
        ),
        re.compile(
            r"(?i)^(?:--|—)\s*[\w .,'’&-]+\s+in\s+"
            r"[\w .,'’&-]+\s+(?:\(\+?\d{1,3}\)|\+?\d)"
            r"[\d -]{6,}$"
        ),
        re.compile(
            r"(?i)^(?:--|—)\s*bloomberg radio\s+\+?\d[\d -]{6,}$"
        ),
        re.compile(
            r"(?i)^siehe dazu auch\s*:\s*fortlaufende kurzmeldungen\s*:\s*"
            r"first\s*<go>\s*first word überschriften\s*:\s*"
            r"nh\s+bfw\s*<go>\s*$"
        ),
        re.compile(
            r"(?i)^überschrift des artikels im original\s*:\s*\S.+$"
        ),
        re.compile(
            r"(?i)^[a-z]{2,5}\s+[a-z0-9]{8,14}\s+<go>\s+\S.+$"
        ),
        re.compile(
            r"(?i)^(?:[a-z]{2,5}\s+)?nsn\s+"
            r"[a-z0-9]{8,14}\s+<go>\s+\S.+$"
        ),
        re.compile(
            r"(?is)^to analyze this 13f\s*:.*<go>.*"
            r"to analyze all 13f(?:'|’)s filed,.*<go>.*$"
        ),
        re.compile(
            r"(?i)^emerging-markets market view\s*:\s*\{emmv\b.*$"
        ),
        re.compile(r"(?is)^相關新聞和信息\s*：.*<go>.*$"),
        re.compile(r"(?is)^相关新闻和信息\s*[：:].*<go>.*$"),
        re.compile(r"(?is)^原文标题\s+\S.+$"),
        re.compile(r"(?is)^관련 기사 및 정보 보기\s*:.*<go>.*$"),
        re.compile(r"(?is)^원본 기사\s*:.*$"),
        re.compile(r"(?is)^--\s*취재보조\s*:.*$"),
        re.compile(r"(?is)^본 기사의 번역자\s*:.*$"),
        re.compile(
            r"(?is)^.*\bnsn\s+[a-z0-9]{8,14}\s*<go>\s*$"
        ),
        re.compile(
            r"(?i)^(?:today(?:'|’)s\s+)?muse highlights include "
            r".{2,180}\.?$"
        ),
        re.compile(
            r"(?i)^(?:today(?:'|’)s\s+)?muse highlights include\s*:\s*"
            r".{2,180}\.?$"
        ),
        re.compile(
            r"(?i)^\(?to save a copy of the chart,\s*click here\.\)?$"
        ),
        re.compile(r"(?i)^click here for (?:the )?web link\.?$"),
        re.compile(r"(?i)^for related news and information\s*:?.*$"),
        re.compile(r"(?is)^related news and information\s*:.*$"),
        re.compile(r"(?i)^for more on .{2,160},\s*click here\.?$"),
        re.compile(
            r"(?i)^for the latest verdict and settlement news,\s*"
            r"click here\.?$"
        ),
        re.compile(
            r"(?i)^for the latest new suits news,\s*click here\.\s*"
            r"for copies of recent civil complaints,\s*click here\."
            r"(?:\s*for the latest lawsuits news,\s*click here\.)?$"
        ),
        re.compile(
            r"(?i)^for the latest litigation department news,\s*"
            r"click here\.?$"
        ),
        re.compile(
            r"(?i)^for the latest lawsuits news,\s*click here\.?$"
        ),
        re.compile(
            r"(?i)^for the latest trial and appeals news,\s*click here\.?$"
        ),
        re.compile(
            r"(?i)^this is a bloomberg podcast\.\s*to download,\s*"
            r"watch or listen (?:to this report )?now,\s*click here\.?$"
        ),
        re.compile(
            r"(?i)^\(?to listen to the podcast,\s*click here\s*\.?\)?$"
        ),
        re.compile(r"(?i)^for more,\s*read this next\s*:\s*$"),
        re.compile(r"(?i)^for more,\s*read this next\s*:\s*\S.+$"),
        re.compile(
            r"(?i)^for more,\s*click here"
            r"(?:(?:,\s*)?\s+and\s+(?:click\s+)?here)?\s*\.?$"
        ),
        re.compile(
            r"(?i)^for the video,\s*click here,\s*and for more,\s*"
            r"click here\.?$"
        ),
        re.compile(r"(?i)^for the video,\s*click here\.?$"),
        re.compile(r"(?i)^for the audio,\s*click here\.?$"),
        re.compile(
            r"(?i)^to read more from .{2,180},\s*click here\s*\.?$"
        ),
        re.compile(
            r"(?i)^to read more of this story,\s*click here\s*\.?$"
        ),
        re.compile(
            r"(?i)^to read the story,\s*click here\s*\.?$"
        ),
        re.compile(
            r"(?i)^to read bloomberg coverage,\s*click here\s*\.?$"
        ),
        re.compile(
            r"(?i)^for a slideshow\b.{1,220},\s*click here\s*\.?$"
        ),
        re.compile(
            r"(?i)^for more .{2,100} news from last week,\s*"
            r"click here(?:\.\s*for copies of recent civil complaints,\s*"
            r"click here)?\.?$"
        ),
        re.compile(r"(?i)^read more echoes columns online\s*\.?$"),
        re.compile(r"(?i)^read more from echoes online\s*\.?$"),
        re.compile(r"(?i)^read more bloomberg view columns\s*\.?$"),
        re.compile(r"(?i)^read more in our full story\s*\.?$"),
        re.compile(
            r"(?i)^read more(?:\s+from)?\s+echoes\s*,?\s*"
            r"bloomberg view(?:'|’)s economic history blog\s*\.?$"
        ),
        re.compile(
            r"(?i)^for (?:more )?(?:copyright|patent|trademark) news,\s*"
            r"click here\.?$"
        ),
        re.compile(
            r"(?i)^link to company news\s*:\s*"
            r"\{[^{}]{1,80}<equity>\s+cn(?:\s+<go>)?\}"
            r"(?:\s*\{[^{}]{1,80}<equity>\s+cn(?:\s+<go>)?\})*\s*$"
        ),
        re.compile(
            r"(?i)^(?:link to company news\s*:\s*"
            r"\{[^{}]{1,80}<equity>\s+cn(?:\s+<go>)?\}\s*){2,}$"
        ),
        re.compile(
            r"(?i)^link to statement\s*:\s*\{\s*https?://[^{}\s]+\s*\}\s*"
            r"link to company news\s*:\s*"
            r"\{[^{}]{1,80}<equity>\s+cn(?:\s+<go>)?\}\s*$"
        ),
        re.compile(
            r"(?i)^link to statement\s*:\s*"
            r"\{\s*nsn\s+[a-z0-9]{8,14}\s+<go>\s*\}\s*$"
        ),
        re.compile(r"(?i)^link to statement\s*:\s*link\s*$"),
        re.compile(
            r"(?i)^hedge[- ]fund rankings\s*:\s*\{\s*hfnd"
            r"(?:\s*<go>)?\s*\}?\s*$"
        ),
        re.compile(
            r"(?i)^story link\s*:\s*"
            r"\{\s*nsn\s+[a-z0-9]{8,14}\s*<go>\s*\}\s*$"
        ),
        re.compile(
            r"(?i)^bi airm\s*<go>\s+for commercial aircraft "
            r"manufacturers(?:'|’) dashboard\s+bi airl eu\s*<go>\s+"
            r"european airline dashboard\s+bi airmg indd\s*<go>\s+"
            r"monthly orders for new aircraft,\s*parked fleet "
            r"statistics\.?$"
        ),
        re.compile(
            r"(?i)^\(to be sent this nordic credit column,\s*click here\.\s*"
            r"for more credit market news,\s*top cm\.\)$"
        ),
        re.compile(
            r"(?i)^to see the methodology and exact wording of the poll "
            r"questions,\s*click on the attachment tab at the top of "
            r"the story\.?$"
        ),
        re.compile(
            r"(?i)^.{2,100}\bis (?:the )?.{2,100} for bloomberg\.\s*"
            r"follow (?:him|her|them) on twitter\b.*$"
        ),
        re.compile(
            r"(?i)^.{2,100}\bis (?:the )?(?:co-)?author of "
            r".{2,300}\.\s+(?:he|she|they) (?:advises?|writes?|works?)\b"
            r".{2,300}\.\s*follow (?:him|her|them) on twitter\b.*$"
        ),
        re.compile(r"(?i)^(?:\*t\s*)+$"),
        re.compile(
            r"(?i)^to contact the "
            r"(?:authors? of|editors? responsible for|reporters? on) "
            r"this (?:story|article)\s*:"
        ),
        re.compile(
            r"(?i)^to contact the (?:lead )?author of this column\s*:"
        ),
        re.compile(
            r"(?i)^to contact (?:the )?bloomberg news staff for this "
            r"(?:story|article)\s*:"
        ),
        re.compile(
            r"(?i)^to contact the "
            r"(?:writers?|authors?|reporters?|editors?) "
            r"(?:for|of|on|responsible for) (?:this|the|his|her) "
            r"(?:story|article|column|review|slideshow|(?:blog )?post)\s*:?"
        ),
        re.compile(
            r"(?i)^to see a slideshow of photos\b.*"
            r"\{[^{}]{1,30}<go>\}.*\{[^{}]{1,30}<go>\}\.?$"
        ),
        re.compile(
            r"(?i)^click on [“\"]send comment[”\"] in (?:the )?sidebar display "
            r"to send a letter to the editor\.?$"
        ),
        re.compile(
            r"(?i)^click on\s*\{\s*lett\s*<go>\s*\}\s*"
            r"to send a letter to the editor\.?$"
        ),
        re.compile(
            r"(?i)^(?:(?:-{1,2}|—|–)\s*)?"
            r"editors?\s*:\s*[\w .,'’&-]+$"
        ),
        re.compile(r"(?i)^editors?\s*:\s*$"),
        re.compile(
            r"(?i)^(?:-{1,2}|—|–)\s*[\w .,'’&-]+\.\s*"
            r"editors?\s*:\s*[\w .,'’&-]+$"
        ),
        re.compile(r"(?i)^[a-z0-9._%+-]+@bloomberg\.net\s*[.;]?$"),
        re.compile(
            r"(?i)^join the discussion on the bloomberg businessweek "
            r"business school forum\b"
        ),
        re.compile(
            r"(?i)^©\s*\d{4}\s+trend news agency\.?\s*"
            r"all rights reserved\.?$"
        ),
        re.compile(
            r"(?i)^to contact the (?:senior )?editor responsible for "
            r"bloomberg view(?:'s|’s) editorials\s*:"
        ),
        re.compile(
            r"(?i)^to contact the (?:senior )?editor responsible for "
            r"bloomberg opinion(?:'s|’s) editorials\s*:"
        ),
        re.compile(
            r"(?i)^this (?:column|article) does not necessarily reflect "
            r"the opinion of (?:the editorial board or )?"
            r"bloomberg lp and its owners\.?$"
        ),
        re.compile(
            r"(?i)^\(?this (?:column|article) does not necessarily reflect "
            r"the opinion of (?:the editorial board or )?"
            r"bloomberg lp and its owners\.\)?$"
        ),
        re.compile(
            r"(?i)^\(?this (?:column|article) does not necessarily reflect "
            r"the opinion of bloomberg (?:view|opinion)(?:'|’)s "
            r"editorial board or bloomberg lp,\s*its owners and investors"
            r"\.\)?$"
        ),
        re.compile(
            r"(?is)^this transcript may not be 100% accurate\b.*"
            r"any opinion expressed in the transcript does not necessarily "
            r"reflect the views of bloomberg lp\.?$"
        ),
        re.compile(
            r"(?i)^follow @\w+ for all the latest news, and sign up (?:for|to) "
            r"our daily .+ newsletter\.?$"
        ),
        re.compile(
            r"(?i)^follow @\w+ on twitter for more(?: on)? .{2,160}\.?$"
        ),
        re.compile(r"(?i)^\*\s*bloomberg\.?$"),
        re.compile(
            r"(?i)^subscribe to .+ on "
            r"(?:itunes|apple) podcasts(?:\s+subscribe to .+ on "
            r"pocket casts)?\.?$"
        ),
        re.compile(
            r"(?i)^subscribe to .+ on pocket casts\.?$"
        ),
        re.compile(
            r"(?i)^subscribe to .+ on pocketcasts?\.?$"
        ),
        re.compile(
            r"(?i)^terminal users\s*:\s*click here to play now\.?$"
        ),
        re.compile(
            r"(?i)^if you(?:'|’)d like to get the daily prophet in "
            r"e-?mail form, right in your inbox, please subscribe "
            r"to this link\s*\.\s*thanks!?"
        ),
        re.compile(
            r"(?i)^start your day with what(?:'|’)s moving markets in asia\. "
            r"sign up here to receive our newsletter\.?$"
        ),
        re.compile(
            r"(?i)^sign up for (?:our new china newsletter|china rising)\s*,"
            r"\s*a (?:new )?weekly dispatch(?:\s+coming soon)? on where china "
            r"stands now and where it(?:'|’)s going next\.?$"
        ),
        re.compile(
            r"(?i)^sign up to receive the brexit bulletin in your inbox, "
            r"and follow @brexit on twitter\.?$"
        ),
        re.compile(
            r"(?i)^sign up to receive the brexit bulletin, a daily briefing "
            r"on the biggest news related to britain(?:'|’)s departure "
            r"from the eu\.?$"
        ),
        re.compile(
            r"(?i)^a version of this column originally appeared in "
            r"bloomberg(?:'|’)s fully charged technology newsletter\. "
            r"you can sign up here\s*\.?$"
        ),
        re.compile(
            r"(?i)^want to hear more\? subscribe on apple podcasts and "
            r"pocket casts for new episodes every week\."
        ),
        re.compile(
            r"(?i)^\(?\s*sign up for the .+ newsletter, your best source "
            r"for .+\)?\.?$"
        ),
        re.compile(
            r"(?i)^want to go deeper inside .+\? sign up for .+ newsletter "
            r"from bloomberg\.?$"
        ),
        re.compile(
            r"(?i)^for a fresh perspective on .+, sign up for our weekly "
            r"newsletter\s*\.?$"
        ),
        re.compile(
            r"(?i)^want\s+more\s+personal\s+finance\s+news\?\s*"
            r"sign\s+up\s+for\s+our\s+weekly\s+personal\s+finance\s+"
            r"newsletter,\s*wealth\s+watch\.?\s*$"
        ),
        re.compile(
            r"(?i)^new to bloomberg opinion today\?\s*"
            r"(?:sign up\s+)?and follow us on twitter and facebook\s*\.?$"
        ),
        re.compile(
            r"(?i)^(?:sign up here\s+)?and follow us on twitter "
            r"and facebook\s*\.?$"
        ),
        re.compile(
            r"(?i)^sign up for bloomberg(?:'|’)s daily technology "
            r"newsletter here\s*\.?$"
        ),
        re.compile(
            r"(?i)^subscribe now to stay ahead with the most trusted "
            r"business news source\.?$"
        ),
        re.compile(
            r"(?i)^(?:follow ht tech on\s+)?facebook\s*,\s*google news\s*,"
            r"\s*and instagram\s*\.\s*for our latest videos,\s*"
            r"subscribe to our youtube channel\s*\.?$"
        ),
        re.compile(
            r"(?i)^catch all the latest tech news\s*,\s*mobile news\s*,"
            r".*for our latest videos,\s*subscribe to our youtube "
            r"channel\s*\.?$"
        ),
        re.compile(
            r"(?i)^sign up for our .+ weekly newsletter, follow us @\w+ "
            r"and subscribe to our podcast\.?$"
        ),
        re.compile(
            r"(?i)^for the best in travel, food, drinks, fashion, cars, "
            r"and life, sign up for the pursuits newsletter\s*\.\s*"
            r"delivered weekly\.?$"
        ),
        re.compile(
            r"(?i)^want to receive this post, and more, into your inbox "
            r"every morning\?\s*sign up here\.?$"
        ),
        re.compile(
            r"(?i)^for more (?:copyright|patent) news,\s*click here\.?$"
        ),
        re.compile(
            r"(?i)^for related stories\s+to see today(?:'|’)s top "
            r"sports stories,\s*see:\s*\{ispo\s*<go>\}\.?$"
        ),
        re.compile(
            r"(?i)^all the .{2,80}\b(?:news|results)"
            r"(?:\s+and\s+(?:news|results))?\s+can be found at\s+"
            r"[a-z]{2,8}\s*<go>\s*\.?$"
        ),
        re.compile(
            r"(?is)^related news and information:\s*"
            r".*\{[^{}]{1,30}<go>\}.*\{[^{}]{1,30}<go>\}.*$"
        ),
        re.compile(
            r"(?is)^stories related to the ecb\s*:\s*"
            r".*\{[^{}]{1,30}<go>\}.*\{[^{}]{1,30}<go>\}.*$"
        ),
        re.compile(
            r"(?i)^to view the source of this information click here\.?$"
        ),
        re.compile(r"(?i)^read more\s*:\s*\S.+$"),
        re.compile(
            r"(?i)^get early returns every morning in your inbox\.\s*"
            r"click here to subscribe\.\s*also subscribe to bloomberg "
            r"all access\b.*$"
        ),
        re.compile(
            r"(?i)^want more bloomberg opinion\?\s*terminal readers "
            r"head to opin\s*<go>\.\s*web readers click here\.?$"
        ),
        re.compile(
            r"(?i)^for more bloomberg opinion,\s*subscribe to our "
            r"newsletter\.?$"
        ),
        re.compile(r"(?i)^for more bloomberg view columns\.?$"),
        re.compile(
            r"(?i)^read more bloomberg sustainability news and "
            r"follow us on twitter\s*\.?$"
        ),
        re.compile(
            r"(?i)^sign up for the brief,\s*a daily afternoon newsletter "
            r"showcasing bloomberg law(?:'s|’s) top stories\.?$"
        ),
        re.compile(
            r"(?i)^sign up for bloomberg(?:'s|’s) business of sports "
            r"newsletter\b.*$"
        ),
        re.compile(
            r"(?i)^sign up for the equality newsletter for weekly "
            r"reporting\b.*$"
        ),
        re.compile(
            r"(?i)^sign up for the washington edition newsletter to "
            r"find out how the worlds? of money and politics intersect "
            r"in the us capital\.?$"
        ),
        re.compile(
            r"(?i)^sign up for the twice-weekly next africa newsletter "
            r"for the latest business and economic news from the "
            r"continent\.?$"
        ),
        re.compile(
            r"(?i)^sign up here for the twice-weekly next africa "
            r"newsletter,\s*and subscribe to the next africa podcast\b.*$"
        ),
        re.compile(
            r"(?i)^or want more lifestyle and passion stories\?\s*"
            r"click here\.?$"
        ),
        re.compile(
            r"(?i)^generated by readers,\s*the comments included herein "
            r"do not reflect the views and opinions of rigzone\.\s*"
            r"all comments are subject to editorial review\..*$"
        ),
        re.compile(
            r"(?i)^(?:\(bloomberg\)\s*(?:--|—)\s*)?sign up for "
            r"(?:the\s+)?(?:daily\s+)?india "
            r"edition newsletter\b.*$"
        ),
        re.compile(
            r"(?i)^sign up for the business of food newsletter\b.*$"
        ),
        re.compile(
            r"(?i)^want more bloomberg opinion\?\s*opin\s*<go>\.\s*"
            r"or (?:you can )?subscribe to our daily newsletter\.?$"
        ),
        re.compile(
            r"(?i)^[\u200b-\u200f\u2060\ufeff]*"
            r"want more (?:from )?bloomberg opinion\?\s*"
            r"opin\s*<go>(?:\s*on the terminal)?\.\s*"
            r"(?:web readers,?\s*click here\.\s*)?"
            r"or (?:you can )?subscribe to our daily newsletter\.?$"
        ),
        re.compile(
            r"(?i)^[\u200b-\u200f\u2060\ufeff]*"
            r"want more bloomberg opinion\?\s*terminal readers "
            r"head to opin\s*<go>\.\s*or (?:you can )?subscribe to our "
            r"daily newsletter\.?$"
        ),
        re.compile(
            r"(?i)^[\u200b-\u200f\u2060\ufeff]*"
            r"want more bloomberg opinion\?\s*head to opin\s*<go>\.\s*"
            r"or (?:you can )?subscribe to our daily newsletter\.?$"
        ),
        re.compile(
            r"(?i)^more stories like this are available on "
            r"bloomberg\.com\.?$"
        ),
        re.compile(
            r"(?i)^sign up here and follow us on threads,\s*tiktok,\s*"
            r"twitter,\s*instagram and facebook\.?$"
        ),
        re.compile(
            r"(?i)^subscribe to the economic times prime and read the "
            r"et epaper online\.?$"
        ),
        re.compile(
            r"(?i)^\(?catch all the business news\s*,\s*breaking news "
            r"and latest news updates on the economic times\s*\.\)?$"
        ),
        re.compile(r"(?i)^more on bloomberg:?$"),
        re.compile(r"(?i)^read more\s*@\s*bloomberg\.?$"),
        re.compile(
            r"(?i)^you want more news on this market\?\s*click here for "
            r"a curated first word channel\b.*$"
        ),
        re.compile(
            r"(?i)^take the mliv pulse survey\b.*share your thoughts\.?$"
        ),
        re.compile(r"(?i)^continue for free$"),
        re.compile(r"(?i)^you can follow lev menand at @levmenand\.?$"),
        re.compile(
            r"(?i)^follow the market issue situation with our daily "
            r"updates\.?$"
        ),
        re.compile(r"(?i)^what do you think\?$"),
        re.compile(
            r"(?i)^get in-depth insights from our expert contributors,\s*"
            r"and dive into financial and economic trends\.?$"
        ),
        re.compile(
            r"(?i)^new us stocks insights\s*&\s*wraps\b.*"
            r"click here to see and subscribe\.?$"
        ),
        re.compile(
            r"(?i)^read more stories about where the money flows,\s*"
            r"and analysis of the biggest market stories from singapore "
            r"and around the world\.?$"
        ),
        re.compile(
            r"(?i)^click here to stay updated with the latest business "
            r"& investment news in singapore\.?$"
        ),
        re.compile(r"(?i)^source:\s*https?://(?:www\.)?bloomberg\.com/?$"),
        re.compile(r"(?i)^source\s*:\s*bloomberg\.?$"),
        re.compile(r"(?i)^read:\s+.{10,200}$"),
        re.compile(r"(?i)^to view or add a comment,\s*sign in\.?$"),
        re.compile(r"(?i)^thank you for your report!?$"),
        re.compile(
            r"(?i)^please enable javascript to view this content\.?$"
        ),
        re.compile(r"(?i)^uploaded by .{2,100}$"),
        re.compile(r"(?i)^top trending stocks\s*:.*share price\b.*$"),
        re.compile(r"(?i)^get automatic alerts for this topic\.?$"),
        re.compile(r"(?i)^about this source$"),
        re.compile(
            r"(?i)^⚠?\ufe0f?\s*disclaimer:\s*this content is for training "
            r"purposes only\b.*$"
        ),
        re.compile(
            r"(?i)^this article was generated from an automated news "
            r"agency feed without modifications to text\.?$"
        ),
        re.compile(r"(?i)^share this\s*:$"),
        re.compile(r"(?i)^📰\s*source$"),
        re.compile(
            r"(?i)^for complete coverage and additional details,\s*"
            r"visit the original article published by bloomberg\.com\.?$"
        ),
        re.compile(r"(?i)^bloomberg\.com$"),
        re.compile(
            r"(?i)^subscribe to et prime and read the economic times "
            r"epaper online\..*$"
        ),
        re.compile(
            r"(?is)^\(?what(?:'|’)s moving sensex and nifty\b.*"
            r"subscribe to our telegram feeds\s*\.\)?$"
        ),
        re.compile(r"(?i)^read the full article$"),
        re.compile(
            r"(?i)^get the latest insurance news sent straight to "
            r"your inbox\.?$"
        ),
        re.compile(r"(?i)^maritime and shipping$"),
        re.compile(r"(?i)^discussion$"),
        re.compile(
            r"(?i)^the post .+ first appeared on bloomberg\.?$"
        ),
        re.compile(
            r"(?i)^©\s*\d{4}\s+the block\.\s*all rights reserved\..*$"
        ),
        re.compile(
            r"(?i)^unlock full access to podcast analytics,\s*"
            r"audience demographics\b.*$"
        ),
        re.compile(
            r"(?i)^recipients will be able to read the full text of "
            r"the article after submitting their email address\b.*$"
        ),
        re.compile(r"(?i)^原文標題\s*.+$"),
        re.compile(r"(?i)^interested in profit loss\s*\?$"),
        re.compile(r"(?i)^interested in claims\s*\?$"),
        re.compile(r"(?i)^listen to this article in summarized format$"),
        re.compile(r"(?i)^most popular$"),
        re.compile(r"(?i)^want to stay up to date\?$"),
        re.compile(r"(?i)^get more podcast analytics$"),
        re.compile(
            r"(?i)^ai-analyzed african market trends delivered to "
            r"your inbox\b.*$"
        ),
        re.compile(r"(?i)^the source\s*:\s*bloomberg$"),
        re.compile(
            r"(?i)^get push alerts the moment our analysts spot setups "
            r"around news events\b.*$"
        ),
        re.compile(
            r"(?i)^sign up here for the daily next africa newsletter "
            r"and subscribe to the next africa podcast\b.*$"
        ),
        re.compile(r"(?i)^advertisement\s*:\s*$"),
        re.compile(r"(?i)^here are more articles you may enjoy\.?$"),
        re.compile(r"(?i)^trade these moves with signalpro$"),
        re.compile(
            r"(?i)^related coverage:\s*.+"
        ),
        re.compile(
            r"(?i)^each image keeps its publisher,\s*caption or article "
            r"title,\s*citation text\b.*$"
        ),
        re.compile(r"(?i)^was this article valuable\?$"),
        re.compile(
            r"(?i)^estimates show your actual share of cashback\b.*"
            r"see full vip trader hub\s*→?$"
        ),
        re.compile(r"(?i)^interested in ai\s*\?$"),
        re.compile(
            r"(?i)^want more bloomberg opinion\?\s*terminal readers,?\s*"
            r"head\s*to\s*opin\s*<go>\.\s*or subscribe to our daily "
            r"newsletter\.?$"
        ),
        re.compile(
            r"(?i)^move the slider to your real monthly trading volume\b.*$"
        ),
        re.compile(
            r"(?i)^disclaimer:\s*the block is an independent media "
            r"outlet that delivers news,\s*research,\s*and data\b.*$"
        ),
        re.compile(
            r"(?i)^previous article\s+next article\b.*$"
        ),
        re.compile(r"(?i)^buy gold$"),
        re.compile(r"(?i)^trending now$"),
        re.compile(
            r"(?i)^build draft survey skills through practical training\b.*$"
        ),
        re.compile(
            r"(?i)^written (?:by|by:)\s+.{2,100}(?:@bloomberg)?$"
        ),
        re.compile(r"(?i)^how much could you earn back per year\?$"),
        re.compile(r"(?i)^related articles$"),
        re.compile(r"(?i)^topics\s+lawsuits\s+claims\s+oklahoma$"),
        re.compile(
            r"(?i)^for complete coverage and additional details,\s*"
            r"visit the original article published by bloomberg"
            r"(?:\.com)?\.?$"
        ),
        re.compile(r"(?i)^cashback calculator$"),
        re.compile(r"(?i)^advanced draft survey$"),
        re.compile(r"(?i)^printer friendly version$"),
        re.compile(
            r"(?i)^trading involves risk of loss\.\s*cashback rates "
            r"are estimates\b.*$"
        ),
        re.compile(r"(?i)^african reviewer\s+view all posts$"),
        re.compile(r"(?i)^s&p 500 top losers$"),
        re.compile(
            r"(?is)^share on facebook \(opens in new window\).*"
            r"share on x \(opens in new window\)\s*x$"
        ),
        re.compile(
            r"(?is)^exclusive stories\s+daily epaper access\s+"
            r"smart market tools\s+curated investment ideas\s+"
            r"ad-lite experience\s+subscription$"
        ),
        re.compile(
            r"(?is)^want to share this article\?\s*upgrade to "
            r"all-access now\b.*$"
        ),
        re.compile(
            r"(?i)^bluesky\s+x\s+threads\s+facebook\s+email$"
        ),
        re.compile(r"(?i)^advertisement\s*\d*$"),
        re.compile(
            r"(?i)^this commercial has not loaded but,?\s*however your "
            r"article continues under\.?$"
        ),
        re.compile(r"(?i)^sign in or create an account$"),
        re.compile(r"^(?:_{5,}|-{5,}|={5,})$"),
        re.compile(
            r"(?i)^.{1,100}\sis\s.{1,100}\sat bloomberg\.\s*"
            r"follow (?:him|her|them) on twitter\b.*"
            r"(?:instagram|facebook)\b.*$"
        ),
    )
    grid_promo = re.compile(
        r"(?i)^visit the grid for the latest about energy,\s*"
        r"natural resources and global business\.?$"
    )
    more_by_author = re.compile(
        r"(?i)^more by .{2,120}(?:\bon twitter\b.*)?:$"
    )
    for marker in list(soup.select("p")):
        if not more_by_author.fullmatch(
            _clean_text(marker.get_text(" ", strip=True))
        ):
            continue
        related = marker.find_next_sibling()
        if isinstance(related, Tag) and related.name in {"ul", "ol"}:
            related.decompose()
            marker.decompose()

    for marker in list(soup.select("h2, h3, h4, p")):
        if not re.fullmatch(
            r"(?i)(?:(?:for more,\s*)?read this next\s*:?|"
            r"for .{2,180},\s*read this next\s*:?|"
            r"for more on .{2,160},\s*check out .{2,80}\s*:|"
            r"related\s*:?)",
            _clean_text(marker.get_text(" ", strip=True)),
        ):
            continue
        related = marker.find_next_sibling()
        if isinstance(related, Tag) and related.name in {"ul", "ol"}:
            related.decompose()
            marker.decompose()

    for marker in list(soup.select("p, h2, h3, h4")):
        if not re.fullmatch(
            r"(?i)more from .{2,120}\s*:",
            _clean_text(marker.get_text(" ", strip=True)),
        ):
            continue
        related = marker.find_next_sibling()
        if isinstance(related, Tag) and related.name in {"ul", "ol"}:
            related.decompose()
            marker.decompose()

    for marker in list(soup.select("p")):
        if (
            _clean_text(marker.get_text(" ", strip=True)).casefold()
            != "daily podcast"
        ):
            continue
        title = marker.find_next_sibling()
        description = (
            title.find_next_sibling()
            if isinstance(title, Tag) and title.name == "p"
            else None
        )
        if not (
            isinstance(description, Tag)
            and description.name == "p"
            and re.search(
                r"(?is)\bpodcast on the bloomberg terminal\b.*"
                r"\bto listen,\s*click here\.?$",
                _clean_text(description.get_text(" ", strip=True)),
            )
        ):
            continue
        description.decompose()
        title.decompose()
        marker.decompose()

    for module in list(soup.select("div.story_inline.assets")):
        if module.select_one("div.author") and module.select_one("div.related"):
            module.decompose()

    for promo in list(soup.select("p")):
        if not grid_promo.fullmatch(
            _clean_text(promo.get_text(" ", strip=True))
        ):
            continue
        related = promo.find_previous_sibling()
        if isinstance(related, Tag) and related.name in {"ul", "ol"}:
            related.decompose()
        promo.decompose()

    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True))
        trimmed = re.sub(
            r"(?i)\s+follow (?:him|her|them) on twitter"
            r"(?:\s+at)?(?:\s+@\w+)?\s*\.?\s*\)$",
            ")",
            text,
        )
        trimmed = re.sub(
            r"(?i)\s+follow (?:him|her|them) on tumblr at\s+"
            r"(?:https?://)?(?:www\.)?[\w.-]+\.[a-z]{2,}"
            r"(?:/[^\s)]*)?(?:\s+or\s+(?:https?://)?"
            r"(?:www\.)?[\w.-]+\.[a-z]{2,}(?:/[^\s)]*)?)?"
            r"\s*\.?\s*\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+e-?mail (?:him|her|them) and\s*\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+for more dine\s*&\s*deal reviews,\s*"
            r"click here\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+(?:to buy this book(?:\s+in\s+"
            r"(?:north america|the u\.?s\.?))?|"
            r"to order(?: this book)?\s+in\s+"
            r"(?:north america|the u\.?s\.?))\s*,\s*"
            r"click here\s*\.?\s*$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+to listen,\s*go to\s+[a-z]{2,8}\s*<go>\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+to be sent this column daily,\s*click\s+"
            r"[a-z]{2,8}(?:\s+[a-z]{2,8})?\s*<go>\s*\.?\s*\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+find this column daily at\s+"
            r"[a-z]{2,8}(?:\s+[a-z]{2,8})?\s*<go>\s*\.?\s*\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+click here for (?:the )?playoff schedule\.?$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+click here for other college football "
            r"game schedules\.?$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+for details,\s*click here\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+for full details on greece(?:'|’)s funding "
            r"commitments,\s*click here\.\s*"
            r"see ext4 for more on the european debt crisis\.\s*$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+to read bloomberg coverage,\s*click here\s*\.?$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s*\*?\s*link to earlier story\s*:\s*.*$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s*\{[a-z]{2,8}\s+\d{5,12}\s+<go>\}\s*$",
            "",
            trimmed,
        )
        if (
            re.match(r"(?i)^stories related to the ecb\s*:", trimmed)
            and len(
                re.findall(
                    r"(?i)\{[a-z][a-z0-9 ]{1,30}<go>\}",
                    trimmed,
                )
            )
            >= 2
        ):
            trimmed = ""
        trimmed = re.sub(
            r"(?i)\s*\{\s*osch\s*<go>\s*\}\s*",
            " ",
            trimmed,
        )
        trimmed = re.sub(r"(?i)\s+-bloomberg\s*$", "", trimmed)
        trimmed = re.sub(
            r"(?i),\s*accessible on live\s*<go>\s*\.\)$",
            ".)",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+see\s+\{?\s*live\s*<go>\s*\}?\s*\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+can be accessed at\s+\{?\s*live\s*<go>\s*\}?"
            r"\s*\.\s*",
            ". ",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+to listen,\s*click on\s+\{?\s*live\s*<go>\s*\}?"
            r"\s*\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+to listen,\s*visit\s+"
            r"[a-z0-9.]{1,16}\s+(?:us\s+)?<equity>\s+"
            r"evt\s*<go>\s*\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+for more bloomberg view,\s*"
            r"click on view\s*<go>\s*\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+\*?\s*for change in stock futures oi,\s*"
            r"see fmon\s*<go>\s*$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+(?:\*\s*t\s+)?contributed via\s*:\s*"
            r"bloomberg publisher web service\s+provider id\s*:\s*"
            r"[0-9a-f]{32}\s*$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+click\s+[a-z]{1,8}(?:\s+[a-z]{1,8})?\s*"
            r"<equity>\s+evts\s*<go>\s+to listen\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)^([^.]{1,180}\.)\s+follow (?:him|her|them) on twitter"
            r"(?:\s+at)?\s+@\w+\s*\.?$",
            r"\1",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)^(.{2,240}\.)\s+follow (?:him|her|them) on twitter"
            r"\s*\.\s*this post originally appeared here\s*\.?$",
            r"\1",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+follow (?:him|her|them) on twitter"
            r"(?:(?:\s+at)?\s+@\w+)?\s*\.\s+"
            r"(?=(?:the )?opinions? expressed\b)",
            " ",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+follow (?:him|her|them) on instagram"
            r"(?:\s+at)?\s*:?\s*@\w+\s*\.?",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)^read more echoes online\s*\.\s*(?=\()",
            "",
            trimmed,
        )
        if trimmed != text:
            paragraph.clear()
            paragraph.append(trimmed)

    for paragraph in list(soup.select("p")):
        paragraph_text = _clean_text(paragraph.get_text(" ", strip=True))
        assistance_bio = re.fullmatch(
            r"(?is)^\(\s*with assistance (?:from|by)\b.+?\.\s+"
            r"(.+\b(?:bloomberg|muse)\b.+)\)$",
            paragraph_text,
        )
        if assistance_bio is not None:
            paragraph.clear()
            paragraph.append(f"({assistance_bio.group(1)})")

    for paragraph in list(soup.select("p")):
        paragraph_text = _clean_text(paragraph.get_text(" ", strip=True))
        assistance = re.search(
            r"\s+With assistance from\b.{2,300}\.?\s*$",
            paragraph_text,
        )
        if assistance is None:
            continue
        retained = paragraph_text[: assistance.start()].rstrip()
        if not retained.endswith((".", "!", "?")):
            continue
        for text_node in list(paragraph.find_all(string=True)):
            match = re.search(
                r"\s+With assistance from\b.{2,300}\.?\s*$",
                str(text_node),
            )
            if match is not None:
                text_node.replace_with(str(text_node)[: match.start()])
                break

    for marker in list(soup.select("p")):
        if _clean_text(marker.get_text(" ", strip=True)).casefold() != "source":
            continue
        source_link = marker.find_next_sibling()
        if not isinstance(source_link, Tag) or source_link.name != "p":
            continue
        source_text = _clean_text(source_link.get_text(" ", strip=True))
        if not re.fullmatch(
            r"(?i)https?://(?:www\.)?"
            r"(?:bloomberg\.com|businessweek\.com)/\S+",
            source_text,
        ):
            continue
        source_link.decompose()
        marker.decompose()

    for marker in list(soup.select("p")):
        if (
            _clean_text(marker.get_text(" ", strip=True)).casefold()
            != "note to editors"
        ):
            continue
        if not any(
            isinstance(sibling, Tag)
            and sibling.name == "p"
            and re.fullmatch(
                r"(?i)for further information please contact\s*:?",
                _clean_text(sibling.get_text(" ", strip=True)),
            )
            for sibling in marker.next_siblings
        ):
            continue
        for sibling in list(marker.next_siblings):
            sibling.extract()
        marker.decompose()

    for heading in list(soup.select("h2, h3, h4")):
        if _clean_text(heading.get_text(" ", strip=True)).casefold() != "statistics":
            continue
        previous = heading.find_previous_sibling()
        if isinstance(previous, Tag) and previous.name in {"pre", "table"}:
            heading.decompose()
            continue
        if any(
            isinstance(sibling, Tag)
            and sibling.name in {"p", "pre", "table", "figure", "img"}
            and _clean_text(sibling.get_text(" ", strip=True))
            for sibling in heading.next_siblings
        ):
            continue
        heading.decompose()

    for marker in list(soup.select("p, h2, h3, h4")):
        if not re.fullmatch(
            r"(?i)more stories (?:by|from) .{2,160}:?",
            _clean_text(marker.get_text(" ", strip=True)),
        ):
            continue
        sibling = marker.find_next_sibling()
        if isinstance(sibling, Tag) and sibling.name in {"ul", "ol"}:
            sibling.decompose()
            marker.decompose()

    contact_footer = re.compile(
        r"(?i)^to contact (?:the )?"
        r"(?:reporters?|writers?|authors?|editors?|bloomberg news staff)\b"
    )
    # A small number of legacy Bloomberg terminal pages contain a stray
    # one-letter paragraph immediately before the reporter contact footer.
    # Scope the repair to that exact boundary so legitimate short paragraphs
    # elsewhere in an article remain untouched.
    for contact in list(soup.select("p")):
        if not contact_footer.match(
            _clean_text(contact.get_text(" ", strip=True))
        ):
            continue
        previous = contact.find_previous_sibling()
        if (
            isinstance(previous, Tag)
            and previous.name == "p"
            and re.fullmatch(
                r"[A-Za-z]",
                _clean_text(previous.get_text(" ", strip=True)),
            )
        ):
            previous.decompose()

    for heading in list(soup.select("h2, h3, h4")):
        sibling = heading.find_next_sibling()
        while isinstance(sibling, Tag) and sibling.name in {"h2", "h3", "h4"}:
            sibling = sibling.find_next_sibling()
        if (
            isinstance(sibling, Tag)
            and sibling.name == "p"
            and contact_footer.match(
                _clean_text(sibling.get_text(" ", strip=True))
            )
        ):
            heading.decompose()

    for node in list(
        soup.select("p, li, span, em, div, h2, h3, h4, blockquote")
    ):
        text = _clean_text(node.get_text(" ", strip=True))
        if (
            text.casefold() == "watch this next"
            or any(pattern.search(text) for pattern in footer_patterns)
            or (
                node.name in {"p", "li", "span"}
                and "@bloomberg.net" in text.casefold()
                and len(text) <= 400
            )
            or re.fullmatch(r"[\u200b-\u200f\u2060\ufeff]+", text)
            or re.fullmatch(r"(?:\*\s*){2,}", text)
            or (
                node.name in {"h2", "h3", "h4"}
                and re.fullmatch(
                    r"[\s‘’“”'\"….,:;!?—–-]+",
                    text,
                )
            )
            or text == "🫣"
        ):
            node.decompose()

    for paragraph in list(soup.select("p")):
        links = paragraph.find_all("a")
        if len(links) != 1:
            continue
        link = links[0]
        text = _clean_text(paragraph.get_text(" ", strip=True))
        link_text = _clean_text(link.get_text(" ", strip=True))
        href = str(link.get("href") or "")
        if (
            text == link_text
            and link_text
            and paragraph.find_next_sibling("p") is None
            and re.search(
                r"(?i)(?:bloomberg\.com)?/news/articles/\d{4}-\d{2}-\d{2}/",
                href,
            )
        ):
            paragraph.decompose()

    for link in list(soup.select("a")):
        text = _clean_text(link.get_text(" ", strip=True)).casefold()
        href = str(link.get("href") or "").casefold()
        if (
            text == "sign up here"
            and "bloombergbusiness.com/join/" in href
        ):
            link.decompose()

    for listing in list(soup.select("ul")):
        items = listing.find_all("li", recursive=False)
        if len(items) < 2:
            continue
        if all(
            item.find(
                "a",
                attrs={"title": re.compile(r"(?i)^click to view webpage\.?$")},
            )
            is not None
            for item in items
        ):
            listing.decompose()

    personal_finance_newsletter_suffix = re.compile(
        r"(?i)\s*want\s+more\s+personal\s+finance\s+news\?\s*"
        r"sign\s+up\s+for\s+our\s+weekly\s+personal\s+finance\s+"
        r"newsletter,\s*wealth\s+watch\.?\s*$"
    )
    for text_node in list(
        soup.find_all(string=personal_finance_newsletter_suffix)
    ):
        cleaned = personal_finance_newsletter_suffix.sub(
            "", str(text_node)
        ).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    view_promo_suffix = re.compile(
        r"(?i)\s*read more opinion online from bloomberg view\s*\.\s*"
        r"subscribe to receive a daily e-?mail highlighting new view "
        r"(?:editorials,\s*columns|columns,\s*editorials) "
        r"and op-ed articles\.?\s*$"
    )
    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True))
        cleaned = view_promo_suffix.sub("", text).rstrip()
        if cleaned == text:
            continue
        if cleaned:
            paragraph.clear()
            paragraph.append(cleaned)
        else:
            paragraph.decompose()

    partner_work_suffix = re.compile(
        r"(?i)\s+(?:read more of (?:his|her|their) work here|"
        r"read more here)\s*\.?\s*\)?$"
    )
    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True))
        parenthetical = text.startswith("(") and text.endswith(")")
        cleaned = partner_work_suffix.sub("", text).rstrip()
        if cleaned == text:
            continue
        if parenthetical and cleaned.startswith("(") and not cleaned.endswith(")"):
            cleaned += ")"
        if cleaned:
            paragraph.clear()
            paragraph.append(cleaned)
        else:
            paragraph.decompose()

    legacy_coverage_clickthrough_suffix = re.compile(
        r"(?i)\s+to read more coverage about .{2,180},\s*"
        r"click here and click here\s*\.?\s*$"
    )
    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True))
        cleaned = legacy_coverage_clickthrough_suffix.sub("", text).rstrip()
        if cleaned == text:
            continue
        if cleaned:
            paragraph.clear()
            paragraph.append(cleaned)
        else:
            paragraph.decompose()

    social_follow_suffix = re.compile(
        r"(?i)\s+follow (?:him|her|them) on "
        r"(?:instagram and twitter|twitter and instagram)\s*\.?\s*$"
    )
    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True))
        cleaned = social_follow_suffix.sub("", text).rstrip()
        if cleaned == text:
            continue
        if cleaned:
            paragraph.clear()
            paragraph.append(cleaned)
        else:
            paragraph.decompose()

    disclaimer_suffix = re.compile(
        r"(?i)\s*\(?this\s+(?:column|article)\s+does\s+not\s+necessarily"
        r"\s+reflect\s+the\s+opinion\s+of\s+"
        r"(?:(?:the\s+)?editorial\s+board\s+or\s+)?"
        r"bloomberg\s+lp\s+and\s+its\s+owners\.\)?\s*$"
    )
    for text_node in list(soup.find_all(string=disclaimer_suffix)):
        cleaned = disclaimer_suffix.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    malformed_partner_tail = re.compile(
        r"(?is)(?:/?p)?em\s*uploaded by .*$"
    )
    for text_node in list(soup.find_all(string=malformed_partner_tail)):
        cleaned = malformed_partner_tail.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    for marker in list(soup.select("p")):
        marker_text = _clean_text(marker.get_text(" ", strip=True))
        if not re.fullmatch(
            r"(?i)\.{3}\s*advertisement\s*\.{3}",
            marker_text,
        ):
            continue
        previous_rule = marker.find_previous_sibling("hr")
        next_rule = marker.find_next_sibling("hr")
        if not isinstance(previous_rule, Tag) or not isinstance(next_rule, Tag):
            marker.decompose()
            continue
        current = previous_rule
        while current is not None:
            following = current.next_sibling
            current.extract()
            if current is next_rule:
                break
            current = following

    partner_recruiting_tail = re.compile(
        r"(?is)\s*(?:despite the downturn,\s*trading firms still continue "
        r"to build out their options trading capabilities|"
        r"to discuss these opportunities confidentially)\b.*$"
    )
    for text_node in list(soup.find_all(string=partner_recruiting_tail)):
        cleaned = partner_recruiting_tail.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    inline_signup = re.compile(
        r"(?i)\s*;\s*(?:sign up here)?\s*\.\s*"
    )
    for text_node in list(soup.find_all(string=inline_signup)):
        cleaned = inline_signup.sub(". ", str(text_node), count=1)
        text_node.replace_with(cleaned)

    for heading in soup.select("h1, h2, h3, h4"):
        text = _clean_text(heading.get_text(" ", strip=True))
        if not re.match(r"(?i)^watch (?:this )?next\s*:", text):
            continue
        sibling = heading.find_next_sibling()
        if (
            isinstance(sibling, Tag)
            and sibling.name == "figure"
            and any(
                marker in {
                    str(value).casefold()
                    for value in sibling.get("class", [])
                }
                for marker in ("inline-video", "video")
            )
        ):
            sibling.decompose()
        heading.decompose()

    for heading in list(soup.select("h2, h3, h4")):
        if (
            _clean_text(heading.get_text(" ", strip=True)).casefold()
            != "market-related stories"
        ):
            continue
        for sibling in list(heading.next_siblings):
            sibling.extract()
        heading.decompose()

    # Legacy Bloomberg figures made the image container act like a lightbox
    # button.  Keep the figure and image, but do not preserve browser-only
    # interaction semantics in the archived article body.
    for thumbnail in list(
        soup.select(
            ".thumbnail_container.overlay_container > a.enlarge_image"
        )
    ):
        overlay = thumbnail.find_next_sibling(
            "div",
            class_="simple_overlay",
        )
        if isinstance(overlay, Tag) and overlay.find("img"):
            thumbnail.decompose()

    for node in soup.select(
        "figure [role='button'][aria-label='Open image in viewer']"
    ):
        node.attrs.pop("role", None)
        node.attrs.pop("tabindex", None)
        node.attrs.pop("aria-label", None)

    # Some legacy pages place an otherwise empty print/share control inside
    # the selected story body.
    for node in list(
        soup.select("[class*='SocialShare-'][role='button']")
    ):
        node.decompose()

    for node in list(
        soup.select(".comment-count-v2__link, .disqus-v2__tout")
    ):
        node.decompose()

    # Older Bloomberg pages wrap real inline images in generic thumbnail
    # ``div`` elements.  Promote those wrappers to figures so the adjacent
    # caption is attached to the image rather than emitted as body text.
    # Video thumbnails are excluded because their "caption" is a story
    # synopsis that is also represented by the article's text paragraphs.
    for container in list(soup.select("div.image.thumbnail:has(p.caption)")):
        classes = {
            str(value).casefold()
            for value in container.get("class", [])
        }
        if "video" in classes or container.find("img") is None:
            continue
        thumbnail = container.find(
            "a",
            class_="enlarge_image",
            recursive=False,
        )
        overlay = container.find(
            "div",
            class_="simple_overlay",
            recursive=False,
        )
        if (
            isinstance(thumbnail, Tag)
            and isinstance(overlay, Tag)
            and overlay.find("img") is not None
        ):
            thumbnail.decompose()
        container.name = "figure"

    # Calendar and market-monitor stories may mention Terminal navigation
    # codes inline (for example, ``{ECO JN <GO>}`` or ``GMEET <GO>``).
    # This must run last:
    # several stricter removals above use the command as their structural
    # signal.  Remove only the command and retain its explanation.
    for node in list(soup.select("p, li, td, th")):
        text = _clean_text(node.get_text(" ", strip=True))
        retained = re.sub(
            r"(?:\{\s*)?\b[A-Z][A-Z0-9]{1,15}"
            r"(?:\s+[A-Z][A-Z0-9]{1,15}){0,2}\s*<\s*GO\s*>\s*\}?",
            "",
            text,
        )
        retained = _clean_text(retained)
        if retained != text:
            node.clear()
            if retained:
                node.append(retained)
            else:
                node.decompose()


def _bloomberg_teaser_shell(soup: BeautifulSoup) -> bool:
    if bool(
        soup.select_one(
            "[class*='teaser-body'], "
            ".body-content[class*='teaser-content']"
        )
    ):
        return True
    marker = (
        "to continue reading this article you must be a bloomberg "
        "professional service subscriber"
    )
    for node in soup.select("p"):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if marker not in text:
            continue
        current: Tag | None = node
        hidden = False
        while isinstance(current, Tag):
            style = _clean_text(str(current.get("style") or "")).casefold()
            if (
                current.has_attr("hidden")
                or str(current.get("aria-hidden") or "").casefold() == "true"
                or re.search(r"(?:^|;)\s*display\s*:\s*none\b", style)
            ):
                hidden = True
                break
            current = current.parent if isinstance(current.parent, Tag) else None
        if not hidden:
            return True
    return False


def _bloomberg_caption_credit(
    container: Tag,
) -> tuple[str | None, str | None]:
    """Keep Bloomberg's explicit figure credit out of the caption field."""
    caption_node = container.select_one("figcaption, [class*='caption' i]")
    if not isinstance(caption_node, Tag):
        return None, None
    copy = BeautifulSoup(str(caption_node), "html.parser").find()
    if not isinstance(copy, Tag):
        return None, None
    credit_parts: list[str] = []
    credit_nodes = list(
        copy.select(
            ".news-figure-credit, [class*='credit' i], "
            "[itemprop='copyrightHolder']"
        )
    )
    if not credit_nodes:
        return _caption_credit(container)
    for credit_node in credit_nodes:
        credit_text = _clean_text(credit_node.get_text(" ", strip=True))
        if credit_text:
            credit_parts.append(credit_text)
        credit_node.decompose()
    caption = _clean_text(copy.get_text(" ", strip=True)) or None
    credit = _dedupe_lines("\n".join(credit_parts)) or None
    if (
        caption
        and credit
        and caption.casefold() == credit.casefold()
    ):
        caption = None
    return caption, credit


def _bloomberg_legacy_published_at(soup: BeautifulSoup) -> str | None:
    """Recover the timestamp rendered by Bloomberg's pre-2015 story template."""
    node = soup.select_one("#story_meta .datestamp noscript")
    if node is None:
        return None
    value = node.get_text(" ", strip=True)
    if not value:
        return None
    try:
        parsed = datetime.strptime(value, "%a %b %d %H:%M:%S GMT %Y")
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc).isoformat()


from jojo_news_archive.parsing.parser_contracts import (
    BaseSourceParser,
    ImageParseContext,
    ParseContext,
)


def _deduplicate_bloomberg_blocks(
    blocks: list[ContentBlock],
) -> list[ContentBlock]:
    textual = {BlockType.PARAGRAPH, BlockType.QUOTE}
    excluded: set[int] = set()
    dateline = re.compile(
        r"(?i)^[a-z]{3,9}\.?\s+\d{1,2}"
        r"(?:,\s*\d{4})?\s+\(bloomberg\)\s*--\s*"
    )
    for index, block in enumerate(blocks):
        if block.type not in textual or not block.text:
            continue
        normalized = _clean_text(block.text).casefold()
        stripped = dateline.sub("", normalized)
        if stripped == normalized or len(stripped) < 80:
            continue
        pieces: list[str] = []
        indexes: list[int] = []
        for other_index in range(index + 1, min(len(blocks), index + 4)):
            other = blocks[other_index]
            if other.type not in textual or not other.text:
                break
            pieces.append(_clean_text(other.text).casefold())
            indexes.append(other_index)
            combined = " ".join(pieces)
            if combined == stripped:
                excluded.update(indexes)
                break
            if len(combined) >= len(stripped):
                break
    filtered = [
        block for index, block in enumerate(blocks) if index not in excluded
    ]
    seen: set[str] = set()
    result: list[ContentBlock] = []
    for block in filtered:
        normalized = _clean_text(block.text or "").casefold()
        stripped = dateline.sub("", normalized) if normalized else ""
        if normalized in seen or (
            stripped and stripped != normalized and stripped in seen
        ):
            continue
        if normalized:
            seen.add(normalized)
            if stripped and stripped != normalized:
                seen.add(stripped)
        result.append(block)
    from jojo_news_archive.parsing.primitives import (
        deduplicate_blocks as _deduplicate_blocks,
    )

    return _deduplicate_blocks(result)


def _clean_bloomberg_syndication_partner_noise(
    body: Tag,
    source_document: BeautifulSoup,
) -> None:
    """Remove partner chrome around licensed copies selected by this source."""

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
    if hostname == "mediapart.fr" or hostname.endswith(".mediapart.fr"):
        for node in list(body.select("p")):
            if re.match(
                r"(?i)^read more of this bloomberg report published by the\b",
                _clean_text(node.get_text(" ", strip=True)),
            ):
                node.decompose()
    if hostname == "eco-business.com" or hostname.endswith(
        ".eco-business.com"
    ):
        for node in list(body.select(".eb-article__eb-circle-banner")):
            node.decompose()
    if hostname == "insurancejournal.com" or hostname.endswith(
        ".insurancejournal.com"
    ):
        for node in list(
            body.select(
                "p.tagtag, .subscribe-banner, [class*='subscribe-banner' i]"
            )
        ):
            node.decompose()
    if hostname == "linkedin.com" or hostname.endswith(".linkedin.com"):
        for node in list(body.select("section.comment, .comment__body")):
            node.decompose()
        for node in list(body.select("p, li")):
            text = _clean_text(node.get_text(" ", strip=True))
            folded = text.casefold()
            if (
                "full article below" in folded
                and "read more from bloomberg news" in folded
            ):
                node.decompose()
                continue
            if re.fullmatch(r"[\d,.]+\s+followers?", text, re.IGNORECASE):
                node.decompose()
                continue
            if folded == "report this post":
                node.decompose()
                continue
            hashtag = re.search(r"\s+#[\w-]+", text)
            if hashtag is None or len(re.findall(r"#[\w-]+", text)) < 5:
                continue
            cleaned = text[:hashtag.start()].rstrip()
            if cleaned.startswith('"') and '" "' in cleaned:
                cleaned = cleaned.split('" "', 1)[0]
            cleaned = cleaned.strip().strip('"').strip()
            if cleaned:
                node.clear()
                node.string = cleaned
            else:
                node.decompose()
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
    if hostname == "newsbreak.com" or hostname.endswith(".newsbreak.com"):
        for card in list(body.select("section")):
            link = card.select_one("a[href][target='_blank']")
            if (
                isinstance(link, Tag)
                and card.select_one("p.textoverflow-3") is not None
            ):
                card.decompose()
    if hostname == "ctrmcenter.com" or hostname.endswith(".ctrmcenter.com"):
        for node in list(body.select(".cat_postinfo, .postinfo, span.bio")):
            text = _clean_text(node.get_text(" ", strip=True)).casefold()
            if (
                "republished on the ctrm center" in text
                and "if you have any issue with this post" in text
            ):
                node.decompose()
    if hostname == "biasly.com" or hostname.endswith(".biasly.com"):
        body.clear()
        return
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


class BloombergParser(BaseSourceParser):
    def select_body(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.body import (
            select_default_body as _select_default_body,
        )
        from jojo_news_archive.parsing.syndication import (
            generic_syndication_allowed as _generic_syndication_allowed,
            generic_syndication_body as _generic_syndication_body,
            is_yahoo_syndication as _is_yahoo_syndication,
            postmedia_syndication_body as _postmedia_syndication_body,
            yahoo_syndication_body as _yahoo_syndication_body,
        )

        body = None
        if _is_yahoo_syndication(context.soup, raw_capture=context.raw_capture):
            body = _yahoo_syndication_body(
                context.soup,
                stop_at_reporting_by=False,
                skipped_list_headings=frozenset(
                    {
                        "most read from bloomberg",
                        "most read from bloomberg businessweek",
                    }
                ),
            )
        syndicated = _generic_syndication_allowed(context)
        if body is None and syndicated:
            body = _bloomberg_partner_body(
                context.soup,
                canonical_url=context.canonical_url,
            )
        if body is None and syndicated:
            body = _postmedia_syndication_body(context.soup)
        if body is None and syndicated:
            body = _newsbreak_syndication_body(context.soup)
        if body is None and syndicated:
            body = _generic_syndication_body(
                context.soup,
                partner_noise_cleaner=_clean_bloomberg_syndication_partner_noise,
            )
        embedded = _bloomberg_embedded_article_body(context.soup)
        if embedded is not None and (
            body is None
            or len(body.get_text(" ", strip=True))
            < len(embedded.get_text(" ", strip=True))
        ):
            body = embedded
        feature = _bloomberg_feature_landing_body(context.soup)
        if feature is not None and (
            body is None
            or len(body.get_text(" ", strip=True))
            < len(feature.get_text(" ", strip=True))
        ):
            body = feature
        quiz = _bloomberg_embedded_quiz_body(context.soup)
        if quiz is not None:
            body = quiz
        context.body = _select_default_body(
            context,
            initial_body=body,
            partner_noise_cleaner=_clean_bloomberg_syndication_partner_noise,
        )

    def clean_body_before_noise(self, context: ParseContext) -> None:
        if context.clean_body is None:
            return
        _trim_bloomberg_subscription_tail(context.clean_body)
        _remove_bloomberg_damaged_attribution(context.clean_body)

    def clean_body_after_noise(self, context: ParseContext) -> None:
        if context.clean_body is not None:
            _remove_bloomberg_promos(context.clean_body)

    def is_noise_node(
        self,
        context: ParseContext,
        node: Tag,
        text: str,
    ) -> bool:
        if text == "share this article":
            return True
        return bool(
            node.name in {"p", "li", "span"}
            and text.startswith(
                (
                    "want to receive this post in your inbox",
                    "sign up for next china",
                    "sign up here to receive the davos diary",
                    "sign up for the new economy daily newsletter",
                    "sign up for our middle east newsletter",
                    "sign up for our coming middle east newsletter",
                    "for the best in travel, food, drinks, fashion, cars, "
                    "and life, sign up for the pursuits newsletter",
                )
            )
        )

    def extract_metadata(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            parse_datetime as _parse_datetime,
        )

        tax_quiz = bool(
            "/features/2017-tax-quiz" in context.canonical_url.casefold()
            and context.soup.select_one("#quiz-container section.question")
        )
        context.headline = _first_text(
            "Bloomberg Tax Quiz" if tax_quiz else None,
            _tag_text(
                context.soup.select_one(
                    "#quiz-container section.question h1, "
                    "#quiz-container section.question h2"
                )
            ),
            context.headline,
        )
        description = context.description
        if description and (
            re.match(
                r"(?i)^sign up to receive (?:the )?.+ newsletter\b",
                description,
            )
            or re.match(
                r"(?i)^want to receive this post in your inbox\b.*"
                r"\bsign up for\b.*\bnewsletter\b",
                description,
            )
            or re.match(
                r"(?i)^for even more:\s*subscribe to bloomberg all access\b",
                description,
            )
        ):
            context.description = None
        if context.published_at is None:
            context.published_at = _parse_datetime(
                _bloomberg_legacy_published_at(context.soup)
            )

    def classify_content(self, context: ParseContext) -> None:
        body = context.body
        if _bloomberg_article_narration(context.soup) or (
            isinstance(body, Tag)
            and body.get("data-jojo-source")
            == "bloomberg-arabamerica-syndication"
        ):
            context.content_type = ContentType.ARTICLE

    def allow_generic_audio(self, context: ParseContext) -> bool:
        body = context.body
        return not (
            _bloomberg_article_narration(context.soup)
            or (
                isinstance(body, Tag)
                and body.get("data-jojo-source")
                == "bloomberg-arabamerica-syndication"
            )
        )

    def accept_lead_image(self, context: ParseContext, url: str) -> bool:
        if _bloomberg_author_avatar_url(url):
            return False
        identities = context.source_data.get("legacy_lightbox_thumbnails")
        if not isinstance(identities, set):
            identities = _bloomberg_legacy_lightbox_thumbnail_identities(
                context.soup,
                base_url=context.canonical_url,
            )
            context.source_data["legacy_lightbox_thumbnails"] = identities
        return _image_identity(url) not in identities

    def image_identity(self, url: str) -> str | None:
        return _bloomberg_source_image_identity(url)

    def is_placeholder_image_url(
        self,
        context: ParseContext,
        url: str,
    ) -> bool:
        decoded = unquote(url).casefold()
        return any(
            marker in decoded
            for marker in (
                "twitter_ms_fdnoir.png",
                "/javelin/images/social-",
                "/javelin/public/images/social-",
                "/lightsaber/_next/static/media/social-",
                "/~assets/social-default.",
            )
        )

    def accept_body_image(
        self,
        context: ParseContext,
        image: ImageCandidate,
    ) -> bool:
        return not _bloomberg_author_avatar_url(image.original_url)

    def prepare_image(self, context: ImageParseContext) -> None:
        context.candidates = _promote_bloomberg_image_candidates(
            context.candidates
        )
        context.caption, context.credit = _bloomberg_caption_credit(
            context.container
        )
        if (
            context.caption
            and _clean_text(context.caption).casefold()
            == "olympus digital camera"
        ):
            context.caption = None
            caption_node = context.container.select_one(
                "figcaption, [class*='caption' i]"
            )
            if isinstance(caption_node, Tag):
                caption_node.decompose()
        if (
            context.alt
            and _clean_text(context.alt).casefold() == "olympus digital camera"
        ):
            context.alt = None
            context.image_node.attrs.pop("alt", None)

    def matching_image(
        self,
        context: ParseContext,
        image: ImageCandidate,
    ) -> ImageCandidate | None:
        if not _bloomberg_low_resolution_image(image):
            return None
        caption = _clean_text(image.caption or "").casefold()
        return next(
            (
                candidate
                for candidate in context.images_by_url.values()
                if candidate.role == ImageRole.LEAD
                and caption
                and _clean_text(candidate.caption or "").casefold()
                == caption
            ),
            None,
        )

    def adjust_image_candidate(
        self,
        context: ParseContext,
        image: ImageCandidate,
        *,
        tag: Tag | None,
    ) -> ImageCandidate:
        candidates = _promote_bloomberg_image_candidates(
            list(dict.fromkeys([image.original_url, *image.candidate_urls]))
        )
        caption = image.caption
        alt = image.alt
        if caption and _clean_text(caption).casefold() == "olympus digital camera":
            caption = None
            if tag is not None:
                container = tag.find_parent("figure") or tag.parent
                if isinstance(container, Tag):
                    caption_node = container.select_one(
                        "figcaption, [class*='caption' i]"
                    )
                    if isinstance(caption_node, Tag):
                        caption_node.decompose()
        if alt and _clean_text(alt).casefold() == "olympus digital camera":
            alt = None
            if tag is not None:
                tag.attrs.pop("alt", None)
        return image.model_copy(
            update={
                "original_url": candidates[0],
                "candidate_urls": candidates,
                "caption": caption,
                "alt": alt,
            }
        )

    def paragraph_block(
        self,
        context: ParseContext,
        node: Tag,
        *,
        text: str,
        position: int,
    ) -> ContentBlock | None:
        from jojo_news_archive.parsing.primitives import (
            normalized_url as _normalized_url,
        )

        embed = node.select_one("a.bbg-embed[href]")
        if not isinstance(embed, Tag) or text != _clean_text(
            embed.get_text(" ", strip=True)
        ):
            return None
        source = _normalized_url(
            embed.get("href"),
            base_url=context.canonical_url,
        )
        if not source:
            return None
        return ContentBlock(
            type=BlockType.EMBED,
            position=position,
            embed_url=source,
            html=str(node),
        )

    def postprocess_blocks(self, context: ParseContext) -> None:
        context.blocks = _deduplicate_bloomberg_blocks(context.blocks)

    def accepts_short_body(self, context: ParseContext) -> bool:
        plain_text = context.plain_text
        if context.content_type in {
            ContentType.INTERACTIVE,
            ContentType.VIDEO,
            ContentType.AUDIO,
            ContentType.TRANSCRIPT,
            ContentType.LIVEBLOG,
            ContentType.NEWSLETTER,
        } and any(
            block.type in {BlockType.EMBED, BlockType.IMAGE}
            for block in context.blocks
        ):
            return True
        if not context.headline:
            return False
        legacy_body = context.soup.select_one("#story_content")
        description = _meta_content(context.soup, "name", "description")
        if legacy_body is not None and description:
            paragraphs = [
                _clean_text(node.get_text(" ", strip=True))
                for node in legacy_body.find_all("p", recursive=False)
            ]
            paragraphs = [
                text
                for text in paragraphs
                if text
                and not re.match(
                    r"(?i)^to contact the (?:reporter|editor)\b",
                    text,
                )
            ]
            description_words = set(
                re.findall(r"[a-z0-9]+", description.casefold())
            )
            body_words = set(
                re.findall(r"[a-z0-9]+", plain_text.casefold())
            )
            if (
                80 <= len(plain_text) < 120
                and len(paragraphs) == 1
                and paragraphs[0] == plain_text
                and len(description_words) >= 8
                and len(description_words & body_words)
                / len(description_words)
                >= 0.9
                and not re.search(r"(?:\.\.\.|…)\s*$", plain_text)
            ):
                return True
        modern_body = context.soup.select_one(
            "article.businessweek[itemtype$='/Article'] "
            ".article-body__content"
        )
        primary_category = context.soup.select_one(
            "article.businessweek meta.primary-category"
            "[content='businessweek-magazine']"
        )
        modern_paragraphs = (
            [
                _clean_text(node.get_text(" ", strip=True))
                for node in modern_body.find_all("p", recursive=False)
                if _clean_text(node.get_text(" ", strip=True))
            ]
            if isinstance(modern_body, Tag)
            else []
        )
        return bool(
            80 <= len(plain_text) < 150
            and primary_category is not None
            and len(modern_paragraphs) == 1
            and modern_paragraphs[0] == plain_text
            and not re.search(r"(?:\.\.\.|…)\s*$", plain_text)
        )

    def quality_warnings(self, context: ParseContext) -> list[str]:
        soup = context.soup
        plain_text = context.plain_text
        truncated = bool(
            _bloomberg_teaser_shell(soup)
            or _bloomberg_parcel_industry_teaser(soup)
            or _bloomberg_pv_magazine_teaser(soup)
            or _bloomberg_partner_full_story_teaser(soup)
            or _bloomberg_macdailynews_excerpt(soup)
            or _bloomberg_origin_abrupt_quote_truncation(soup)
            or _bloomberg_origin_incomplete_for_more_tail(soup)
            or _bloomberg_origin_trailing_heading_truncation(soup)
            or _bloomberg_john_lothian_summary(soup)
            or _bloomberg_short_source_link_excerpt(
                soup,
                plain_text=plain_text,
            )
            or (
                len(plain_text) < 500
                and soup.select_one("article.artData.paywall") is not None
            )
            or (
                soup.select_one(".ai-block") is not None
                and "signalpro"
                in _clean_text(soup.get_text(" ", strip=True)).casefold()
            )
        )
        page_text = _clean_text(soup.get_text(" ", strip=True)).casefold()
        page_url = _clean_text(
            _first_text(
                _meta_content(soup, "property", "og:url"),
                _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
            )
            or ""
        ).casefold()
        if "linkedin.com/" in page_url and any(
            marker in page_text
            for marker in (
                "cut through the ai noise",
                "full article below with no paywall",
                "read my latest, for free",
                "humbled to see our journey featured in bloomberg",
                "excited to be quoted in bloomberg news",
                "had the pleasure of joining bloomberg podcasts",
                "always-superb editing by",
            )
        ):
            truncated = True
        if any(
            marker in page_text
            for marker in (
                "the practical value is the source trail",
                "as international investment experts report",
                "abitech analysis",
                "biggo finance appears first in google search",
            )
        ):
            truncated = True
        return ["truncated-body"] if truncated else []

    def short_body_warning(self, context: ParseContext) -> str | None:
        if context.content_type in {
            ContentType.INTERACTIVE,
            ContentType.VIDEO,
            ContentType.AUDIO,
            ContentType.TRANSCRIPT,
            ContentType.LIVEBLOG,
            ContentType.NEWSLETTER,
        } and any(
            block.type in {BlockType.EMBED, BlockType.IMAGE}
            for block in context.blocks
        ):
            return None
        return (
            "structured-short-record"
            if self.accepts_short_body(context)
            else None
        )


PARSER: BloombergParser = BloombergParser()
