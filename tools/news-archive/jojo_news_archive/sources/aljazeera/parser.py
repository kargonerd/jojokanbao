from __future__ import annotations

from urllib.parse import unquote, urlsplit, urlunsplit
from bs4 import BeautifulSoup, Tag
from jojo_news_archive.models import (
    BlockType,
    ContentBlock,
    ContentType,
    ImageCandidate,
)
from jojo_news_archive.parsing.primitives import (
    clean_text as _clean_text,
    image_urls as _image_urls,
    normalized_url as _normalized_url,
)


def _aljazeera_image_identity(url: str) -> str | None:
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    if (
        host in {"aljazeera.com", "www.aljazeera.com"}
        and unquote(parts.path).casefold().startswith("/wp-content/uploads/")
    ):
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


def _aljazeera_body_content_type(
    *,
    default: ContentType,
    headline: str | None,
    plain_text: str,
    blocks: list[ContentBlock],
    visual_tags: str | None = None,
) -> ContentType:
    """Classify short Al Jazeera media reports after blocks are available.

    Migrated legacy video reports retain an iframe and only a short written
    synopsis, while migrated timeline packages may retain only an intro.  The
    generic JSON-LD on both page shapes still says ``NewsArticle``.
    """

    if default != ContentType.ARTICLE:
        return default
    normalized_visual_tags = (visual_tags or "").casefold()
    if any(
        marker in normalized_visual_tags
        for marker in ("infographic", "interactive")
    ):
        if any(block.type == BlockType.EMBED for block in blocks):
            return ContentType.INTERACTIVE
        if any(block.type == BlockType.IMAGE for block in blocks):
            return ContentType.GALLERY
    normalized_headline = _clean_text(headline or "").casefold()
    if normalized_headline.startswith("timeline:") and len(plain_text) < 500:
        return ContentType.INTERACTIVE
    if len(plain_text) >= 1_000:
        return default
    video_embed_markers = (
        "youtube.com/",
        "youtu.be/",
        "vimeo.com/",
        "dailymotion.com/",
        "brightcove.net/",
        "jwplatform.com/",
    )
    if any(
        block.type == BlockType.EMBED
        and block.embed_url
        and any(
            marker in block.embed_url.casefold()
            for marker in video_embed_markers
        )
        for block in blocks
    ):
        return ContentType.VIDEO
    return default


def _aljazeera_visual_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Recover migrated Al Jazeera visual payloads from the story body."""

    body = soup.select_one(".wysiwyg")
    if not isinstance(body, Tag):
        return None
    source_iframe = body.select_one("iframe[src]")
    if not isinstance(source_iframe, Tag):
        return None
    source = _normalized_url(source_iframe.get("src"), base_url=canonical_url)
    hostname = (urlsplit(source or "").hostname or "").casefold()
    if not source or hostname != "interactive.aljazeera.com":
        return None
    fragment = BeautifulSoup(
        "<article data-jojo-source='aljazeera-interactive'></article>",
        "html.parser",
    )
    article = fragment.select_one("article")
    if not isinstance(article, Tag):
        return None
    iframe = fragment.new_tag("iframe", src=source)
    iframe["title"] = "Al Jazeera interactive"
    iframe["data-interactive-provider"] = "aljazeera"
    article.append(iframe)
    return article


def _aljazeera_gallery_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Select migrated Al Jazeera gallery figures over an empty text shell."""

    if "/gallery/" not in canonical_url.casefold():
        return None
    candidate = soup.select_one(".gallery-images")
    if not isinstance(candidate, Tag):
        return None
    if len(candidate.select("figure img[src]")) < 2:
        return None
    return candidate


def _remove_aljazeera_body_chrome(soup: BeautifulSoup) -> None:
    """Remove legacy Al Jazeera recirculation modules from story bodies."""

    # Migrated 2010-era pages preserve sidebar/recirculation tables inside
    # ``wysiwyg--all-content``.  Their header cell is a stable discriminator;
    # removing arbitrary tables would also destroy genuine editorial data.
    for header in list(soup.select("td.Skyscrapper_Header")):
        if _clean_text(header.get_text(" ", strip=True)).casefold() not in {
            "special report",
            "in depth",
        }:
            continue
        table = header.find_parent("table")
        if isinstance(table, Tag):
            table.decompose()

    # Several migrated 2015 pages embed the same "New to Al Jazeera?" promo
    # cards as ordinary body images.  Keep surrounding editorial prose and
    # legitimate infographics while dropping only the confirmed shared assets.
    for image in list(soup.select("img")):
        urls = _image_urls(
            image,
            base_url="https://www.aljazeera.com/",
        )
        if not urls or not all(
            _aljazeera_non_editorial_image_url(url) for url in urls
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

    # Legacy story exports insert one or more related-story lists in the
    # middle of the article.  The tracking campaign is a narrow discriminator
    # for this publisher module; an ordinary editorial heading named "More"
    # without those links remains untouched.
    for heading in list(soup.select("p, h2, h3, h4, h5, h6")):
        if _clean_text(heading.get_text(" ", strip=True)).casefold() not in {
            "more",
            "more:",
        }:
            continue
        related_lists: list[Tag] = []
        sibling = heading.find_next_sibling()
        while isinstance(sibling, Tag) and sibling.name in {"ul", "ol"}:
            if not sibling.select_one(
                "a[href*='utm_campaign=read_more_links']"
            ):
                break
            related_lists.append(sibling)
            sibling = sibling.find_next_sibling()
        if not related_lists:
            continue
        heading.decompose()
        for listing in related_lists:
            listing.decompose()


_ALJAZEERA_NON_EDITORIAL_IMAGE_FILENAMES = frozenset(
    {
        "445ed4f604cc49698f3836f370e3bd83_6.jpeg",
        "face24c59e154577ab3a9ac3fae037c5_6.jpeg",
        "689d319d19954da39884b1ed32bc111b_6.jpeg",
        "9092c8160ac341cf8595d7551b94cd0a_6.jpeg",
        "5dcea9e1193048efa4a46fdc4754adee_18.jpeg",
        "5b28784782164b5ea20f5c0071206fd7_6.jpeg",
    }
)


def _aljazeera_non_editorial_image_url(url: str) -> bool:
    """Recognize confirmed shared Al Jazeera branding and promo artwork."""
    parts = urlsplit(url)
    if (parts.hostname or "").casefold() not in {
        "aljazeera.com",
        "www.aljazeera.com",
    }:
        return False
    path = unquote(parts.path).casefold().rstrip("/")
    return (
        path == "/images/logo_aje_social.png"
        or path.rsplit("/", 1)[-1]
        in _ALJAZEERA_NON_EDITORIAL_IMAGE_FILENAMES
    )


from jojo_news_archive.parsing.parser_contracts import BaseSourceParser, ParseContext


class AlJazeeraParser(BaseSourceParser):
    def select_body(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.body import (
            select_default_body as _select_default_body,
        )

        body = _select_default_body(context)
        visual = _aljazeera_visual_body(
            context.soup,
            canonical_url=context.canonical_url,
        )
        if visual is not None:
            body = visual
        gallery = _aljazeera_gallery_body(
            context.soup,
            canonical_url=context.canonical_url,
        )
        if gallery is not None:
            body = gallery
            context.structured_image_gallery_selected = True
        context.body = body

    def clean_body_before_noise(self, context: ParseContext) -> None:
        if context.clean_body is not None:
            _remove_aljazeera_body_chrome(context.clean_body)

    def is_noise_node(
        self,
        context: ParseContext,
        node: Tag,
        text: str,
    ) -> bool:
        if text in {
            "related",
            "back to top",
            "read more",
            "read more:",
            "recommended stories",
        }:
            return True
        if (
            text.startswith(
                "the views expressed in this article are the author’s own"
            )
            and "al jazeera" in text
            and ("editorial policy" in text or "editorial stance" in text)
        ):
            return True
        normalized = text.replace("’", "'").replace("‘", "'")
        return bool(
            (len(text) >= 2 and set(text) == {"_"})
            or (
                normalized.startswith(
                    "sign up for the prison journalism project's newsletter"
                )
                and "follow them on instagram" in normalized
                and " or x" in normalized
            )
        )

    def accept_lead_image(self, context: ParseContext, url: str) -> bool:
        return not _aljazeera_non_editorial_image_url(url)

    def image_identity(self, url: str) -> str | None:
        return _aljazeera_image_identity(url)

    def accept_body_image(
        self,
        context: ParseContext,
        image: ImageCandidate,
    ) -> bool:
        return not _aljazeera_non_editorial_image_url(image.original_url)

    def postprocess_output(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            first_text as _first_text,
            meta_content as _meta_content,
        )

        if (
            context.content_type == ContentType.ARTICLE
            and "/gallery/" in context.canonical_url.casefold()
            and (
                any(block.type == BlockType.IMAGE for block in context.blocks)
                or context.images
            )
        ):
            context.content_type = ContentType.GALLERY
        context.content_type = _aljazeera_body_content_type(
            default=context.content_type,
            headline=context.headline,
            plain_text=context.plain_text,
            blocks=context.blocks,
            visual_tags=_first_text(
                _meta_content(context.soup, "name", "tags"),
                _meta_content(context.soup, "name", "primaryTag"),
                _meta_content(context.soup, "name", "taxonomy-tags"),
            ),
        )

    def minimum_body_characters(self, context: ParseContext) -> int:
        if context.content_type == ContentType.INTERACTIVE:
            return 500
        return 100

    def accepts_short_body(self, context: ParseContext) -> bool:
        return bool(
            super().accepts_short_body(context)
            or (
                context.content_type == ContentType.GALLERY
                and "/gallery/" in context.canonical_url.casefold()
                and context.images
            )
        )


PARSER: AlJazeeraParser = AlJazeeraParser()
