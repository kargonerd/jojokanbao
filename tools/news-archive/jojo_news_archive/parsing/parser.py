from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import re
from typing import Any
from urllib.parse import unquote, urlsplit

from bs4 import BeautifulSoup, Comment, Tag

from jojo_news_archive.models import (
    ARCHIVABLE_IMAGE_ROLES,
    ArticleStatus,
    Author,
    BlockType,
    CaptureProvider,
    CaptureReference,
    ContentBlock,
    ContentType,
    Extraction,
    ImageCandidate,
    ImageRole,
    JojoArticle,
    Quality,
    RawCapture,
)
from jojo_news_archive.sources.contracts import PublisherSpec
from jojo_news_archive.sources.registry import publisher_spec
from jojo_news_archive.parsing.parser_contracts import (
    ImageParseContext,
    ParseContext,
    SourceParserHooks,
)
from jojo_news_archive.parsing.primitives import (
    caption_credit as _caption_credit,
    clean_text as _clean_text,
    deduplicate_blocks as _deduplicate_blocks,
    document_language as _document_language,
    first_text as _first_text,
    image_urls as _image_urls,
    inner_html as _inner_html,
    integer_attribute as _integer_attribute,
    json_ld_objects as _json_ld_objects,
    looks_like_gallery as _looks_like_gallery,
    meta_content as _meta_content,
    normalized_url as _normalized_url,
    parse_datetime as _parse_datetime,
    string_or_none as _string_or_none,
    tag_attribute as _tag_attribute,
    tag_text as _tag_text,
    walk_json_objects as _walk_json_objects,
)
from jojo_news_archive.parsing.images import (
    generic_image_identity as _image_identity,
    is_placeholder_image_url as _is_placeholder_image_url,
)


COMMON_REMOVE_SELECTORS = (
    "script",
    "style",
    "noscript",
    "template",
    "[aria-label*='advertisement' i]",
    "[class*='advertisement' i]",
    "[class*='recommended' i]",
    "[class*='related-' i]",
    "[data-testid*='ad-' i]",
    "[data-testid*='related' i]",
    "[data-component*='newsletter' i]",
    "[data-component*='paywall' i]",
    "nav",
    "footer",
)


_NOISE_RE = re.compile(
    r"(?i)(advert|sponsor|promo|recommend|related|newsletter|subscribe|"
    r"paywall|cookie|tracking|pixel|logo|icon|avatar)"
)
_TRACKING_RE = re.compile(r"(?i)(pixel|tracking|spacer|transparent)")
_GRAPHIC_RE = re.compile(r"(?i)(chart|graphic|infographic|interactive)")
_EXACT_NOISE_TEXT = {
    ".",
    "##",
    "advertisement",
    "advertiser content",
    "sponsored content",
    "trending stories",
}


def stable_article_id(publisher: str, canonical_url: str) -> str:
    digest = hashlib.sha256(canonical_url.encode("utf-8")).hexdigest()
    return f"{publisher}:{digest}"


def _source_parser_hooks(publisher: str) -> SourceParserHooks:
    """Resolve one source strategy without importing concrete publishers here."""

    from jojo_news_archive.sources.runtime import parser_hooks

    return parser_hooks(publisher)


def _extract_default_metadata(context: ParseContext) -> None:
    """Populate metadata that follows publisher-independent standards."""

    article = context.news_article
    soup = context.soup
    context.headline = _first_text(
        _string_or_none(article.get("headline")) if article else None,
        _meta_content(soup, "property", "og:title"),
        _meta_content(soup, "name", "twitter:title"),
        _tag_text(soup.select_one("article h1, main h1, h1")),
    )
    context.description = _first_text(
        _string_or_none(article.get("description")) if article else None,
        _meta_content(soup, "name", "description"),
        _meta_content(soup, "property", "og:description"),
    )
    context.authors = _extract_authors(article, soup)
    context.published_at = _parse_datetime(
        _first_text(
            _string_or_none(article.get("datePublished")) if article else None,
            _meta_content(soup, "property", "article:published_time"),
            _meta_content(soup, "property", "og:article:published_time"),
            _meta_content(soup, "name", "pub_date"),
            _meta_content(soup, "name", "pdate"),
            _meta_content(soup, "name", "analyticsAttributes.articleDate"),
            _meta_content(soup, "name", "sailthru.date"),
            _tag_attribute(
                soup.select_one(
                    '[itemprop="datePublished"][datetime], '
                    'time[datetime][data-testid*="timestamp" i]'
                ),
                "datetime",
            ),
        )
    )
    context.modified_at = _parse_datetime(
        _first_text(
            _string_or_none(article.get("dateModified")) if article else None,
            _meta_content(soup, "property", "article:modified_time"),
            _meta_content(soup, "name", "lastmod"),
            _tag_attribute(
                soup.select_one('[itemprop="dateModified"][datetime]'),
                "datetime",
            ),
        )
    )
    context.section = _first_text(
        _string_or_none(article.get("articleSection")) if article else None,
        context.raw_capture.section if context.raw_capture else None,
        _meta_content(soup, "name", "section"),
        _meta_content(soup, "property", "article:section"),
    )
    context.language = _document_language(
        soup,
        default=context.spec.default_language,
    )
    context.content_type = _content_type(article, context.canonical_url)
    if any(
        value.get("@type") == "LiveBlogPosting"
        for value in _json_ld_objects(soup)
    ):
        context.content_type = ContentType.LIVEBLOG


def parse_article(
    html_bytes: bytes,
    *,
    publisher: str,
    canonical_url: str,
    raw_capture: RawCapture | None = None,
    dependent_resources: dict[str, bytes] | None = None,
    parsed_at: datetime | None = None,
    allow_generic_syndication: bool = False,
) -> JojoArticle:
    """Parse one capture through its publisher-owned strategy."""

    return _parse_article_pipeline(
        html_bytes,
        publisher=publisher,
        canonical_url=canonical_url,
        raw_capture=raw_capture,
        dependent_resources=dependent_resources,
        parsed_at=parsed_at,
        allow_generic_syndication=allow_generic_syndication,
        hooks=_source_parser_hooks(publisher),
    )


def _parse_article_pipeline(
    html_bytes: bytes,
    *,
    publisher: str,
    canonical_url: str,
    raw_capture: RawCapture | None = None,
    dependent_resources: dict[str, bytes] | None = None,
    parsed_at: datetime | None = None,
    allow_generic_syndication: bool = False,
    hooks: SourceParserHooks,
) -> JojoArticle:
    spec = publisher_spec(publisher)
    declared_latin1 = re.search(
        rb"(?i)charset\s*=\s*[\"']?(?:iso-8859-1|latin-?1)\b",
        html_bytes[:8192],
    )
    has_windows_1252_punctuation = any(
        byte in html_bytes for byte in range(0x80, 0xA0)
    )
    soup = BeautifulSoup(
        html_bytes,
        "html.parser",
        from_encoding=(
            "windows-1252"
            if declared_latin1 and has_windows_1252_punctuation
            else None
        ),
    )
    context = ParseContext(
        html_bytes=html_bytes,
        publisher=publisher,
        canonical_url=canonical_url,
        spec=spec,
        soup=soup,
        raw_capture=raw_capture,
        dependent_resources=dependent_resources or {},
        allow_generic_syndication=allow_generic_syndication,
    )
    context.news_article = _find_news_article_json(soup)
    hooks.preprocess(context)
    hooks.select_body(context)
    body = context.body

    clean_body = (
        BeautifulSoup(str(body), "html.parser")
        if body is not None
        else BeautifulSoup("", "html.parser")
    )
    context.clean_body = clean_body
    hooks.clean_body_before_noise(context)
    _remove_noise(clean_body, spec, hooks=hooks, context=context)
    hooks.clean_body_after_noise(context)

    soup = context.soup
    news_article = context.news_article
    body = context.body
    clean_body = context.clean_body
    structured_image_gallery_selected = (
        context.structured_image_gallery_selected
    )

    _extract_default_metadata(context)
    hooks.extract_metadata(context)
    if context.published_at is None and context.raw_capture is not None:
        context.published_at = context.raw_capture.published_at
    hooks.classify_content(context)
    if (
        context.content_type == ContentType.ARTICLE
        and context.soup.select_one(
            "audio[data-audio-subtype='podcast'], "
            "audio source[type^='audio/']"
        )
        and hooks.allow_generic_audio(context)
    ):
        context.content_type = ContentType.AUDIO

    headline = context.headline
    description = context.description
    authors = context.authors
    published_at = context.published_at
    modified_at = context.modified_at
    section = context.section
    language = context.language
    content_type = context.content_type

    context.images_by_url = {}
    for url in _lead_image_urls(
        soup,
        news_article,
        canonical_url,
        hooks=hooks,
        context=context,
    ):
        if not hooks.accept_lead_image(context, url):
            continue
        image = _image_candidate(
            url=url,
            candidate_urls=[url],
            role=ImageRole.LEAD,
        spec=spec,
        reasons=["structured-lead-image"],
        hooks=hooks,
        context=context,
        )
        image = hooks.adjust_image_candidate(context, image, tag=None)
        image_key = _resolved_image_identity(hooks, image.original_url)
        existing = context.images_by_url.get(image_key)
        if existing is None:
            context.images_by_url[image_key] = image
        else:
            _merge_candidate_urls(existing, image)

    blocks: list[ContentBlock] = []
    if clean_body:
        blocks, body_images = _extract_blocks(
            clean_body,
            base_url=canonical_url,
            spec=spec,
            starting_position=0,
            hooks=hooks,
            context=context,
        )
        for image in body_images:
            if not hooks.accept_body_image(context, image):
                continue
            image_key = _resolved_image_identity(hooks, image.original_url)
            existing = (
                context.images_by_url.get(image_key)
                or hooks.matching_image(context, image)
            )
            if existing is None:
                context.images_by_url[image_key] = image
                continue
            if not existing.should_archive and image.should_archive:
                _merge_candidate_urls(image, existing)
                if not image.caption and existing.caption:
                    image.caption = existing.caption
                if not image.credit and existing.credit:
                    image.credit = existing.credit
                if not image.alt and existing.alt:
                    image.alt = existing.alt
                image.selection_reasons = sorted(
                    set(image.selection_reasons + existing.selection_reasons)
                    - {
                        "author-avatar-url",
                        "social-or-author-icon-url",
                    }
                )
                context.images_by_url[image_key] = image
                continue
            _merge_candidate_urls(existing, image)
            if not existing.caption and image.caption:
                existing.caption = image.caption
            if not existing.credit and image.credit:
                existing.credit = image.credit
            if not existing.alt and image.alt:
                existing.alt = image.alt
            existing.selection_reasons = sorted(
                set(existing.selection_reasons + image.selection_reasons)
            )
            for block in blocks:
                if block.asset_id == image.asset_id:
                    block.asset_id = existing.asset_id

        selected_asset_ids = {
            image.asset_id for image in context.images_by_url.values()
        }
        blocks = [
            block
            for block in blocks
            if not (
                block.type == BlockType.IMAGE
                and block.asset_id
                and block.asset_id not in selected_asset_ids
            )
        ]
        blocks = _deduplicate_blocks(blocks)

    context.blocks = blocks
    hooks.postprocess_blocks(context)
    if (
        context.content_type == ContentType.ARTICLE
        and (
            context.structured_image_gallery_selected
            or _looks_like_gallery(context.blocks)
        )
    ):
        context.content_type = ContentType.GALLERY
    hooks.postprocess_output(context)

    blocks = context.blocks
    images_by_url = context.images_by_url
    images = context.images
    content_type = context.content_type
    plain_text = context.plain_text
    body_html = _inner_html(clean_body)

    warnings: list[str] = []
    if not context.headline:
        warnings.append("missing-headline")
    publisher_notice = _is_publisher_notice(
        headline=context.headline,
        description=context.description,
        plain_text=context.plain_text,
    )
    short_warning = hooks.short_body_warning(context)
    if (
        len(context.plain_text) < hooks.minimum_body_characters(context)
        and not hooks.accepts_short_body(context)
        and not publisher_notice
        and short_warning is None
    ):
        warnings.append("body-too-short")
    if publisher_notice:
        warnings.append("publisher-notice")
    if short_warning is not None:
        warnings.append(short_warning)
    warnings.extend(hooks.quality_warnings(context))
    if not context.published_at:
        warnings.append("missing-published-at")
    if context.body is None:
        warnings.append("article-body-not-found")

    warnings = list(dict.fromkeys(warnings))
    context.warnings = warnings
    status = ArticleStatus.COMPLETE
    if "article-body-not-found" in warnings:
        status = ArticleStatus.UNSUPPORTED
    elif any(
        warning in warnings
        for warning in (
            "body-too-short",
            "missing-headline",
            "truncated-body",
            "incomplete-gallery",
            "incomplete-interactive",
        )
    ):
        status = ArticleStatus.PARTIAL

    capture_reference = _capture_reference(
        raw_capture=raw_capture,
        publisher=publisher,
        canonical_url=canonical_url,
    )
    parsed_at = parsed_at or datetime.now(timezone.utc)
    return JojoArticle(
        article_id=(
            raw_capture.article_id
            if raw_capture
            else stable_article_id(publisher, canonical_url)
        ),
        publisher=publisher,
        edition=spec.edition,
        canonical_url=canonical_url,
        language=language,
        content_type=content_type,
        section=section,
        headline=headline,
        description=description,
        authors=authors,
        published_at=published_at,
        modified_at=modified_at,
        plain_text=plain_text,
        body_html=body_html,
        blocks=blocks,
        images=images,
        source_capture=capture_reference,
        extraction=Extraction(
            parser=publisher,
            parser_version=spec.parser_version,
            parsed_at=parsed_at,
            source_capture_id=capture_reference.capture_id,
        ),
        quality=Quality(
            status=status,
            body_characters=len(plain_text),
            block_count=len(blocks),
            images_referenced=len(images),
            images_selected=sum(image.should_archive for image in images),
            warnings=warnings,
        ),
    )


def _capture_reference(
    *,
    raw_capture: RawCapture | None,
    publisher: str,
    canonical_url: str,
) -> CaptureReference:
    if raw_capture:
        candidate = raw_capture.selected_candidate
        timestamp = (
            candidate.captured_at.isoformat()
            if candidate.captured_at
            else "unknown"
        )
        return CaptureReference(
            capture_id=(
                f"{candidate.provider.value}:{timestamp}:"
                f"{raw_capture.raw_html.sha256[:16]}"
            ),
            provider=candidate.provider,
            snapshot_url=candidate.snapshot_url,
            captured_at=candidate.captured_at,
            raw_html=raw_capture.raw_html,
        )
    digest = hashlib.sha256(canonical_url.encode("utf-8")).hexdigest()[:16]
    return CaptureReference(
        capture_id=f"other:unknown:{digest}",
        provider=CaptureProvider.OTHER,
        snapshot_url=canonical_url,
    )


def _find_news_article_json(soup: BeautifulSoup) -> dict[str, Any]:
    for script in soup.select('script[type="application/ld+json"]'):
        value = script.string or script.get_text()
        if not value.strip():
            continue
        try:
            payload = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            continue
        for item in _walk_json_objects(payload):
            types = item.get("@type")
            if isinstance(types, str):
                types = [types]
            if isinstance(types, list) and any(
                value in {"NewsArticle", "Article", "ReportageNewsArticle"}
                for value in types
            ):
                return item
    return {}


def _is_publisher_notice(
    *,
    headline: str | None,
    description: str | None,
    plain_text: str,
) -> bool:
    combined = " ".join(
        value for value in (headline, description, plain_text) if value
    ).casefold()
    return bool(
        re.search(
            r"\barticle was published in error\b|"
            r"\binadvertently published on this page\b|"
            r"\b(?:article|feature) (?:has been|was) removed "
            r"because of a copyright dispute\b",
            combined,
        )
    )


def _remove_noise(
    soup: BeautifulSoup,
    spec: PublisherSpec,
    *,
    hooks: SourceParserHooks | None = None,
    context: ParseContext | None = None,
) -> None:
    for comment in list(
        soup.find_all(string=lambda value: isinstance(value, Comment))
    ):
        comment.extract()
    for selector in (*COMMON_REMOVE_SELECTORS, *spec.remove_selectors):
        for node in soup.select(selector):
            node.decompose()
    for node in list(
        soup.select("p, li, div, span, h1, h2, h3, h4, h5, h6")
    ):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if text in _EXACT_NOISE_TEXT or (
            hooks is not None
            and context is not None
            and hooks.is_noise_node(context, node, text)
        ):
            node.decompose()


def _extract_blocks(
    body: BeautifulSoup,
    *,
    base_url: str,
    spec: PublisherSpec,
    starting_position: int,
    hooks: SourceParserHooks,
    context: ParseContext,
) -> tuple[list[ContentBlock], list[ImageCandidate]]:
    blocks: list[ContentBlock] = []
    images: list[ImageCandidate] = []
    selectors = [
        "p",
        "pre",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "ul",
        "ol",
        "figure",
        "img",
        "table",
        "hr",
        "iframe",
        "audio",
        "amp-brightcove",
        *spec.text_block_selectors,
    ]
    selected = body.select(", ".join(selectors))
    publisher_text_node_ids = {
        id(node)
        for selector in spec.text_block_selectors
        for node in body.select(selector)
    }
    for node in selected:
        has_selected_ancestor = _has_selected_ancestor(
            node,
            body,
            publisher_text_node_ids=publisher_text_node_ids,
        )
        if (
            has_selected_ancestor
            and not hooks.retain_nested_block(context, node)
        ):
            continue
        position = starting_position + len(blocks)
        name = node.name.lower()
        if name in {"p", "pre"}:
            text = _clean_text(node.get_text(" ", strip=True))
            override = hooks.paragraph_block(
                context,
                node,
                text=text,
                position=position,
            )
            if override is not None:
                blocks.append(override)
                continue
            if text:
                blocks.append(
                    ContentBlock(
                        type=BlockType.PARAGRAPH,
                        position=position,
                        text=text,
                        html=str(node),
                    )
                )
        elif name in {"div", "span"} and id(node) in publisher_text_node_ids:
            text = _clean_text(node.get_text(" ", strip=True))
            if text:
                event = node.find_parent("article")
                is_heading = bool(
                    isinstance(event, Tag)
                    and "title" in (event.get("class") or [])
                )
                blocks.append(
                    ContentBlock(
                        type=(
                            BlockType.HEADING
                            if is_heading
                            else BlockType.PARAGRAPH
                        ),
                        position=position,
                        level=2 if is_heading else None,
                        text=text,
                        html=str(node),
                    )
                )
        elif name in {"h2", "h3", "h4", "h5", "h6"}:
            text = _clean_text(node.get_text(" ", strip=True))
            if text:
                blocks.append(
                    ContentBlock(
                        type=BlockType.HEADING,
                        position=position,
                        level=int(name[1]),
                        text=text,
                        html=str(node),
                    )
                )
        elif name == "blockquote":
            text = _clean_text(node.get_text(" ", strip=True))
            if text:
                blocks.append(
                    ContentBlock(
                        type=BlockType.QUOTE,
                        position=position,
                        text=text,
                        html=str(node),
                    )
                )
        elif name in {"ul", "ol"}:
            items = [
                _clean_text(item.get_text(" ", strip=True))
                for item in node.find_all("li", recursive=False)
            ]
            items = [item for item in items if item]
            if items:
                blocks.append(
                    ContentBlock(
                        type=BlockType.LIST,
                        position=position,
                        text="\n".join(items),
                        items=items,
                        html=str(node),
                    )
                )
        elif name in {"figure", "img"}:
            image_nodes = (
                [node]
                if name == "img"
                else [
                    image_node
                    for image_node in node.find_all("img")
                    if image_node.find_parent("figure") is node
                ]
            )
            image_nodes = hooks.figure_image_nodes(context, node, image_nodes)
            for image_node in image_nodes:
                image_container = hooks.image_container(
                    context,
                    image_node,
                    node,
                )
                image = _image_from_tag(
                    image_node,
                    container=image_container,
                    base_url=base_url,
                    spec=spec,
                    hooks=hooks,
                    context=context,
                )
                if not image:
                    continue
                images.append(image)
                blocks.append(
                    ContentBlock(
                        type=BlockType.IMAGE,
                        position=starting_position + len(blocks),
                        asset_id=image.asset_id,
                        caption=image.caption,
                        credit=image.credit,
                        html=str(image_container),
                    )
                )
        elif name == "table":
            text = _clean_text(node.get_text(" ", strip=True))
            blocks.append(
                ContentBlock(
                    type=BlockType.TABLE,
                    position=position,
                    text=text or None,
                    html=str(node),
                )
            )
        elif name == "hr":
            blocks.append(ContentBlock(type=BlockType.DIVIDER, position=position))
        elif name == "iframe":
            source = _normalized_url(node.get("src"), base_url=base_url)
            if source:
                blocks.append(
                    ContentBlock(
                        type=BlockType.EMBED,
                        position=position,
                        embed_url=source,
                        html=str(node),
                    )
                )
        elif name == "audio":
            source_node = node.select_one("source[src]")
            source_value = (
                source_node.get("src")
                if isinstance(source_node, Tag)
                else node.get("src")
            )
            source = _normalized_url(source_value, base_url=base_url)
            if source:
                blocks.append(
                    ContentBlock(
                        type=BlockType.EMBED,
                        position=position,
                        embed_url=source,
                        html=str(node),
                    )
                )
        elif name == "amp-brightcove":
            account = _string_or_none(node.get("data-account"))
            player = _string_or_none(node.get("data-player")) or "default"
            embed = _string_or_none(node.get("data-embed")) or "default"
            video_id = _string_or_none(node.get("data-video-id"))
            if account and video_id:
                source = (
                    f"https://players.brightcove.net/{account}/"
                    f"{player}_{embed}/index.html?videoId={video_id}"
                )
                blocks.append(
                    ContentBlock(
                        type=BlockType.EMBED,
                        position=position,
                        embed_url=source,
                        html=str(node),
                    )
                )
    return blocks, images


def _has_selected_ancestor(
    node: Tag,
    body: BeautifulSoup,
    *,
    publisher_text_node_ids: set[int] | None = None,
) -> bool:
    selected_names = {
        "p",
        "pre",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "ul",
        "ol",
        "figure",
        "table",
        "iframe",
    }
    parent = node.parent
    while isinstance(parent, Tag) and parent is not body:
        if (
            publisher_text_node_ids is not None
            and id(parent) in publisher_text_node_ids
        ):
            return True
        if node.name in {"iframe", "audio"} and parent.name in {"p", "pre"}:
            # Some migrated CMS pages emit invalid ``<p><div><iframe>``
            # markup, while archived audio players legitimately nest their
            # ``audio`` element inside a paragraph. Keep the media block even
            # though its paragraph shell is also a selected block.
            parent = parent.parent
            continue
        if (
            parent.name == "figure"
            and parent.select_one("img") is None
        ):
            # Modern scrollytelling packages use <figure> as a layout shell
            # around narrative paragraphs rather than as an image container.
            parent = parent.parent
            continue
        if (
            node.name == "img"
            and parent.name == "p"
            and not _clean_text(parent.get_text(" ", strip=True))
        ):
            parent = parent.parent
            continue
        if parent.name and parent.name.lower() in selected_names:
            return True
        parent = parent.parent
    return False


def _image_from_tag(
    image_node: Tag,
    *,
    container: Tag,
    base_url: str,
    spec: PublisherSpec,
    hooks: SourceParserHooks,
    context: ParseContext,
) -> ImageCandidate | None:
    candidates = _image_urls(image_node, base_url=base_url)
    if not candidates:
        return None
    width = _integer_attribute(image_node, "width")
    height = _integer_attribute(image_node, "height")
    alt = _first_text(
        _clean_text(image_node.get("alt", "")),
        _clean_text(image_node.get("aria-label", "")),
    )
    caption, credit = _caption_credit(container)
    original_url = candidates[0]
    image_context = " ".join(
        filter(
            None,
            [
                container.get("class") and " ".join(container.get("class", [])),
                container.get("id"),
                image_node.get("class")
                and " ".join(image_node.get("class", [])),
                image_node.get("id"),
                original_url,
            ],
        )
    )
    extraction = ImageParseContext(
        article=context,
        image_node=image_node,
        container=container,
        candidates=candidates,
        width=width,
        height=height,
        alt=alt,
        caption=caption,
        credit=credit,
        image_context=image_context,
        noise_context=image_context,
    )
    hooks.prepare_image(extraction)
    if extraction.discard or not extraction.candidates:
        return None

    original_url = extraction.candidates[0]
    role = ImageRole.BODY
    reasons = ["inside-article-body", *extraction.reasons]
    if _TRACKING_RE.search(extraction.noise_context) or (
        extraction.width is not None
        and extraction.height is not None
        and extraction.width <= 2
        and extraction.height <= 2
    ):
        role = ImageRole.TRACKING
        reasons.append("tracking-signal")
    elif extraction.forced_role is not None:
        role = extraction.forced_role
    elif _NOISE_RE.search(extraction.noise_context):
        if re.search(
            r"(?i)(advert|sponsor|promo)",
            extraction.noise_context,
        ):
            role = ImageRole.ADVERTISEMENT
        elif re.search(
            r"(?i)(recommend|related)",
            extraction.noise_context,
        ):
            role = ImageRole.RECOMMENDATION
        elif re.search(r"(?i)avatar", extraction.noise_context):
            role = ImageRole.AUTHOR_AVATAR
        elif re.search(r"(?i)logo", extraction.noise_context):
            role = ImageRole.LOGO
        else:
            role = ImageRole.ICON
        reasons.append("non-editorial-context")
    elif (
        extraction.width is not None
        and extraction.height is not None
        and max(extraction.width, extraction.height) <= 64
    ):
        role = ImageRole.ICON
        reasons.append("small-dimensions")
    elif _GRAPHIC_RE.search(extraction.image_context):
        role = (
            ImageRole.INFOGRAPHIC
            if re.search(r"(?i)infographic", extraction.image_context)
            else ImageRole.CHART
        )
        reasons.append("graphic-context")
    if extraction.caption:
        reasons.append("has-caption")
    if urlsplit(original_url).hostname in spec.preferred_image_hosts:
        reasons.append("publisher-image-host")
    image = _image_candidate(
        url=original_url,
        candidate_urls=extraction.candidates,
        role=role,
        spec=spec,
        reasons=reasons,
        caption=extraction.caption,
        credit=extraction.credit,
        alt=extraction.alt,
        width=extraction.width,
        height=extraction.height,
        hooks=hooks,
        context=context,
    )
    return hooks.adjust_image_candidate(context, image, tag=image_node)


def _image_candidate(
    *,
    url: str,
    candidate_urls: list[str],
    role: ImageRole,
    spec: PublisherSpec,
    reasons: list[str],
    caption: str | None = None,
    credit: str | None = None,
    alt: str | None = None,
    width: int | None = None,
    height: int | None = None,
    hooks: SourceParserHooks,
    context: ParseContext,
) -> ImageCandidate:
    if (
        role == ImageRole.LEAD
        and "structured-lead-image" in reasons
        and not any((caption, credit, alt, width, height))
        and _structured_site_branding_image_url(url)
    ):
        # Syndication sites sometimes publish their compact masthead logo as
        # ``NewsArticle.image`` when the original story has no artwork. A
        # metadata-only, explicitly size-labelled logo is site chrome, not a
        # lead photograph, even though the structured field normally carries
        # strong editorial-image weight.
        role = ImageRole.LOGO
        reasons = [*reasons, "structured-site-branding"]
    if _is_placeholder_image_url(url) or hooks.is_placeholder_image_url(
        context,
        url,
    ):
        role = ImageRole.LOGO
        reasons = [*reasons, "generic-publisher-branding"]
    identity = _resolved_image_identity(hooks, url)
    asset_id = (
        f"urlsha256:{hashlib.sha256(identity.encode('utf-8')).hexdigest()}"
    )
    return ImageCandidate(
        asset_id=asset_id,
        role=role,
        original_url=url,
        candidate_urls=candidate_urls,
        caption=caption,
        credit=credit,
        alt=alt,
        width=width,
        height=height,
        should_archive=role in ARCHIVABLE_IMAGE_ROLES,
        selection_reasons=sorted(set(reasons)),
    )


def _resolved_image_identity(
    hooks: SourceParserHooks,
    url: str,
) -> str:
    generic_identity = _image_identity(url)
    return (
        hooks.image_identity(url)
        or hooks.image_identity(generic_identity)
        or generic_identity
    )


def _merge_candidate_urls(
    existing: ImageCandidate,
    incoming: ImageCandidate,
) -> None:
    for url in (
        incoming.original_url,
        *incoming.candidate_urls,
    ):
        if url not in existing.candidate_urls:
            existing.candidate_urls.append(url)


def _lead_image_urls(
    soup: BeautifulSoup,
    article: dict[str, Any],
    base_url: str,
    *,
    hooks: SourceParserHooks,
    context: ParseContext,
) -> list[str]:
    values: list[str] = []
    if article:
        values.extend(_flatten_image_values(article.get("image")))
    values.extend(
        filter(
            None,
            [
                _meta_content(soup, "property", "og:image"),
                _meta_content(soup, "name", "twitter:image"),
                _meta_content(soup, "name", "parsely-image-url"),
            ],
        )
    )
    result: list[str] = []
    for value in values:
        normalized = _normalized_url(value, base_url=base_url)
        if (
            normalized
            and not _is_placeholder_image_url(normalized)
            and not hooks.is_placeholder_image_url(context, normalized)
            and normalized not in result
        ):
            result.append(normalized)
    return hooks.transform_lead_image_urls(context, result)


def _structured_site_branding_image_url(url: str) -> bool:
    leaf = unquote(urlsplit(url).path).casefold().rsplit("/", 1)[-1]
    return bool(
        re.fullmatch(
            r"(?:[a-z0-9]{1,24}[-_])*logo[-_]"
            r"(?:sm|small|lg|large|basic|header|masthead|mobile|desktop|"
            r"\d{2,4}x\d{2,4})"
            r"\.(?:avif|gif|jpe?g|png|webp)",
            leaf,
        )
    )


def _flatten_image_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return _flatten_image_values(value.get("url") or value.get("contentUrl"))
    if isinstance(value, list):
        result: list[str] = []
        for item in value:
            result.extend(_flatten_image_values(item))
        return result
    return []


def _extract_authors(
    article: dict[str, Any],
    soup: BeautifulSoup,
) -> list[Author]:
    values: list[str] = []
    source = article.get("author") if article else None
    if isinstance(source, str):
        values.append(source)
    elif isinstance(source, dict):
        name = _string_or_none(source.get("name"))
        if name:
            values.append(name)
    elif isinstance(source, list):
        for item in source:
            if isinstance(item, str):
                values.append(item)
            elif isinstance(item, dict):
                name = _string_or_none(item.get("name"))
                if name:
                    values.append(name)
    if not values:
        meta = _meta_content(soup, "name", "author")
        if meta:
            values.extend(part.strip() for part in meta.split(","))
    result: list[Author] = []
    seen: set[str] = set()
    for value in values:
        clean = _clean_text(value)
        if clean and clean.casefold() not in seen:
            result.append(Author(name=clean))
            seen.add(clean.casefold())
    return result


def _content_type(article: dict[str, Any], canonical_url: str) -> ContentType:
    article_type = article.get("@type") if article else None
    url = canonical_url.casefold()
    if article_type == "LiveBlogPosting" or re.search(
        r"/(?:live|liveblog)(?:/|$)",
        url,
    ):
        return ContentType.LIVEBLOG
    if "newsletter" in url:
        return ContentType.NEWSLETTER
    if "transcript" in url:
        return ContentType.TRANSCRIPT
    if "podcast" in url:
        return ContentType.AUDIO
    if "opinion" in url:
        return ContentType.OPINION
    if "video" in url:
        return ContentType.VIDEO
    if "interactive" in url or "/features/" in url:
        return ContentType.INTERACTIVE
    if isinstance(article_type, str) and article_type == "ReportageNewsArticle":
        return ContentType.ARTICLE
    return ContentType.ARTICLE
