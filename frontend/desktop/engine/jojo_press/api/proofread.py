from pathlib import Path
import re
from typing import Annotated
from urllib.parse import unquote, urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, StrictStr

from jojo_press.services.cleanup_service import CleanupService
from jojo_press.services.issue_service import IssueService
from jojo_press.services.mineru_service import MineruService, RecognitionTaskNotFoundError, RecognitionTaskStateError
from jojo_press.services.project_document_service import ProjectDocumentService

router = APIRouter(prefix='/proofread', tags=['proofread'])
LOCAL_DEV_ORIGIN_PATTERN = re.compile(r'^http://(127\.0\.0\.1|localhost):\d+$')
SOURCE_PDF_EXPOSED_HEADERS = 'Content-Length, Content-Range, Accept-Ranges'


class UpdateBlockRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    text: StrictStr = Field(min_length=1)


def get_proofread_repository() -> ProjectDocumentService:
    if not hasattr(get_proofread_repository, '_repository'):
        from jojo_press.api.projects import PROJECTS_ROOT

        get_proofread_repository._repository = ProjectDocumentService(projects_root=PROJECTS_ROOT)
    return get_proofread_repository._repository


def get_issue_service() -> IssueService:
    return IssueService()


def get_proofread_task_service() -> MineruService:
    from jojo_press.api.projects import PROJECTS_ROOT

    return MineruService(base_dir=PROJECTS_ROOT)


def _is_seeded_project(project_id: str) -> bool:
    from jojo_press.services.seeded_project_documents import SEEDED_PROJECT_DOCUMENTS

    return project_id in SEEDED_PROJECT_DOCUMENTS


def _load_document(project_id: str, repository: ProjectDocumentService):
    try:
        return repository.load_book_document(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail='book document not found') from exc


@router.get('/{project_id}/issues')
def list_issues(
    project_id: str,
    repository: Annotated[ProjectDocumentService, Depends(get_proofread_repository)],
    issue_service: Annotated[IssueService, Depends(get_issue_service)],
) -> dict[str, list[dict[str, str]]]:
    document = _load_document(project_id, repository)
    cleaned = CleanupService().run(document)
    items = [issue.model_dump() for issue in issue_service.build(cleaned)]
    return {'items': items}


def _build_source_pdf_url(project_id: str) -> str:
    return f'/proofread/{project_id}/source-pdf'


def _resolve_source_pdf_path(raw_path: str) -> Path:
    if raw_path.startswith('file:///'):
        parsed = urlparse(raw_path)
        return Path(unquote(parsed.path.lstrip('/'))).resolve()
    return Path(raw_path).expanduser().resolve()


def _apply_source_pdf_cors_headers(response: FileResponse, origin: str | None) -> FileResponse:
    if origin and LOCAL_DEV_ORIGIN_PATTERN.match(origin):
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Vary'] = 'Origin'
    elif origin is None:
        response.headers['Access-Control-Allow-Origin'] = '*'

    response.headers['Access-Control-Expose-Headers'] = SOURCE_PDF_EXPOSED_HEADERS
    response.headers['Cache-Control'] = 'no-store'
    return response


@router.get('/{project_id}/source-pdf')
def get_source_pdf(
    project_id: str,
    request: Request,
    repository: Annotated[ProjectDocumentService, Depends(get_proofread_repository)],
) -> FileResponse:
    document = _load_document(project_id, repository)
    pdf_path = _resolve_source_pdf_path(document.import_meta.source_pdf)
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail='source pdf not found')
    response = FileResponse(pdf_path, media_type='application/pdf', filename=pdf_path.name, content_disposition_type='inline')
    return _apply_source_pdf_cors_headers(response, request.headers.get('origin'))


@router.get('/{project_id}/workspace')
def get_workspace(
    project_id: str,
    repository: Annotated[ProjectDocumentService, Depends(get_proofread_repository)],
    issue_service: Annotated[IssueService, Depends(get_issue_service)],
    task_service: Annotated[MineruService, Depends(get_proofread_task_service)],
) -> dict[str, object]:
    document = _load_document(project_id, repository)

    try:
        task = task_service.resume_task(project_id)
    except RecognitionTaskNotFoundError:
        task = None if not _is_seeded_project(project_id) else type('SeededTask', (), {'status': 'completed'})()
    except RecognitionTaskStateError as exc:
        raise HTTPException(status_code=409, detail='recognition task state is corrupted') from exc

    if task is not None and task.status != 'completed':
        return {
            'status': 'recognition_pending',
            'notice': 'MinerU 识别还没完成，当前还没有可校对文字。请先完成识别，再进入文字校对。',
            'issues': [],
            'preview': {
                'page': 1,
                'documentUrl': _build_source_pdf_url(project_id),
            },
            'block': None,
            'toc': [],
        }

    cleaned = CleanupService().run(document)
    cleaned_block_ids = {block.id for block in cleaned.blocks}
    issues = [issue.model_dump(by_alias=True) for issue in issue_service.build(cleaned)]
    first_block = cleaned.blocks[0]
    preview_page = first_block.source_page

    # Build layout pages from document.layout
    layout_pages = []
    for page_layout in document.layout:
        layout_pages.append({
            'pageNum': page_layout.page_num,
            'blocks': [
                {
                    'id': block.id,
                    'type': block.type,
                    'text': block.text,
                    'bbox': {
                        'x': block.bbox.x,
                        'y': block.bbox.y,
                        'width': block.bbox.width,
                        'height': block.bbox.height,
                    },
                    'level': block.level,
                }
                for block in page_layout.blocks
                if block.id in cleaned_block_ids
            ]
        })

    return {
        'status': 'ready',
        'notice': None,
        'issues': issues,
        'preview': {
            'page': preview_page,
            'documentUrl': _build_source_pdf_url(project_id),
            'pages': layout_pages,
            'totalPages': len(layout_pages),
        },
        'block': {
            'id': first_block.id,
            'text': first_block.text,
        },
        'toc': [
            {
                'id': block.id,
                'label': block.text,
            }
            for block in cleaned.blocks
            if block.type == 'heading'
        ],
    }


@router.post('/{project_id}/blocks/{block_id}')
def update_block(
    project_id: str,
    block_id: str,
    payload: UpdateBlockRequest,
    repository: Annotated[ProjectDocumentService, Depends(get_proofread_repository)],
) -> dict[str, dict[str, str | int]]:
    document = _load_document(project_id, repository)
    updated_block = None
    updated_blocks = []

    for block in document.blocks:
        if block.id == block_id:
            updated_block = block.model_copy(update={'text': payload.text})
            updated_blocks.append(updated_block)
        else:
            updated_blocks.append(block)

    if updated_block is None:
        raise HTTPException(status_code=404, detail='block not found')

    repository.save_book_document(project_id, document.model_copy(update={'blocks': updated_blocks}))
    return {'item': updated_block.model_dump()}
