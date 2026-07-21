from pathlib import Path
import sys

from fastapi.testclient import TestClient

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from jojo_press.api.quality import get_quality_repository
from jojo_press.app import app
from jojo_press.models.book import BookBlock, BookDocument, BookMeta, ImportMeta
from jojo_press.services.quality_service import QualityService


class StubQualityRepository:
    def __init__(self, documents: dict[str, BookDocument], issues: dict[str, list[dict[str, str]]]) -> None:
        self._documents = documents
        self._issues = issues

    def load_book_document(self, project_id: str) -> BookDocument:
        try:
            return self._documents[project_id]
        except KeyError as exc:
            raise FileNotFoundError(project_id) from exc

    def list_issues(self, project_id: str) -> list[dict[str, str]]:
        return self._issues.get(project_id, [])


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
            BookBlock(id='block-1', type='paragraph', text='第一段正文', source_page=1),
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



def test_quality_service_blocks_export_when_high_priority_issues_exist() -> None:
    result = QualityService().evaluate(build_document(), issues=[{'severity': 'high'}])

    assert result['status'] == 'blocked'
    assert result['checks'] == ['Resolve high-severity issues first']



def test_quality_route_returns_blocked_when_repository_has_high_severity_issue() -> None:
    client = TestClient(app)
    repository = StubQualityRepository(
        documents={'blocked-project': build_document()},
        issues={'blocked-project': [{'severity': 'high'}]},
    )
    app.dependency_overrides.clear()

    def override_repository() -> StubQualityRepository:
        return repository

    app.dependency_overrides[get_quality_repository] = override_repository
    try:
        response = client.get('/quality/blocked-project')

        assert response.status_code == 200
        assert response.json() == {
            'status': 'blocked',
            'checks': ['Resolve high-severity issues first'],
        }
    finally:
        app.dependency_overrides.clear()



def test_quality_route_returns_seeded_blocked_fixture_for_task_10_project() -> None:
    client = TestClient(app)

    response = client.get('/quality/project-ops-handbook')

    assert response.status_code == 200
    assert response.json() == {
        'status': 'blocked',
        'checks': ['Resolve high-severity issues first'],
    }



def test_quality_route_returns_not_found_for_unknown_project() -> None:
    client = TestClient(app)
    repository = StubQualityRepository(documents={}, issues={})
    app.dependency_overrides.clear()

    def override_repository() -> StubQualityRepository:
        return repository

    app.dependency_overrides[get_quality_repository] = override_repository
    try:
        response = client.get('/quality/missing-project')

        assert response.status_code == 404
        assert response.json() == {'detail': 'book document not found'}
    finally:
        app.dependency_overrides.clear()
