from __future__ import annotations

from dataclasses import dataclass
from html import escape
import json
from pathlib import Path
import re
import zipfile

from jojo_press.models.book import BookBlock, BookDocument


PACKAGE_SCHEMA_VERSION = '1.0'
EXPORT_FILE_BASENAME = 'book'


@dataclass(frozen=True)
class ExportChapter:
    id: str
    title: str
    order: int
    blocks: tuple[BookBlock, ...]


class ExportService:
    def export_markdown(self, document: BookDocument, output_dir: Path) -> Path:
        output_dir.mkdir(parents=True, exist_ok=True)
        markdown_path = output_dir / f'{EXPORT_FILE_BASENAME}.md'
        markdown_path.write_text(self.build_markdown(document), encoding='utf-8')
        return markdown_path

    def export_html(self, document: BookDocument, output_dir: Path) -> Path:
        output_dir.mkdir(parents=True, exist_ok=True)
        html_path = output_dir / f'{EXPORT_FILE_BASENAME}.html'
        html_path.write_text(self.build_html(document), encoding='utf-8')
        return html_path

    def export_epub(self, document: BookDocument, output_dir: Path) -> Path:
        output_dir.mkdir(parents=True, exist_ok=True)
        epub_path = output_dir / f'{EXPORT_FILE_BASENAME}.epub'
        chapters = self.build_chapters(document)

        with zipfile.ZipFile(epub_path, 'w') as package:
            mimetype_info = zipfile.ZipInfo('mimetype')
            mimetype_info.compress_type = zipfile.ZIP_STORED
            package.writestr(mimetype_info, 'application/epub+zip')
            package.writestr('META-INF/container.xml', self._build_epub_container_xml())
            package.writestr('OEBPS/content.opf', self._build_epub_package_opf(document, chapters))
            package.writestr('OEBPS/nav.xhtml', self._build_epub_nav_xhtml(document, chapters))
            package.writestr('OEBPS/styles.css', self._build_epub_css())
            for chapter in chapters:
                package.writestr(f'OEBPS/chapters/{chapter.id}.xhtml', self._build_epub_chapter_xhtml(chapter))

        return epub_path

    def export_import_package(self, document: BookDocument, output_dir: Path) -> Path:
        output_dir.mkdir(parents=True, exist_ok=True)
        package_path = output_dir / 'jojo-rag-import.zip'
        chapters = self.build_chapters(document)
        manifest = self._build_rag_manifest(document, chapters)

        with zipfile.ZipFile(package_path, 'w', compression=zipfile.ZIP_DEFLATED) as package:
            package.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
            for chapter in chapters:
                package.writestr(f'chapters/{chapter.id}.md', self._build_chapter_markdown(chapter))

        return package_path

    def build_markdown(self, document: BookDocument) -> str:
        lines = [f'# {document.book.title}', '']
        for chapter in self.build_chapters(document):
            lines.append(f'## {chapter.title}')
            lines.append('')
            for block in chapter.blocks:
                text = self._clean_text(block.text)
                if not text or text == chapter.title:
                    continue
                lines.extend(self._format_markdown_block(block, text))
            lines.append('')
        return self._normalize_trailing_newline('\n'.join(lines))

    def build_html(self, document: BookDocument) -> str:
        sections = []
        for chapter in self.build_chapters(document):
            blocks = '\n'.join(
                self._format_html_block(block)
                for block in chapter.blocks
                if self._clean_text(block.text) and self._clean_text(block.text) != chapter.title
            )
            sections.append(
                f'<section id="{escape(chapter.id)}">\n'
                f'  <h2>{escape(chapter.title)}</h2>\n'
                f'{blocks}\n'
                f'</section>'
            )

        return self._normalize_trailing_newline(
            '<!doctype html>\n'
            '<html lang="zh-Hant">\n'
            '<head>\n'
            '  <meta charset="utf-8">\n'
            f'  <title>{escape(document.book.title)}</title>\n'
            '  <style>\n'
            f'{self._build_html_css()}\n'
            '  </style>\n'
            '</head>\n'
            '<body>\n'
            f'  <h1>{escape(document.book.title)}</h1>\n'
            f'{"".join(section + chr(10) for section in sections)}'
            '</body>\n'
            '</html>\n'
        )

    def build_chapters(self, document: BookDocument) -> list[ExportChapter]:
        readable_blocks = [block for block in document.blocks if self._is_readable_block(block)]
        if not readable_blocks:
            return [
                ExportChapter(
                    id='chapter-001',
                    title=document.book.title,
                    order=1,
                    blocks=tuple(),
                )
            ]

        layout_heading_ids = self._layout_heading_ids(document)
        chapters: list[ExportChapter] = []
        current_title: str | None = None
        current_blocks: list[BookBlock] = []
        pending_headings: list[BookBlock] = []
        saw_heading = False

        def flush_pending_headings() -> None:
            nonlocal current_title
            if not pending_headings:
                return
            if current_blocks:
                flush_current()
            current_title = self._join_heading_run(pending_headings) or document.book.title
            current_blocks.extend(pending_headings)
            pending_headings.clear()

        def flush_current() -> None:
            nonlocal current_title, current_blocks
            if not current_blocks:
                return
            title = current_title or (document.book.title if not saw_heading and not chapters else self._infer_chapter_title(current_blocks, document.book.title))
            chapters.append(
                ExportChapter(
                    id=f'chapter-{len(chapters) + 1:03d}',
                    title=title,
                    order=len(chapters) + 1,
                    blocks=tuple(current_blocks),
                )
            )
            current_title = None
            current_blocks = []

        for block in readable_blocks:
            if self._is_heading_block(block, layout_heading_ids):
                saw_heading = True
                pending_headings.append(block)
                continue

            flush_pending_headings()
            current_blocks.append(block)

        flush_pending_headings()
        flush_current()
        return chapters or [
            ExportChapter(
                id='chapter-001',
                title=document.book.title,
                order=1,
                blocks=tuple(readable_blocks),
            )
        ]

    def _build_rag_manifest(self, document: BookDocument, chapters: list[ExportChapter]) -> dict[str, object]:
        return {
            'schema_version': PACKAGE_SCHEMA_VERSION,
            'title': document.book.title,
            'description': document.book.subtitle or '',
            'book': {
                'id': document.book.id,
                'title': document.book.title,
                'authors': document.book.authors,
                'language': document.book.language,
            },
            'chapters': [
                {
                    'id': chapter.id,
                    'title': chapter.title,
                    'order': chapter.order,
                    'path': f'chapters/{chapter.id}.md',
                    'summary': self._build_chapter_summary(chapter),
                }
                for chapter in chapters
            ],
            'toc': [
                {
                    'id': chapter.id,
                    'title': chapter.title,
                    'chapter_id': chapter.id,
                    'level': 1,
                    'order': chapter.order,
                }
                for chapter in chapters
            ],
            'assets': [],
            'annotations': [],
            'reader_config': {
                'default_theme': 'paper',
                'source': 'jojo-press',
            },
        }

    def _build_chapter_markdown(self, chapter: ExportChapter) -> str:
        lines = [f'# {chapter.title}', '']
        for block in chapter.blocks:
            text = self._clean_text(block.text)
            if not text or text == chapter.title:
                continue
            lines.extend(self._format_markdown_block(block, text))
        return self._normalize_trailing_newline('\n'.join(lines))

    def _format_markdown_block(self, block: BookBlock, text: str) -> list[str]:
        if block.type == 'heading':
            return [f'### {text}', '']
        if block.type == 'footnote':
            return [f'> {text}', '']
        if block.type == 'table':
            return ['```', text, '```', '']
        return [text, '']

    def _format_html_block(self, block: BookBlock) -> str:
        text = self._clean_text(block.text)
        if block.type == 'heading':
            return f'  <h3>{escape(text)}</h3>'
        if block.type == 'footnote':
            return f'  <blockquote>{escape(text)}</blockquote>'
        if block.type == 'table':
            return f'  <pre>{escape(text)}</pre>'
        return f'  <p>{escape(text).replace(chr(10), "<br>")}</p>'

    def _build_epub_container_xml(self) -> str:
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
            '  <rootfiles>\n'
            '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n'
            '  </rootfiles>\n'
            '</container>\n'
        )

    def _build_epub_package_opf(self, document: BookDocument, chapters: list[ExportChapter]) -> str:
        manifest_items = [
            '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
            '<item id="styles" href="styles.css" media-type="text/css"/>',
        ]
        spine_items = []
        for chapter in chapters:
            manifest_items.append(
                f'<item id="{chapter.id}" href="chapters/{chapter.id}.xhtml" media-type="application/xhtml+xml"/>'
            )
            spine_items.append(f'<itemref idref="{chapter.id}"/>')

        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<package version="3.0" unique-identifier="book-id" xmlns="http://www.idpf.org/2007/opf">\n'
            '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
            f'    <dc:identifier id="book-id">{escape(document.book.id)}</dc:identifier>\n'
            f'    <dc:title>{escape(document.book.title)}</dc:title>\n'
            f'    <dc:language>{escape(document.book.language)}</dc:language>\n'
            '  </metadata>\n'
            f'  <manifest>{"".join(manifest_items)}</manifest>\n'
            f'  <spine>{"".join(spine_items)}</spine>\n'
            '</package>\n'
        )

    def _build_epub_nav_xhtml(self, document: BookDocument, chapters: list[ExportChapter]) -> str:
        items = ''.join(
            f'<li><a href="chapters/{chapter.id}.xhtml">{escape(chapter.title)}</a></li>'
            for chapter in chapters
        )
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE html>\n'
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-Hant">\n'
            '<head><title>Table of Contents</title><link rel="stylesheet" href="styles.css"/></head>\n'
            '<body>\n'
            f'<nav epub:type="toc"><h1>{escape(document.book.title)}</h1><ol>{items}</ol></nav>\n'
            '</body>\n'
            '</html>\n'
        )

    def _build_epub_chapter_xhtml(self, chapter: ExportChapter) -> str:
        body = '\n'.join(
            self._format_html_block(block)
            for block in chapter.blocks
            if self._clean_text(block.text) and self._clean_text(block.text) != chapter.title
        )
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE html>\n'
            '<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-Hant">\n'
            f'<head><title>{escape(chapter.title)}</title><link rel="stylesheet" href="../styles.css"/></head>\n'
            '<body>\n'
            f'<h1>{escape(chapter.title)}</h1>\n'
            f'{body}\n'
            '</body>\n'
            '</html>\n'
        )

    def _build_html_css(self) -> str:
        return (
            'body{max-width:780px;margin:0 auto;padding:48px 24px;'
            'font-family:"Noto Serif SC","Songti SC",serif;line-height:1.85;color:#202020;}'
            'h1,h2,h3{color:#8b1a1a;line-height:1.35;}'
            'section{margin-top:2.5rem;}'
            'p{margin:0 0 1rem;}'
            'blockquote{border-left:3px solid #8b1a1a;margin:1rem 0;padding-left:1rem;color:#555;}'
            'pre{white-space:pre-wrap;background:#f7f4ef;padding:1rem;}'
        )

    def _build_epub_css(self) -> str:
        return (
            'body{font-family:serif;line-height:1.8;}'
            'h1,h2,h3{line-height:1.35;}'
            'p{margin:0 0 1em;}'
            'pre{white-space:pre-wrap;}'
        )

    def _layout_heading_ids(self, document: BookDocument) -> set[str]:
        ids: set[str] = set()
        for page in document.layout:
            for block in page.blocks:
                if block.level > 0 and self._clean_text(block.text):
                    ids.add(block.id)
        return ids

    def _is_readable_block(self, block: BookBlock) -> bool:
        text = self._clean_text(block.text)
        return bool(text) and block.type not in {'page_number'}

    def _is_heading_block(self, block: BookBlock, layout_heading_ids: set[str]) -> bool:
        text = self._clean_text(block.text)
        if not text:
            return False
        if block.type == 'heading':
            return True
        return block.id in layout_heading_ids and len(text) <= 90 and not self._looks_like_page_marker(text)

    def _looks_like_page_marker(self, text: str) -> bool:
        normalized = text.strip(' ·.。')
        return bool(re.fullmatch(r'[xivxlcdmIVXLCDM\d]+', normalized))

    def _join_heading_run(self, blocks: list[BookBlock]) -> str:
        texts = [self._clean_text(block.text) for block in blocks if self._clean_text(block.text)]
        if not texts:
            return ''
        joined = ' - '.join(texts[:3])
        if len(joined) > 96:
            return joined[:95].rstrip() + '…'
        return joined

    def _infer_chapter_title(self, blocks: list[BookBlock], fallback: str) -> str:
        for block in blocks:
            text = self._clean_text(block.text)
            if text:
                return text[:80]
        return fallback

    def _build_chapter_summary(self, chapter: ExportChapter) -> str:
        for block in chapter.blocks:
            text = self._clean_text(block.text)
            if text and text != chapter.title:
                return text[:120]
        return ''

    def _clean_text(self, value: str) -> str:
        return re.sub(r'[ \t]+', ' ', value.replace('\r\n', '\n').replace('\r', '\n')).strip()

    def _normalize_trailing_newline(self, value: str) -> str:
        return re.sub(r'\n{3,}', '\n\n', value.rstrip()) + '\n'
