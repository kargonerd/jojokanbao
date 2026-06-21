from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictStr, field_validator

from jojo_press.api.projects import PROJECTS_ROOT
from jojo_press.services.mineru_service import (
    MineruGatewayNotConfiguredError,
    MineruService,
    RecognitionTask,
    RecognitionTaskNotFoundError,
    RecognitionTaskStateError,
    build_mineru_gateway_from_env,
)

router = APIRouter(prefix='/tasks', tags=['tasks'])


class StartRecognitionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    pdf_path: StrictStr = Field(min_length=1)

    @field_validator('pdf_path')
    @classmethod
    def validate_pdf_path(cls, value: str) -> str:
        if not value.strip():
            raise ValueError('pdf_path must not be blank')
        return value


def get_mineru_gateway():
    return build_mineru_gateway_from_env()


def get_mineru_service() -> MineruService:
    return MineruService(base_dir=PROJECTS_ROOT, gateway=get_mineru_gateway())


@router.post('/{project_id}/recognition/start', response_model=RecognitionTask)
def start_recognition(
    project_id: str,
    request: StartRecognitionRequest,
    service: Annotated[MineruService, Depends(get_mineru_service)],
) -> RecognitionTask:
    try:
        return service.start_task(project_id=project_id, pdf_path=request.pdf_path)
    except MineruGatewayNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail='mineru gateway is not configured') from exc


@router.post('/{project_id}/recognition/retry', response_model=RecognitionTask)
def retry_recognition(
    project_id: str,
    service: Annotated[MineruService, Depends(get_mineru_service)],
) -> RecognitionTask:
    try:
        return service.retry_task(project_id=project_id)
    except RecognitionTaskNotFoundError as exc:
        raise HTTPException(status_code=404, detail='recognition task state not found') from exc
    except RecognitionTaskStateError as exc:
        raise HTTPException(status_code=409, detail='recognition task state is corrupted') from exc


@router.post('/{project_id}/recognition/resume', response_model=RecognitionTask)
def resume_recognition(
    project_id: str,
    service: Annotated[MineruService, Depends(get_mineru_service)],
) -> RecognitionTask:
    try:
        return service.resume_task(project_id=project_id)
    except RecognitionTaskNotFoundError as exc:
        raise HTTPException(status_code=404, detail='recognition task state not found') from exc
    except RecognitionTaskStateError as exc:
        raise HTTPException(status_code=409, detail='recognition task state is corrupted') from exc


@router.get('/{project_id}/recognition/status', response_model=RecognitionTask | None)
def get_recognition_status(
    project_id: str,
    service: Annotated[MineruService, Depends(get_mineru_service)],
) -> RecognitionTask | None:
    try:
        return service.resume_task(project_id=project_id)
    except RecognitionTaskNotFoundError:
        return None
    except RecognitionTaskStateError as exc:
        raise HTTPException(status_code=409, detail='recognition task state is corrupted') from exc
