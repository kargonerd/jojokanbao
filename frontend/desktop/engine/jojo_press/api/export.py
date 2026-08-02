from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from jojo_press.config import Settings
from jojo_press.services.cleanup_service import CleanupService
from jojo_press.services.export_service import ExportService
from jojo_press.services.project_document_service import ProjectDocumentService

router = APIRouter(prefix='/export', tags=['export'])


def get_export_repository() -> ProjectDocumentService:
    if not hasattr(get_export_repository, '_repository'):
        from jojo_press.api.projects import PROJECTS_ROOT

        get_export_repository._repository = ProjectDocumentService(projects_root=PROJECTS_ROOT)
    return get_export_repository._repository


def get_export_service() -> ExportService:
    return ExportService()


def get_export_output_root() -> Path:
    return Settings().export_root


def _load_document(project_id: str, repository: ProjectDocumentService):
    try:
        return CleanupService().run(repository.load_book_document(project_id))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail='book document not found') from exc


@router.get('/{project_id}/options')
def list_export_options(
    project_id: str,
    repository: Annotated[ProjectDocumentService, Depends(get_export_repository)],
) -> dict[str, list[dict[str, str]]]:
    _load_document(project_id, repository)
    return {
        'options': [
            {'id': 'markdown', 'label': 'Export Markdown'},
            {'id': 'html', 'label': 'Export HTML'},
            {'id': 'epub', 'label': 'Export EPUB'},
            {'id': 'jojo-rag', 'label': 'Export jojo-rag Package'},
        ]
    }


@router.post('/{project_id}/markdown')
def export_markdown(
    project_id: str,
    repository: Annotated[ProjectDocumentService, Depends(get_export_repository)],
    export_service: Annotated[ExportService, Depends(get_export_service)],
    export_output_root: Annotated[Path, Depends(get_export_output_root)],
) -> dict[str, str]:
    document = _load_document(project_id, repository)
    path = export_service.export_markdown(document, export_output_root / project_id / 'markdown')
    return {'path': str(path)}


@router.post('/{project_id}/html')
def export_html(
    project_id: str,
    repository: Annotated[ProjectDocumentService, Depends(get_export_repository)],
    export_service: Annotated[ExportService, Depends(get_export_service)],
    export_output_root: Annotated[Path, Depends(get_export_output_root)],
) -> dict[str, str]:
    document = _load_document(project_id, repository)
    path = export_service.export_html(document, export_output_root / project_id / 'html')
    return {'path': str(path)}


@router.post('/{project_id}/epub')
def export_epub(
    project_id: str,
    repository: Annotated[ProjectDocumentService, Depends(get_export_repository)],
    export_service: Annotated[ExportService, Depends(get_export_service)],
    export_output_root: Annotated[Path, Depends(get_export_output_root)],
) -> dict[str, str]:
    document = _load_document(project_id, repository)
    path = export_service.export_epub(document, export_output_root / project_id / 'epub')
    return {'path': str(path)}


@router.post('/{project_id}/jojo-rag')
def export_import_package(
    project_id: str,
    repository: Annotated[ProjectDocumentService, Depends(get_export_repository)],
    export_service: Annotated[ExportService, Depends(get_export_service)],
    export_output_root: Annotated[Path, Depends(get_export_output_root)],
) -> dict[str, str]:
    document = _load_document(project_id, repository)
    path = export_service.export_import_package(document, export_output_root / project_id / 'jojo-rag')
    return {'path': str(path)}
