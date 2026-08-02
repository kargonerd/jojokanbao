import json
from pathlib import Path
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jojo_press.api.export import get_export_output_root
from jojo_press.api.projects import get_project_service
from jojo_press.api.tasks import get_mineru_service
from jojo_press.app import app
from jojo_press.services.mineru_service import MineruService
from tests.test_project_service import StubMineruGateway
from jojo_press.services.project_service import ProjectService


def test_health_route_returns_ok_status() -> None:
    client = TestClient(app)

    response = client.get('/health')

    assert response.status_code == 200
    assert response.json() == {'status': 'ok'}


def test_health_route_allows_local_desktop_dev_origin() -> None:
    client = TestClient(app)

    response = client.get('/health', headers={'Origin': 'http://127.0.0.1:4181'})

    assert response.status_code == 200
    assert response.headers['access-control-allow-origin'] == 'http://127.0.0.1:4181'


def test_app_registers_task_11_engine_routes(tmp_path: Path) -> None:
    client = TestClient(app)
    app.dependency_overrides.clear()

    def override_project_service() -> ProjectService:
        return ProjectService(projects_root=tmp_path / 'projects')

    def override_mineru_service() -> MineruService:
        return MineruService(base_dir=tmp_path / 'projects', gateway=StubMineruGateway())

    def override_export_output_root() -> Path:
        return tmp_path / 'exports'

    app.dependency_overrides[get_project_service] = override_project_service
    app.dependency_overrides[get_mineru_service] = override_mineru_service
    app.dependency_overrides[get_export_output_root] = override_export_output_root
    try:
        project_response = client.post('/projects', json={'name': 'task-11-route-check'})
        created_project = project_response.json()
        project_list_response = client.get('/projects')
        project_detail_response = client.get('/projects/project-demo')
        metadata_response = client.get('/projects/project-demo/metadata')
        task_response = client.post(
            f"/tasks/{created_project['project_id']}/recognition/start",
            json={'pdf_path': 'samples/demo.pdf'},
        )
        proofread_response = client.get('/proofread/project-demo/issues')
        quality_response = client.get('/quality/project-ops-handbook')
        export_response = client.post('/export/project-ops-handbook/markdown')

        assert project_response.status_code == 201
        assert project_list_response.status_code == 200
        assert project_detail_response.status_code == 200
        assert all('createdAt' in item and 'path' in item and 'coverUrl' in item for item in project_list_response.json())
        assert 'createdAt' in project_detail_response.json()
        assert 'path' in project_detail_response.json()
        assert 'coverUrl' in project_detail_response.json()
        assert metadata_response.status_code == 200
        assert task_response.status_code == 200
        assert proofread_response.status_code == 200
        assert quality_response.status_code == 200
        assert export_response.status_code == 200
    finally:
        app.dependency_overrides.clear()


def test_recognition_status_route_returns_saved_task_state(tmp_path: Path) -> None:
    client = TestClient(app)
    app.dependency_overrides.clear()

    def override_mineru_service() -> MineruService:
        return MineruService(base_dir=tmp_path / 'projects', gateway=StubMineruGateway())

    app.dependency_overrides[get_mineru_service] = override_mineru_service
    try:
        project_root = tmp_path / 'projects' / 'demo-project'
        state_dir = project_root / 'state'
        state_dir.mkdir(parents=True, exist_ok=True)
        (state_dir / 'recognition-task.json').write_text(
            json.dumps(
                {
                    'project_id': 'demo-project',
                    'status': 'processing',
                    'engine': 'pipeline',
                    'language': 'chinese_cht',
                    'is_ocr': True,
                    'pdf_path': 'file:///C:/books/demo.pdf',
                }
            ),
            encoding='utf-8',
        )

        response = client.get('/tasks/demo-project/recognition/status')

        assert response.status_code == 200
        assert response.json() == {
            'project_id': 'demo-project',
            'status': 'processing',
            'engine': 'pipeline',
            'language': 'chinese_cht',
            'is_ocr': True,
            'pdf_path': 'file:///C:/books/demo.pdf',
        }
    finally:
        app.dependency_overrides.clear()
