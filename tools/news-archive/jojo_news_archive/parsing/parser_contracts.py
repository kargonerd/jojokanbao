from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol, runtime_checkable

from bs4 import BeautifulSoup, Tag

from jojo_news_archive.models import (
    Author,
    ContentBlock,
    ContentType,
    ImageCandidate,
    ImageRole,
    RawCapture,
)
from jojo_news_archive.sources.contracts import PublisherSpec


@dataclass(slots=True)
class ParseContext:
    """Mutable state shared by the publisher-neutral parser pipeline.

    Publisher modules own every source-specific decision and may retain
    private intermediate values in ``source_data``.  The shared engine only
    reads the explicitly generic fields below.
    """

    html_bytes: bytes
    publisher: str
    canonical_url: str
    spec: PublisherSpec
    soup: BeautifulSoup
    raw_capture: RawCapture | None = None
    dependent_resources: dict[str, bytes] = field(default_factory=dict)
    allow_generic_syndication: bool = False
    news_article: dict[str, Any] = field(default_factory=dict)
    source_data: dict[str, Any] = field(default_factory=dict)

    body: Tag | None = None
    clean_body: BeautifulSoup | None = None
    structured_image_gallery_selected: bool = False

    headline: str | None = None
    description: str | None = None
    authors: list[Author] = field(default_factory=list)
    published_at: datetime | None = None
    modified_at: datetime | None = None
    section: str | None = None
    language: str = ""
    content_type: ContentType = ContentType.ARTICLE

    blocks: list[ContentBlock] = field(default_factory=list)
    images_by_url: dict[str, ImageCandidate] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    @property
    def images(self) -> list[ImageCandidate]:
        return list(self.images_by_url.values())

    @property
    def plain_text(self) -> str:
        from jojo_news_archive.parsing.primitives import block_plain_text

        return "\n\n".join(
            value
            for block in self.blocks
            if (value := block_plain_text(block))
        )


@dataclass(slots=True)
class ImageParseContext:
    article: ParseContext
    image_node: Tag
    container: Tag
    candidates: list[str]
    width: int | None
    height: int | None
    alt: str | None
    caption: str | None
    credit: str | None
    image_context: str
    noise_context: str
    forced_role: ImageRole | None = None
    reasons: list[str] = field(default_factory=list)
    discard: bool = False


@runtime_checkable
class SourceParserHooks(Protocol):
    """Coarse parser stages implemented by one publisher package."""

    def preprocess(self, context: ParseContext) -> None: ...

    def select_body(self, context: ParseContext) -> None: ...

    def clean_body_before_noise(self, context: ParseContext) -> None: ...

    def clean_body_after_noise(self, context: ParseContext) -> None: ...

    def is_noise_node(
        self,
        context: ParseContext,
        node: Tag,
        text: str,
    ) -> bool: ...

    def extract_metadata(self, context: ParseContext) -> None: ...

    def classify_content(self, context: ParseContext) -> None: ...

    def allow_generic_audio(self, context: ParseContext) -> bool: ...

    def transform_lead_image_urls(
        self,
        context: ParseContext,
        urls: list[str],
    ) -> list[str]: ...

    def is_placeholder_image_url(
        self,
        context: ParseContext,
        url: str,
    ) -> bool: ...

    def accept_lead_image(self, context: ParseContext, url: str) -> bool: ...

    def accept_body_image(
        self,
        context: ParseContext,
        image: ImageCandidate,
    ) -> bool: ...

    def adjust_image_candidate(
        self,
        context: ParseContext,
        image: ImageCandidate,
        *,
        tag: Tag | None,
    ) -> ImageCandidate: ...

    def prepare_image(self, context: ImageParseContext) -> None: ...

    def image_identity(self, url: str) -> str | None: ...

    def matching_image(
        self,
        context: ParseContext,
        image: ImageCandidate,
    ) -> ImageCandidate | None: ...

    def retain_nested_block(self, context: ParseContext, node: Tag) -> bool: ...

    def paragraph_block(
        self,
        context: ParseContext,
        node: Tag,
        *,
        text: str,
        position: int,
    ) -> ContentBlock | None: ...

    def figure_image_nodes(
        self,
        context: ParseContext,
        node: Tag,
        images: list[Tag],
    ) -> list[Tag]: ...

    def image_container(
        self,
        context: ParseContext,
        image: Tag,
        container: Tag,
    ) -> Tag: ...

    def postprocess_blocks(self, context: ParseContext) -> None: ...

    def postprocess_output(self, context: ParseContext) -> None: ...

    def minimum_body_characters(self, context: ParseContext) -> int: ...

    def accepts_short_body(self, context: ParseContext) -> bool: ...

    def short_body_warning(self, context: ParseContext) -> str | None: ...

    def quality_warnings(self, context: ParseContext) -> list[str]: ...


class BaseSourceParser:
    """No-op defaults; concrete source packages override owned behavior."""

    def preprocess(self, context: ParseContext) -> None:
        return None

    def select_body(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.body import select_default_body

        context.body = select_default_body(context)

    def clean_body_before_noise(self, context: ParseContext) -> None:
        return None

    def clean_body_after_noise(self, context: ParseContext) -> None:
        return None

    def is_noise_node(
        self,
        context: ParseContext,
        node: Tag,
        text: str,
    ) -> bool:
        return False

    def extract_metadata(self, context: ParseContext) -> None:
        return None

    def classify_content(self, context: ParseContext) -> None:
        return None

    def allow_generic_audio(self, context: ParseContext) -> bool:
        return True

    def transform_lead_image_urls(
        self,
        context: ParseContext,
        urls: list[str],
    ) -> list[str]:
        return urls

    def is_placeholder_image_url(
        self,
        context: ParseContext,
        url: str,
    ) -> bool:
        return False

    def accept_lead_image(self, context: ParseContext, url: str) -> bool:
        return True

    def accept_body_image(
        self,
        context: ParseContext,
        image: ImageCandidate,
    ) -> bool:
        return True

    def adjust_image_candidate(
        self,
        context: ParseContext,
        image: ImageCandidate,
        *,
        tag: Tag | None,
    ) -> ImageCandidate:
        return image

    def prepare_image(self, context: ImageParseContext) -> None:
        return None

    def image_identity(self, url: str) -> str | None:
        return None

    def matching_image(
        self,
        context: ParseContext,
        image: ImageCandidate,
    ) -> ImageCandidate | None:
        return None

    def retain_nested_block(self, context: ParseContext, node: Tag) -> bool:
        return False

    def paragraph_block(
        self,
        context: ParseContext,
        node: Tag,
        *,
        text: str,
        position: int,
    ) -> ContentBlock | None:
        return None

    def figure_image_nodes(
        self,
        context: ParseContext,
        node: Tag,
        images: list[Tag],
    ) -> list[Tag]:
        return images[:1]

    def image_container(
        self,
        context: ParseContext,
        image: Tag,
        container: Tag,
    ) -> Tag:
        return container

    def postprocess_blocks(self, context: ParseContext) -> None:
        return None

    def postprocess_output(self, context: ParseContext) -> None:
        return None

    def minimum_body_characters(self, context: ParseContext) -> int:
        from jojo_news_archive.parsing.limits import MINIMUM_BODY_CHARACTERS

        return MINIMUM_BODY_CHARACTERS

    def accepts_short_body(self, context: ParseContext) -> bool:
        from jojo_news_archive.models import BlockType, ContentType

        if (
            context.content_type == ContentType.GALLERY
            and any(block.type == BlockType.IMAGE for block in context.blocks)
        ):
            return True
        if context.content_type not in {
            ContentType.INTERACTIVE,
            ContentType.VIDEO,
            ContentType.AUDIO,
            ContentType.TRANSCRIPT,
            ContentType.LIVEBLOG,
            ContentType.NEWSLETTER,
        }:
            return False
        accepted_types = (
            {BlockType.EMBED}
            if context.content_type == ContentType.NEWSLETTER
            else {BlockType.EMBED, BlockType.IMAGE}
        )
        return any(block.type in accepted_types for block in context.blocks)

    def short_body_warning(self, context: ParseContext) -> str | None:
        return None

    def quality_warnings(self, context: ParseContext) -> list[str]:
        return []
