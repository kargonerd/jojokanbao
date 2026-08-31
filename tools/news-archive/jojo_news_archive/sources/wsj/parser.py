from __future__ import annotations

import copy
import json
import re
from typing import Any
from urllib.parse import unquote, urlsplit, urlunsplit
from bs4 import BeautifulSoup, Tag
from jojo_news_archive.models import BlockType, ContentType
from jojo_news_archive.parsing.images import (
    generic_image_identity as _generic_image_identity,
)
from jojo_news_archive.parsing.primitives import (
    clean_text as _clean_text,
    first_text as _first_text,
    meta_content as _meta_content,
    normalized_url as _normalized_url,
    string_or_none as _string_or_none,
    tag_attribute as _tag_attribute,
    tag_text as _tag_text,
)


def _wsj_source_image_identity(url: str) -> str | None:
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    image = (
        re.fullmatch(
            r"(/im-\d+)(?:/(?:social|portrait))?/?",
            parts.path,
            flags=re.IGNORECASE,
        )
        if host in {"images.wsj.net", "opinion-images.wsj.net"}
        else None
    )
    if image is not None:
        return urlunsplit(
            (
                parts.scheme.casefold(),
                parts.netloc.casefold(),
                image.group(1),
                "",
                "",
            )
        )
    if host == "si.wsj.net":
        legacy_image = re.fullmatch(
            r"(.+?)_(?:G|D|M|SOC|TOP|IM)_(\d+)\.([a-z0-9]+)",
            parts.path,
            flags=re.IGNORECASE,
        )
        if legacy_image is not None:
            return (
                "wsj-legacy-image:"
                f"{legacy_image.group(1).casefold()}_"
                f"{legacy_image.group(2)}."
                f"{legacy_image.group(3).casefold()}"
            )
    return None


def _image_identity(url: str) -> str:
    generic = _generic_image_identity(url)
    return (
        _wsj_source_image_identity(url)
        or _wsj_source_image_identity(generic)
        or generic
    )


def _wsj_tovima_body(soup: BeautifulSoup) -> Tag | None:
    """Select only the licensed WSJ copy from To Vima partner pages."""
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    if not partner_url or "tovima.com/" not in partner_url.casefold():
        return None
    body = soup.select_one(".post-body.main-content, .post-body.article-wrapper")
    return body if isinstance(body, Tag) else None


def _wsj_selected_body_is_comment(body: Tag) -> bool:
    """Return whether a generic WSJ body candidate is Livefyre discussion."""

    classes = {
        str(value).casefold() for value in body.get("class", [])
    }
    if any(value.startswith("fyre-comment") for value in classes):
        return True
    return bool(
        body.find_parent(id="livefyre-comment")
        or body.find_parent(
            attrs={"data-module-name": re.compile("livefyre", re.IGNORECASE)}
        )
    )


def _wsj_is_legacy_video(soup: BeautifulSoup) -> bool:
    if soup.select_one(
        "#masterVideoCenter, .vcrPlayerArea, .js_videoPlayer #videoPlayer"
    ):
        return True
    return any(
        re.search(r"""articleType\s*:\s*["']Video\s*-\s*WSJ["']""", value)
        for script in soup.select("script")
        if (value := script.string or script.get_text())
    )


def _wsj_legacy_video_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Recover descriptions and transcripts from the old WSJ Video Center."""
    if not _wsj_is_legacy_video(soup):
        return None
    description = _first_text(
        _tag_text(
            soup.select_one(
                "#videoPlayerDescription [itemprop='description'], "
                "#currentVideoInfo > p"
            )
        ),
        _meta_content(soup, "name", "description"),
        _meta_content(soup, "property", "og:description"),
    )
    transcript = _tag_text(soup.select_one(".vcrTranscriptContent"))
    video_url = _first_text(
        _tag_attribute(soup.select_one("#videoTitle[href]"), "href"),
        canonical_url,
    )
    if not description and not transcript and not video_url:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    if description:
        paragraph = document.new_tag("p")
        paragraph.string = description
        article.append(paragraph)
    if transcript:
        heading = document.new_tag("h2")
        heading.string = "Transcript"
        article.append(heading)
        paragraph = document.new_tag("p")
        paragraph.string = transcript
        article.append(paragraph)
    normalized_video_url = _normalized_url(
        video_url,
        base_url=canonical_url,
    )
    if normalized_video_url:
        iframe = document.new_tag("iframe")
        iframe["src"] = normalized_video_url
        iframe["title"] = "WSJ video"
        article.append(iframe)
    return article


def _wsj_amp_story_gallery(soup: BeautifulSoup) -> Tag | None:
    pages = soup.select("amp-story > amp-story-page")
    if len(pages) < 3:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for page in pages:
        image = page.select_one(
            "amp-img[media*='landscape' i], amp-img"
        )
        if not isinstance(image, Tag):
            continue
        source = _string_or_none(image.get("src"))
        if not source:
            continue
        figure = document.new_tag("figure")
        image_node = document.new_tag("img")
        image_node["src"] = source
        width = _string_or_none(image.get("width"))
        height = _string_or_none(image.get("height"))
        if width:
            image_node["width"] = width
        if height:
            image_node["height"] = height
        caption = _tag_text(page.select_one(".wsj--caption"))
        credit = _tag_text(page.select_one(".wsj--credit"))
        if caption:
            image_node["alt"] = caption
        figure.append(image_node)
        if caption or credit:
            figcaption = document.new_tag("figcaption")
            figcaption.string = " ".join(
                value
                for value in (
                    caption,
                    f"Credit: {credit}" if credit else None,
                )
                if value
            )
            figure.append(figcaption)
        article.append(figure)
    return article if len(article.select("figure")) >= 3 else None


def _wsj_legacy_slideshow(soup: BeautifulSoup) -> Tag | None:
    slides = soup.select(
        ".dj-slideshow .slide-wrapper:not(.thumbgrid-wrapper), "
        ".wsj-slideshow-slide:not(.explore-more-slide)"
    )
    if len(slides) < 2:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for slide in slides:
        image = slide.select_one("img[src], img[data-src]")
        content_url = slide.select_one(
            "meta[itemprop='contentUrl'][content], "
            "meta[property='contentUrl'][content]"
        )
        source = _first_text(
            _string_or_none(content_url.get("content"))
            if isinstance(content_url, Tag)
            else None,
            _string_or_none(image.get("src"))
            if isinstance(image, Tag)
            else None,
            _string_or_none(image.get("data-src"))
            if isinstance(image, Tag)
            else None,
        )
        if not source:
            continue
        credit = _first_text(
            _string_or_none(slide.get("data-credit")),
            _tag_text(
                slide.select_one(
                    ".caption-wrapper span, "
                    "[itemprop='copyrightHolder'], "
                    ".credit"
                )
            ),
        )
        caption_node = slide.select_one(
            ".caption-wrapper p, [itemprop='caption'], "
            ".wsj-slideshow-caption, figcaption"
        )
        caption = None
        if isinstance(caption_node, Tag):
            caption_copy = BeautifulSoup(
                str(caption_node),
                "html.parser",
            )
            for credit_node in caption_copy.select("span"):
                credit_node.decompose()
            caption = _tag_text(caption_copy)
        figure = document.new_tag("figure")
        image_node = document.new_tag("img")
        image_node["src"] = source
        if caption:
            image_node["alt"] = caption
        figure.append(image_node)
        if caption or credit:
            figcaption = document.new_tag("figcaption")
            figcaption.string = " ".join(
                value
                for value in (
                    caption,
                    f"Credit: {credit}" if credit else None,
                )
                if value
            )
            figure.append(figcaption)
        article.append(figure)
    return article if len(article.select("figure")) >= 2 else None


def _wsj_inline_slideshow_article_body(
    body: Tag | None,
    *,
    gallery_body: Tag,
) -> Tag | None:
    """Replace an inline legacy slideshow without discarding article prose."""

    if not isinstance(body, Tag):
        return None
    document = BeautifulSoup(str(body), "html.parser")
    body_copy = document.find(body.name)
    if not isinstance(body_copy, Tag):
        return None
    slideshows = body_copy.select(".wsj-slideshow, .dj-slideshow")
    if not slideshows:
        return None
    prose_copy = BeautifulSoup(str(body_copy), "html.parser")
    for slideshow in prose_copy.select(".wsj-slideshow, .dj-slideshow"):
        slideshow.decompose()
    prose = _clean_text(prose_copy.get_text(" ", strip=True))
    if len(prose) < 400:
        return None
    replacement = document.new_tag("div")
    replacement["data-jojo-inline-gallery"] = ""
    for figure in gallery_body.select("figure"):
        replacement.append(copy.copy(figure))
    if len(replacement.select("figure")) < 2:
        return None
    slideshows[0].replace_with(replacement)
    for duplicate in slideshows[1:]:
        duplicate.decompose()
    return body_copy


def _wsj_webui_slideshow(soup: BeautifulSoup) -> Tag | None:
    rows: list[tuple[str, str | None, str | None]] = []
    seen: set[str] = set()
    decoder = json.JSONDecoder()
    for script in soup.find_all("script"):
        value = script.string or script.get_text()
        if "WEBUI_SLIDESHOWS" not in value:
            continue
        for match in re.finditer(r"\bstate\s*:\s*(?=\{)", value):
            try:
                state, _ = decoder.raw_decode(value, match.end())
            except json.JSONDecodeError:
                continue
            if not isinstance(state, dict):
                continue
            context = state.get("context")
            slides = (
                context.get("slides")
                if isinstance(context, dict)
                else None
            )
            if not isinstance(slides, list):
                continue
            for slide in slides:
                if not isinstance(slide, dict):
                    continue
                source = _string_or_none(slide.get("imageSrc"))
                if not source:
                    continue
                identity = _image_identity(source)
                if identity in seen:
                    continue
                seen.add(identity)
                rows.append(
                    (
                        source,
                        _string_or_none(slide.get("caption")),
                        _string_or_none(slide.get("credit")),
                    )
                )
    if len(rows) < 3:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for source, caption, credit in rows:
        figure = document.new_tag("figure")
        image = document.new_tag("img")
        image["src"] = source
        if caption:
            image["alt"] = caption
        figure.append(image)
        if caption or credit:
            figcaption = document.new_tag("figcaption")
            figcaption.string = " ".join(
                value
                for value in (
                    caption,
                    f"Credit: {credit}" if credit else None,
                )
                if value
            )
            figure.append(figcaption)
        article.append(figure)
    return article


def _wsj_legacy_ellipsis_truncation(plain_text: str) -> bool:
    """Recognize short legacy archive captures cut off with a literal ellipsis."""
    text = plain_text.rstrip()
    return len(text) < 1_000 and bool(re.search(r"\.{3,}$", text))


def _wsj_missing_best_seller_chart(
    *,
    headline: str | None,
    plain_text: str,
) -> bool:
    """Reject archived bestseller pages whose actual chart is absent.

    Some 2019 AMP captures preserve the headline and the common NPD
    BookScan methodology footer while their media-object chart slots are
    empty.  The shared footer is long enough to clear the generic article
    body floor, but it is not the article's editorial payload.
    """
    normalized_headline = _clean_text(headline or "").casefold()
    normalized_text = _clean_text(plain_text).casefold()
    return bool(
        normalized_headline.startswith("best-selling books")
        and "week ended" in normalized_headline
        and normalized_text.startswith("methodology ")
        and "npd bookscan gathers point-of-sale book data" in normalized_text
        and len(normalized_text) < 1_500
    )


def _wsj_subscription_truncation(
    soup: BeautifulSoup,
    *,
    content_type: ContentType,
    plain_text: str,
    selected_sign_in: bool,
) -> bool:
    """Reject metered WSJ previews while retaining substantial recovered copy."""
    # WSJ's snippet template is also used for short, complete items such as
    # Letters.  Those pages retain the generic membership overlay even when
    # the extracted body reaches the publisher-declared word count.  Check
    # that explicit completeness signal before treating the overlay as a
    # truncation marker; a real preview with a larger declared count still
    # falls through to the existing deficit checks below.
    declared_word_count = _wsj_declared_word_count(soup)
    extracted_word_count = len(
        re.findall(
            r"[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*",
            plain_text,
        )
    )
    declared_copy_is_complete = bool(
        declared_word_count is not None
        and extracted_word_count >= max(
            1,
            int(declared_word_count * 0.85),
        )
    )
    template_value = _tag_attribute(
        soup.select_one("meta[name='article.template']"), "content"
    )
    explicit_snippet_template = bool(
        (template_value or "").casefold() in {"snippet", "preview"}
        or any(
            re.search(
                r'''["']article_template["']\s*:\s*["']preview["']''',
                script.string or script.get_text(),
                re.IGNORECASE,
            )
            for script in soup.find_all("script")
        )
    )
    if content_type != ContentType.ARTICLE and not (
        explicit_snippet_template
        and declared_word_count is not None
        and declared_word_count >= 100
        and not declared_copy_is_complete
    ):
        return False
    legacy_article_panel = soup.select_one("#articleTabs_panel_article")
    if (
        isinstance(legacy_article_panel, Tag)
        and legacy_article_panel.select_one(".article.story") is None
        and (
            legacy_article_panel.select_one("#artSnippetControl") is not None
            or "available to wsj.com subscribers"
            in _clean_text(
                legacy_article_panel.get_text(" ", strip=True)
            ).casefold()
        )
    ):
        # Some 2010--2013 partner/preview captures retain the headline but
        # omit the story node entirely.  The broad legacy panel then consists
        # of MSN navigation, recommended-story snippets, sign-in controls and
        # email-dialog copy; its aggregate length can exceed the generic body
        # minimum even though no article prose survives.
        return True
    if soup.select_one("[class*='ArticleRoadblock' i]") or any(
        _clean_text(node.get_text(" ", strip=True))
        .casefold()
        .startswith("to read the full story")
        for node in soup.select("p, h2, h3, h4")
    ):
        return True
    snippet_roadblock_phrases = (
        "to read the full story",
        "continue reading your article with a wsj membership",
        "subscribe to wsj to read the rest of this article",
    )
    if any(
        any(phrase in text for phrase in snippet_roadblock_phrases)
        for node in soup.select(
            ".snippet-promotion, #cx-snippet-overlay, .snippet-content"
        )
        if (text := _clean_text(node.get_text(" ", strip=True)).casefold())
    ):
        # Archived 2020-era WSJ pages can preserve several substantial
        # preview paragraphs before an explicit membership overlay. Their
        # extracted text may exceed the generic 1,000-character safety
        # threshold even though the article ends at the paywall.
        return not declared_copy_is_complete
    if len(plain_text) >= 1_000:
        return False
    if (
        declared_copy_is_complete
    ):
        return False
    if (
        declared_word_count is not None
        and declared_word_count >= 100
        and extracted_word_count * 2 < declared_word_count
    ):
        # Some archived WSJ templates omit both the visible roadblock and
        # copyright footer while preserving only a three-paragraph preview.
        # WSJ's own article word count is still present in those captures;
        # a deficit greater than half is strong truncation evidence without
        # penalizing genuine short reports or editorial letters.
        return True
    if selected_sign_in:
        return True
    copyright_footer = any(
        (
            (text := _clean_text(node.get_text(" ", strip=True))).casefold()
            .startswith("copyright ©")
            and "dow jones & company" in text.casefold()
        )
        for node in soup.select("p")
    )
    if not copyright_footer:
        return False
    modern_body_paragraphs = [
        node
        for node in soup.select("p[data-type='paragraph']")
        if _clean_text(node.get_text(" ", strip=True))
    ]
    has_metered_controls = bool(
        soup.select_one(
            "[class*='ListenToArticle' i], "
            "[class*='MinutesLabel' i], "
            "h2[class*='SectionLabel' i]"
        )
    )
    return bool(has_metered_controls or len(modern_body_paragraphs) <= 3)


def _wsj_declared_word_count(soup: BeautifulSoup) -> int | None:
    """Read WSJ's own word count so genuine short reports are not previews."""
    raw = _first_text(
        _meta_content(soup, "name", "article:word_count"),
        _meta_content(soup, "property", "article:word_count"),
    )
    if raw is None:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def _wsj_unsupported_media_gallery(soup: BeautifulSoup) -> Tag | None:
    """Recover the synopsis when an old slideshow app cannot be replayed."""
    shell = soup.select_one(".wsj-snippet-body, .wsj-snippet-login")
    if isinstance(shell, Tag):
        shell_text = shell.get_text(" ", strip=True).casefold()
        if (
            "media that is not currently supported" not in shell_text
            or soup.select_one(".slideshow-article") is None
        ):
            return None
    else:
        # Infini-News sometimes materializes an old WSJ photo story as a tiny
        # derived document.  It has no replayable slide payload and its body
        # consists solely of the explicit unsupported-media notice followed by
        # subscription/navigation chrome.  Returning an empty article keeps
        # the record as a gallery shell while preventing interface prose from
        # entering the canonical body.
        derived = soup.select_one(
            "article[data-jojo-representation='derived-infini-news']"
        )
        if not isinstance(derived, Tag):
            return None
        derived_text = derived.get_text(" ", strip=True).casefold()
        if (
            "article not supported" not in derived_text
            or "media that is not currently supported" not in derived_text
            or "to read the full story" not in derived_text
        ):
            return None
        document = BeautifulSoup("<article></article>", "html.parser")
        article = document.article
        return article if isinstance(article, Tag) else None
    description = _first_text(
        _meta_content(soup, "name", "description"),
        _meta_content(soup, "property", "og:description"),
    )
    if not description:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    paragraph = document.new_tag("p")
    paragraph.string = description
    article.append(paragraph)
    return article


def _wsj_interactive_puzzle(
    soup: BeautifulSoup,
    article: dict[str, Any],
    canonical_url: str,
) -> bool:
    section = _string_or_none(article.get("articleSection")) if article else None
    has_puzzle_embed = soup.select_one(
        ".interactive-puzzle-template iframe, "
        ".puzzle-template-article-sector iframe, "
        "iframe[class*='puzzle' i], "
        "a[href*='/documents/'][href$='.pdf' i]"
    )
    if not has_puzzle_embed:
        return False
    url = canonical_url.casefold()
    return bool(
        (section and "puzzle" in section.casefold())
        or any(
            token in url
            for token in (
                "acrostic",
                "crossword",
                "cryptic-puzzle",
                "variety-puzzle",
                "number-puzzles",
                "/puzzles/",
            )
        )
    )


def _wsj_puzzle_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    links = [
        link
        for link in soup.select("a[href]")
        if (
            (href := _string_or_none(link.get("href")))
            and "/documents/" in href.casefold()
            and href.casefold().split("?", 1)[0].endswith(".pdf")
        )
    ]
    if not links:
        return None
    page_text = _clean_text(soup.get_text(" ", strip=True)).casefold()
    url = canonical_url.casefold()
    if "puzzle" not in page_text and "puzzle" not in url:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    seen: set[str] = set()
    for link in links:
        href = str(link.get("href"))
        if href in seen:
            continue
        seen.add(href)
        label = _tag_text(link) or "Download puzzle PDF"
        paragraph = document.new_tag("p")
        paragraph.string = label
        article.append(paragraph)
        iframe = document.new_tag("iframe")
        iframe["src"] = href
        iframe["title"] = label
        article.append(iframe)
    return article if seen else None


def _wsj_inset_table_body(soup: BeautifulSoup) -> Tag | None:
    """Render archived WSJ graphics data-table JSON into semantic tables."""
    decoder = json.JSONDecoder()
    payloads: list[dict[str, Any]] = []
    marker = re.compile(
        r"\bvar\s+insetData_[A-Za-z0-9_]+\s*=\s*"
        r"function\s*\(\s*\)\s*\{\s*return\s*",
    )
    for script in soup.find_all("script"):
        value = script.string or script.get_text()
        if not value or "insetData_" not in value:
            continue
        for match in marker.finditer(value):
            try:
                payload, _ = decoder.raw_decode(value[match.end() :])
            except (json.JSONDecodeError, TypeError):
                continue
            if (
                isinstance(payload, dict)
                and isinstance(payload.get("data"), list)
                and payload["data"]
            ):
                payloads.append(payload)
    if not payloads:
        return None
    document = BeautifulSoup(
        "<article data-jojo-source='wsj-inset-tables'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None
    for payload in payloads:
        rows = [row for row in payload["data"] if isinstance(row, dict)]
        if not rows:
            continue
        configured_columns = payload.get("settings", {}).get("columns", [])
        columns = [
            str(column["name"])
            for column in configured_columns
            if isinstance(column, dict)
            and isinstance(column.get("name"), str)
            and column["name"] in rows[0]
        ]
        if not columns:
            columns = [str(key) for key in rows[0]]
        headline = _string_or_none(payload.get("headline"))
        if headline:
            heading = document.new_tag("h2")
            heading.string = headline
            article.append(heading)
        description = _string_or_none(payload.get("description"))
        if description and (
            not headline or description.casefold() != headline.casefold()
        ):
            paragraph = document.new_tag("p")
            paragraph.string = description
            article.append(paragraph)
        table = document.new_tag("table")
        header = document.new_tag("thead")
        header_row = document.new_tag("tr")
        for column in columns:
            cell = document.new_tag("th")
            cell.string = column
            header_row.append(cell)
        header.append(header_row)
        table.append(header)
        table_body = document.new_tag("tbody")
        for row in rows:
            table_row = document.new_tag("tr")
            for column in columns:
                cell = document.new_tag("td")
                cell.string = _clean_text(
                    BeautifulSoup(
                        f"<span>{row.get(column, '')}</span>",
                        "html.parser",
                    ).get_text(" ", strip=True)
                )
                table_row.append(cell)
            table_body.append(table_row)
        table.append(table_body)
        article.append(table)
        source = _string_or_none(payload.get("source"))
        if source:
            source_paragraph = document.new_tag("p")
            source_paragraph.string = f"Source: {source}"
            article.append(source_paragraph)
    return article if article.select_one("table") is not None else None


def _trim_wsj_roadblock_tail(soup: BeautifulSoup) -> None:
    """Drop the subscription roadblock and recirculation appended after it."""
    marker = soup.select_one("[class*='ArticleRoadblock' i]")
    if not isinstance(marker, Tag):
        marker = next(
            (
                node
                for node in soup.select("p, h2, h3, h4")
                if _clean_text(node.get_text(" ", strip=True))
                .casefold()
                .startswith(
                    (
                        "to read the full story",
                        "continue reading your article with",
                    )
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


def _remove_wsj_promos(soup: BeautifulSoup) -> None:
    """Remove metered-view controls, copyright footers and coupon modules."""
    full_access_body = any(
        _clean_text(str(node.get("amp-access") or "")).casefold()
        == "access"
        for node in soup.select("[amp-access]")
    ) or soup.select_one("[subscriptions-section='content']") is not None
    if full_access_body:
        for snippet in list(
            soup.select(
                ".snippet[amp-access], "
                ".snippet[subscriptions-section='content-not-granted']"
            )
        ):
            access_rule = _clean_text(
                str(snippet.get("amp-access") or "")
            ).casefold()
            subscription_rule = _clean_text(
                str(snippet.get("subscriptions-section") or "")
            ).casefold()
            if (
                access_rule == "not access"
                or subscription_rule == "content-not-granted"
            ):
                # AMP keeps a deliberately truncated metered preview beside
                # the complete subscriber body.  Once the complete sibling
                # is present, retaining the preview leaks duplicate opening
                # paragraphs and a meaningless terminal ``The...`` block.
                # Newer AMP subscriptions markup expresses the same state as
                # ``content`` / ``content-not-granted`` attributes.
                snippet.decompose()
    for marker in list(soup.select("p")):
        marker_text = _clean_text(marker.get_text(" ", strip=True)).casefold()
        if not marker_text.startswith("the wsj is now on line."):
            continue
        # Korea Real Time and a few other legacy WSJ blogs appended a LINE
        # signup, QR code and an ``Also popular`` link rail as ordinary
        # paragraphs inside ``articleBody``.  The promo is a terminal footer,
        # so remove it and every following sibling while retaining the update
        # or correction paragraph immediately before it.
        top = soup.find()
        if not isinstance(top, Tag):
            break
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
        break
    for newsletter_link in list(
        soup.select("a[href*='/newsletters'][href*='sub=best_of_the_web']")
    ):
        # Best of the Web columns append this inline subscription CTA in an
        # otherwise unclassified ``em`` node inside the article body.
        newsletter_link.decompose()
    for marker in list(soup.select("p")):
        marker_text = _clean_text(
            marker.get_text(" ", strip=True)
        ).casefold()
        if marker_text != "follow james freeman on twitter.":
            continue
        profile_link = marker.select_one(
            "a[href*='twitter.com/freemanwsj' i], "
            "a[href*='x.com/freemanwsj' i]"
        )
        if not isinstance(profile_link, Tag):
            continue
        # Best of the Web columns archived in 2019 append a stable author
        # promotion after the final editorial paragraph: the author's
        # Twitter profile, an email solicitation, compiler credit and a book
        # biography.  Trim only the tail identified by Freeman's exact
        # profile link, leaving ordinary in-article Twitter references and
        # every preceding paragraph untouched.
        top = soup.find()
        if not isinstance(top, Tag):
            break
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
        break
    for button in list(soup.select("button")):
        button.decompose()
    for form in list(soup.select("form")):
        # Reader questionnaires and share-by-email dialogs are interactive
        # controls, not article copy. Removing the whole form also drops its
        # field labels and consent boilerplate instead of leaving a flattened
        # pseudo-paragraph in the archived body.
        form.decompose()
    for control in list(soup.select("input, select, textarea")):
        control.decompose()
    for tagline in list(soup.select("p.articleTagLine")):
        if re.fullmatch(
            r"[_=—–-]+",
            _clean_text(tagline.get_text(" ", strip=True)),
        ):
            tagline.decompose()
    for strap in list(soup.select(".strap-container")):
        heading = strap.select_one("h2, h3, h4, h5, h6, .strap")
        if (
            isinstance(heading, Tag)
            and _clean_text(heading.get_text(" ", strip=True)).casefold()
            == "related video"
        ):
            strap.decompose()
    for rich_text in list(soup.select(".media-object-rich-text")):
        heading = rich_text.select_one("h2, h3, h4, h5, h6")
        heading_text = (
            _clean_text(heading.get_text(" ", strip=True)).casefold()
            if isinstance(heading, Tag)
            else ""
        )
        link = rich_text.select_one("a[href]")
        link_text = (
            _clean_text(link.get_text(" ", strip=True)).casefold()
            if isinstance(link, Tag)
            else ""
        )
        link_href = str(link.get("href") or "") if isinstance(link, Tag) else ""
        rich_text_text = _clean_text(
            rich_text.get_text(" ", strip=True)
        ).casefold()
        newsletter_signup = bool(
            isinstance(link, Tag)
            and "sign up" in link_text
            and "newsletter" in link_text
            and (
                "email-setup" in link_href.casefold()
                or "newsletter" in link_href.casefold()
            )
        )
        article_list_newsletter = bool(
            isinstance(link, Tag)
            and rich_text.select_one("ul.articleList") is not None
            and rich_text_text.startswith("sign up for ")
            and "newsletter" in link_text
            and (
                "newsletter" in link_href.casefold()
                or "/newsletters/" in link_href.casefold()
            )
        )
        heading_newsletter_signup = bool(
            isinstance(link, Tag)
            and heading_text.endswith("newsletter")
            and "sign up" in rich_text_text
            and "newsletter" in link_href.casefold()
        )
        coronavirus_link_rail = bool(
            heading_text == "understanding coronavirus"
            and rich_text.select_one("ul.articleList") is not None
            and len(rich_text.select("ul.articleList a[href*='/articles/']"))
            >= 2
        )
        coronavirus_newsletter_signup = bool(
            heading_text == "stay informed"
            and rich_text.select_one("ul.articleList") is not None
            and "get a coronavirus briefing" in rich_text_text
            and "sign up here" in rich_text_text
            and isinstance(link, Tag)
            and "newsletter" in link_href.casefold()
        )
        if (
            (
                isinstance(heading, Tag)
                and (
                    heading_text
                    in {
                        "read more",
                        "related reading",
                        "share your thoughts",
                    }
                    or (
                        (
                            heading_text in {"more", "related"}
                            or heading_text.startswith("more ")
                        )
                        and rich_text.select_one("ul.articleList") is not None
                    )
                )
            )
            or newsletter_signup
            or article_list_newsletter
            or heading_newsletter_signup
            or coronavirus_link_rail
            or coronavirus_newsletter_signup
        ):
            rich_text.decompose()
    for card in list(soup.select(".media-object.type-InsetRichMedia")):
        link = card.select_one(".media-object-interactiveLink a[href]")
        if not isinstance(link, Tag):
            continue
        href = str(link.get("href") or "").strip()
        split = urlsplit(href)
        if (
            "/articles/" in split.path
            and (not split.netloc or split.netloc.casefold().endswith("wsj.com"))
        ):
            # Legacy templates embedded related-story cards as rich media
            # inside articleBody. Their thumbnail, teaser and heading are
            # recirculation rather than an image or paragraph of this story.
            card.decompose()
    # Pre-Oak WSJ pages placed related-story rails and section navigation in
    # generic ``module inset-box`` containers inside ``articleBody``.  The
    # same markup also carries real slideshows and graphics, so remove only
    # modules with narrow publisher-interface signatures observed in the
    # archived pages.
    for module in list(
        soup.select(
            ".module.inset-box, .module.rich-media-inset, .media-object"
        )
    ):
        if module.parent is None:
            continue
        module_text = _clean_text(
            module.get_text(" ", strip=True)
        ).casefold()
        heading_texts = {
            _clean_text(heading.get_text(" ", strip=True)).casefold()
            for heading in module.select("h2, h3, h4, h5, h6")
        }
        links = list(module.select("a[href]"))
        hrefs = [str(link.get("href") or "").casefold() for link in links]
        legacy_link_rail = (
            bool(links)
            and (
                (
                    "more" in heading_texts
                    and module.select_one("ul.articleList") is not None
                )
                or bool(
                    heading_texts
                    & {"earlier", "journal community", "journal report"}
                )
                or any(
                    heading_text.startswith("more in ")
                    for heading_text in heading_texts
                )
            )
        )
        fins_workplace_rail = (
            module_text.startswith("fins: women in the workplace")
            and any("fins.com/" in href for href in hrefs)
        )
        saturday_rail = (
            module_text.startswith("also in saturday's wsj")
            and len(links) >= 2
        )
        olympics_rail = (
            any("/public/page/olympics-london.html" in href for href in hrefs)
            and len(links) >= 4
        )
        concierge_rail = (
            module_text.startswith("more journal concierge city guides")
            and len(links) >= 5
        )
        if any(
            (
                legacy_link_rail,
                fins_workplace_rail,
                saturday_rail,
                olympics_rail,
                concierge_rail,
            )
        ):
            module.decompose()
    # A real slideshow inset can append this generic gallery-directory CTA.
    # Drop only its list so the story-specific image and caption survive.
    for article_list in list(soup.select("ul.articleList")):
        text = _clean_text(article_list.get_text(" ", strip=True)).casefold()
        if text != "more photos and interactive graphics":
            continue
        link = article_list.select_one("a[href]")
        href = str(link.get("href") or "").casefold() if link else ""
        if "/public/page/0_0_wp_2003.html" in href:
            article_list.decompose()
    for paragraph in list(soup.select("p")):
        if (
            _clean_text(paragraph.get_text(" ", strip=True))
            .casefold()
            .startswith(
                "to explore and search through all our recipes, "
                "check out the new wsj recipes page"
            )
        ):
            paragraph.decompose()

    # Older WSJ captures flatten newsletter and recirculation cards into
    # ordinary paragraphs/headings inside the article wrapper.  Their
    # classes vary by template, so selector-only cleanup misses them.  Keep
    # this list deliberately narrow and operate only on standalone text
    # blocks; normal reporting sentences that merely mention a newsletter or
    # a related topic must remain in the body.
    wsj_interface_patterns = (
        re.compile(r"^related(?: stories)?$", re.IGNORECASE),
        re.compile(r"^read more:?$", re.IGNORECASE),
        re.compile(
            r"^subscribe to (?:our morning newsletter|the best of the web "
            r"(?:today )?email)\b.*$",
            re.IGNORECASE,
        ),
        re.compile(
            r"^write to .+? at [\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\.?$",
            re.IGNORECASE,
        ),
        re.compile(r"^related(?: coverage| video)$", re.IGNORECASE),
        re.compile(r"^in other news$", re.IGNORECASE),
        re.compile(r"^number of the day$", re.IGNORECASE),
        re.compile(r"^quotable$", re.IGNORECASE),
        re.compile(r"^best of the rest$", re.IGNORECASE),
        re.compile(
            r"^here(?:'|’)s your morning roundup of the biggest marketing, "
            r"advertising and media industry news and happenings\.?$",
            re.IGNORECASE,
        ),
        re.compile(
            r"^sign up:\s*with one click, get this newsletter delivered "
            r"to your inbox\.?$",
            re.IGNORECASE,
        ),
        re.compile(r"^click to read story$", re.IGNORECASE),
        re.compile(
            r"^sign up for the wsj book club here\s*\.?$",
            re.IGNORECASE,
        ),
        re.compile(r"^corrections?\s*&\s*amplifications$", re.IGNORECASE),
        re.compile(
            r"^today[’']s top supply chain and logistics news from wsj$",
            re.IGNORECASE,
        ),
        re.compile(
            r"^cmo insights and analysis from deloitte$",
            re.IGNORECASE,
        ),
        re.compile(r"^content from our sponsor$", re.IGNORECASE),
        re.compile(
            r"^follow us on twitter:\s*@.+$",
            re.IGNORECASE,
        ),
        re.compile(
            r"^please note:\s*the wall street journal news department "
            r"was not involved in the creation of the content above\.?$",
            re.IGNORECASE,
        ),
    )
    for node in list(soup.select("p, h2, h3, h4, h5, h6")):
        if node.parent is None:
            continue
        text = _clean_text(node.get_text(" ", strip=True))
        if any(pattern.fullmatch(text) for pattern in wsj_interface_patterns):
            node.decompose()

    for inset in list(
        soup.select(".media-object.type-InsetMediaIllustration")
    ):
        image = inset.select_one("img[src], img[data-enlarge]")
        image_url = (
            str(image.get("data-enlarge") or image.get("src") or "")
            if isinstance(image, Tag)
            else ""
        )
        caption = inset.select_one(".wsj-article-caption-content")
        caption_text = _clean_text(
            caption.get_text(" ", strip=True)
            if isinstance(caption, Tag)
            else ""
        ).casefold()
        if caption_text == "wsj" and re.search(
            r"(?i)://images\.wsj\.net/im-273836(?:[/?]|$)",
            image_url,
        ):
            # This fixed house illustration appears in unrelated articles as
            # an AMP-era presentation inset.  It is not editorial media from
            # either story and must not become a reusable body image.
            inset.decompose()
    for node in list(
        soup.select(
            ".coupon-list, [class*='SavingsUnited' i], "
            ".chiclet-wrapper, "
            "[class*='SnippetSignIn' i], .author-links, .author-info, "
            ".bylineWrap, "
            ".webui-newsletter-inset, #webui_newsletter_inset, "
            ".newsletter-inset, .wsj-ad, "
            "[class*='mobile-modal-author' i], .byline-wrap, "
            ".article__byline, .module.automated-news, "
            ".module.editors-picks, .share-bottom, .printSummary, "
            ".article-news-front, [class*='AuthoringContainer'], "
            ".media-object.type-InsetNewsletterSignup, "
            ".article__inset--type-InsetNewsletterSignup, "
            "[data-block='doNotPrint'], "
            "[data-module-zone='opinion_editors_picks'], "
            "[data-module-zone='contentCarousel'], "
            ".content-carousel, .olympics-carousel, "
            ".series-nav__inset-container, "
            "[class*='-JRStrap'], [class*='-JRNextArticle'], "
            "[class*='-JRMoreArticles'], "
            ".opinion-editors-picks"
        )
    ):
        node.decompose()
    for node in list(soup.select(".media-object.inline")):
        heading = node.select_one("h2, h3, h4, h5, h6")
        if (
            isinstance(heading, Tag)
            and _clean_text(heading.get_text(" ", strip=True))
            .casefold()
            .startswith("more ")
            and node.select_one("ul.articleList") is not None
        ):
            node.decompose()
    for heading in list(soup.select("h2.subhead")):
        if (
            _clean_text(heading.get_text(" ", strip=True)).casefold()
            != "opinion editor's picks"
        ):
            continue
        sibling = heading.find_next_sibling()
        if isinstance(sibling, Tag) and sibling.name in {"ul", "ol"}:
            sibling.decompose()
        heading.decompose()
    for control in list(soup.select("a[role='button']")):
        if _clean_text(control.get_text(" ", strip=True)).casefold() != "see all":
            continue
        collection = next(
            (
                parent
                for parent in control.parents
                if isinstance(parent, Tag)
                and len(parent.select("article")) >= 2
            ),
            None,
        )
        if isinstance(collection, Tag):
            collection.decompose()
        else:
            control.decompose()
    for wrapper in list(
        soup.select(
            ".theme-nav-wrapper, "
            "[class*='theme-navigation-'][class*='-container']"
        )
    ):
        inset = wrapper.find_parent(
            class_=lambda value: value
            and "article__inset" in " ".join(
                value if isinstance(value, list) else [value]
            )
        )
        (inset if isinstance(inset, Tag) else wrapper).decompose()
    for node in list(soup.select(".media-object.type-InsetRichText")):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if (
            text.startswith("stay informed get a coronavirus briefing")
            and "sign up here" in text
        ):
            node.decompose()
    for prompt in list(soup.select("p, h2, h3, h4, h5, h6")):
        text = _clean_text(prompt.get_text(" ", strip=True)).casefold()
        if text in {"- wsj news exclusive", "wsj news exclusive"}:
            prompt.decompose()
            continue
        if text != "share your thoughts":
            continue
        followup = prompt.find_next_sibling()
        if isinstance(followup, Tag) and "join the conversation" in (
            _clean_text(followup.get_text(" ", strip=True)).casefold()
        ):
            followup.decompose()
        prompt.decompose()
    text_nodes = list(soup.select("p, h2, h3, h4, h5, h6"))
    for index, node in enumerate(text_nodes):
        if node.parent is None:
            continue
        if (
            _clean_text(node.get_text(" ", strip=True)).casefold()
            != "stay informed"
        ):
            continue
        promo_nodes = [node]
        nearby = "stay informed"
        for candidate in text_nodes[index + 1 : index + 3]:
            if candidate.parent is None:
                continue
            promo_nodes.append(candidate)
            nearby += " " + _clean_text(
                candidate.get_text(" ", strip=True)
            ).casefold()
            if (
                "get a coronavirus briefing" in nearby
                and "sign up here" in nearby
            ):
                for promo_node in promo_nodes:
                    promo_node.decompose()
                break
    for node in list(soup.select("p, h2, h3, h4, h5, h6")):
        if node.parent is None:
            continue
        text = _clean_text(node.get_text(" ", strip=True))
        folded = text.casefold()
        classes = " ".join(node.get("class") or []).casefold()
        if (
            text in {".", "\u200b", "\ufeff"}
            or (
                folded.startswith("copyright ©")
                and "dow jones & company" in folded
            )
            or folded.startswith("already a member? sign in")
            or folded in {"listen", "listen to article"}
            or re.fullmatch(r"\(\d+\s+min(?:ute)?s?\)", folded)
            or (
                folded == "videos"
                and "sectionlabel" in classes
            )
            or (
                folded.startswith(
                    "buy side from wsj expert recommendations "
                    "on products and services"
                )
                and node.select_one(
                    "a[href*='wsj.com/buyside']"
                )
            )
        ):
            node.decompose()
            continue
        if (
            "sign up for our" in folded
            and "newsletter" in folded
            and (
                folded.startswith(("—for more wsj", "-for more wsj"))
                or len(folded) <= 400
            )
        ):
            node.decompose()


def _wsj_is_editorial_letter(soup: BeautifulSoup) -> bool:
    """Identify intentionally short WSJ letters without relaxing news gates."""
    values = (
        _meta_content(soup, "name", "article.type"),
        _meta_content(soup, "name", "article.type.display"),
        _meta_content(soup, "name", "article.page"),
    )
    return any(
        value and _clean_text(value).casefold() == "letters"
        for value in values
    )


def _wsj_legacy_published_at(soup: BeautifulSoup) -> str | None:
    """Read publication dates serialized by WSJ's pre-Oak templates."""
    for script in soup.select("script"):
        value = script.string or script.get_text()
        match = re.search(
            r"""(?:publicationDate\s*:\s*|"""
            r"""setMetaData\(\s*["']apublished["']\s*,\s*)"""
            r"""["'](?P<date>\d{4}-\d{2}-\d{2}"""
            r"""(?:T\d{2}:\d{2}(?::\d{2})?)?)["']""",
            value,
        )
        if match:
            return match.group("date")
    return None


def _wsj_legacy_headline(soup: BeautifulSoup) -> str | None:
    """Read headlines serialized by WSJ's legacy video templates."""
    for script in soup.select("script"):
        value = script.string or script.get_text()
        match = re.search(
            r"""(?:articleHeadline|clickTitle)\s*:\s*"""
            r"""(?P<quote>["'])(?P<headline>.+?)(?P=quote)"""
            r"""(?=\s*[,}])""",
            value,
        )
        if match:
            headline = _clean_text(match.group("headline"))
            headline = re.sub(r"(?i)^wsj\.com\s*-\s*", "", headline)
            if headline:
                return headline
    title = _tag_text(soup.select_one("head > title"))
    if title:
        title = re.sub(r"(?i)\s*-\s*wsj\.com\s*$", "", title).strip()
        if title and title.casefold() not in {
            "the wall street journal",
            "wsj",
            "wsj.com",
        }:
            return title
    return None


from jojo_news_archive.parsing.parser_contracts import BaseSourceParser, ParseContext


class WsjParser(BaseSourceParser):
    def image_identity(self, url: str) -> str | None:
        return _wsj_source_image_identity(url)

    def is_placeholder_image_url(
        self,
        context: ParseContext,
        url: str,
    ) -> bool:
        decoded = unquote(url).casefold()
        return any(
            marker in decoded
            for marker in (
                "/img/meta/wsj-social-share.",
                "/img/wsj_logo_black_social.",
                "/img/wsj_profile_lg.",
                "/common/imgs/wsjsection.",
            )
        )

    def select_body(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.body import (
            select_body as _select_body,
            select_default_body as _select_default_body,
        )
        from jojo_news_archive.parsing.structured import (
            structured_image_gallery as _structured_image_gallery,
        )
        from jojo_news_archive.parsing.primitives import (
            clean_text as _clean_text,
        )

        soup = context.soup
        body = _wsj_tovima_body(soup)
        legacy_video = _wsj_legacy_video_body(
            soup,
            canonical_url=context.canonical_url,
        )
        if legacy_video is not None:
            body = legacy_video
        puzzle = _wsj_puzzle_body(soup, canonical_url=context.canonical_url)
        if puzzle is not None:
            body = puzzle
        body = _select_default_body(context, initial_body=body)
        if (
            body is None
            or _wsj_selected_body_is_comment(body)
            or (
                soup.select_one("#wsj-article-wrap") is None
                and re.search(
                    rb"(?i)id\s*=\s*[\"']wsj-article-wrap[\"']",
                    context.html_bytes,
                )
                is not None
            )
        ):
            try:
                fallback_soup = BeautifulSoup(context.html_bytes, "lxml")
            except Exception:
                fallback_soup = None
            if fallback_soup is not None:
                fallback_body = _select_body(fallback_soup, context.spec)
                if (
                    fallback_body is not None
                    and not _wsj_selected_body_is_comment(fallback_body)
                ):
                    context.soup = fallback_soup
                    soup = fallback_soup
                    body = fallback_body
        gallery = _structured_image_gallery(soup)
        if gallery is None:
            gallery = _wsj_amp_story_gallery(soup)
        if gallery is None:
            gallery = _wsj_webui_slideshow(soup)
        if gallery is None:
            gallery = _wsj_legacy_slideshow(soup)
        if gallery is None:
            gallery = _wsj_unsupported_media_gallery(soup)
        if gallery is not None:
            inline = _wsj_inline_slideshow_article_body(
                body,
                gallery_body=gallery,
            )
            if inline is not None:
                body = inline
            else:
                body = gallery
                context.structured_image_gallery_selected = True
        context.body = body

    def clean_body_before_noise(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            clean_text as _clean_text,
        )

        if context.clean_body is not None:
            context.source_data["selected_sign_in"] = any(
                _clean_text(node.get_text(" ", strip=True))
                .casefold()
                .startswith("already a member? sign in")
                for node in context.clean_body.select("p")
            )
            _trim_wsj_roadblock_tail(context.clean_body)

    def clean_body_after_noise(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            clean_text as _clean_text,
        )

        if context.clean_body is None:
            return
        _remove_wsj_promos(context.clean_body)
        inset = _wsj_inset_table_body(context.soup)
        if inset is None:
            return
        existing_text = _clean_text(
            context.clean_body.get_text(" ", strip=True)
        ).casefold()
        for child in list(inset.children):
            if (
                isinstance(child, Tag)
                and child.name in {"h2", "h3"}
                and _clean_text(child.get_text(" ", strip=True)).casefold()
                in existing_text
            ):
                continue
            context.clean_body.append(child)

    def is_noise_node(
        self,
        context: ParseContext,
        node: Tag,
        text: str,
    ) -> bool:
        return len(text) >= 2 and set(text) == {"_"}

    def extract_metadata(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            parse_datetime as _parse_datetime,
        )

        structured_headline = _string_or_none(
            context.news_article.get("headline")
        )
        if not structured_headline:
            context.headline = _first_text(
                _wsj_legacy_headline(context.soup),
                context.headline,
            )
        if context.published_at is None:
            context.published_at = _parse_datetime(
                _wsj_legacy_published_at(context.soup)
            )

    def classify_content(self, context: ParseContext) -> None:
        if _wsj_interactive_puzzle(
            context.soup,
            context.news_article,
            context.canonical_url,
        ):
            context.content_type = ContentType.INTERACTIVE
        if _wsj_is_legacy_video(context.soup):
            context.content_type = ContentType.VIDEO
        page_content_type = _clean_text(
            _meta_content(
                context.soup,
                "name",
                "page.content.type",
            )
            or ""
        ).casefold()
        if (
            context.content_type == ContentType.INTERACTIVE
            and page_content_type == "article"
            and re.search(
                r"(?i)/articles/interactive-brokers(?:-|$)",
                urlsplit(context.canonical_url).path,
            )
        ):
            context.content_type = ContentType.ARTICLE
        if page_content_type in {
            "gallery",
            "photo gallery",
            "photo-gallery",
            "slideshow",
        } or context.soup.select_one(".slideshow-article"):
            context.content_type = ContentType.GALLERY

    def postprocess_blocks(self, context: ParseContext) -> None:
        if not context.blocks:
            return
        trailing_text = _clean_text(context.blocks[-1].text or "")
        standalone_truncation_marker = bool(
            context.blocks[-1].type == BlockType.PARAGRAPH
            and len(trailing_text) <= 80
            and (
                trailing_text == "…"
                or re.search(r"\.{3,}$", trailing_text)
            )
        )
        context.source_data["standalone_truncation_marker"] = (
            standalone_truncation_marker
        )
        if standalone_truncation_marker:
            context.blocks.pop()

    def postprocess_output(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            looks_like_gallery as _looks_like_gallery,
        )

        if context.content_type == ContentType.ARTICLE and (
            context.structured_image_gallery_selected
            or _looks_like_gallery(context.blocks)
        ):
            context.content_type = ContentType.GALLERY

    def minimum_body_characters(self, context: ParseContext) -> int:
        from jojo_news_archive.parsing.limits import (
            MINIMUM_BODY_CHARACTERS as _MINIMUM_BODY_CHARACTERS,
        )

        if _wsj_is_editorial_letter(context.soup):
            return _MINIMUM_BODY_CHARACTERS
        if context.content_type == ContentType.ARTICLE:
            return 500
        return _MINIMUM_BODY_CHARACTERS

    def accepts_short_body(self, context: ParseContext) -> bool:
        if (
            context.content_type == ContentType.GALLERY
            and (
                any(block.type == BlockType.IMAGE for block in context.blocks)
                or any(image.should_archive for image in context.images)
            )
        ):
            return True
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
        section = _string_or_none(
            context.news_article.get("articleSection")
        )
        display_type = _meta_content(
            context.soup,
            "name",
            "article.type.display",
        )
        return bool(
            len(context.plain_text) >= 100
            and (
                (section and "wire" in section.casefold())
                or (
                    display_type
                    and "dow jones newswires" in display_type.casefold()
                )
            )
        )

    def quality_warnings(self, context: ParseContext) -> list[str]:
        warnings: list[str] = []
        plain_text = context.plain_text
        if (
            context.content_type == ContentType.ARTICLE
            and (
                context.source_data.get("standalone_truncation_marker")
                or _wsj_legacy_ellipsis_truncation(plain_text)
                or _wsj_missing_best_seller_chart(
                    headline=context.headline,
                    plain_text=plain_text,
                )
            )
        ):
            warnings.append("truncated-body")
        if _wsj_subscription_truncation(
            context.soup,
            content_type=context.content_type,
            plain_text=plain_text,
            selected_sign_in=bool(
                context.source_data.get("selected_sign_in")
            ),
        ):
            warnings.append("truncated-body")
        if (
            context.content_type == ContentType.GALLERY
            and context.soup.select_one(".slideshow-article")
            and sum(image.should_archive for image in context.images) < 3
        ):
            warnings.append("incomplete-gallery")
        return list(dict.fromkeys(warnings))

    def short_body_warning(self, context: ParseContext) -> str | None:
        if context.content_type != ContentType.ARTICLE:
            return None
        section = _string_or_none(context.news_article.get("articleSection"))
        display_type = _meta_content(
            context.soup,
            "name",
            "article.type.display",
        )
        return (
            "structured-short-record"
            if len(context.plain_text) >= 100
            and (
                (section and "wire" in section.casefold())
                or (
                    display_type
                    and "dow jones newswires" in display_type.casefold()
                )
            )
            else None
        )


PARSER: WsjParser = WsjParser()
