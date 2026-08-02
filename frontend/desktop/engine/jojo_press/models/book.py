from typing import Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr


ProofreadStatus = Literal['pending', 'in_review', 'approved']
BookBlockType = Literal['heading', 'paragraph', 'footnote', 'image', 'table', 'page_number', 'toc']
ContentType = BookBlockType
CONTENT_BLOCK_TYPES: tuple[BookBlockType, ...] = get_args(BookBlockType)
LayoutBlockKind = Literal['text', 'image', 'table']


class StrictBaseModel(BaseModel):
    model_config = ConfigDict(extra='forbid', protected_namespaces=())


class SourceInfo(StrictBaseModel):
    source_uri: StrictStr = Field(min_length=1)
    page_count: StrictInt = Field(ge=1)


class ContentBlock(StrictBaseModel):
    id: StrictStr = Field(min_length=1)
    type: ContentType
    text: StrictStr
    page: StrictInt = Field(ge=1)
    proofread_status: ProofreadStatus
    source_page: StrictInt = Field(ge=1)
    source_ocr_text: StrictStr


class LayoutBlock(StrictBaseModel):
    content_id: StrictStr = Field(min_length=1)
    kind: LayoutBlockKind
    bbox: list[StrictFloat] = Field(min_length=4, max_length=4)


class LayoutPage(StrictBaseModel):
    page: StrictInt = Field(ge=1)
    blocks: list[LayoutBlock] = Field(min_length=1)


class Book(StrictBaseModel):
    book_id: StrictStr = Field(min_length=1)
    title: StrictStr = Field(min_length=1)
    language: StrictStr = Field(min_length=1)
    source: SourceInfo
    content_list: list[ContentBlock] = Field(min_length=1)
    layout: list[LayoutPage] = Field(min_length=1)


class BookMeta(StrictBaseModel):
    id: StrictStr = Field(min_length=1)
    title: StrictStr = Field(min_length=1)
    subtitle: StrictStr | None = None
    authors: list[StrictStr] = Field(default_factory=list)
    language: StrictStr = Field(min_length=1)
    status: StrictStr = Field(min_length=1)


class BookBlock(StrictBaseModel):
    id: StrictStr = Field(min_length=1)
    type: BookBlockType
    text: StrictStr
    source_page: StrictInt = Field(ge=1)


class BBox(StrictBaseModel):
    x: StrictFloat
    y: StrictFloat
    width: StrictFloat
    height: StrictFloat


class PageLayoutBlock(StrictBaseModel):
    id: StrictStr = Field(min_length=1)
    type: StrictStr
    text: StrictStr
    bbox: BBox
    level: StrictInt = Field(ge=0)


class PageLayout(StrictBaseModel):
    page_num: StrictInt = Field(ge=1)
    blocks: list[PageLayoutBlock] = Field(default_factory=list)


class ImportMeta(StrictBaseModel):
    source_pdf: StrictStr = Field(min_length=1)
    mineru_job_id: StrictStr
    model_version: StrictStr = Field(min_length=1)
    language: StrictStr = Field(min_length=1)
    is_ocr: StrictBool


class BookDocument(StrictBaseModel):
    book: BookMeta
    toc: list[dict] = Field(default_factory=list)
    blocks: list[BookBlock] = Field(min_length=1)
    footnotes: list[dict] = Field(default_factory=list)
    assets: list[dict] = Field(default_factory=list)
    import_meta: ImportMeta
    layout: list[PageLayout] = Field(default_factory=list)
