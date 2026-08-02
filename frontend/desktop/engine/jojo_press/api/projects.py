from copy import deepcopy
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from jojo_press.api.schemas import MetadataConfirmationUpdate
from jojo_press.models.book import BookDocument
from jojo_press.models.project import CreateProjectRequest, Project
from jojo_press.services.metadata_service import MetadataService
from jojo_press.services.project_document_service import ProjectDocumentService
from jojo_press.services.project_service import ProjectService

router = APIRouter(prefix='/projects', tags=['projects'])
PROJECTS_ROOT = Path(__file__).resolve().parents[2] / 'projects'


class ProjectOverviewResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    currentStage: str = Field(min_length=1)
    createdAt: str | None = None
    path: str | None = None
    coverUrl: str | None = None


class ProjectMetadataConfirmationResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    subtitle: str | None = None
    authors: list[str] = Field(default_factory=list)
    language: str = Field(min_length=1)
    coverAssetId: str | None = None


class ProjectMetadataUpdateResponse(ProjectMetadataConfirmationResponse):
    currentStage: str = Field(min_length=1)


class ProjectSourcePdfUploadResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    pdf_path: str = Field(min_length=1)


SEEDED_PROJECTS: list[ProjectOverviewResponse] = []

SEEDED_PROJECTS_BY_ID = {project.id: project for project in SEEDED_PROJECTS}

SEEDED_PROJECT_METADATA = {
    'project-demo': ProjectMetadataConfirmationResponse(
        id='project-demo',
        title='革命造反年代',
        subtitle=None,
        authors=['编校组'],
        language='chinese_cht',
        coverAssetId=None,
    ),
    'project-ops-handbook': ProjectMetadataConfirmationResponse(
        id='project-ops-handbook',
        title='工作手册',
        subtitle='发布工作手册',
        authors=['编校组'],
        language='chinese_cht',
        coverAssetId='cover-ops-handbook',
    ),
}


class ProjectMetadataStore:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._items = {project_id: deepcopy(project) for project_id, project in SEEDED_PROJECT_METADATA.items()}

    def get(self, project_id: str) -> ProjectMetadataConfirmationResponse | None:
        project = self._items.get(project_id)
        if project is None:
            return None
        return deepcopy(project)

    def update(self, project_id: str, payload: MetadataConfirmationUpdate) -> ProjectMetadataUpdateResponse | None:
        project = self._items.get(project_id)
        if project is None:
            return None
        updated_project = ProjectMetadataConfirmationResponse(
            id=project.id,
            title=payload.title,
            subtitle=payload.subtitle,
            authors=list(payload.authors),
            language=payload.language,
            coverAssetId=payload.cover_asset_id,
        )
        self._items[project_id] = updated_project
        return ProjectMetadataUpdateResponse(
            id=updated_project.id,
            title=updated_project.title,
            subtitle=updated_project.subtitle,
            authors=list(updated_project.authors),
            language=updated_project.language,
            coverAssetId=updated_project.coverAssetId,
            currentStage='Proofreading workspace',
        )


def get_project_metadata_store() -> ProjectMetadataStore:
    if not hasattr(get_project_metadata_store, '_store'):
        get_project_metadata_store._store = ProjectMetadataStore()
    return get_project_metadata_store._store


def get_project_service() -> ProjectService:
    return ProjectService(projects_root=PROJECTS_ROOT)


def get_project_document_service() -> ProjectDocumentService:
    return ProjectDocumentService(projects_root=PROJECTS_ROOT)


def get_metadata_service() -> MetadataService:
    return MetadataService()


def _get_current_stage(document: BookDocument) -> str:
    return 'Metadata confirmation' if document.book.status == 'draft' else 'Proofreading workspace'


def _build_project_overview(project_id: str, document: BookDocument) -> ProjectOverviewResponse:
    return ProjectOverviewResponse(
        id=project_id,
        title=document.book.title,
        currentStage=_get_current_stage(document),
        createdAt=None,
        path=document.import_meta.source_pdf,
        coverUrl=None,
    )


def _build_project_input_path(project_id: str, filename: str, service: ProjectService) -> Path:
    cleaned_filename = Path(filename).name.strip()
    if not cleaned_filename or cleaned_filename != filename or not cleaned_filename.lower().endswith('.pdf'):
        raise HTTPException(status_code=422, detail='filename must be a pdf file name')

    input_dir = service.repository.projects_root / project_id / 'input'
    if not input_dir.is_dir():
        raise HTTPException(status_code=404, detail='project not found')

    return input_dir / cleaned_filename


@router.get('', response_model=list[ProjectOverviewResponse])
def list_projects(
    document_service: Annotated[ProjectDocumentService, Depends(get_project_document_service)],
) -> list[ProjectOverviewResponse]:
    projects = list(SEEDED_PROJECTS)
    for project_id in document_service.list_project_ids():
        if project_id in SEEDED_PROJECTS_BY_ID:
            continue
        try:
            document = document_service.load_book_document(project_id)
        except FileNotFoundError:
            continue
        projects.append(_build_project_overview(project_id, document))
    return projects


@router.get('/{project_id}', response_model=ProjectOverviewResponse)
def get_project_overview(
    project_id: str,
    document_service: Annotated[ProjectDocumentService, Depends(get_project_document_service)],
) -> ProjectOverviewResponse:
    project = SEEDED_PROJECTS_BY_ID.get(project_id)
    if project is not None:
        return project
    try:
        return _build_project_overview(project_id, document_service.load_book_document(project_id))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail='project not found') from exc


@router.get('/{project_id}/metadata', response_model=ProjectMetadataConfirmationResponse)
def get_project_metadata_confirmation(
    project_id: str,
    store: Annotated[ProjectMetadataStore, Depends(get_project_metadata_store)],
    document_service: Annotated[ProjectDocumentService, Depends(get_project_document_service)],
    metadata_service: Annotated[MetadataService, Depends(get_metadata_service)],
) -> ProjectMetadataConfirmationResponse:
    project = store.get(project_id)
    if project is not None:
        return project
    try:
        confirmation = metadata_service.extract_confirmation(document_service.load_book_document(project_id))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail='project not found') from exc
    return ProjectMetadataConfirmationResponse(
        id=project_id,
        title=confirmation.title,
        subtitle=confirmation.subtitle,
        authors=list(confirmation.authors),
        language=confirmation.language,
        coverAssetId=confirmation.cover_asset_id,
    )


@router.post('/{project_id}/metadata', response_model=ProjectMetadataUpdateResponse)
def update_project_metadata_confirmation(
    project_id: str,
    payload: MetadataConfirmationUpdate,
    store: Annotated[ProjectMetadataStore, Depends(get_project_metadata_store)],
    document_service: Annotated[ProjectDocumentService, Depends(get_project_document_service)],
    metadata_service: Annotated[MetadataService, Depends(get_metadata_service)],
) -> ProjectMetadataUpdateResponse:
    project = store.update(project_id, payload)
    if project is not None:
        return project
    try:
        document = document_service.load_book_document(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail='project not found') from exc
    updated_document = metadata_service.update_confirmation(
        document,
        title=payload.title,
        subtitle=payload.subtitle,
        authors=list(payload.authors),
        language=payload.language,
        cover_asset_id=payload.cover_asset_id,
    )
    document_service.save_book_document(project_id, updated_document)
    confirmation = metadata_service.extract_confirmation(updated_document)
    return ProjectMetadataUpdateResponse(
        id=project_id,
        title=confirmation.title,
        subtitle=confirmation.subtitle,
        authors=list(confirmation.authors),
        language=confirmation.language,
        coverAssetId=confirmation.cover_asset_id,
        currentStage=_get_current_stage(updated_document),
    )


@router.post('', response_model=Project, status_code=201)
def create_project(
    request: CreateProjectRequest,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> Project:
    try:
        return service.create_project(name=request.name)
    except FileExistsError as exc:
        raise HTTPException(
            status_code=409,
            detail='project already exists',
        ) from exc


@router.post('/{project_id}/source-pdf', response_model=ProjectSourcePdfUploadResponse)
async def upload_project_source_pdf(
    project_id: str,
    request: Request,
    filename: Annotated[str, Query(min_length=1)],
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> ProjectSourcePdfUploadResponse:
    payload = await request.body()
    if not payload:
        raise HTTPException(status_code=400, detail='pdf body is empty')

    target_path = _build_project_input_path(project_id, filename, service)
    target_path.write_bytes(payload)
    return ProjectSourcePdfUploadResponse(pdf_path=target_path.as_uri())
