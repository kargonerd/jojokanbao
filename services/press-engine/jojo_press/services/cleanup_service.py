import re

from jojo_press.models.book import BookBlock, BookDocument


class CleanupService:
    _WHITESPACE_PATTERN = re.compile(r'\s+')
    _PAGE_MARKER_PATTERN = re.compile(r'^[·.\s]*(?:[ivxlcdmIVXLCDM]+|\d+)[·.\s]*$')
    _SOURCE_WATERMARK_PATTERN = re.compile(r'(大众图书馆|dztsg\.info|dtssg\.info)', re.IGNORECASE)

    def run(self, document: BookDocument) -> BookDocument:
        cleaned_blocks: list[BookBlock] = []
        for block in document.blocks:
            normalized_text = self._normalize_text(block.text)
            if self._should_skip_block(block, normalized_text):
                continue
            cleaned_blocks.append(block.model_copy(update={'text': normalized_text}))

        return document.model_copy(update={'blocks': cleaned_blocks})

    def cleanup(self, document: BookDocument) -> BookDocument:
        return self.run(document)

    def _normalize_text(self, text: str) -> str:
        return self._WHITESPACE_PATTERN.sub(' ', text.strip())

    def _should_skip_block(self, block: BookBlock, text: str) -> bool:
        if block.type == 'page_number':
            return True
        if not text:
            return True
        if self._PAGE_MARKER_PATTERN.fullmatch(text):
            return True
        return bool(self._SOURCE_WATERMARK_PATTERN.search(text))
