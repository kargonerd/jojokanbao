from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict

from fastapi import APIRouter, Depends, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from ..core.config import Settings, get_settings
from ..core.errors import ApiError, SpeechServiceError
from .providers import PROVIDERS
from .delivery import resolve_speech, delivery_version


logger = logging.getLogger("jojo.platform_api.speech")
router = APIRouter(tags=["speech"])


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=600)
    provider: str = Field(default="edge", max_length=32)
    voice: str | None = Field(default=None, max_length=80)

    @field_validator("text")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("Speech text cannot be blank")
        return normalized


@router.get("/speech/providers")
async def speech_providers(settings: Settings = Depends(get_settings)) -> dict:
    return {
        "defaultProvider": "mimo" if settings.speech_storage == "b2" or PROVIDERS["mimo"].available(settings) else "edge",
        "defaultVoice": "白桦" if settings.speech_storage == "b2" or PROVIDERS["mimo"].available(settings) else "zh-CN-XiaoxiaoNeural",
        "requiresAuth": False,
        "loginRequiredInUi": True,
        "cdnBase": settings.speech_cdn_base if settings.speech_storage == "b2" else None,
        "providers": [
            {
                "id": provider.id, "label": provider.label,
                "description": provider.description,
                "available": provider.available(settings) or settings.speech_storage == "b2",
                "canGenerate": provider.available(settings),
                "cacheVersion": delivery_version(provider.id),
                "voices": [asdict(voice) for voice in provider.voices],
            }
            for provider in PROVIDERS.values()
        ],
    }


@router.post("/speech", response_class=Response)
async def speech(
    request: SpeechRequest,
    settings: Settings = Depends(get_settings),
) -> Response:
    try:
        # Frontend-only login restriction is intentional. Never expose provider keys.
        async with asyncio.timeout(110):
            audio, cache_status = await resolve_speech(request.provider, request.voice, request.text, settings)
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
