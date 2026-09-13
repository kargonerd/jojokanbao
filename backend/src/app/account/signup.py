"""Authorize registration without accepting a client-supplied policy decision."""
import re

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import Settings, get_settings
from app.core.errors import ApiError
from app.core.remote_config import RemoteConfig, get_remote_config
from app.core.service_rpc import service_rpc

router = APIRouter()


class SignupAuthorizationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=3, max_length=254)
    invitationCode: str = Field(default="", max_length=64)


@router.post("/account/signup-authorization", tags=["account"])
async def authorize_signup(
    body: SignupAuthorizationInput,
    config: RemoteConfig = Depends(get_remote_config),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    email = body.email.strip().lower()
    code = re.sub(r"[^a-zA-Z0-9]", "", body.invitationCode.strip()).upper()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise ApiError(400, "email_address_invalid", "邮箱地址格式不正确。")
    policy = await config.get("auth_signup_config")
    if policy["invitationRequired"] and not re.fullmatch(r"[A-Z0-9]{6}", code):
        raise ApiError(400, "invitation_required", "Invitation code is required or invalid.")
    receipt = await service_rpc(settings, "authorize_signup", {
        "p_email": email, "p_code": code, "p_invitation_required": policy["invitationRequired"],
    })
    if not isinstance(receipt, str) or not receipt:
        raise ApiError(502, "signup_authorization_failed", "暂时无法注册，请稍后重试。")
    return {"authorization": receipt}
