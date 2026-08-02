from pathlib import Path
import sys
import zipfile

from fastapi.testclient import TestClient

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from jojo_press.api.export import get_export_output_root, get_export_repository
from jojo_press.app import app
from jojo_press.models.book import BookBlock, BookDocument, BookMeta, ImportMeta, PageLayout, PageLayoutBlock, BBox
from jojo_press.services.export_service import ExportService


class StubExportRepository:
    def __init__(self, documents: dict[str, BookDocument]) -> None:
        self._documents = documents

    def load_book_document(self, project_id: str) -> BookDocument:
        try:
            return self._documents[project_id]
        except KeyError as exc:
            raise FileNotFoundError(project_id) from exc


def build_document() -> BookDocument:
    return BookDocument(
        book=BookMeta(
            id='book-1',
            title='示例书',
            language='chinese_cht',
            status='draft',
        ),
        toc=[],
        blocks=[
            BookBlock(id='heading-1', type='paragraph', text='第一章', source_page=1),
            BookBlock(id='body-1', type='paragraph', text='第一段正文', source_page=1),
            BookBlock(id='heading-2', type='paragraph', text='第二章', source_page=2),
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
        layout=[
            PageLayout(
                page_num=1,
                blocks=[
                    PageLayoutBlock(id='heading-1', type='text', text='第一章', bbox=BBox(x=0, y=0, width=100, height=20), level=1),
                    PageLayoutBlock(id='body-1', type='text', text='第一段正文', bbox=BBox(x=0, y=30, width=100, height=20), level=0),
                ],
            ),
            PageLayout(
                page_num=2,
                blocks=[
                    PageLayoutBlock(id='heading-2', type='text', text='第二章', bbox=BBox(x=0, y=0, width=100, height=20), level=1),
                    PageLayoutBlock(id='body-2', type='text', text='第二段正文', bbox=BBox(x=0, y=30, width=100, height=20), level=0),
                ],
            ),
        ],
    )


def test_export_service_builds_chapters_from_layout_headings() -> None:
    chapters = ExportService().build_chapters(build_document())

    assert [(chapter.id, chapter.title, [block.id for block in chapter.blocks]) for chapter in chapters] == [
        ('chapter-001', '第一章', ['heading-1', 'body-1']),
        ('chapter-002', '第二章', ['heading-2', 'body-2']),
    ]


def test_export_service_writes_markdown_file(tmp_path: Path) -> None:
    ExportService().export_markdown(build_document(), tmp_path)

    assert (tmp_path / 'book.md').read_text(encoding='utf-8') == '# 示例书\n\n## 第一章\n\n第一段正文\n\n## 第二章\n\n第二段正文\n'


def test_export_service_writes_html_file(tmp_path: Path) -> None:
    ExportService().export_html(build_document(), tmp_path)

    html = (tmp_path / 'book.html').read_text(encoding='utf-8')
    assert '<title>示例书</title>' in html
    assert '<h2>第一章</h2>' in html
    assert '<p>第一段正文</p>' in html


def test_export_service_writes_epub_file(tmp_path: Path) -> None:
    path = ExportService().export_epub(build_document(), tmp_path)

    with zipfile.ZipFile(path) as package:
        assert package.read('mimetype') == b'application/epub+zip'
        assert 'META-INF/container.xml' in package.namelist()
        assert 'OEBPS/content.opf' in package.namelist()
        assert 'OEBPS/nav.xhtml' in package.namelist()
        assert 'OEBPS/chapters/chapter-001.xhtml' in package.namelist()


def test_export_service_writes_rag_import_package(tmp_path: Path) -> None:
    path = ExportService().export_import_package(build_document(), tmp_path)

    with zipfile.ZipFile(path) as package:
        manifest = package.read('manifest.json').decode('utf-8')
        chapter = package.read('chapters/chapter-001.md').decode('utf-8')

    assert '"schema_version": "1.0"' in manifest
    assert '"title": "示例书"' in manifest
    assert '"path": "chapters/chapter-001.md"' in manifest
    assert chapter == '# 第一章\n\n第一段正文\n'


def test_export_routes_create_files_under_configured_export_root(tmp_path: Path) -> None:
    client = TestClient(app)
    repository = StubExportRepository(documents={'book-1': build_document()})
    app.dependency_overrides.clear()

    def override_repository() -> StubExportRepository:
        return repository

    def override_export_output_root() -> Path:
        return tmp_path

    app.dependency_overrides[get_export_repository] = override_repository
    app.dependency_overrides[get_export_output_root] = override_export_output_root
    try:
        expected = {
            'markdown': tmp_path / 'book-1' / 'markdown' / 'book.md',
            'html': tmp_path / 'book-1' / 'html' / 'book.html',
            'epub': tmp_path / 'book-1' / 'epub' / 'book.epub',
            'jojo-rag': tmp_path / 'book-1' / 'jojo-rag' / 'jojo-rag-import.zip',
        }
        for export_id, path in expected.items():
            response = client.post(f'/export/book-1/{export_id}')
            assert response.status_code == 200
            assert response.json() == {'path': str(path)}
            assert path.exists()
    finally:
        app.dependency_overrides.clear()


def test_export_route_returns_seeded_project_for_supported_formats(tmp_path: Path) -> None:
    client = TestClient(app)
    app.dependency_overrides.clear()

    def override_export_output_root() -> Path:
        return tmp_path

    app.dependency_overrides[get_export_output_root] = override_export_output_root
    try:
        for export_id, filename in {
            'markdown': 'markdown/book.md',
            'html': 'html/book.html',
            'epub': 'epub/book.epub',
            'jojo-rag': 'jojo-rag/jojo-rag-import.zip',
        }.items():
            response = client.post(f'/export/project-ops-handbook/{export_id}')
            path = tmp_path / 'project-ops-handbook' / filename
            assert response.status_code == 200
            assert response.json() == {'path': str(path)}
            assert path.exists()
    finally:
        app.dependency_overrides.clear()


def test_export_route_returns_not_found_for_unknown_project(tmp_path: Path) -> None:
    client = TestClient(app)
    repository = StubExportRepository(documents={})
    app.dependency_overrides.clear()

    def override_repository() -> StubExportRepository:
        return repository

    def override_export_output_root() -> Path:
        return tmp_path

    app.dependency_overrides[get_export_repository] = override_repository
    app.dependency_overrides[get_export_output_root] = override_export_output_root
    try:
        response = client.post('/export/missing-project/markdown')

        assert response.status_code == 404
        assert response.json() == {'detail': 'book document not found'}
    finally:
        app.dependency_overrides.clear()


def test_export_route_lists_supported_options_for_project() -> None:
    client = TestClient(app)
    repository = StubExportRepository(documents={'book-1': build_document()})
    app.dependency_overrides.clear()

    def override_repository() -> StubExportRepository:
        return repository

    app.dependency_overrides[get_export_repository] = override_repository
    try:
        response = client.get('/export/book-1/options')

        assert response.status_code == 200
        assert response.json() == {
            'options': [
                {'id': 'markdown', 'label': 'Export Markdown'},
                {'id': 'html', 'label': 'Export HTML'},
                {'id': 'epub', 'label': 'Export EPUB'},
                {'id': 'jojo-rag', 'label': 'Export jojo-rag Package'},
            ]
        }
    finally:
        app.dependency_overrides.clear()
