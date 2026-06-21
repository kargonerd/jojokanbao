from typing import cast

from jojo_press.models.book import (
    CONTENT_BLOCK_TYPES,
    BBox,
    BookBlock,
    BookBlockType,
    BookDocument,
    BookMeta,
    ImportMeta,
    PageLayout,
    PageLayoutBlock,
)


class NormalizeService:
    _TITLE_TYPES = ('title', 'heading')
    _ALLOWED_BLOCK_TYPES = frozenset(CONTENT_BLOCK_TYPES)

    def from_mineru(self, content_list: list[dict], source_pdf: str) -> BookDocument:
        title = self._derive_title(content_list)
        blocks = [
            BookBlock(
                id=item.get('id') or f'block-{index}',
                type=self._normalize_block_type(item.get('type')),
                text=self._normalize_text(item.get('text')),
                source_page=self._normalize_page_number(item),
            )
            for index, item in enumerate(content_list, start=1)
        ]

        # Build layout from content_list (grouped by page)
        layout = self._build_layout(content_list)

        return BookDocument(
            book=BookMeta(
                id='book-generated',
                title=title,
                language='chinese_cht',
                status='draft',
            ),
            toc=[],
            blocks=blocks,
            footnotes=[],
            assets=[],
            import_meta=ImportMeta(
                source_pdf=source_pdf,
                mineru_job_id='',
                model_version='pipeline',
                language='chinese_cht',
                is_ocr=True,
            ),
            layout=layout,
        )

    def _build_layout(self, content_list: list[dict]) -> list[PageLayout]:
        """Build page layout from content_list with bbox info."""
        pages: dict[int, list[PageLayoutBlock]] = {}
        for index, item in enumerate(content_list, start=1):
            page_num = self._normalize_page_number(item)
            bbox = self._normalize_bbox(item.get('bbox'))

            block = PageLayoutBlock(
                id=item.get('id') or f'block-{index}',
                type=item.get('type', 'text'),
                text=self._normalize_text(item.get('text')),
                bbox=bbox,
                level=item.get('level') or item.get('text_level') or 0,
            )

            if page_num not in pages:
                pages[page_num] = []
            pages[page_num].append(block)

        return [
            PageLayout(page_num=page_num, blocks=blocks)
            for page_num, blocks in sorted(pages.items())
        ]
    def _normalize_page_number(self, item: dict) -> int:
        page_num = item.get('pageNum') or item.get('page')
        if isinstance(page_num, str) and page_num.isdigit():
            normalized = int(page_num)
            if normalized >= 1:
                return normalized
        if isinstance(page_num, int) and not isinstance(page_num, bool) and page_num >= 1:
            return page_num
        page_idx = item.get('page_idx')
        if isinstance(page_idx, str) and page_idx.isdigit():
            return int(page_idx) + 1
        if isinstance(page_idx, int) and not isinstance(page_idx, bool) and page_idx >= 0:
            return page_idx + 1
        return 1

    def _normalize_bbox(self, value: object) -> BBox:
        if isinstance(value, dict):
            return BBox(
                x=float(value.get('x', 0)),
                y=float(value.get('y', 0)),
                width=float(value.get('width', 0)),
                height=float(value.get('height', 0)),
            )
        if isinstance(value, list) and len(value) >= 4:
            left = float(value[0])
            top = float(value[1])
            right = float(value[2])
            bottom = float(value[3])
            return BBox(
                x=left,
                y=top,
                width=max(0.0, right - left),
                height=max(0.0, bottom - top),
            )
        return BBox(x=0, y=0, width=0, height=0)

    def _derive_title(self, content_list: list[dict]) -> str:
        for preferred_type in self._TITLE_TYPES:
            for item in content_list:
                if item.get('type') == preferred_type:
                    text = self._normalize_text(item.get('text')).strip()
                    if text:
                        return text

        for item in content_list:
            text = self._normalize_text(item.get('text')).strip()
            if text:
                return text

        return 'Untitled Book'

    def _normalize_text(self, value: object) -> str:
        return value if isinstance(value, str) else ''

    def _normalize_block_type(self, value: object) -> BookBlockType:
        if isinstance(value, str) and value in self._ALLOWED_BLOCK_TYPES:
            return cast(BookBlockType, value)
        return 'paragraph'

    def _normalize_page(self, value: object) -> int:
        if isinstance(value, int) and not isinstance(value, bool) and value >= 1:
            return value
        if isinstance(value, str) and value.isdigit():
            normalized = int(value)
            if normalized >= 1:
                return normalized
        return 1
