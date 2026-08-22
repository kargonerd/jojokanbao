from __future__ import annotations

from functools import lru_cache

from fastapi import APIRouter, Depends, HTTPException, Query

from ..core.auth import get_current_user
from ..core.config import get_settings
from .service import TimesFeedService


@lru_cache(maxsize=1)
def get_times_service() -> TimesFeedService:
    return TimesFeedService(get_settings())


router = APIRouter(tags=["times"], dependencies=[Depends(get_current_user)])


@router.get("/news")
async def list_news(
    limit: int = Query(default=100, ge=1, le=200),
    service: TimesFeedService = Depends(get_times_service),
):
    return await service.list_news(limit)


@router.get("/news/{news_id}")
async def get_news(news_id: str, service: TimesFeedService = Depends(get_times_service)):
    news = await service.get_news(news_id)
    if news is None:
        raise HTTPException(status_code=404, detail="News not found")
    return news
