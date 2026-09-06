from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from ..core.config import Settings, get_settings
from ..core.errors import ApiError, SpeechServiceError
from .delivery import resolve_speech, delivery_version
from .providers import PROVIDERS
from .voices import VOICES


logger = logging.getLogger("jojo.platform_api.speech")
router = APIRouter(tags=["speech"])


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=600)
    provider: str = Field(default="auto", max_length=32)
    voice: str | None = Field(default=None, max_length=80)
    scope: Literal["book", "news"] = "book"

    @field_validator("text")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("Speech text cannot be blank")
        return normalized


@router.get("/speech/providers")
async def speech_providers(settings: Settings = Depends(get_settings), v: int = Query(1, ge=1, le=2)) -> dict:
    if v == 1:
        # Installed 0.0.2 clients validate physical keys and cannot read aliases.
        provider = PROVIDERS["mimo" if settings.speech_storage == "b2" or PROVIDERS["mimo"].available(settings) else "edge"]
        return {
            "defaultProvider": provider.id, "defaultVoice": VOICES["male"][provider.id],
            "requiresAuth": False, "loginRequiredInUi": True,
            "cdnBase": settings.speech_cdn_base if settings.speech_storage == "b2" else None,
            "providers": [{
                "id": provider.id, "label": "在线朗读", "description": "",
                "available": provider.available(settings) or settings.speech_storage == "b2",
                "canGenerate": provider.available(settings), "cacheVersion": delivery_version(provider.id),
                "voices": [{"id": VOICES[voice][provider.id], "label": label, "description": ""}
                           for voice, label in (("male", "男声"), ("female", "女声"))],
            }],
        }
    return {
        "defaultProvider": "auto",
        "defaultVoice": "male",
        "requiresAuth": False,
        "loginRequiredInUi": True,
        "cdnBase": settings.speech_cdn_base if settings.speech_storage == "b2" else None,
        "providers": [{
            "id": "auto", "label": "在线朗读", "description": "",
            "available": settings.tts_enabled or settings.speech_storage == "b2",
            "canGenerate": settings.tts_enabled,
            "cacheVersion": delivery_version("auto"),
            "voices": [{"id": "male", "label": "男声", "description": ""},
                       {"id": "female", "label": "女声", "description": ""}],
        }],
    }


@router.post("/speech", response_class=Response)
async def speech(
    request: SpeechRequest,
    settings: Settings = Depends(get_settings),
) -> Response:
    try:
        # Frontend-only login restriction is intentional. Never expose provider keys.
        audio, cache_status = await asyncio.wait_for(
            resolve_speech(request.provider, request.voice, request.text, settings, scope=request.scope), timeout=110,
        )
    except ApiError:
        raise
    except Exception as error:
        logger.warning("Speech synthesis failed: provider=%s error_type=%s", request.provider, type(error).__name__)
        raise SpeechServiceError("语音生成失败，请重试或切换其他声音") from error
    if isinstance(audio, dict):
        return JSONResponse({**audio, "cache": cache_status}, headers={"Cache-Control": "no-store"})
    return Response(
        content=audio.data,
        media_type=audio.media_type,
        headers={
            "Content-Disposition": f'inline; filename="speech.{audio.extension}"',
            "X-Speech-Provider": request.provider,
            "X-Speech-Cache": cache_status,
        },
    )
