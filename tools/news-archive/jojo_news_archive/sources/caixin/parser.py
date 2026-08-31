from __future__ import annotations

import re
from urllib.parse import unquote, urlsplit
from bs4 import BeautifulSoup, Comment, NavigableString, Tag
from jojo_news_archive.models import ImageCandidate
from jojo_news_archive.parsing.primitives import (
    clean_text as _clean_text,
    image_urls as _image_urls,
    normalized_url as _normalized_url,
    tag_text as _tag_text,
)


def _remove_caixin_body_chrome(soup: BeautifulSoup) -> None:
    """Remove legacy Caixin print controls and subscription QR images."""

    legacy_body = soup.select_one("#Main_Content_Val")
    if isinstance(legacy_body, Tag):
        # Caixin's legacy CMS often emitted the lead or even the entire short
        # report as a direct text node beside a bold byline. The common block
        # extractor deliberately ignores loose text, so preserve these nodes
        # in document order as ordinary paragraphs before block extraction.
        for child in list(legacy_body.children):
            if not isinstance(child, NavigableString) or isinstance(
                child, Comment
            ):
                continue
            text = _clean_text(str(child))
            if len(text) < 2:
                continue
            paragraph = soup.new_tag("p")
            paragraph.string = text
            child.replace_with(paragraph)
    for node in list(soup.select(".fullUrl, #jumpurl, .yinduBottom")):
        node.decompose()
    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True)).casefold()
        if re.fullmatch(r"[（(]\s*财新记者[^()（）]{1,120}[)）]", text):
            # Older Caixin pages repeat the reporter credit as a standalone
            # paragraph inside the article body. The canonical byline is
            # already extracted from page metadata, so this is template
            # chrome rather than reporting prose.
            paragraph.decompose()
            continue
        if (
            text.startswith("欢迎关注财新网")
            and ("公号" in text or "公众号" in text)
        ) or (
            text.startswith("《知识分子》是由")
            and "移动新媒体平台" in text
        ) or (
            text.startswith("撰写：财小智")
            and "责编：财小新" in text
        ) or (
            text.startswith("今日敏感舆情指数")
            and "财新数据" in text
        ):
            # These recurring paragraphs are account promotion or generated
            # data-service notices embedded by Caixin's section templates.
            paragraph.decompose()
            continue
        if (
            text.startswith("推荐进入")
            and "财新数据库" in text
            and "可随时查阅" in text
        ) or (
            text.startswith("本文内容精选自财新高端订阅产品")
            and "财新数据通" in text
        ) or text.startswith(">>更多精彩内容请点击"):
            # Current and legacy Caixin pages append subscription marketing
            # inside the article wrapper. It is site chrome, not reporting.
            container = paragraph.find_parent(
                ("div", "aside"), class_=lambda value: value and "lanmu_textend" in value
            )
            if isinstance(container, Tag):
                container.decompose()
            else:
                paragraph.decompose()
            continue
        if (
            text.startswith("更多报道详见：")
            and paragraph.select_one(
                "a[href*='caixin.com/'][href*='/2013lh/']"
            )
        ):
            # Legacy 2013 reports appended a cross-site Two Sessions topic
            # link inside the broad article node. It is recirculation, not a
            # sentence from the report.
            paragraph.decompose()
            continue
        if text.startswith("marketwatch拥有位于三大洲的100多名记者"):
            # Caixin appended the same corporate description to syndicated
            # MarketWatch stories. Preserve the preceding original-URL
            # attribution, but do not treat this publisher boilerplate as
            # article prose.
            paragraph.decompose()
    for image in list(soup.select("img")):
        urls = _image_urls(
            image,
            base_url="https://www.caixin.com/",
        )
        if not urls or not all(
            _caixin_non_editorial_image_url(url) for url in urls
        ):
            continue
        container = image.find_parent("figure")
        image.decompose()
        if (
            isinstance(container, Tag)
            and not _clean_text(container.get_text(" ", strip=True))
        ):
            container.decompose()


def _caixin_legacy_gallery_body(soup: BeautifulSoup) -> Tag | None:
    """Convert Caixin's table-based photo channel into semantic figures."""

    source = soup.select_one("#pic_content")
    if not isinstance(source, Tag):
        return None
    document = BeautifulSoup(
        "<article data-jojo-source='caixin-legacy-gallery'></article>",
        "html.parser",
    )
    wrapper = document.select_one("article")
    if not isinstance(wrapper, Tag):
        return None
    for item in source.find_all("li", recursive=False):
        if not isinstance(item, Tag):
            continue
        image = next(
            (
                node
                for node in item.select(".imgBox img[src], img[src]")
                if isinstance(node, Tag)
                and not _caixin_non_editorial_image_url(
                    _normalized_url(
                        node.get("src"),
                        base_url="https://photos.caixin.com/",
                    )
                    or ""
                )
            ),
            None,
        )
        if not isinstance(image, Tag):
            continue
        figure = document.new_tag("figure")
        copied_image = document.new_tag("img")
        copied_image.attrs = dict(image.attrs)
        figure.append(copied_image)
        image_row = image.find_parent("tr")
        caption_row = (
            image_row.find_next_sibling("tr")
            if isinstance(image_row, Tag)
            else None
        )
        caption = (
            _clean_text(caption_row.get_text(" ", strip=True))
            if isinstance(caption_row, Tag)
            else ""
        )
        if not caption:
            caption = _clean_text(
                _tag_text(item.select_one("#subhead, .title")) or ""
            )
        if caption:
            figcaption = document.new_tag("figcaption")
            figcaption.string = caption
            figure.append(figcaption)
        wrapper.append(figure)
    return wrapper if wrapper.select_one("figure img") else None


def _caixin_legacy_gallery_expected_images(soup: BeautifulSoup) -> int:
    # The counter is a loose text node beside the controls in some snapshots,
    # not a descendant of `.op`; inspect the complete editorial wrapper.
    counter = _clean_text(_tag_text(soup.select_one(".focusBody")) or "")
    matches = re.findall(r"(?<!\d)\d+\s*/\s*(\d+)(?!\d)", counter)
    return max((int(value) for value in matches), default=1)


def _caixin_non_editorial_image_url(url: str) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    path = unquote(parts.path).casefold()
    return (
        host == "file.caing.com"
        and path.endswith("/images/channel/content/images/fullurl.gif")
    ) or (
        host == "file.caixin.com"
        and (
            path.endswith("/file/vip/images/code.jpg")
            or path.endswith("/images/common/images/shareimg.jpg")
        )
    ) or (
        host == "file.caixin.com"
        and re.search(
            r"/images/common/images/logo[^/]*\.(?:gif|jpe?g|png|webp)$",
            path,
        )
        is not None
    ) or (
        host == "entities.caixin.com"
        and path.endswith("/support.png")
    )


def _caixin_legacy_published_at(soup: BeautifulSoup) -> str | None:
    value = _clean_text(
        _tag_text(soup.select_one(".focusBody .infobox"))
        or _tag_text(soup.select_one(".focusBody .op"))
        or _tag_text(soup.select_one(".datetime"))
        or ""
    )
    match = re.search(
        r"(?:发表时间\s*[：:]\s*)?(?P<year>20\d{2})年"
        r"(?P<month>\d{1,2})月(?P<day>\d{1,2})日"
        r"(?:\s*(?P<hour>\d{1,2}):(?P<minute>\d{2}))?",
        value,
    )
    if match is None:
        return None
    return (
        f"{int(match.group('year')):04d}-"
        f"{int(match.group('month')):02d}-"
        f"{int(match.group('day')):02d}T"
        f"{int(match.group('hour') or 0):02d}:"
        f"{int(match.group('minute') or 0):02d}:00+08:00"
    )


def _caixin_legacy_headline(soup: BeautifulSoup) -> str | None:
    """Skip the empty site-logo ``h1`` in Caixin's legacy template."""

    # Older Caixin pages put an empty ``h1.logo`` before the real headline
    # under ``.the_content``.  ``select_one('h1')`` therefore returns the
    # logo and leaves an otherwise usable article without a headline.
    for node in soup.select(".the_content h1, #Main_Content_Val h1, h1"):
        if "logo" in (node.get("class") or []):
            continue
        value = _tag_text(node)
        if value:
            return value
    return None


from jojo_news_archive.parsing.parser_contracts import BaseSourceParser, ParseContext


class CaixinParser(BaseSourceParser):
    def select_body(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.body import (
            select_default_body as _select_default_body,
        )

        body = _select_default_body(context)
        gallery = _caixin_legacy_gallery_body(context.soup)
        if gallery is not None:
            body = gallery
            context.structured_image_gallery_selected = True
            context.source_data["legacy_gallery_selected"] = True
        else:
            legacy = context.soup.select_one("#Main_Content_Val")
            if isinstance(legacy, Tag):
                body = legacy
        context.body = body

    def clean_body_before_noise(self, context: ParseContext) -> None:
        if context.clean_body is not None:
            _remove_caixin_body_chrome(context.clean_body)

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
            _caixin_legacy_headline(context.soup),
            context.headline,
        )
        if context.published_at is None:
            context.published_at = _parse_datetime(
                _caixin_legacy_published_at(context.soup)
            )

    def accept_lead_image(self, context: ParseContext, url: str) -> bool:
        return not _caixin_non_editorial_image_url(url)

    def accept_body_image(
        self,
        context: ParseContext,
        image: ImageCandidate,
    ) -> bool:
        return not _caixin_non_editorial_image_url(image.original_url)

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
        body = context.soup.select_one("#Main_Content_Val")
        plain_text = context.plain_text
        headline = context.headline or ""
        return bool(
            isinstance(body, Tag)
            and 30 <= len(plain_text) < 100
            and (
                re.match(r"^(?:编辑更正|休刊启事)", headline)
                or (
                    "特此更正" in plain_text
                    and re.search(r"(?:编辑部|杂志社)\s*$", plain_text)
                )
            )
            and not re.search(r"(?:继续阅读|登录|注册|订阅)\s*$", plain_text)
        )

    def quality_warnings(self, context: ParseContext) -> list[str]:
        if not context.source_data.get("legacy_gallery_selected"):
            return []
        expected = _caixin_legacy_gallery_expected_images(context.soup)
        actual = sum(image.should_archive for image in context.images)
        return ["incomplete-gallery"] if expected > actual else []


PARSER: CaixinParser = CaixinParser()
