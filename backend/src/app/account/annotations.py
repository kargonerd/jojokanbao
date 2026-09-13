"""Supply trusted PostHog parameters to the atomic reader operations."""
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from app.core.config import Settings, get_settings
from app.core.auth import get_current_user
from app.core.models import CurrentUser
from app.core.remote_config import RemoteConfig, get_remote_config
from app.core.service_rpc import service_rpc

router = APIRouter()


class AnnotationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal[
        "get_annotation_threads",
        "create_content_annotation",
        "add_annotation_comment",
        "report_annotation_comment",
        "set_annotation_comment_like",
        "delete_my_annotation_mark",
        "delete_my_annotation_comment",
    ]
    params: dict[str, Any]


@router.post("/annotations", tags=["reader"])
async def annotations(
    body: AnnotationRequest,
    user: CurrentUser = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
    config: RemoteConfig = Depends(get_remote_config),
) -> Any:
    policy = await config.get("reader_annotations_config")
    return await service_rpc(settings, "annotation_request", {
        "p_user_id": user.id,
        "p_public_mark_threshold": policy["publicMarkThreshold"],
        "p_operation": body.operation, "p_params": body.params,
    })
