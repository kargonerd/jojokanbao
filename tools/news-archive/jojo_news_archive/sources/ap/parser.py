from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re
from typing import Any
from urllib.parse import unquote, urlsplit
from bs4 import BeautifulSoup, Tag
from jojo_news_archive.models import Author, ContentType
from jojo_news_archive.parsing.primitives import (
    clean_text as _clean_text,
    first_text as _first_text,
    string_list as _string_list,
    string_or_none as _string_or_none,
    tag_attribute as _tag_attribute,
    tag_text as _tag_text,
)
from jojo_news_archive.parsing.limits import (
    MINIMUM_BODY_CHARACTERS as _MINIMUM_BODY_CHARACTERS,
)


def _ap_carousel_gallery(soup: BeautifulSoup) -> Tag | None:
    for carousel in soup.select(
        ".Page-main bsp-carousel.Carousel, "
        ".Page-main .Carousel"
    ):
        slides = carousel.select(".Carousel-slide")
        if len(slides) < 3:
            continue
        document = BeautifulSoup("<article></article>", "html.parser")
        article = document.article
        if not isinstance(article, Tag):
            return None
        for slide in slides:
            source_image = slide.select_one("img")
            if not isinstance(source_image, Tag):
                continue
            image = BeautifulSoup(
                str(source_image),
                "html.parser",
            ).find("img")
            if not isinstance(image, Tag):
                continue
            figure = document.new_tag("figure")
            figure.append(image)
            caption = _first_text(
                _tag_text(
                    slide.select_one(
                        ".CarouselSlide-caption, "
                        ".CarouselSlide-description, "
                        "[class*='caption' i]"
                    )
                ),
                _clean_text(source_image.get("alt", "")) or None,
            )
            if caption:
                figcaption = document.new_tag("figcaption")
                figcaption.string = caption
                figure.append(figcaption)
            article.append(figure)
        if len(article.select("figure")) >= 3:
            return article
    return None


def _ap_hosted_headline(soup: BeautifulSoup) -> str | None:
    """Extract headlines from AP's pre-BigStory distribution templates."""
    return _tag_text(
        soup.select_one(
            ".ap-story-table .headline.entry-title, "
            ".ap-story-table .entry-title, "
            "#yn-story #yn-title, "
            "#hostednews-article #hn-headline, "
            ".entry h1"
        )
    )


def _ap_hosted_authors(soup: BeautifulSoup) -> list[Author]:
    """Extract bylines from AP's legacy hNews/vCard markup."""
    result: list[Author] = []
    seen: set[str] = set()
    for node in soup.select(
        ".ap-story-table .byline .author .fn, "
        ".ap-story-table .byline .vcard .fn, "
        "#yn-story .byline .vcard .fn, "
        ".entry .wire_author"
    ):
        name = _clean_text(node.get_text(" ", strip=True))
        key = name.casefold()
        if name and key not in seen:
            result.append(Author(name=name))
            seen.add(key)
    if result:
        return result
    google_byline = _tag_text(
        soup.select_one("#hostednews-article .hn-byline")
    )
    if google_byline:
        match = re.match(
            r"(?is)^\s*by\s+(.+?),\s*(?:the\s+)?associated\s+press\b",
            google_byline,
        )
        if match:
            for name in re.split(
                r"\s+(?:and|&)\s+|\s*,\s*",
                match.group(1),
            ):
                cleaned = _clean_text(name)
                key = cleaned.casefold()
                if cleaned and key not in seen:
                    result.append(Author(name=cleaned))
                    seen.add(key)
    return result


def _ap_hosted_published_at(soup: BeautifulSoup) -> str | None:
    """Return a machine-readable AP legacy timestamp, when present."""
    return _tag_attribute(
        soup.select_one(
            ".ap-story-table .timestamp.updated[title], "
            ".ap-story-table time.updated[datetime], "
            "#yn-story .byline abbr.timedate[title], "
            ".article-data .updated[title]"
        ),
        "title",
    ) or _tag_attribute(
        soup.select_one(".ap-story-table time.updated[datetime]"),
        "datetime",
    ) or _ap_huff_wire_published_at(soup)


def _ap_huff_wire_published_at(soup: BeautifulSoup) -> str | None:
    """Read the exact publication timestamp from HuffPost AP-wire pages."""
    metadata = soup.select_one(".entry .comments_datetime")
    text = _clean_text(metadata.get_text(" ", strip=True)) if metadata else ""
    match = re.search(
        r"(?i)\b([A-Z][a-z]+ \d{1,2}, 20\d{2} "
        r"\d{1,2}:\d{2} [AP]M)\s+(EST|EDT)\b",
        text,
    )
    if match is None:
        return None
    try:
        parsed = datetime.strptime(match.group(1), "%B %d, %Y %I:%M %p")
    except ValueError:
        return None
    offset = -5 if match.group(2).upper() == "EST" else -4
    return parsed.replace(
        tzinfo=timezone(timedelta(hours=offset))
    ).isoformat()


def _ap_structured_race_call_body(
    news_article: dict[str, Any],
) -> Tag | None:
    if not news_article:
        return None
    keywords = _string_list(news_article.get("keywords"))
    description = _string_or_none(news_article.get("description"))
    if (
        not description
        or len(description) < _MINIMUM_BODY_CHARACTERS
        or not any("race call" in value.casefold() for value in keywords)
    ):
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    paragraph = document.new_tag("p")
    paragraph.string = description
    article.append(paragraph)
    return article


def _ap_structured_description_body(
    news_article: dict[str, Any],
) -> Tag | None:
    """Recover self-contained AP briefs stored only in JSON-LD descriptions."""
    if not news_article:
        return None
    description = _string_or_none(news_article.get("description"))
    keywords = _string_list(news_article.get("keywords"))
    is_score_bulletin = any(
        re.search(r"(?i)\b(?:prep\s+)?scores?\b", keyword)
        for keyword in keywords
    )
    is_archive_brief = any(
        keyword.casefold() == "archive"
        for keyword in keywords
    )
    if not description or (
        len(description) < _MINIMUM_BODY_CHARACTERS
        and not is_score_bulletin
        and not is_archive_brief
    ):
        return None
    if re.search(
        r"(?i)^(?:visit|view|click|subscribe)\b.*(?:\||edition|website)",
        description,
    ):
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    paragraph = document.new_tag("p")
    paragraph.string = description
    article.append(paragraph)
    return article


def _ap_structured_data_bulletin_body(
    news_article: dict[str, Any],
    canonical_url: str,
) -> Tag | None:
    """Represent AP metadata-only election/result wires without inventing prose."""
    if not _is_ap_data_bulletin(news_article, canonical_url):
        return None
    headline = _first_text(
        _string_or_none(news_article.get("headline")),
        _ap_data_bulletin_headline(news_article),
    )
    if not headline:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    paragraph = document.new_tag("p")
    paragraph.string = headline
    article.append(paragraph)
    return article


def _ap_data_bulletin_headline(
    news_article: dict[str, Any],
) -> str | None:
    if not news_article:
        return None
    keywords = _string_list(news_article.get("keywords"))
    for keyword in keywords:
        if re.search(r"(?i)(?:--.*\bbox\b|\bbox score\b)", keyword):
            return keyword
    if any(keyword.casefold() == "lotteries" for keyword in keywords):
        ignored = {"lotteries", "general news", "ap", "ap news"}
        return next(
            (
                keyword
                for keyword in keywords
                if keyword.casefold() not in ignored
            ),
            "Lottery results",
        )
    return None


def _ap_structured_headline(
    news_article: dict[str, Any],
) -> str | None:
    headline = (
        _string_or_none(news_article.get("headline"))
        if news_article
        else None
    )
    if headline and headline.casefold() in {"ap", "ap news"}:
        return None
    return headline


def _ap_wire_keyword_headline(
    news_article: dict[str, Any],
) -> str | None:
    """Use AP's descriptive wire slug when generic page metadata says AP News."""
    if not news_article:
        return None
    keywords = _string_list(news_article.get("keywords"))
    strict_wire_slug = next(
        (
            keyword
            for keyword in keywords
            if re.match(r"^[A-Z]{2,5}--\S", keyword)
        ),
        None,
    )
    if strict_wire_slug:
        return strict_wire_slug
    ignored = {
        "general news",
        "international news",
        "ap",
        "ap news",
        "archive",
    }
    return next(
        (
            keyword
            for keyword in keywords
            if keyword.casefold() not in ignored
            and "-" in keyword
            and len(keyword) >= 12
        ),
        None,
    )


def _is_ap_data_bulletin(
    news_article: dict[str, Any],
    canonical_url: str,
) -> bool:
    if not news_article:
        return False
    headline = _first_text(
        _string_or_none(news_article.get("headline")),
        _ap_data_bulletin_headline(news_article),
    )
    keywords = _string_list(news_article.get("keywords"))
    has_description = bool(
        _string_or_none(news_article.get("description"))
    )
    combined = " ".join(
        [headline or "", canonical_url, *keywords]
    ).casefold()
    metadata_only_election_slug = bool(
        not has_description
        and headline
        and any(headline.casefold() == keyword.casefold() for keyword in keywords)
        and re.fullmatch(
            r"[a-z]{2}-(?=[a-z0-9-]*(?:"
            r"uncontested|nominated|winners?|topraces|"
            r"camend|house|sthou|delg-dist|cnty"
            r"))[a-z0-9-]+",
            headline.casefold(),
        )
    )
    return bool(
        re.search(r"--.*\bbox\b|\bbox score\b", combined)
        or re.search(
            r"(?:^|[-/])(?:[a-z]{2}-)?house-\d+-nominated(?:-|$)",
            combined,
        )
        or (
            not has_description
            and any(
                "race call" in keyword.casefold()
                for keyword in keywords
            )
        )
        or (
            not has_description
            and any(
                keyword.casefold() == "lotteries"
                for keyword in keywords
            )
        )
        or (
            not has_description
            and any(
                re.fullmatch(r"[a-z]{2}-winners", keyword.casefold())
                for keyword in keywords
            )
        )
        or metadata_only_election_slug
    )


def _remove_ap_body_promos(soup: BeautifulSoup) -> None:
    """Remove AP calls-to-action embedded as legacy body paragraphs."""
    for module in list(
        soup.select(
            ".article-share, .sharedaddy, .sd-sharing, .item-newsletter, "
            ".PagePromo"
        )
    ):
        module.decompose()
    for node in list(
        soup.select(
            "#hn-headline, .hn-byline, #hn-distributor-copyright, "
            ".contin_below, .adver_cont_below, .mid_article_ad_label, "
            ".ad_wrapper"
        )
    ):
        node.decompose()
    for node in list(soup.select("[data-ap-readmore]")):
        node.decompose()
    for node in list(soup.select("form, input, select, textarea")):
        node.decompose()
    for button in list(soup.select("button")):
        button.decompose()

    # Some AP live-update/gallery stories include a plain ``Read more:``
    # paragraph followed by a run of related-story links and an ``___``
    # separator.  Those links are navigation chrome, not part of the wire
    # copy.  Remove the complete contiguous module while retaining the next
    # live-update heading and its substantive paragraphs.
    for marker in list(soup.select("p")):
        if _clean_text(marker.get_text(" ", strip=True)).casefold() != (
            "read more:"
        ):
            continue
        sibling = marker.find_next_sibling()
        marker.decompose()
        while isinstance(sibling, Tag):
            next_sibling = sibling.find_next_sibling()
            text = _clean_text(sibling.get_text(" ", strip=True))
            sibling.decompose()
            if text == "___":
                break
            sibling = next_sibling

    # AP's syndicated legacy body uses inline ``RELATED`` link labels as
    # navigation chrome.  Keep the linked headline that follows, but remove
    # the standalone interface marker from the normalized prose.
    for marker in list(soup.select(".LinkEnhancement")):
        if _clean_text(marker.get_text(" ", strip=True)).rstrip(":").casefold() != "related":
            continue
        parent = marker.parent
        marker.decompose()
        if isinstance(parent, Tag) and not _clean_text(parent.get_text(" ", strip=True)):
            parent.decompose()

    patterns = (
        re.compile(
            r"(?i)\bsign up for (?:the )?ap(?:'s|’s) .*newsletter\b"
        ),
        re.compile(
            r"(?i)^sign up for .{0,120}\bnewsletter\b.{0,120}"
            r"\b(?:the )?ap(?:'s|’s)\b"
        ),
        re.compile(
            r"(?i)^for more lottery results,\s*go to jackpot\.com\b"
        ),
        re.compile(
            r"(?i)^(?:more\s+)?ap\s+(?:mlb|nfl|soccer|golf|nba|nhl|"
            r"college football)\s*:\s*https?://apnews\.com/hub/\S+"
            r"(?:\s+and\s+https?://(?:(?:www\.)?(?:twitter|x)\.com/|"
            r"apnews\.com/hub/)\S+)*\s*$"
        ),
        re.compile(
            r"(?i)^[▶►]?\s*view and download the (?:men(?:'|’)s|women(?:'|’)s) "
            r"ncaa tournament bracket\s*$"
        ),
    )
    for row in list(soup.select("tr")):
        cells = [
            _clean_text(cell.get_text(" ", strip=True))
            for cell in row.select(":scope > th, :scope > td")
        ]
        if cells and all(
            not text
            or re.fullmatch(r"[_=—–-]+", text)
            or re.fullmatch(r"[•·]{2,}", text)
            for text in cells
        ):
            row.decompose()
    for table in list(soup.select("table")):
        if not _clean_text(table.get_text(" ", strip=True)):
            table.decompose()

    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if (
            text == "."
            or re.fullmatch(r"[_=—–-]+", text)
            or re.fullmatch(r"[•·]{2,}", text)
            or text in {"<", ">"}
        ):
            node.decompose()
            continue
        if not any(pattern.search(text) for pattern in patterns):
            continue
        previous = node.find_previous_sibling()
        for _ in range(4):
            if not isinstance(previous, Tag):
                break
            earlier = previous.find_previous_sibling()
            if _clean_text(previous.get_text(" ", strip=True)) == "___":
                previous.decompose()
            previous = earlier
        node.decompose()


from jojo_news_archive.parsing.parser_contracts import (
    BaseSourceParser,
    ImageParseContext,
    ParseContext,
)


def _ap_image_identity(url: str) -> str | None:
    parts = urlsplit(url)
    if (parts.hostname or "").casefold() != "dims.apnews.com":
        return None
    nested_match = re.search(
        r"(?:^|&)url=([^&]+)",
        parts.query,
        flags=re.IGNORECASE,
    )
    if nested_match is None:
        return None
    nested = unquote(nested_match.group(1))
    nested_parts = urlsplit(nested)
    if nested_parts.scheme in {"http", "https"} and nested_parts.netloc:
        return nested
    return None


class ApParser(BaseSourceParser):
    def select_body(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.body import (
            select_body as _select_body,
            select_default_body as _select_default_body,
        )
        from jojo_news_archive.parsing.primitives import (
            clean_text as _clean_text,
        )

        body = _ap_carousel_gallery(context.soup)
        if body is not None:
            context.structured_image_gallery_selected = True
        else:
            body = _ap_structured_race_call_body(context.news_article)
            if body is None:
                body = _ap_structured_description_body(context.news_article)
            if body is None:
                body = _ap_structured_data_bulletin_body(
                    context.news_article,
                    context.canonical_url,
                )
        dom_body = _select_body(context.soup, context.spec)
        if dom_body is not None and (
            body is None
            or len(_clean_text(dom_body.get_text(" ", strip=True)))
            > len(_clean_text(body.get_text(" ", strip=True)))
        ):
            body = dom_body
        context.body = _select_default_body(context, initial_body=body)

    def clean_body_before_noise(self, context: ParseContext) -> None:
        if context.clean_body is not None:
            _remove_ap_body_promos(context.clean_body)

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
        )

        context.headline = _first_text(
            _ap_structured_headline(context.news_article),
            _ap_data_bulletin_headline(context.news_article),
            _ap_wire_keyword_headline(context.news_article),
            _ap_hosted_headline(context.soup),
            context.headline,
        )
        if not context.authors:
            context.authors = _ap_hosted_authors(context.soup)
        if context.published_at is None:
            context.published_at = _parse_datetime(
                _ap_hosted_published_at(context.soup)
            )

    def classify_content(self, context: ParseContext) -> None:
        if _is_ap_data_bulletin(
            context.news_article,
            context.canonical_url,
        ):
            context.content_type = ContentType.INTERACTIVE

    def prepare_image(self, context: ImageParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            caption_credit as _caption_credit,
        )

        slide = context.image_node.find_parent(
            class_=lambda value: value and "Carousel-slide" in value
        )
        if isinstance(slide, Tag):
            context.container = slide
            context.caption, context.credit = _caption_credit(slide)

    def image_identity(self, url: str) -> str | None:
        return _ap_image_identity(url)

    def is_placeholder_image_url(
        self,
        context: ParseContext,
        url: str,
    ) -> bool:
        decoded = unquote(url).casefold()
        return any(
            marker in decoded
            for marker in (
                "the-ap-default-image-",
                "/fox-news/og/",
                "/today-socialshareimages-bento/",
                "/newsgroup-logos/nbcnews/social/",
                "restrictedimagesub.jpg",
                "/thegrio-default-",
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
        plain_text = context.plain_text
        if not headline:
            return False
        keywords = _string_list(context.news_article.get("keywords"))
        metric_labels = re.findall(
            r"(?i)(?:calories|fat|sodium|sugar|protein|"
            r"carbohydrates?|price|rank(?:ing)?)"
            r"(?:\s*\([^)]{1,12}\))?\s*:",
            plain_text,
        )
        keys = {
            re.sub(r"[^a-z0-9]+", "", value.casefold())
            for value in keywords
        }
        alert = bool(
            len(plain_text) >= 40
            and ({"apalertanoticioso", "apnewsalert"} & keys)
        )
        data_bulletin = bool(
            _is_ap_data_bulletin(context.news_article, "")
            and plain_text.casefold() == headline.casefold()
        )
        score = bool(
            len(plain_text) >= 40
            and any(
                re.search(r"(?i)\b(?:prep\s+)?scores?\b", value)
                for value in keywords
            )
        )
        description = _string_or_none(
            context.news_article.get("description")
        )
        archive_brief = bool(
            len(plain_text) >= 40
            and description
            and plain_text == description
            and any(value.casefold() == "archive" for value in keywords)
            and not re.search(
                r"(?i)^(?:visit|view|click|subscribe)\b",
                plain_text,
            )
        )
        return bool(
            (
                re.match(r"^\s*#\d+\b", headline)
                and any(value.casefold() == "archive" for value in keywords)
                and len(metric_labels) >= 3
            )
            or alert
            or data_bulletin
            or score
            or archive_brief
        )


PARSER: ApParser = ApParser()
