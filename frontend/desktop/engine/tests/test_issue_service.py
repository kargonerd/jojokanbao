from pathlib import Path
import sys

from fastapi.testclient import TestClient

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from jojo_press.api.proofread import get_proofread_repository, get_proofread_task_service
from jojo_press.app import app
from jojo_press.models.book import BookBlock, BookDocument, BookMeta, ImportMeta
from jojo_press.services.issue_service import IssueService
from jojo_press.services.mineru_service import RecognitionTask, RecognitionTaskNotFoundError


class StubProofreadRepository:
    def __init__(self, document: BookDocument) -> None:
        self.document = document

    def load_book_document(self, project_id: str) -> BookDocument:
        return self.document

    def save_book_document(self, project_id: str, document: BookDocument) -> BookDocument:
        self.document = document
        return document


class StubRecognitionTaskService:
    def __init__(self, task: RecognitionTask | None = None) -> None:
        self.task = task

    def resume_task(self, project_id: str) -> RecognitionTask:
        if self.task is None:
            raise RecognitionTaskNotFoundError(project_id)
        return self.task


def build_document(*, heading_text: str = '第一章 开始') -> BookDocument:
    return BookDocument(
        book=BookMeta(
            id='book-1',
            title='示例书',
            language='chinese_cht',
            status='draft',
        ),
        toc=[],
        blocks=[
            BookBlock(id='heading-1', type='heading', text=heading_text, source_page=1),
            BookBlock(id='body-1', type='paragraph', text='第一段正文', source_page=1),
            BookBlock(id='page-number-1', type='page_number', text='1', source_page=1),
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


def test_issue_service_skips_heading_with_positive_level_information() -> None:
    issues = IssueService().build(build_document(heading_text='第一章 开始'))

    assert issues == []


def test_issue_service_builds_issue_for_heading_without_level_information() -> None:
    issues = IssueService().build(build_document(heading_text='开始'))

    assert len(issues) == 1
    assert issues[0].model_dump() == {
        'id': 'issue-heading-1',
        'kind': 'heading_level_review',
        'severity': 'medium',
        'block_id': 'heading-1',
        'message': '这个标题可能缺少章节层级，请核对。',
    }


def test_proofread_api_lists_only_unresolved_heading_level_issues() -> None:
    client = TestClient(app)
    repository = StubProofreadRepository(build_document(heading_text='开始'))
    app.dependency_overrides.clear()

    def override_repository() -> StubProofreadRepository:
        return repository

    app.dependency_overrides[get_proofread_repository] = override_repository
    try:
        response = client.get('/proofread/book-1/issues')

        assert response.status_code == 200
        assert response.json() == {
            'items': [
                {
                    'id': 'issue-heading-1',
                    'kind': 'heading_level_review',
                    'severity': 'medium',
                    'block_id': 'heading-1',
                    'message': '这个标题可能缺少章节层级，请核对。',
                }
            ]
        }
    finally:
        app.dependency_overrides.clear()


def test_proofread_api_returns_pending_workspace_when_recognition_is_not_finished() -> None:
    client = TestClient(app)
    repository = StubProofreadRepository(build_document(heading_text='革命造反年代——上海文革运动史稿 I (1)'))
    task_service = StubRecognitionTaskService(
        RecognitionTask(
            project_id='book-1',
            status='queued',
            engine='pipeline',
            language='chinese_cht',
            is_ocr=True,
            pdf_path='input/source.pdf',
        )
    )
    app.dependency_overrides.clear()

    def override_repository() -> StubProofreadRepository:
        return repository

    def override_task_service() -> StubRecognitionTaskService:
        return task_service

    app.dependency_overrides[get_proofread_repository] = override_repository
    app.dependency_overrides[get_proofread_task_service] = override_task_service
    try:
        response = client.get('/proofread/book-1/workspace')

        assert response.status_code == 200
        assert response.json() == {
            'status': 'recognition_pending',
            'notice': 'MinerU 识别还没完成，当前还没有可校对文字。请先完成识别，再进入文字校对。',
            'issues': [],
            'preview': {
                'page': 1,
                'documentUrl': '/proofread/book-1/source-pdf',
            },
            'block': None,
            'toc': [],
        }
    finally:
        app.dependency_overrides.clear()


def test_proofread_api_serves_the_source_pdf() -> None:
    client = TestClient(app)
    pdf_path = Path(__file__).resolve().parent / 'fixtures-source.pdf'
    pdf_path.write_bytes(b'%PDF-1.4\n%stub pdf\n')
    document = build_document().model_copy(
        update={
            'import_meta': build_document().import_meta.model_copy(update={'source_pdf': pdf_path.as_uri()})
        }
    )
    repository = StubProofreadRepository(document)
    app.dependency_overrides.clear()

    def override_repository() -> StubProofreadRepository:
        return repository

    app.dependency_overrides[get_proofread_repository] = override_repository
    try:
        response = client.get('/proofread/book-1/source-pdf', headers={'Origin': 'http://127.0.0.1:5180'})

        assert response.status_code == 200
        assert response.content.startswith(b'%PDF-1.4')
        assert response.headers['content-type'] == 'application/pdf'
        assert response.headers['content-disposition'] == 'inline; filename="fixtures-source.pdf"'
        assert response.headers['access-control-allow-origin'] == 'http://127.0.0.1:5180'
        assert response.headers['access-control-expose-headers'] == 'Content-Length, Content-Range, Accept-Ranges'
        assert response.headers['cache-control'] == 'no-store'

        no_origin_response = client.get('/proofread/book-1/source-pdf')

        assert no_origin_response.status_code == 200
        assert no_origin_response.headers['access-control-allow-origin'] == '*'
        assert no_origin_response.headers['cache-control'] == 'no-store'
    finally:
        pdf_path.unlink(missing_ok=True)
        app.dependency_overrides.clear()


def test_proofread_api_updates_a_block_text() -> None:
    client = TestClient(app)
    repository = StubProofreadRepository(build_document())
    app.dependency_overrides.clear()

    def override_repository() -> StubProofreadRepository:
        return repository

    app.dependency_overrides[get_proofread_repository] = override_repository
    try:
        response = client.post('/proofread/book-1/blocks/body-1', json={'text': '已修正文段'})

        assert response.status_code == 200
        assert response.json() == {
            'item': {
                'id': 'body-1',
                'type': 'paragraph',
                'text': '已修正文段',
                'source_page': 1,
            }
        }
        assert repository.document.blocks[1].text == '已修正文段'
    finally:
        app.dependency_overrides.clear()


def test_proofread_api_returns_workspace_payload() -> None:
    client = TestClient(app)
    repository = StubProofreadRepository(build_document(heading_text='开始'))
    task_service = StubRecognitionTaskService(
        RecognitionTask(
            project_id='book-1',
            status='completed',
            engine='pipeline',
            language='chinese_cht',
            is_ocr=True,
            pdf_path='input/source.pdf',
        )
    )
    app.dependency_overrides.clear()

    def override_repository() -> StubProofreadRepository:
        return repository

    def override_task_service() -> StubRecognitionTaskService:
        return task_service

    app.dependency_overrides[get_proofread_repository] = override_repository
    app.dependency_overrides[get_proofread_task_service] = override_task_service
    try:
        response = client.get('/proofread/book-1/workspace')

        assert response.status_code == 200
        assert response.json() == {
            'status': 'ready',
            'notice': None,
            'issues': [
                {
                    'id': 'issue-heading-1',
                    'kind': 'heading_level_review',
                    'severity': 'medium',
                    'block_id': 'heading-1',
                    'message': '这个标题可能缺少章节层级，请核对。',
                }
            ],
            'preview': {
                'page': 1,
                'documentUrl': '/proofread/book-1/source-pdf',
                'pages': [],
                'totalPages': 0,
            },
            'block': {
                'id': 'heading-1',
                'text': '开始',
            },
            'toc': [
                {
                    'id': 'heading-1',
                    'label': '开始',
                }
            ],
        }
    finally:
        app.dependency_overrides.clear()
