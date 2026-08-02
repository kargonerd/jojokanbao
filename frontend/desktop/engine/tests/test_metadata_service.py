from pathlib import Path
import sys

from fastapi.testclient import TestClient

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from jojo_press.api.projects import get_project_metadata_store
from jojo_press.app import app
from jojo_press.models.book import BookBlock, BookDocument, BookMeta, ImportMeta
from jojo_press.services.metadata_service import MetadataService


def build_document() -> BookDocument:
    document = BookDocument(
        book=BookMeta(
            id='book-demo',
            title='JoJo Volume 1',
            language='ja',
            status='draft',
        ),
        toc=[],
        blocks=[
            BookBlock(
                id='block-1',
                type='heading',
                text='JoJo Volume 1',
                source_page=1,
            )
        ],
        footnotes=[],
        assets=[
            {'id': 'asset-cover', 'role': 'cover', 'path': 'assets/cover.png'},
            {'id': 'asset-2', 'role': 'inline', 'path': 'assets/page-1.png'},
        ],
        import_meta=ImportMeta(
            source_pdf='samples/demo.pdf',
            mineru_job_id='job-1',
            model_version='pipeline',
            language='ja',
            is_ocr=True,
        ),
    )
    object.__setattr__(document.book, 'subtitle', 'Phantom Blood')
    object.__setattr__(document.book, 'authors', ['Hirohiko Araki'])
    return document



def test_extract_confirmation_fields_from_normalized_document() -> None:
    confirmation = MetadataService().extract_confirmation(build_document())

    assert confirmation.title == 'JoJo Volume 1'
    assert confirmation.subtitle == 'Phantom Blood'
    assert confirmation.authors == ['Hirohiko Araki']
    assert confirmation.language == 'ja'
    assert confirmation.cover_asset_id == 'asset-cover'



def test_update_confirmation_updates_title_subtitle_authors_language_and_cover_asset() -> None:
    updated_document = MetadataService().update_confirmation(
        build_document(),
        title='JoJo Volume 1 Revised',
        subtitle='Battle Tendency',
        authors=['Hirohiko Araki', 'Editorial Team'],
        language='zh-Hant',
        cover_asset_id='asset-2',
    )

    assert updated_document.book.title == 'JoJo Volume 1 Revised'
    assert updated_document.book.subtitle == 'Battle Tendency'
    assert updated_document.book.authors == ['Hirohiko Araki', 'Editorial Team']
    assert updated_document.book.language == 'zh-Hant'
    assert updated_document.import_meta.language == 'zh-Hant'
    assert updated_document.assets == [
        {'id': 'asset-cover', 'role': 'inline', 'path': 'assets/cover.png'},
        {'id': 'asset-2', 'role': 'cover', 'path': 'assets/page-1.png'},
    ]


def test_projects_metadata_route_updates_confirmation_and_advances_stage() -> None:
    client = TestClient(app)
    store = get_project_metadata_store()
    store.reset()

    response = client.post(
        '/projects/project-demo/metadata',
        json={
            'title': 'Book Production Workspace Revised',
            'subtitle': 'Operator Edition',
            'authors': ['Operations Team', 'QA Desk'],
            'language': 'zh-Hant',
            'coverAssetId': 'cover-revised',
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        'id': 'project-demo',
        'title': 'Book Production Workspace Revised',
        'subtitle': 'Operator Edition',
        'authors': ['Operations Team', 'QA Desk'],
        'language': 'zh-Hant',
        'coverAssetId': 'cover-revised',
        'currentStage': 'Proofreading workspace',
    }
