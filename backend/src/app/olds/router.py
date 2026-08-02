from __future__ import annotations

from functools import lru_cache

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from .agent import (
    answer_question,
    build_briefing,
    build_digest,
    extract_entities_from_text,
    generate_entity_timeline,
)
from .models import (
    AgentAskRequest,
    CommentCreate,
    HighlightCreate,
    ScrapbookJobCreate,
    SearchForClaudeRequest,
    SourceCreate,
    TextRequest,
    TimelineRequest,
)
from .rss import fetch_all_sources
from .scrapbook import generate_for_news
from .settings import get_settings
from .store import Store


@lru_cache(maxsize=1)
def get_store() -> Store:
    return Store(get_settings().db_path)


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/health")
    def health(db: Store = Depends(get_store)):
        return db.health()

    @router.get("/sources")
    def list_sources(db: Store = Depends(get_store)):
        return db.list_sources()

    @router.post("/sources", status_code=201)
    def create_source(payload: SourceCreate, db: Store = Depends(get_store)):
        return db.create_source(payload.name, payload.rssUrl)

    @router.delete("/sources/{source_id}")
    def delete_source(source_id: str, db: Store = Depends(get_store)):
        deleted = db.delete_source(source_id)
        if deleted is None:
            raise HTTPException(status_code=404, detail="Source not found")
        return deleted

    @router.get("/news")
    def list_news(limit: int = 100, db: Store = Depends(get_store)):
        return db.list_news(limit=limit)

    @router.get("/news/{news_id}")
    def get_news(news_id: str, db: Store = Depends(get_store)):
        detail = db.get_news_detail(news_id)
        if detail is None and db.get_source(news_id):
            return db.list_news(source_id=news_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="News not found")
        return detail

    @router.get("/articles/{news_id}")
    def get_article(news_id: str, db: Store = Depends(get_store)):
        detail = db.get_news_detail(news_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="Article not found")
        return detail["news"]

    @router.get("/stats")
    def stats(db: Store = Depends(get_store)):
        return db.stats()

    @router.get("/ai/digest")
    def ai_digest(limit: int = 100, db: Store = Depends(get_store)):
        return build_digest(db, limit=limit)

    @router.get("/ai/briefing/{news_id}")
    def ai_briefing(news_id: str, db: Store = Depends(get_store)):
        briefing = build_briefing(db, news_id)
        if briefing is None:
            raise HTTPException(status_code=404, detail="News not found")
        return briefing

    @router.post("/ai/ask")
    def ai_ask(payload: AgentAskRequest, db: Store = Depends(get_store)):
        answer = answer_question(db, payload.newsId, payload.question)
        if answer is None:
            raise HTTPException(status_code=404, detail="News not found")
        return answer

    @router.post("/jobs/fetch-rss")
    async def fetch_rss_job(db: Store = Depends(get_store)):
        return await fetch_all_sources(db)

    @router.post("/admin/fetch")
    async def admin_fetch(db: Store = Depends(get_store)):
        results = await fetch_all_sources(db)
        return {"success": True, "results": results}

    @router.post("/highlights", status_code=201)
    def create_highlight(payload: HighlightCreate, db: Store = Depends(get_store)):
        highlight = db.create_highlight(payload)
        if highlight is None:
            raise HTTPException(status_code=404, detail="News not found")
        return highlight

    @router.post("/comments", status_code=201)
    def create_comment(payload: CommentCreate, db: Store = Depends(get_store)):
        comment = db.create_comment(payload)
        if comment is None:
            raise HTTPException(status_code=404, detail="Highlight not found")
        return comment

    @router.get("/scrapbook/{news_id}")
    def list_scrapbook(news_id: str, db: Store = Depends(get_store)):
        return db.list_scrapbook(news_id)

    @router.post("/jobs/generate-scrapbook")
    def generate_scrapbook(payload: ScrapbookJobCreate, db: Store = Depends(get_store)):
        return generate_for_news(db, payload.newsId)

    @router.get("/search")
    def search(q: str, limit: int = 20, db: Store = Depends(get_store)):
        articles = db.search(q, limit=limit)
        return {"articles": articles, "total": len(articles)}

    @router.get("/hot-keywords")
    def hot_keywords(limit: int = 100, db: Store = Depends(get_store)):
        return build_digest(db, limit=limit)["hotKeywords"]

    @router.get("/events")
    def events(limit: int = 100, db: Store = Depends(get_store)):
        digest = build_digest(db, limit=limit)
        return digest["attentionLanes"]

    @router.get("/events/{event_id}")
    def event_detail(event_id: str, db: Store = Depends(get_store)):
        digest = build_digest(db, limit=100)
        lane = next((item for item in digest["attentionLanes"] if item["label"] == event_id), None)
        if lane is None:
            raise HTTPException(status_code=404, detail="Event not found")
        articles = [item for item in db.list_news(limit=100) if item["id"] in lane["articleIds"]]
        return {"id": event_id, **lane, "articles": articles}

    @router.post("/admin/fetch-folo")
    def fetch_folo():
        return {"success": False, "message": "Folo fetch is not configured in the Python backend yet."}

    @router.get("/admin/folo-setup")
    def folo_setup():
        return {"instructions": "Set up Folo integration in a Python worker before enabling this endpoint."}

    @router.post("/admin/identify-events")
    def identify_events():
        return {"success": True, "created": 0}

    @router.post("/admin/reindex")
    def reindex():
        return {"success": True}

    @router.post("/search-for-claude")
    def search_for_claude(payload: SearchForClaudeRequest, db: Store = Depends(get_store)):
        return {"results": db.search(payload.query, limit=payload.limit)}

    @router.post("/extract-entities")
    def extract_entities(payload: TextRequest):
        return {"entities": extract_entities_from_text(payload.text)}

    @router.post("/generate-timeline")
    def generate_timeline(payload: TimelineRequest):
        return generate_entity_timeline(payload.entity, payload.articles)

    @router.post("/upload-avatar")
    async def upload_avatar(image: UploadFile = File(...)):
        return {"url": f"/uploads/{image.filename}", "filename": image.filename}

    return router


router = create_router()
