from pathlib import Path
import sys

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from jojo_press.models.book import BookBlock, BookDocument, BookMeta, ImportMeta
from jojo_press.services.cleanup_service import CleanupService


def test_cleanup_removes_non_proofread_noise_blocks() -> None:
    service = CleanupService()
    document = BookDocument(
        book=BookMeta(
            id='book-1',
            title='示例书',
            language='chinese_cht',
            status='draft',
        ),
        toc=[],
        blocks=[
            BookBlock(id='body-1', type='paragraph', text=' 第一段正文 ', source_page=1),
            BookBlock(id='page-number-1', type='page_number', text='1', source_page=1),
            BookBlock(id='numeric-paragraph-1', type='paragraph', text=' 2 ', source_page=2),
            BookBlock(id='watermark-1', type='paragraph', text='大众图书馆http://dztsg.info', source_page=2),
            BookBlock(id='empty-1', type='paragraph', text='  ', source_page=2),
            BookBlock(id='body-2', type='paragraph', text='第二段正文', source_page=2),
        ],
        footnotes=[],
        assets=[],
        import_meta=ImportMeta(
            source_pdf='input/source.pdf',
            mineru_job_id='',
            model_version='pipeline',
            language='chinese_cht',
            is_ocr=True,
        ),
    )

    cleaned = service.cleanup(document)

    assert [block.id for block in cleaned.blocks] == ['body-1', 'body-2']
    assert [block.text for block in cleaned.blocks] == ['第一段正文', '第二段正文']
