"""Supply trusted PostHog parameters to the atomic reader operations."""
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, ConfigDict

from app.core.config import Settings, get_settings
from app.core.errors import ApiError, AuthenticationError, ConfigurationError
from app.core.remote_config import RemoteConfig, get_remote_config

router = APIRouter()


class AnnotationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["get_annotation_threads", "create_content_annotation", "add_annotation_comment", "report_annotation_comment", "set_annotation_comment_like", "delete_my_annotation_mark"]
    params: dict[str, Any]


@router.post("/annotations", tags=["reader"])
async def annotations(
    body: AnnotationRequest,
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
    config: RemoteConfig = Depends(get_remote_config),
) -> Any:
    if not authorization or not authorization.startswith("Bearer ") or len(authorization) <= 7:
        raise AuthenticationError()
    if not settings.operator_token:
        raise ConfigurationError()
    base, key = settings.require_supabase()
    policy = await config.get("reader_annotations_config")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(f"{base}/rest/v1/rpc/annotation_request", headers={
                "apikey": key, "Authorization": authorization,
            }, json={
                "p_operator_token": settings.operator_token,
                "p_public_mark_threshold": policy["publicMarkThreshold"],
                "p_operation": body.operation, "p_params": body.params,
            })
        if not response.is_success:
            status = response.status_code if response.status_code in (400, 401, 403, 404, 409) else 502
            raise ApiError(status, "annotation_request_failed", "阅读笔记操作未完成，请检查登录状态后重试。")
        return response.json()
    except (httpx.HTTPError, ValueError) as error:
        raise ApiError(502, "annotation_service_unavailable", "阅读笔记服务暂时不可用。") from error
