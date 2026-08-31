from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, unquote, urlsplit, urlunsplit
from bs4 import BeautifulSoup, NavigableString, Tag
from jojo_news_archive.models import ContentType, ImageCandidate
from jojo_news_archive.parsing.primitives import (
    clean_text as _clean_text,
    image_urls as _image_urls,
    string_or_none as _string_or_none,
    terminal_tandem_repeat_length as _terminal_tandem_repeat_length,
)
from jojo_news_archive.parsing.limits import (
    MINIMUM_BODY_CHARACTERS as _MINIMUM_BODY_CHARACTERS,
)


def _zaobao_image_identity(url: str) -> str | None:
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    if not (
        host == "zaobao.com.sg"
        or host.endswith(".zaobao.com.sg")
        or host.endswith(".zaobao.com")
    ):
        return None
    if "/sites/default/files/styles/" not in parts.path.casefold():
        return None
    zaobao_path = re.sub(
        r"^/sites/default/files/styles/[^/]+/public/",
        "/sites/default/files/",
        unquote(parts.path),
        flags=re.IGNORECASE,
    )
    return f"zaobao-image:{zaobao_path.casefold()}"


def _remove_zaobao_body_chrome(soup: BeautifulSoup) -> None:
    """Remove site-wide controls embedded in legacy Zaobao article wrappers."""

    # Drupal-era comic and visual pages can leave the editorial picture only
    # in ``<source data-srcset>`` nodes, without an ``<img>`` fallback.  Block
    # extraction intentionally works from images, so materialize the first
    # publisher rendition before removing the surrounding page controls.  The
    # source list is ordered from the largest desktop rendition down to the
    # transparent placeholder in these archived templates.
    for picture in soup.select("picture"):
        if any(
            isinstance(value, str)
            and value.strip()
            and not value.strip().casefold().startswith("data:")
            for image in picture.select("img")
            for attribute in ("src", "data-src", "srcset", "data-srcset")
            if (value := image.get(attribute)) is not None
        ):
            continue
        source_url = next(
            (
                url
                for source in picture.select("source")
                for url in _image_urls(
                    source,
                    base_url="https://www.zaobao.com.sg/",
                )
                if not _zaobao_non_editorial_image_url(url)
            ),
            None,
        )
        if not source_url:
            continue
        # BeautifulSoup's body-copy round trip can read the ``&times`` prefix
        # in an unescaped Drupal ``&timestamp=`` srcset parameter as the
        # multiplication entity. Restore it long enough to parse the query,
        # then discard that non-semantic cache-busting timestamp.
        source_url = re.sub(
            r"×tamp=",
            "&timestamp=",
            source_url,
            flags=re.IGNORECASE,
        )
        source_parts = urlsplit(source_url)
        source_query = [
            (key, value)
            for key, value in parse_qsl(
                source_parts.query,
                keep_blank_values=True,
            )
            if key.casefold() != "timestamp"
        ]
        source_url = urlunsplit(
            source_parts._replace(
                query=urlencode(source_query)
            )
        )
        image = soup.new_tag("img", src=source_url)
        title = _string_or_none(picture.get("title"))
        if title:
            image["alt"] = title
        picture.append(image)

    # Archived Zaobao pages commonly place share/follow and newsletter
    # controls inside the same ``article`` node as the historical body.
    # They are not editorial blocks and otherwise fail the normalized-body
    # interactive-tag audit.
    for node in list(soup.select("button, form, input, select, textarea")):
        node.decompose()

    # Freemium snapshots put the subscription roadblock and its generic
    # fallback artwork inside the same article wrapper as the recovered
    # paragraphs. Keep the editorial prose, but never archive the paywall UI
    # or its repeated default images as article content.
    for node in list(
        soup.select(
            "#freemium_subscribe, .freemium_subscribe, "
            ".microtransaction-body, .microtransaction-option, "
            ".article-microtransaction, .cta-subscribe, "
            ".overlay-microtransaction, "
            ".paywall-message, "
            "#related-articles, #mobile-recommend-articles, "
            ".bff-recommend-article"
        )
    ):
        node.decompose()
    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True))
        direct_text = paragraph.string
        repeated_suffix_length = _terminal_tandem_repeat_length(text)
        if (
            repeated_suffix_length
            and isinstance(direct_text, NavigableString)
        ):
            # A small number of Drupal-era snapshots contain a damaged final
            # paragraph whose terminal clause was appended twice inside the
            # publisher's own HTML. Only repair an exact, long tandem suffix
            # in a text-only paragraph; preserving nested inline markup is
            # safer than attempting a lossy tree rewrite.
            direct_text.replace_with(text[:-repeated_suffix_length].rstrip())
            text = text[:-repeated_suffix_length].rstrip()
        if (
            text.startswith("此文章为早报")
            and "专享内容" in text
        ) or text in {
            "请您选择以下方式，阅读全文：",
            "已是早报订户，请您登录后继续阅读全文。",
        } or text.startswith("新用户体验价"):
            paragraph.decompose()
            continue
        if re.fullmatch(
            r"点击\s*《联合早报》世界杯专页\s*[，,]\s*"
            r"获知世界杯比分、赛程和最新新闻等资讯[。.]?",
            text,
        ):
            # This site-wide World Cup cross-promotion is injected as a plain
            # emphasized paragraph inside otherwise editorial article HTML.
            # Match the complete sentence only so genuine World Cup reporting
            # and links remain untouched.
            paragraph.decompose()
    for node in list(soup.select("p, h1, h2, h3, h4, h5, h6")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"请\s*like\s*我们的官方面簿网页以获取更多新信息\s*[。.]?",
            text,
            flags=re.IGNORECASE,
        ) or re.fullmatch(r"热词\s*[:：]", text):
            # The Drupal-era article wrapper flattened the site-wide
            # Facebook CTA and keyword-panel heading into ordinary editorial
            # blocks.  Neither is story text; keyword values remain available
            # from metadata rather than this empty UI label.
            node.decompose()
    for image in list(soup.select("img")):
        urls = _image_urls(image, base_url="https://www.zaobao.com.sg/")
        if not urls or not all(
            _zaobao_non_editorial_image_url(url) for url in urls
        ):
            continue
        container = image.find_parent(("figure", "a"))
        image.decompose()
        if (
            isinstance(container, Tag)
            and not container.get_text(" ", strip=True)
            and not container.select_one("img")
        ):
            container.decompose()


def _zaobao_non_editorial_image_url(url: str) -> bool:
    """Recognize Zaobao paywall/default artwork, not story media."""
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    path = unquote(parts.path).casefold()
    if host not in {"www.zaobao.com.sg", "static.zaobao.com"}:
        return False
    return bool(
        re.search(
            r"/themes/custom/zbsg2020/images/default-img\.png$|"
            r"/themes/custom/zbsg2020/images/social-share\.png$|"
            r"/dist/images/zbsg/default-image\.png$|"
            r"/sites/all/themes/zb2016/assets/imgs/(?:zbsg/)?default-image\.png$|"
            r"/sites/all/themes/zb2016/assets/imgs/icon_(?:newspost|newsmine)_(?:cn|en)_new\.png$|"
            r"/sites/all/themes/zb2013/img/zb_logo\.jpg$|"
            r"/assets/newspost-[a-z0-9_-]+\.svg$|"
            r"/r0lgodlhaqabaiaaaaaaap/[a-z0-9_-]+$|"
            r"/zbsg/zaobaosg-facebook-share\.png$|"
            r"/freemium_images/[^/]+/[^/]*default[-_](?:desktop|mobile)[^/]*\.(?:gif|jpe?g|png|webp)$|"
            r"/(?:11_mobile_updated_covid_19_0|desktop_covid_19_0)\.png$",
            path,
            flags=re.IGNORECASE,
        )
    )


def _zaobao_visual_short_record(
    article: dict[str, Any],
    *,
    body_characters: int,
    images: list[ImageCandidate],
) -> bool:
    """Recognize old Zaobao photo-news records with caption-only bodies."""
    if not article or not any(image.should_archive for image in images):
        return False
    access_mode = _string_or_none(article.get("accessMode"))
    if not access_mode or access_mode.casefold() != "visual":
        return False
    word_count = article.get("wordCount")
    if not isinstance(word_count, int) or word_count > 120:
        return False
    article_body = _string_or_none(article.get("articleBody"))
    if not article_body or not _clean_text(article_body):
        return False
    return body_characters < _MINIMUM_BODY_CHARACTERS


def _zaobao_structured_visual_body_is_more_complete(
    article: dict[str, Any],
    *,
    body: Tag,
    structured_body: Tag,
) -> bool:
    """Prefer complete JSON-LD text over a truncated legacy visual body."""
    if not article:
        return False
    access_mode = _string_or_none(article.get("accessMode"))
    if not access_mode or access_mode.casefold() != "visual":
        return False
    editorial_body = body.select_one(
        ".article-content-container, #FineDining"
    )
    if not isinstance(editorial_body, Tag):
        return False
    dom_text = _clean_text(editorial_body.get_text(" ", strip=True))
    structured_text = _clean_text(
        structured_body.get_text(" ", strip=True)
    )
    return (
        len(structured_text) >= _MINIMUM_BODY_CHARACTERS
        and len(structured_text) > len(dom_text)
    )


def _zaobao_embedded_published_at(soup: BeautifulSoup) -> str | None:
    """Read publication time from RSC data or legacy visible date markup."""
    for script in soup.select("script"):
        value = script.string or script.get_text()
        if "publication_date" not in value.casefold():
            continue
        # Next.js serializes the Drupal article payload inside a quoted RSC
        # frame, so field names and values commonly appear as \"...\".
        # Removing only escaped quote delimiters leaves other escape sequences
        # untouched and makes both flattened pairs and ordinary JSON match.
        normalized = value.replace(r'\"', '"')
        match = re.search(
            r'''["']publication_date["']\s*(?::|,)\s*["']'''
            r'''(?P<date>20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}'''
            r'''(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)["']''',
            normalized,
            flags=re.IGNORECASE,
        )
        if match is None:
            continue
        published_at = match.group("date")
        if not re.search(r"(?:Z|[+-]\d{2}:?\d{2})$", published_at):
            published_at += "+08:00"
        return published_at
    for node in soup.select("p.date, .date"):
        text = _clean_text(node.get_text(" ", strip=True))
        match = re.search(
            r"(?P<year>20\d{2})年(?P<month>\d{1,2})月(?P<day>\d{1,2})日",
            text,
        )
        if match is not None:
            return (
                f"{int(match.group('year')):04d}-"
                f"{int(match.group('month')):02d}-"
                f"{int(match.group('day')):02d}T00:00:00+08:00"
            )
    return None


from jojo_news_archive.parsing.parser_contracts import BaseSourceParser, ParseContext


class ZaobaoParser(BaseSourceParser):
    def select_body(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.body import (
            select_body as _select_body,
            select_default_body as _select_default_body,
        )
        from jojo_news_archive.parsing.structured import (
            structured_article_body as _structured_article_body,
        )

        body = _select_body(context.soup, context.spec)
        structured = _structured_article_body(context.news_article)
        force = bool(
            body is not None
            and structured is not None
            and _zaobao_structured_visual_body_is_more_complete(
                context.news_article,
                body=body,
                structured_body=structured,
            )
        )
        context.body = _select_default_body(
            context,
            initial_body=body,
            force_structured=force,
        )

    def clean_body_before_noise(self, context: ParseContext) -> None:
        if context.clean_body is not None:
            _remove_zaobao_body_chrome(context.clean_body)

    def extract_metadata(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            parse_datetime as _parse_datetime,
        )

        if context.published_at is None:
            context.published_at = _parse_datetime(
                _zaobao_embedded_published_at(context.soup)
            )

    def classify_content(self, context: ParseContext) -> None:
        if "/shorts/" in context.canonical_url.casefold():
            context.content_type = ContentType.VIDEO

    def accept_lead_image(self, context: ParseContext, url: str) -> bool:
        return not _zaobao_non_editorial_image_url(url)

    def image_identity(self, url: str) -> str | None:
        return _zaobao_image_identity(url)

    def accept_body_image(
        self,
        context: ParseContext,
        image: ImageCandidate,
    ) -> bool:
        return not _zaobao_non_editorial_image_url(image.original_url)

    def postprocess_output(self, context: ParseContext) -> None:
        from jojo_news_archive.models import BlockType

        if context.content_type != ContentType.ARTICLE:
            return
        comic = (
            "/forum/comic/" in context.canonical_url.casefold()
            and (
                any(block.type == BlockType.IMAGE for block in context.blocks)
                or context.images
            )
        )
        visual_short = _zaobao_visual_short_record(
            context.news_article,
            body_characters=len(context.plain_text),
            images=context.images,
        )
        if comic or visual_short:
            context.content_type = ContentType.GALLERY

    def minimum_body_characters(self, context: ParseContext) -> int:
        return 20 if context.content_type == ContentType.ARTICLE else 100

    def accepts_short_body(self, context: ParseContext) -> bool:
        return bool(
            super().accepts_short_body(context)
            or (
                context.content_type == ContentType.GALLERY
                and context.images
                and (
                    "/forum/comic/" in context.canonical_url.casefold()
                    or _zaobao_visual_short_record(
                        context.news_article,
                        body_characters=len(context.plain_text),
                        images=context.images,
                    )
                )
            )
        )


PARSER: ZaobaoParser = ZaobaoParser()
