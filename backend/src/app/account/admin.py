"""Moderation APIs authorized by current, server-managed JOJO roles."""
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.core.auth import get_current_user
from app.core.config import Settings, get_settings
from app.core.errors import ApiError
from app.core.models import CurrentUser
from app.core.service_rpc import service_rpc

router = APIRouter()


async def require_moderator(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    roles = user.app_metadata.get("jojo_roles")
    if not isinstance(roles, list) or not any(role in ("admin", "moderator") for role in roles):
        raise ApiError(403, "permission_denied", "你没有评论审核权限。")
    return user


class ModerationInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    action: Literal["hide", "restore", "dismiss"]
    reason: str = Field(min_length=2, max_length=500)


@router.get("/admin/moderation/comments", tags=["admin"])
async def list_reports(status: Literal["pending", "resolved", "dismissed", "all"] = "pending",
                       user: CurrentUser = Depends(require_moderator), settings: Settings = Depends(get_settings)):
    return {"success": True, "items": await service_rpc(settings, "admin_list_annotation_reports", {"p_status": status})}


@router.post("/admin/moderation/comments/{comment_id}", tags=["admin"])
async def moderate_comment(comment_id: UUID, body: ModerationInput,
                           user: CurrentUser = Depends(require_moderator), settings: Settings = Depends(get_settings)):
    result = await service_rpc(settings, "admin_moderate_annotation_comment", {
        "p_actor_id": user.id, "p_comment_id": str(comment_id), "p_action": body.action, "p_reason": body.reason,
    })
    return {"success": True, "result": result}
