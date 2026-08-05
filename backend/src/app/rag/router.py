from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core.auth import get_current_user
from app.core.config import Settings, get_settings
from app.core.models import CurrentUser
from app.core.service_auth import authorize_service_request

from .agent_client import AgentClient
from .documents import RagDocumentRepository


router = APIRouter(prefix="/rag", tags=["rag"])
internal_router = APIRouter(prefix="/internal/rag", tags=["internal-rag"])


class RagQuestion(BaseModel):
    notebook_id: str = Field(min_length=1, max_length=128)
    question: str = Field(min_length=1, max_length=10_000)
    conversation_id: str | None = Field(
        default=None,
        min_length=6,
        max_length=36,
        pattern=r"^[0-9A-Za-z._-]+$",
    )
    source_ids: list[str] = Field(min_length=1, max_length=20)


class DocumentToolRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=128)
    notebook_id: str = Field(min_length=1, max_length=128)
    source_ids: list[str] = Field(min_length=1, max_length=20)
    operation: Literal["search", "read"]
    query: str | None = Field(default=None, max_length=500)
    max_results: int = Field(default=3, ge=1, le=8)
    source_id: str | None = Field(default=None, max_length=128)
    start: int = Field(default=0, ge=0)
    length: int = Field(default=3_000, ge=1, le=6_000)


@lru_cache(maxsize=4)
def _document_repository(settings: Settings) -> RagDocumentRepository:
    return RagDocumentRepository(settings)


def document_repository(
    settings: Annotated[Settings, Depends(get_settings)],
) -> RagDocumentRepository:
    return _document_repository(settings)


@router.get("/notebooks")
async def list_notebooks(
    documents: Annotated[RagDocumentRepository, Depends(document_repository)],
) -> list[dict[str, Any]]:
    return await documents.notebooks()


@router.get("/notebooks/{notebook_id}/sources")
async def list_sources(
    notebook_id: str,
    documents: Annotated[RagDocumentRepository, Depends(document_repository)],
) -> list[dict[str, Any]]:
    return await documents.sources(notebook_id)


@router.post("/chat/stream")
async def chat_stream(
    body: RagQuestion,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> StreamingResponse:
    try:
        stream = await AgentClient(settings).open_rag_stream(
            user_id=user.id,
            question=body.question.strip(),
            notebook_id=body.notebook_id,
            source_ids=body.source_ids,
            conversation_id=body.conversation_id,
        )
    except Exception as error:
        raise HTTPException(status_code=502, detail="Agent service is unavailable") from error
    return StreamingResponse(
        stream.chunks(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@internal_router.post("/documents")
async def document_tool(
    body: DocumentToolRequest,
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    documents: Annotated[RagDocumentRepository, Depends(document_repository)],
) -> dict[str, Any]:
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Request body must be an object")
    await authorize_service_request(request, settings, payload)
    try:
        if body.operation == "search":
            return await documents.search(
                notebook_id=body.notebook_id,
                source_ids=body.source_ids,
                query=body.query or "",
                max_results=body.max_results,
            )
        return await documents.read(
            notebook_id=body.notebook_id,
            source_ids=body.source_ids,
            source_id=body.source_id or "",
            start=body.start,
            length=body.length,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
