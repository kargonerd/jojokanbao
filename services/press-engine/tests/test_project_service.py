from io import BytesIO
import json
import os
from pathlib import Path
import sys
import threading
import time
import zipfile

import pytest
import requests
from fastapi.testclient import TestClient
from pydantic import ValidationError

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from jojo_press.api.export import get_export_repository
from jojo_press.api.projects import get_project_document_service, get_project_service
from jojo_press.api.proofread import get_proofread_repository
from jojo_press.api.quality import QualityRepository, get_quality_repository
from jojo_press.api.tasks import get_mineru_gateway, get_mineru_service
from jojo_press.app import app
from jojo_press.models.project import CreateProjectCommand, Project
from jojo_press.repositories.project_repository import ProjectRepository
from jojo_press.services.mineru_service import HttpMineruGateway, MineruService, RecognitionTask, RecognitionTaskNotFoundError
from jojo_press.services.project_document_service import ProjectDocumentService
from jojo_press.services.project_service import ProjectService


def test_create_project_creates_expected_directories_and_sets_recognition_stage(tmp_path: Path) -> None:
    service = ProjectService(projects_root=tmp_path)

    project = service.create_project(name='demo-project')

    project_root = tmp_path / project.project_id
    assert project.name == 'demo-project'
    assert project.current_stage == 'recognition'
    assert project_root.is_dir()
    assert (project_root / 'input').is_dir()
    assert (project_root / 'output').is_dir()
    assert (project_root / 'artifacts').is_dir()


def test_create_project_rejects_whitespace_only_name(tmp_path: Path) -> None:
    service = ProjectService(projects_root=tmp_path)

    with pytest.raises(ValidationError):
        service.create_project(name='   ')


def test_repository_create_rejects_existing_project_directory(tmp_path: Path) -> None:
    repository = ProjectRepository(projects_root=tmp_path)
    project = Project(project_id='duplicate-project', name='demo-project')
    existing_root = tmp_path / project.project_id
    existing_root.mkdir(parents=True)

    with pytest.raises(FileExistsError):
        repository.create(project)


def test_create_project_route_rejects_duplicate_project_creation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ProjectService(projects_root=tmp_path)
    client = TestClient(app)
    app.dependency_overrides.clear()

    def override_project_service() -> ProjectService:
        return service

    app.dependency_overrides[get_project_service] = override_project_service
    monkeypatch.setattr(
        CreateProjectCommand,
        'to_project',
        lambda self: Project(project_id='duplicate-project', name=self.name),
    )
    try:
        first_response = client.post('/projects', json={'name': 'demo-project'})
        second_response = client.post('/projects', json={'name': 'demo-project'})

        assert first_response.status_code == 201
        assert second_response.status_code == 409
        assert second_response.json() == {'detail': 'project already exists'}
    finally:
        app.dependency_overrides.clear()



def test_created_project_appears_in_project_routes_after_recognition_finishes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = TestClient(app)
    project_service = ProjectService(projects_root=tmp_path)
    mineru_service = MineruService(base_dir=tmp_path, gateway=BlockingStubMineruGateway())
    document_service = ProjectDocumentService(projects_root=tmp_path)
    quality_repository = QualityRepository(projects_root=tmp_path)
    app.dependency_overrides.clear()

    def override_project_service() -> ProjectService:
        return project_service

    def override_mineru_service() -> MineruService:
        return mineru_service

    def override_project_document_service() -> ProjectDocumentService:
        return document_service

    def override_proofread_repository() -> ProjectDocumentService:
        return document_service

    def override_quality_repository() -> QualityRepository:
        return quality_repository

    def override_export_repository() -> ProjectDocumentService:
        return document_service

    app.dependency_overrides[get_project_service] = override_project_service
    app.dependency_overrides[get_mineru_service] = override_mineru_service
    app.dependency_overrides[get_project_document_service] = override_project_document_service
    app.dependency_overrides[get_proofread_repository] = override_proofread_repository
    app.dependency_overrides[get_quality_repository] = override_quality_repository
    app.dependency_overrides[get_export_repository] = override_export_repository
    monkeypatch.setattr(
        CreateProjectCommand,
        'to_project',
        lambda self: Project(project_id='generated-project', name=self.name),
    )

    try:
        create_response = client.post('/projects', json={'name': '革命造反年代'})
        recognition_response = client.post(
            '/tasks/generated-project/recognition/start',
            json={'pdf_path': 'file:///C:/books/demo.pdf'},
        )
        task_state_path = tmp_path / 'generated-project' / 'state' / 'recognition-task.json'
        task_state_path.parent.mkdir(parents=True, exist_ok=True)
        task_state_path.write_text(
            json.dumps(
                {
                    'project_id': 'generated-project',
                    'status': 'completed',
                    'engine': 'pipeline',
                    'language': 'chinese_cht',
                    'is_ocr': True,
                    'pdf_path': 'file:///C:/books/demo.pdf',
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding='utf-8',
        )
        document_path = tmp_path / 'generated-project' / 'output' / 'book-document.json'
        document_path.write_text(
            json.dumps(
                {
                    'book': {
                        'id': 'book-generated',
                        'title': '革命造反年代',
                        'language': 'chinese_cht',
                        'status': 'draft',
                        'subtitle': '上海文革运动史稿',
                        'authors': ['金大陆']
                    },
                    'toc': [],
                    'blocks': [
                        {
                            'id': 'heading-1',
                            'type': 'heading',
                            'text': '革命造反年代',
                            'source_page': 1
                        }
                    ],
                    'footnotes': [],
                    'assets': [],
                    'import_meta': {
                        'source_pdf': 'file:///C:/books/demo.pdf',
                        'mineru_job_id': '',
                        'model_version': 'pipeline',
                        'language': 'chinese_cht',
                        'is_ocr': True
                    }
                },
                ensure_ascii=False,
            ),
            encoding='utf-8',
        )
        list_response = client.get('/projects')
        overview_response = client.get('/projects/generated-project')
        metadata_response = client.get('/projects/generated-project/metadata')
        proofread_response = client.get('/proofread/generated-project/workspace')
        quality_response = client.get('/quality/generated-project')
        export_response = client.get('/export/generated-project/options')

        assert create_response.status_code == 201
        assert recognition_response.status_code == 200
        assert list_response.status_code == 200
        assert {
            'id': 'generated-project',
            'title': '革命造反年代',
            'currentStage': 'Metadata confirmation',
            'createdAt': None,
            'path': 'file:///C:/books/demo.pdf',
            'coverUrl': None,
        } in list_response.json()
        assert overview_response.status_code == 200
        assert overview_response.json() == {
            'id': 'generated-project',
            'title': '革命造反年代',
            'currentStage': 'Metadata confirmation',
            'createdAt': None,
            'path': 'file:///C:/books/demo.pdf',
            'coverUrl': None,
        }
        assert metadata_response.status_code == 200
        assert metadata_response.json() == {
            'id': 'generated-project',
            'title': '革命造反年代',
            'subtitle': '上海文革运动史稿',
            'authors': ['金大陆'],
            'language': 'chinese_cht',
            'coverAssetId': None,
        }
        assert proofread_response.status_code == 200
        assert proofread_response.json()['block']['text'] == '革命造反年代'
        assert quality_response.status_code == 200
        assert quality_response.json() == {'status': 'passed', 'checks': []}
        assert export_response.status_code == 200
        assert export_response.json() == {
            'options': [
                {'id': 'markdown', 'label': 'Export Markdown'},
                {'id': 'html', 'label': 'Export HTML'},
                {'id': 'epub', 'label': 'Export EPUB'},
                {'id': 'jojo-rag', 'label': 'Export jojo-rag Package'},
            ]
        }
    finally:
        app.dependency_overrides.clear()


def test_start_task_writes_queued_recognition_task_state_before_background_processing(tmp_path: Path) -> None:
    service = MineruService(base_dir=tmp_path, gateway=BlockingStubMineruGateway())
    pdf_path = tmp_path / 'demo.pdf'
    pdf_path.write_bytes(b'%PDF-1.7\n')

    task = service.start_task(project_id='book_demo', pdf_path=str(pdf_path))

    assert task.status == 'queued'
    assert (tmp_path / 'book_demo' / 'state' / 'recognition-task.json').exists()


def test_start_task_completes_in_background_and_persists_finished_state(tmp_path: Path) -> None:
    release_event = threading.Event()
    service = MineruService(base_dir=tmp_path, gateway=BlockingStubMineruGateway(release_event=release_event))
    pdf_path = tmp_path / 'demo.pdf'
    pdf_path.write_bytes(b'%PDF-1.7\n')

    task = service.start_task(project_id='book_demo', pdf_path=str(pdf_path))

    assert task.status == 'queued'

    wait_for_task_status(service, 'book_demo', 'processing')

    release_event.set()

    current_task = wait_for_task_status(service, 'book_demo', 'completed')

    assert (tmp_path / 'book_demo' / 'output' / 'book-document.json').exists()


def test_start_recognition_route_returns_queued_task_payload(tmp_path: Path) -> None:
    client = TestClient(app)
    service = MineruService(base_dir=tmp_path, gateway=BlockingStubMineruGateway())
    app.dependency_overrides.clear()
    pdf_path = tmp_path / 'demo.pdf'
    pdf_path.write_bytes(b'%PDF-1.7\n')

    def override_mineru_service() -> MineruService:
        return service

    app.dependency_overrides[get_mineru_service] = override_mineru_service
    try:
        response = client.post(
            '/tasks/book_demo/recognition/start',
            json={'pdf_path': str(pdf_path)},
        )

        assert response.status_code == 200
        assert response.json() == {
            'project_id': 'book_demo',
            'status': 'queued',
            'engine': 'pipeline',
            'language': 'chinese_cht',
            'is_ocr': True,
            'pdf_path': str(pdf_path),
        }
    finally:
        app.dependency_overrides.clear()



def test_start_recognition_route_rejects_unconfigured_gateway_instead_of_writing_placeholder_document(tmp_path: Path) -> None:
    client = TestClient(app)
    service = MineruService(base_dir=tmp_path)
    document_service = ProjectDocumentService(projects_root=tmp_path)
    app.dependency_overrides.clear()
    pdf_uri = 'file:///C:/books/%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf'

    def override_mineru_service() -> MineruService:
        return service

    def override_project_document_service() -> ProjectDocumentService:
        return document_service

    app.dependency_overrides[get_mineru_service] = override_mineru_service
    app.dependency_overrides[get_project_document_service] = override_project_document_service
    try:
        response = client.post(
            '/tasks/generated-project/recognition/start',
            json={'pdf_path': pdf_uri},
        )
        metadata_response = client.get('/projects/generated-project/metadata')

        assert response.status_code == 503
        assert response.json() == {'detail': 'mineru gateway is not configured'}
        assert metadata_response.status_code == 404
        assert not (tmp_path / 'generated-project' / 'output' / 'book-document.json').exists()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize('route_path', [
    '/tasks/book_demo/recognition/retry',
    '/tasks/book_demo/recognition/resume',
])
def test_recognition_routes_return_not_found_when_task_state_is_missing(
    tmp_path: Path,
    route_path: str,
) -> None:
    client = TestClient(app)
    service = MineruService(base_dir=tmp_path)
    app.dependency_overrides.clear()

    def override_mineru_service() -> MineruService:
        return service

    app.dependency_overrides[get_mineru_service] = override_mineru_service
    try:
        response = client.post(route_path)

        assert response.status_code == 404
        assert response.json() == {'detail': 'recognition task state not found'}
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize('route_path', [
    '/tasks/book_demo/recognition/retry',
    '/tasks/book_demo/recognition/resume',
])
def test_recognition_routes_return_conflict_when_task_state_is_corrupted(
    tmp_path: Path,
    route_path: str,
) -> None:
    client = TestClient(app)
    service = MineruService(base_dir=tmp_path)
    state_path = tmp_path / 'book_demo' / 'state' / 'recognition-task.json'
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text('{"project_id": "book_demo",', encoding='utf-8')
    app.dependency_overrides.clear()

    def override_mineru_service() -> MineruService:
        return service

    app.dependency_overrides[get_mineru_service] = override_mineru_service
    try:
        response = client.post(route_path)

        assert response.status_code == 409
        assert response.json() == {'detail': 'recognition task state is corrupted'}
    finally:
        app.dependency_overrides.clear()


def test_upload_source_pdf_route_stores_browser_uploaded_pdf_and_returns_file_uri(tmp_path: Path) -> None:
    client = TestClient(app)
    project_service = ProjectService(projects_root=tmp_path)
    app.dependency_overrides.clear()

    def override_project_service() -> ProjectService:
        return project_service

    app.dependency_overrides[get_project_service] = override_project_service
    try:
        created_project = client.post('/projects', json={'name': '革命造反年代'}).json()
        response = client.post(
            f"/projects/{created_project['project_id']}/source-pdf?filename=%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf",
            content=b'%PDF-1.7\n',
            headers={'Content-Type': 'application/pdf'},
        )

        assert response.status_code == 200
        uploaded_path = tmp_path / created_project['project_id'] / 'input' / '革命造反年代.pdf'
        assert uploaded_path.read_bytes() == b'%PDF-1.7\n'
        assert response.json() == {'pdf_path': uploaded_path.as_uri()}
    finally:
        app.dependency_overrides.clear()



def test_start_recognition_route_accepts_real_pdf_file_uri_without_path_mangling(
    tmp_path: Path,
) -> None:
    client = TestClient(app)
    pdf_file = tmp_path / '革命造反年代——上海文革运动史稿 I (1).pdf'
    pdf_file.write_bytes(b'%PDF-1.7\n')
    service = MineruService(base_dir=tmp_path, gateway=StubMineruGateway())
    app.dependency_overrides.clear()
    real_pdf_uri = pdf_file.as_uri()

    def override_mineru_service() -> MineruService:
        return service

    app.dependency_overrides[get_mineru_service] = override_mineru_service
    try:
        response = client.post(
            '/tasks/book_demo/recognition/start',
            json={'pdf_path': real_pdf_uri},
        )

        assert response.status_code == 200
        assert response.json()['pdf_path'] == real_pdf_uri
        assert wait_for_task_status(service, 'book_demo', 'completed').pdf_path == real_pdf_uri
    finally:
        app.dependency_overrides.clear()


def test_start_recognition_route_requires_pdf_path() -> None:
    client = TestClient(app)

    response = client.post('/tasks/book_demo/recognition/start', json={})

    assert response.status_code == 422


def test_start_recognition_route_rejects_whitespace_only_pdf_path() -> None:
    client = TestClient(app)

    response = client.post('/tasks/book_demo/recognition/start', json={'pdf_path': '   '})

    assert response.status_code == 422
    assert response.json()['detail'][0]['msg'] == 'Value error, pdf_path must not be blank'


def test_start_recognition_route_returns_503_when_mineru_is_not_configured() -> None:
    client = TestClient(app)
    app.dependency_overrides.clear()

    def override_mineru_service() -> MineruService:
        return MineruService(base_dir=Path('test-projects'), gateway=None)

    app.dependency_overrides[get_mineru_service] = override_mineru_service
    try:
        response = client.post('/tasks/book_demo/recognition/start', json={'pdf_path': 'C:/books/demo.pdf'})

        assert response.status_code == 503
        assert response.json() == {'detail': 'mineru gateway is not configured'}
    finally:
        app.dependency_overrides.clear()


class StubMineruGateway:
    def __init__(self, *, zip_bytes: bytes | None = None) -> None:
        self.submitted_pdf_path: Path | None = None
        self.submitted_options: dict[str, object] | None = None
        self.submitted_pdf_paths: list[Path] = []
        self.waited_task_id: str | None = None
        self.downloaded_url: str | None = None
        self.downloaded_output_path: Path | None = None
        self.zip_bytes = zip_bytes or self._build_zip_bytes()

    def _build_zip_bytes(self) -> bytes:
        buffer = BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr(
                'content_list.json',
                '[{"id":"heading-1","type":"heading","text":"真实标题","page":1}]',
            )
            archive.writestr(
                'layout.json',
                '{"pages":[{"page_num":1,"blocks":[{"id":"heading-1","type":"heading","text":"真实标题","bbox":{"x":10,"y":12,"width":60,"height":8},"level":1}]}]}',
            )
        return buffer.getvalue()

    def submit_task(self, pdf_path: Path, options: dict[str, object]) -> str:
        self.submitted_pdf_path = pdf_path
        self.submitted_pdf_paths.append(pdf_path)
        self.submitted_options = options
        return 'job-123'

    def wait_for_result(self, task_id: str) -> str:
        self.waited_task_id = task_id
        return 'https://mineru.example/result.zip'

    def download_result(self, url: str, output_path: Path) -> None:
        self.downloaded_url = url
        self.downloaded_output_path = output_path
        output_path.write_bytes(self.zip_bytes)


class PrefixedContentListMineruGateway(StubMineruGateway):
    def _build_zip_bytes(self) -> bytes:
        buffer = BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr(
                '68ec14b9-7341-47f2-8cf9-355d24de630e_content_list.json',
                '[{"id":"heading-1","type":"heading","text":"真实标题","page":1}]',
            )
            archive.writestr(
                'layout.json',
                '{"pages":[{"page_num":1,"blocks":[{"id":"heading-1","type":"heading","text":"真实标题","bbox":{"x":10,"y":12,"width":60,"height":8},"level":1}]}]}',
            )
            archive.writestr('full.md', '# 真实标题')
        return buffer.getvalue()


class BlockingStubMineruGateway(StubMineruGateway):
    def __init__(self, *, release_event: threading.Event | None = None) -> None:
        super().__init__()
        self.release_event = release_event or threading.Event()

    def wait_for_result(self, task_id: str) -> str:
        self.waited_task_id = task_id
        self.release_event.wait(timeout=5)
        return 'https://mineru.example/result.zip'


def wait_for_task_status(service: MineruService, project_id: str, expected_status: str, *, timeout: float = 2) -> RecognitionTask:
    deadline = time.time() + timeout
    last_task: RecognitionTask | None = None
    while time.time() < deadline:
        try:
            current_task = service.resume_task(project_id)
        except RecognitionTaskNotFoundError:
            time.sleep(0.01)
            continue
        last_task = current_task
        if current_task.status == expected_status:
            return current_task
        time.sleep(0.01)
    raise AssertionError(
        f'expected recognition task {project_id} to reach {expected_status}, last status was {last_task.status if last_task else "missing"}'
    )


class PageLimitMineruGateway(StubMineruGateway):
    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    def wait_for_result(self, task_id: str) -> str:
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError('MinerU task failed: failed, payload={"err_msg": "number of pages exceeds limit, please split the file and try again"}')
        return super().wait_for_result(task_id)


@pytest.mark.parametrize(
    ('raw_path', 'expected_name'),
    [
        ('sample.pdf', 'sample.pdf'),
        ('file:///C:/Users/luoxixi/Downloads/demo%20book.pdf', 'demo book.pdf'),
    ],
)
def test_start_task_resolves_local_pdf_path_before_submitting_to_gateway(
    tmp_path: Path,
    raw_path: str,
    expected_name: str,
) -> None:
    gateway = StubMineruGateway()
    service = MineruService(base_dir=tmp_path, gateway=gateway)
    pdf_path = tmp_path / expected_name
    pdf_path.write_bytes(b'%PDF-1.7\n')
    resolved_raw_path = raw_path if raw_path.startswith('file:///') else str(pdf_path)
    if raw_path.startswith('file:///'):
        resolved_raw_path = pdf_path.as_uri()

    task = service.start_task(project_id='book_demo', pdf_path=resolved_raw_path)
    completed_task = wait_for_task_status(service, 'book_demo', 'completed')

    assert task.status == 'queued'
    assert completed_task.pdf_path == resolved_raw_path
    assert gateway.submitted_pdf_path == pdf_path.resolve()
    assert gateway.submitted_options == {
        'language': 'chinese_cht',
        'is_ocr': True,
        'engine': 'pipeline',
    }
    assert gateway.waited_task_id == 'job-123'
    assert gateway.downloaded_url == 'https://mineru.example/result.zip'


def test_start_task_persists_raw_result_zip_under_project_artifacts(tmp_path: Path) -> None:
    gateway = StubMineruGateway()
    service = MineruService(base_dir=tmp_path, gateway=gateway)
    pdf_path = tmp_path / 'sample.pdf'
    pdf_path.write_bytes(b'%PDF-1.7\n')

    task = service.start_task(project_id='book_demo', pdf_path=str(pdf_path))
    wait_for_task_status(service, 'book_demo', 'completed')

    raw_zip_path = tmp_path / 'book_demo' / 'artifacts' / 'mineru' / 'raw-result.zip'
    assert task.status == 'queued'
    assert raw_zip_path.exists()
    assert raw_zip_path.read_bytes() == gateway.zip_bytes
    assert gateway.downloaded_output_path == raw_zip_path



def test_start_task_extracts_content_list_json_from_raw_result_zip(tmp_path: Path) -> None:
    gateway = StubMineruGateway()
    service = MineruService(base_dir=tmp_path, gateway=gateway)
    pdf_path = tmp_path / 'sample.pdf'
    pdf_path.write_bytes(b'%PDF-1.7\n')

    service.start_task(project_id='book_demo', pdf_path=str(pdf_path))
    wait_for_task_status(service, 'book_demo', 'completed')

    content_list_path = tmp_path / 'book_demo' / 'artifacts' / 'mineru' / 'content_list.json'
    assert content_list_path.exists()
    assert content_list_path.read_text(encoding='utf-8') == '[{"id":"heading-1","type":"heading","text":"真实标题","page":1}]'



def test_start_task_extracts_prefixed_content_list_json_from_realistic_raw_result_zip(tmp_path: Path) -> None:
    gateway = PrefixedContentListMineruGateway()
    service = MineruService(base_dir=tmp_path, gateway=gateway)
    pdf_path = tmp_path / 'sample.pdf'
    pdf_path.write_bytes(b'%PDF-1.7\n')

    service.start_task(project_id='book_demo', pdf_path=str(pdf_path))
    wait_for_task_status(service, 'book_demo', 'completed')

    content_list_path = tmp_path / 'book_demo' / 'artifacts' / 'mineru' / 'content_list.json'
    assert content_list_path.exists()
    assert content_list_path.read_text(encoding='utf-8') == '[{"id":"heading-1","type":"heading","text":"真实标题","page":1}]'



def test_start_task_writes_normalized_document_from_extracted_content_list(tmp_path: Path) -> None:
    gateway = StubMineruGateway()
    service = MineruService(base_dir=tmp_path, gateway=gateway)
    pdf_path = tmp_path / 'sample.pdf'
    pdf_path.write_bytes(b'%PDF-1.7\n')

    service.start_task(project_id='book_demo', pdf_path=str(pdf_path))
    wait_for_task_status(service, 'book_demo', 'completed')

    document_path = tmp_path / 'book_demo' / 'output' / 'book-document.json'
    assert document_path.exists()
    assert '真实标题' in document_path.read_text(encoding='utf-8')
    assert 'sample.pdf' in document_path.read_text(encoding='utf-8')



def test_start_task_retries_with_split_pdf_when_mineru_reports_page_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = PageLimitMineruGateway()
    service = MineruService(base_dir=tmp_path, gateway=gateway)
    pdf_path = tmp_path / 'sample.pdf'
    pdf_path.write_bytes(b'%PDF-1.7\n')
    split_part_path = tmp_path / 'split-part-01.pdf'
    split_part_path.write_bytes(b'%PDF-1.7 split\n')
    monkeypatch.setattr(service, '_split_pdf_for_mineru', lambda path: [split_part_path])

    task = service.start_task(project_id='book_demo', pdf_path=str(pdf_path))
    wait_for_task_status(service, 'book_demo', 'completed')

    assert task.status == 'queued'
    assert gateway.submitted_pdf_paths == [pdf_path.resolve(), split_part_path]



def test_split_pdf_for_mineru_uses_smaller_chunk_size_than_mineru_limit(tmp_path: Path) -> None:
    service = MineruService(base_dir=tmp_path)
    pdf_path = tmp_path / 'sample.pdf'
    writer = __import__('PyPDF2').PdfWriter()
    for _ in range(827):
        writer.add_blank_page(width=72, height=72)
    with pdf_path.open('wb') as handle:
        writer.write(handle)

    split_paths = service._split_pdf_for_mineru(pdf_path)

    assert [len(__import__('PyPDF2').PdfReader(str(path)).pages) for path in split_paths] == [300, 300, 227]



def test_start_task_raises_original_error_when_page_limit_split_returns_no_parts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = PageLimitMineruGateway()
    service = MineruService(base_dir=tmp_path, gateway=gateway)
    pdf_path = tmp_path / 'sample.pdf'
    pdf_path.write_bytes(b'%PDF-1.7\n')
    monkeypatch.setattr(service, '_split_pdf_for_mineru', lambda path: [])

    task = service.start_task(project_id='book_demo', pdf_path=str(pdf_path))
    failed_task = wait_for_task_status(service, 'book_demo', 'failed')

    assert task.status == 'queued'
    assert failed_task.pdf_path == str(pdf_path)
    assert gateway.submitted_pdf_paths == [pdf_path.resolve()]



def test_get_mineru_gateway_returns_none_without_env_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('MINERU_API_BASE', raising=False)
    monkeypatch.delenv('MINERU_API_TOKEN', raising=False)

    assert get_mineru_gateway() is None



def test_get_mineru_gateway_returns_http_gateway_when_env_configuration_exists(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('MINERU_API_BASE', 'https://mineru.example/api')
    monkeypatch.setenv('MINERU_API_TOKEN', 'secret-token')

    gateway = get_mineru_gateway()

    assert gateway is not None
    assert gateway.api_base == 'https://mineru.example/api'
    assert gateway.token == 'secret-token'


class StubResponse:
    def __init__(self, *, status_code: int, json_data: dict | None = None, content: bytes = b'', text: str = '') -> None:
        self.status_code = status_code
        self._json_data = json_data
        self.content = content
        self.text = text or json.dumps(json_data or {}, ensure_ascii=False)

    def json(self) -> dict:
        if self._json_data is None:
            raise ValueError('no json payload')
        return self._json_data

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f'HTTP {self.status_code}: {self.text}')



def test_http_mineru_gateway_uploads_pdf_via_batch_file_urls_before_polling_results(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    pdf_path = tmp_path / 'sample.pdf'
    pdf_path.write_bytes(b'%PDF-1.7\n')
    post_calls: list[dict[str, object]] = []
    put_calls: list[dict[str, object]] = []

    def fake_post(url: str, *, headers: dict[str, str], json: dict[str, object], timeout: int) -> StubResponse:
        post_calls.append({'url': url, 'headers': headers, 'json': json, 'timeout': timeout})
        return StubResponse(
            status_code=200,
            json_data={
                'code': 0,
                'data': {
                    'batch_id': 'batch-123',
                    'file_urls': ['https://upload.example/sample.pdf'],
                },
            },
        )

    def fake_put(url: str, *, data: bytes, headers: dict[str, str], timeout: int) -> StubResponse:
        put_calls.append({'url': url, 'data': data, 'headers': headers, 'timeout': timeout})
        return StubResponse(status_code=200)

    monkeypatch.setattr('jojo_press.services.mineru_service.requests.post', fake_post)
    monkeypatch.setattr('jojo_press.services.mineru_service.requests.put', fake_put)
    gateway = HttpMineruGateway(api_base='https://mineru.net/api/v4', token='secret-token')

    batch_id = gateway.submit_task(pdf_path, {'language': 'chinese_cht', 'is_ocr': True, 'engine': 'pipeline'})

    assert batch_id == 'batch-123'
    assert post_calls == [
        {
            'url': 'https://mineru.net/api/v4/file-urls/batch',
            'headers': {
                'Authorization': 'Bearer secret-token',
                'Content-Type': 'application/json',
                'Accept': '*/*',
            },
            'json': {
                'files': [{'name': 'sample.pdf', 'data_id': 'sample.pdf'}],
                'language': 'chinese_cht',
                'is_ocr': True,
                'engine': 'pipeline',
            },
            'timeout': 45,
        },
    ]
    assert put_calls == [
        {
            'url': 'https://upload.example/sample.pdf',
            'data': b'%PDF-1.7\n',
            'headers': {},
            'timeout': 180,
        },
    ]



def test_http_mineru_gateway_polls_batch_results_until_full_zip_url_is_available(monkeypatch: pytest.MonkeyPatch) -> None:
    responses = iter([
        StubResponse(status_code=200, json_data={'data': {'extract_result': [{'state': 'running'}]}}),
        StubResponse(
            status_code=200,
            json_data={
                'data': {
                    'extract_result': [
                        {'state': 'done', 'full_zip_url': 'https://mineru.example/result.zip'},
                    ],
                },
            },
        ),
    ])
    calls: list[dict[str, object]] = []

    def fake_get(url: str, *, headers: dict[str, str], timeout: int) -> StubResponse:
        calls.append({'url': url, 'headers': headers, 'timeout': timeout})
        return next(responses)

    monkeypatch.setattr('jojo_press.services.mineru_service.requests.get', fake_get)
    monkeypatch.setattr('jojo_press.services.mineru_service.time.sleep', lambda _: None)
    gateway = HttpMineruGateway(api_base='https://mineru.net/api/v4', token='secret-token')

    result_url = gateway.wait_for_result('batch-123')

    assert result_url == 'https://mineru.example/result.zip'
    assert calls == [
        {
            'url': 'https://mineru.net/api/v4/extract-results/batch/batch-123',
            'headers': {'Authorization': 'Bearer secret-token'},
            'timeout': 30,
        },
        {
            'url': 'https://mineru.net/api/v4/extract-results/batch/batch-123',
            'headers': {'Authorization': 'Bearer secret-token'},
            'timeout': 30,
        },
    ]



def test_http_mineru_gateway_keeps_polling_beyond_old_timeout_window(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []
    counter = {'count': 0}

    def fake_get(url: str, *, headers: dict[str, str], timeout: int) -> StubResponse:
        counter['count'] += 1
        calls.append({'url': url, 'headers': headers, 'timeout': timeout})
        if counter['count'] <= 130:
            return StubResponse(status_code=200, json_data={'data': {'extract_result': [{'state': 'running'}]}})
        return StubResponse(
            status_code=200,
            json_data={'data': {'extract_result': [{'state': 'done', 'full_zip_url': 'https://mineru.example/result.zip'}]}},
        )

    monkeypatch.setattr('jojo_press.services.mineru_service.requests.get', fake_get)
    monkeypatch.setattr('jojo_press.services.mineru_service.time.sleep', lambda _: None)
    gateway = HttpMineruGateway(api_base='https://mineru.net/api/v4', token='secret-token')

    result_url = gateway.wait_for_result('batch-123')

    assert result_url == 'https://mineru.example/result.zip'
    assert len(calls) == 131



def test_http_mineru_gateway_downloads_result_zip_to_output_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    output_path = tmp_path / 'result.zip'

    def fake_get(url: str, *, timeout: int) -> StubResponse:
        assert url == 'https://mineru.example/result.zip'
        assert timeout == 180
        return StubResponse(status_code=200, content=b'zip-bytes')

    monkeypatch.setattr('jojo_press.services.mineru_service.requests.get', fake_get)
    gateway = HttpMineruGateway(api_base='https://mineru.net/api/v4', token='secret-token')

    gateway.download_result('https://mineru.example/result.zip', output_path)

    assert output_path.read_bytes() == b'zip-bytes'
