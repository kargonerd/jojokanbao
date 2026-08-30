from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


def _to_camel(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(part.capitalize() for part in parts[1:])


class ArchiveModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class CaptureProvider(str, Enum):
    WAYBACK = "wayback"
    ARQUIVO_PT = "arquivo-pt"
    COMMON_CRAWL = "commoncrawl"
    INFINI_NEWS = "infini-news"
    LIVE_ORIGIN = "live-origin"
    OTHER = "other"


class CaptureRepresentation(str, Enum):
    RAW_HTML = "raw-html"
    DERIVED_HTML = "derived-html"


class CaptureCandidate(ArchiveModel):
    provider: CaptureProvider
    snapshot_url: str
    source_url: str | None = None
    expected_headline: str | None = None
    captured_at: datetime | None = None
    digest: str | None = None
    mime_type: str | None = None
    status_code: int | None = None
    byte_count: int | None = Field(default=None, ge=0)
    warc_filename: str | None = None
    warc_offset: int | None = Field(default=None, ge=0)
    warc_length: int | None = Field(default=None, ge=1)


class BlobReference(ArchiveModel):
    path: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    byte_count: int = Field(ge=0)
    stored_byte_count: int = Field(ge=0)
    content_encoding: str | None = None


class DependentResource(ArchiveModel):
    source_url: str
    snapshot_url: str
    content_type: str
    blob: BlobReference


class RawCapture(ArchiveModel):
    format_version: str = "jojo-raw-capture/1"
    article_id: str
    publisher: str
    canonical_url: str
    published_at: datetime | None = None
    section: str | None = None
    selected_candidate: CaptureCandidate
    candidates_considered: list[CaptureCandidate] = Field(default_factory=list)
    retrieved_at: datetime
    final_url: str
    http_status: int
    content_type: str
    representation: CaptureRepresentation = CaptureRepresentation.RAW_HTML
    quality_score: int
    quality_signals: dict[str, Any] = Field(default_factory=dict)
    raw_html: BlobReference
    dependent_resources: list[DependentResource] = Field(default_factory=list)


class ArticleStatus(str, Enum):
    COMPLETE = "complete"
    PARTIAL = "partial"
    ERROR = "error"
    UNSUPPORTED = "unsupported"


class ContentType(str, Enum):
    ARTICLE = "article"
    OPINION = "opinion"
    LIVEBLOG = "liveblog"
    NEWSLETTER = "newsletter"
    TRANSCRIPT = "transcript"
    GALLERY = "gallery"
    VIDEO = "video"
    AUDIO = "audio"
    INTERACTIVE = "interactive"


class BlockType(str, Enum):
    PARAGRAPH = "paragraph"
    HEADING = "heading"
    IMAGE = "image"
    QUOTE = "quote"
    LIST = "list"
    TABLE = "table"
    EMBED = "embed"
    DIVIDER = "divider"


class ImageRole(str, Enum):
    LEAD = "lead"
    BODY = "body"
    CHART = "chart"
    INFOGRAPHIC = "infographic"
    AUTHOR_AVATAR = "author-avatar"
    RECOMMENDATION = "recommendation"
    ADVERTISEMENT = "advertisement"
    LOGO = "logo"
    ICON = "icon"
    TRACKING = "tracking"
    UNKNOWN = "unknown"


ARCHIVABLE_IMAGE_ROLES = {
    ImageRole.LEAD,
    ImageRole.BODY,
    ImageRole.CHART,
    ImageRole.INFOGRAPHIC,
}


class Author(ArchiveModel):
    name: str
    role: str = "author"


class ImageCandidate(ArchiveModel):
    asset_id: str
    role: ImageRole
    original_url: str
    candidate_urls: list[str] = Field(default_factory=list)
    caption: str | None = None
    credit: str | None = None
    alt: str | None = None
    width: int | None = Field(default=None, ge=0)
    height: int | None = Field(default=None, ge=0)
    should_archive: bool
    selection_reasons: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def archive_decision_matches_role(self) -> "ImageCandidate":
        expected = self.role in ARCHIVABLE_IMAGE_ROLES
        if self.should_archive != expected:
            raise ValueError(
                f"should_archive={self.should_archive} is inconsistent with role={self.role}"
            )
        return self


class ContentBlock(ArchiveModel):
    type: BlockType
    position: int = Field(ge=0)
    text: str | None = None
    html: str | None = None
    level: int | None = Field(default=None, ge=1, le=6)
    items: list[str] = Field(default_factory=list)
    asset_id: str | None = None
    caption: str | None = None
    credit: str | None = None
    embed_url: str | None = None


class CaptureReference(ArchiveModel):
    capture_id: str
    provider: CaptureProvider
    snapshot_url: str
    captured_at: datetime | None = None
    raw_html: BlobReference | None = None


class Extraction(ArchiveModel):
    parser: str
    parser_version: str
    parsed_at: datetime
    source_capture_id: str


class Quality(ArchiveModel):
    status: ArticleStatus
    body_characters: int = Field(ge=0)
    block_count: int = Field(ge=0)
    images_referenced: int = Field(ge=0)
    images_selected: int = Field(ge=0)
    warnings: list[str] = Field(default_factory=list)


class JojoArticle(ArchiveModel):
    format_version: str = "jojo-article/1"
    article_id: str
    publisher: str
    edition: str | None = None
    canonical_url: str
    language: str
    content_type: ContentType
    section: str | None = None
    headline: str | None = None
    description: str | None = None
    authors: list[Author] = Field(default_factory=list)
    published_at: datetime | None = None
    modified_at: datetime | None = None
    plain_text: str
    body_html: str
    blocks: list[ContentBlock]
    images: list[ImageCandidate]
    source_capture: CaptureReference
    extraction: Extraction
    quality: Quality

    @model_validator(mode="after")
    def references_existing_images(self) -> "JojoArticle":
        asset_ids = {image.asset_id for image in self.images}
        missing = {
            block.asset_id
            for block in self.blocks
            if block.type == BlockType.IMAGE
            and block.asset_id
            and block.asset_id not in asset_ids
        }
        if missing:
            raise ValueError(f"image blocks reference missing assets: {sorted(missing)}")
        return self
