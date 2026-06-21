from json import loads
from pathlib import Path
import sys

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from jojo_press.services.normalize_service import NormalizeService

PROJECT_ROOT = ENGINE_ROOT


def test_normalize_content_list_builds_book_document() -> None:
    service = NormalizeService()
    content_list = loads((PROJECT_ROOT / 'samples' / 'sample_content_list.json').read_text(encoding='utf-8'))

    book = service.from_mineru(content_list=content_list, source_pdf='input/source.pdf')

    assert book.book.id == 'book-generated'
    assert book.book.title == '第一章 开始'
    assert book.book.language == 'chinese_cht'
    assert book.book.status == 'draft'
    assert len(book.blocks) == 7
    assert book.blocks[0].id == 'toc-1'
    assert book.blocks[0].type == 'toc'
    assert book.blocks[0].text == '目录'
    assert book.blocks[0].source_page == 1
    assert book.blocks[1].id == 'heading-1'
    assert book.blocks[1].type == 'heading'
    assert book.blocks[1].text == '第一章 开始'
    assert book.blocks[1].source_page == 2
    assert book.blocks[-1].id == 'page-number-4'
    assert book.blocks[-1].type == 'page_number'
    assert book.blocks[-1].text == '4'
    assert book.blocks[-1].source_page == 4
    assert book.import_meta.source_pdf == 'input/source.pdf'
    assert book.import_meta.mineru_job_id == ''
    assert book.import_meta.model_version == 'pipeline'
    assert book.import_meta.language == 'chinese_cht'
    assert book.import_meta.is_ocr is True


def test_normalize_content_list_prefers_heading_title_and_applies_explicit_fallbacks() -> None:
    service = NormalizeService()

    book = service.from_mineru(
        content_list=[
            {'id': 'toc-1', 'type': 'toc', 'text': '目录', 'page': 1},
            {'id': 'heading-1', 'type': 'heading', 'text': '  正式标题  ', 'page': '3'},
            {'id': 'body-1', 'type': 'caption', 'text': '图注', 'page': 0},
            {'id': 'body-2', 'type': 'paragraph', 'text': None, 'page': True},
        ],
        source_pdf='input/edge.pdf',
    )

    assert book.book.title == '正式标题'
    assert [block.type for block in book.blocks] == ['toc', 'heading', 'paragraph', 'paragraph']
    assert [block.source_page for block in book.blocks] == [1, 3, 1, 1]
    assert [block.text for block in book.blocks] == ['目录', '  正式标题  ', '图注', '']



def test_normalize_content_list_supports_real_mineru_page_idx_and_bbox_arrays() -> None:
    service = NormalizeService()

    book = service.from_mineru(
        content_list=[
            {
                'type': 'text',
                'text': '革命造反年代',
                'text_level': 1,
                'bbox': [64, 92, 898, 186],
                'page_idx': 0,
            },
            {
                'type': 'text',
                'text': '上海文革運動史稿',
                'bbox': [344, 221, 884, 264],
                'page_idx': 0,
            },
        ],
        source_pdf='input/real-mineru.pdf',
    )

    assert book.book.title == '革命造反年代'
    assert [block.source_page for block in book.blocks] == [1, 1]
    assert book.layout[0].page_num == 1
    assert book.layout[0].blocks[0].bbox.x == 64
    assert book.layout[0].blocks[0].bbox.y == 92
    assert book.layout[0].blocks[0].bbox.width == 834
    assert book.layout[0].blocks[0].bbox.height == 94
    assert book.layout[0].blocks[1].bbox.x == 344
    assert book.layout[0].blocks[1].bbox.width == 540
