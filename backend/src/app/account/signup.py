"""Authorize registration without accepting a client-supplied policy decision."""
import base64
import hashlib
import hmac
import json
import re
import time

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import Settings, get_settings
from app.core.errors import ApiError, ConfigurationError
from app.core.remote_config import RemoteConfig, get_remote_config

router = APIRouter()


class SignupAuthorizationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=3, max_length=254)
    invitationCode: str = Field(default="", max_length=64)


def sign_signup_authorization(email: str, code: str, required: bool, operator_token: str, *, now: int | None = None) -> str:
    payload = {"email": email, "code": code, "required": required, "expires": (now if now is not None else int(time.time())) + 120}
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    key = hashlib.sha256(operator_token.encode()).digest()
    signature = hmac.new(key, f"jojo.signup.v1.{encoded}".encode(), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


@router.post("/account/signup-authorization", tags=["account"])
async def authorize_signup(
    body: SignupAuthorizationInput,
    config: RemoteConfig = Depends(get_remote_config),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    if not settings.operator_token or len(settings.operator_token) < 32:
        raise ConfigurationError()
    email = body.email.strip().lower()
    code = re.sub(r"[^a-zA-Z0-9]", "", body.invitationCode.strip()).upper()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise ApiError(400, "email_address_invalid", "邮箱地址格式不正确。")
    policy = await config.get("auth_signup_config")
    if policy["invitationRequired"] and not re.fullmatch(r"[A-Z0-9]{6}", code):
        raise ApiError(400, "invitation_required", "Invitation code is required or invalid.")
    return {"authorization": sign_signup_authorization(email, code, policy["invitationRequired"], settings.operator_token)}
