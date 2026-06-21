from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from jojo_press.services.project_document_service import ProjectDocumentService
from jojo_press.services.quality_service import QualityService
from jojo_press.services.seeded_project_documents import SEEDED_QUALITY_ISSUES

router = APIRouter(prefix='/quality', tags=['quality'])


class QualityRepository(ProjectDocumentService):
    def list_issues(self, project_id: str) -> list[dict[str, str]]:
        return list(SEEDED_QUALITY_ISSUES.get(project_id, []))


def get_quality_repository() -> QualityRepository:
    if not hasattr(get_quality_repository, '_repository'):
        from jojo_press.api.projects import PROJECTS_ROOT

        get_quality_repository._repository = QualityRepository(projects_root=PROJECTS_ROOT)
    return get_quality_repository._repository


def get_quality_service() -> QualityService:
    return QualityService()


def _load_document(project_id: str, repository: QualityRepository):
    try:
        return repository.load_book_document(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail='book document not found') from exc


@router.get('/{project_id}')
def get_quality_status(
    project_id: str,
    repository: Annotated[QualityRepository, Depends(get_quality_repository)],
    quality_service: Annotated[QualityService, Depends(get_quality_service)],
) -> dict[str, str | list[str]]:
    document = _load_document(project_id, repository)
    return quality_service.evaluate(document, issues=repository.list_issues(project_id))
