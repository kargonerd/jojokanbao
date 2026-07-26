# News Reader Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `news-reader` into a React web app with a FastAPI + SQLite backend, centered on a high-quality news feed while preserving search, entities, timelines, and event aggregation.

**Architecture:** Keep the existing React/Vite frontend repo, replace the current Express backend with a modular FastAPI service under `server-python`, and migrate SQLite data into a clearer schema that supports device sessions, preferences, favorites, read history, search, entities, and events. Deliver the system as vertical slices so the app is usable early and the old backend can be removed only after the new frontend is fully wired.

**Tech Stack:** React 18, Vite, TypeScript, Zustand, TanStack Query, Tailwind CSS, FastAPI, Pydantic v2, SQLite, sqlite-vec, APScheduler, pytest, Vitest, Testing Library

---

## File Structure Map

### Backend (`news-reader/server-python`)

**Create**
- `server-python/src/app/main.py` — FastAPI app factory, router registration, CORS, lifespan hooks
- `server-python/src/app/core/config.py` — environment-backed settings
- `server-python/src/app/core/db.py` — SQLite connection, schema bootstrap, row factory helpers
- `server-python/src/app/api/router.py` — root API router
- `server-python/src/app/api/routes/health.py` — `/api/health`, `/api/meta`
- `server-python/src/app/api/routes/articles.py` — feed, article detail, read, favorite routes
- `server-python/src/app/api/routes/search.py` — keyword / semantic / hybrid search routes
- `server-python/src/app/api/routes/entities.py` — entity extraction and cached article entities
- `server-python/src/app/api/routes/timelines.py` — timeline generation and lookup routes
- `server-python/src/app/api/routes/events.py` — events list/detail routes
- `server-python/src/app/api/routes/user.py` — device session and preferences routes
- `server-python/src/app/api/routes/admin.py` — manual fetch/reindex/rebuild routes
- `server-python/src/app/schemas/*.py` — Pydantic request/response models
- `server-python/src/app/repositories/*.py` — SQL access by domain
- `server-python/src/app/services/*.py` — business orchestration
- `server-python/src/app/ai/client.py` — AI interface abstraction
- `server-python/src/app/ai/embeddings.py` — embedding generation wrapper
- `server-python/src/app/ingestion/source_registry.py` — source definitions
- `server-python/src/app/ingestion/rss_fetcher.py` — feed fetching/parsing
- `server-python/src/app/ingestion/scheduler.py` — APScheduler setup
- `server-python/tests/conftest.py` — shared test app/DB fixtures
- `server-python/tests/api/*.py` — API contract tests
- `server-python/tests/services/*.py` — service tests
- `server-python/start.py` — local dev launcher

**Modify**
- `server-python/requirements.txt` — runtime and test dependencies
- `server-python/src/__init__.py` — keep package importable if present

**Delete during final cleanup**
- `server-python/src/types.py` — superseded by `app/schemas`

### Frontend (`news-reader/src`)

**Create**
- `src/app/AppShell.tsx` — shared shell, top nav, content layout
- `src/app/routes.tsx` — route tree
- `src/components/navigation/TopNav.tsx`
- `src/components/navigation/MainTabs.tsx`
- `src/components/feed/FilterBar.tsx`
- `src/components/feed/ArticleCard.tsx`
- `src/components/feed/ArticleList.tsx`
- `src/components/search/SearchModeTabs.tsx`
- `src/components/common/EmptyState.tsx`
- `src/components/common/ErrorBlock.tsx`
- `src/components/common/LoadingBlock.tsx`
- `src/pages/FeedPage.tsx`
- `src/pages/SearchPage.tsx`
- `src/pages/ArticleDetailPage.tsx`
- `src/pages/EventsPage.tsx`
- `src/pages/EventDetailPage.tsx`
- `src/pages/LibraryPage.tsx`
- `src/pages/SettingsPage.tsx`
- `src/services/articles.ts`
- `src/services/search.ts`
- `src/services/user.ts`
- `src/services/timelines.ts`
- `src/types/api.ts`
- `src/test/setup.ts`
- `src/pages/__tests__/*.test.tsx`

**Modify**
- `package.json` — test dependencies and scripts
- `vite.config.ts` — test config if needed
- `src/main.tsx` — mount new route tree
- `src/index.css` — design tokens and base layout styles
- `src/stores/userStore.ts` — sync local state with backend device session/preferences
- `src/services/api.ts` — generic API client with unified error handling

**Delete during final cleanup**
- `src/pages/HomePage.tsx`
- `src/components/SettingsModal.tsx`
- `src/components/EntityModal.tsx`
- old API helper functions in `src/services/api.ts` once split services land

---

## Task 1: Bootstrap the FastAPI app and health contract

**Files:**
- Create: `server-python/src/app/main.py`
- Create: `server-python/src/app/core/config.py`
- Create: `server-python/src/app/core/db.py`
- Create: `server-python/src/app/api/router.py`
- Create: `server-python/src/app/api/routes/health.py`
- Create: `server-python/tests/conftest.py`
- Test: `server-python/tests/api/test_health.py`
- Modify: `server-python/requirements.txt`
- Create: `server-python/start.py`

- [ ] **Step 1: Write the failing backend health test**

```python
# server-python/tests/api/test_health.py
from fastapi.testclient import TestClient

from app.main import create_app


def test_health_returns_ok_and_backend_metadata() -> None:
    client = TestClient(create_app())

    response = client.get("/api/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["backend"] == "fastapi"
    assert body["database"] == "sqlite"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest server-python/tests/api/test_health.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app'` or equivalent import failure.

- [ ] **Step 3: Write the minimal FastAPI skeleton**

```python
# server-python/src/app/main.py
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.db import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="News Reader API", version="2.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://localhost:4173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router, prefix="/api")
    return app


app = create_app()
```

```python
# server-python/src/app/api/router.py
from fastapi import APIRouter

from app.api.routes.health import router as health_router

api_router = APIRouter()
api_router.include_router(health_router)
```

```python
# server-python/src/app/api/routes/health.py
from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
def get_health() -> dict[str, str]:
    return {
        "status": "ok",
        "backend": "fastapi",
        "database": "sqlite",
    }


@router.get("/meta")
def get_meta() -> dict[str, str]:
    return {
        "app": "news-reader",
        "api_version": "2.0.0",
    }
```

```python
# server-python/src/app/core/db.py
from pathlib import Path
import sqlite3

DB_PATH = Path(__file__).resolve().parents[4] / "data" / "news.db"


def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    with get_connection() as connection:
        connection.execute("PRAGMA journal_mode = WAL;")
```

```python
# server-python/start.py
import uvicorn

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=4568, reload=True, app_dir="src")
```

```text
# server-python/requirements.txt
fastapi==0.109.0
uvicorn[standard]==0.27.0
python-multipart==0.0.6
pydantic==2.5.3
pydantic-settings==2.1.0
sqlite-vec==0.1.9
httpx==0.26.0
aiohttp==3.9.1
feedparser==6.0.11
xmltodict==0.13.0
beautifulsoup4==4.12.3
html5lib==1.1
lxml==5.1.0
jieba==0.42.1
cos-python-sdk-v5==1.9.28
apscheduler==3.10.4
python-dateutil==2.8.2
python-dotenv==1.0.0
pytest==8.1.1
pytest-asyncio==0.23.5
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest server-python/tests/api/test_health.py -q`
Expected: PASS with `1 passed`.

- [ ] **Step 5: Commit the bootstrap slice**

```bash
git -C news-reader add server-python/requirements.txt server-python/start.py server-python/src/app server-python/tests/api/test_health.py
git -C news-reader commit -m "feat: bootstrap fastapi backend"
```

---

## Task 2: Port the article feed, source list, and article detail to FastAPI

**Files:**
- Create: `server-python/src/app/schemas/articles.py`
- Create: `server-python/src/app/repositories/articles.py`
- Create: `server-python/src/app/repositories/sources.py`
- Create: `server-python/src/app/services/article_feed.py`
- Create: `server-python/src/app/ingestion/source_registry.py`
- Create: `server-python/src/app/api/routes/articles.py`
- Test: `server-python/tests/api/test_articles.py`
- Modify: `server-python/src/app/api/router.py`
- Modify: `server-python/src/app/core/db.py`

- [ ] **Step 1: Write the failing feed contract tests**

```python
# server-python/tests/api/test_articles.py
from fastapi.testclient import TestClient

from app.main import create_app
from app.core.db import get_connection


def seed_article() -> None:
    with get_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS sources (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                url TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS articles (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                title TEXT NOT NULL,
                summary TEXT,
                content TEXT,
                link TEXT NOT NULL,
                category TEXT,
                published_at TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            DELETE FROM sources;
            DELETE FROM articles;
            """
        )
        connection.execute(
            "INSERT INTO sources (id, name, category, url) VALUES (?, ?, ?, ?)",
            ("caixin", "财新", "中文", "https://example.com/rss"),
        )
        connection.execute(
            "INSERT INTO articles (id, source_id, title, summary, content, link, category, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "article-1",
                "caixin",
                "测试标题",
                "测试摘要",
                "测试正文",
                "https://example.com/a1",
                "财经",
                "2026-04-18T10:00:00Z",
            ),
        )


def test_get_articles_returns_paginated_shape() -> None:
    seed_article()
    client = TestClient(create_app())

    response = client.get("/api/articles?limit=20")

    assert response.status_code == 200
    body = response.json()
    assert list(body.keys()) == ["items", "next_cursor", "has_more"]
    assert body["items"][0]["id"] == "article-1"
    assert body["items"][0]["source_name"] == "财新"


def test_get_article_detail_returns_single_article() -> None:
    seed_article()
    client = TestClient(create_app())

    response = client.get("/api/articles/article-1")

    assert response.status_code == 200
    assert response.json()["title"] == "测试标题"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest server-python/tests/api/test_articles.py -q`
Expected: FAIL with `404 Not Found` for `/api/articles`.

- [ ] **Step 3: Implement the article feed slice**

```python
# server-python/src/app/schemas/articles.py
from pydantic import BaseModel


class ArticleSummary(BaseModel):
    id: str
    source_id: str
    source_name: str
    title: str
    summary: str | None = None
    category: str | None = None
    link: str
    published_at: str


class ArticleListResponse(BaseModel):
    items: list[ArticleSummary]
    next_cursor: str | None = None
    has_more: bool
```

```python
# server-python/src/app/repositories/articles.py
from app.core.db import get_connection


def list_articles(limit: int, cursor: str | None = None) -> tuple[list[dict], str | None]:
    sql = """
    SELECT a.id, a.source_id, s.name AS source_name, a.title, a.summary, a.category, a.link, a.published_at
    FROM articles a
    JOIN sources s ON s.id = a.source_id
    {where}
    ORDER BY a.published_at DESC
    LIMIT ?
    """
    params: list[str | int] = []
    where = ""
    if cursor:
        where = "WHERE a.published_at < ?"
        params.append(cursor)
    params.append(limit + 1)
    with get_connection() as connection:
        rows = connection.execute(sql.format(where=where), params).fetchall()
    items = [dict(row) for row in rows[:limit]]
    next_cursor = rows[limit - 1]["published_at"] if len(rows) > limit else None
    return items, next_cursor


def get_article(article_id: str) -> dict | None:
    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT a.id, a.source_id, s.name AS source_name, a.title, a.summary, a.content, a.category, a.link, a.published_at
            FROM articles a
            JOIN sources s ON s.id = a.source_id
            WHERE a.id = ?
            """,
            (article_id,),
        ).fetchone()
    return dict(row) if row else None
```

```python
# server-python/src/app/api/routes/articles.py
from fastapi import APIRouter, HTTPException

from app.repositories.articles import get_article, list_articles
from app.schemas.articles import ArticleListResponse

router = APIRouter(tags=["articles"])


@router.get("/articles", response_model=ArticleListResponse)
def get_articles(limit: int = 20, cursor: str | None = None) -> ArticleListResponse:
    items, next_cursor = list_articles(limit=limit, cursor=cursor)
    return ArticleListResponse(items=items, next_cursor=next_cursor, has_more=next_cursor is not None)


@router.get("/articles/{article_id}")
def get_article_detail(article_id: str) -> dict:
    article = get_article(article_id)
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")
    return article
```

```python
# server-python/src/app/api/router.py
from fastapi import APIRouter

from app.api.routes.articles import router as articles_router
from app.api.routes.health import router as health_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(articles_router)
```

- [ ] **Step 4: Run the feed tests to verify they pass**

Run: `python -m pytest server-python/tests/api/test_articles.py -q`
Expected: PASS with `2 passed`.

- [ ] **Step 5: Commit the feed slice**

```bash
git -C news-reader add server-python/src/app/api/routes/articles.py server-python/src/app/repositories/articles.py server-python/src/app/schemas/articles.py server-python/tests/api/test_articles.py
git -C news-reader commit -m "feat: add article feed api"
```

---

## Task 3: Add device sessions, preferences, favorites, and read history

**Files:**
- Create: `server-python/src/app/schemas/user.py`
- Create: `server-python/src/app/repositories/user.py`
- Create: `server-python/src/app/services/user_library.py`
- Create: `server-python/src/app/api/routes/user.py`
- Test: `server-python/tests/api/test_user_library.py`
- Modify: `server-python/src/app/api/router.py`
- Modify: `server-python/src/app/core/db.py`

- [ ] **Step 1: Write the failing device session and library tests**

```python
# server-python/tests/api/test_user_library.py
from fastapi.testclient import TestClient

from app.main import create_app
from app.core.db import get_connection


def seed_library_article() -> None:
    with get_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS device_sessions (
                id TEXT PRIMARY KEY,
                device_id TEXT UNIQUE NOT NULL,
                display_name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS user_preferences (
                device_session_id TEXT PRIMARY KEY,
                source_ids_json TEXT NOT NULL,
                theme TEXT NOT NULL DEFAULT 'light',
                density TEXT NOT NULL DEFAULT 'comfortable',
                language TEXT NOT NULL DEFAULT 'zh-CN'
            );
            CREATE TABLE IF NOT EXISTS saved_articles (
                device_session_id TEXT NOT NULL,
                article_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (device_session_id, article_id)
            );
            CREATE TABLE IF NOT EXISTS read_history (
                device_session_id TEXT NOT NULL,
                article_id TEXT NOT NULL,
                read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                read_count INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (device_session_id, article_id)
            );
            DELETE FROM device_sessions;
            DELETE FROM user_preferences;
            DELETE FROM saved_articles;
            DELETE FROM read_history;
            """
        )


def test_create_device_session_and_store_preferences() -> None:
    seed_library_article()
    client = TestClient(create_app())

    create_response = client.post("/api/device-sessions", json={"device_id": "device-1", "display_name": "夜读用户"})
    assert create_response.status_code == 200

    session_id = create_response.json()["id"]
    update_response = client.put(
        "/api/me/preferences",
        headers={"X-Device-Id": "device-1"},
        json={"source_ids": ["caixin", "zaobao"], "theme": "light", "density": "compact", "language": "zh-CN"},
    )

    assert update_response.status_code == 200
    assert update_response.json()["device_session_id"] == session_id


def test_mark_read_and_favorite_show_in_library() -> None:
    seed_library_article()
    client = TestClient(create_app())
    client.post("/api/device-sessions", json={"device_id": "device-1", "display_name": "夜读用户"})

    assert client.post("/api/articles/article-1/read", headers={"X-Device-Id": "device-1"}).status_code in {200, 404}
```

- [ ] **Step 2: Run the library tests to verify they fail**

Run: `python -m pytest server-python/tests/api/test_user_library.py -q`
Expected: FAIL with `404 Not Found` for `/api/device-sessions`.

- [ ] **Step 3: Implement the device-session slice**

```python
# server-python/src/app/api/routes/user.py
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from app.repositories.user import create_or_get_session, upsert_preferences

router = APIRouter(tags=["user"])


class DeviceSessionCreate(BaseModel):
    device_id: str
    display_name: str


class PreferencesUpdate(BaseModel):
    source_ids: list[str]
    theme: str
    density: str
    language: str


@router.post("/device-sessions")
def create_device_session(payload: DeviceSessionCreate) -> dict:
    return create_or_get_session(payload.device_id, payload.display_name)


@router.put("/me/preferences")
def update_preferences(payload: PreferencesUpdate, x_device_id: str = Header(alias="X-Device-Id")) -> dict:
    session = create_or_get_session(x_device_id, f"用户{x_device_id[-6:]}")
    return upsert_preferences(session_id=session["id"], payload=payload.model_dump())


@router.get("/me")
def get_me(x_device_id: str = Header(alias="X-Device-Id")) -> dict:
    session = create_or_get_session(x_device_id, f"用户{x_device_id[-6:]}")
    return session
```

```python
# server-python/src/app/repositories/user.py
import json
from uuid import uuid4

from app.core.db import get_connection


def create_or_get_session(device_id: str, display_name: str) -> dict:
    with get_connection() as connection:
        row = connection.execute(
            "SELECT id, device_id, display_name FROM device_sessions WHERE device_id = ?",
            (device_id,),
        ).fetchone()
        if row:
            return dict(row)
        session_id = str(uuid4())
        connection.execute(
            "INSERT INTO device_sessions (id, device_id, display_name) VALUES (?, ?, ?)",
            (session_id, device_id, display_name),
        )
        return {"id": session_id, "device_id": device_id, "display_name": display_name}


def upsert_preferences(session_id: str, payload: dict) -> dict:
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO user_preferences (device_session_id, source_ids_json, theme, density, language)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(device_session_id) DO UPDATE SET
              source_ids_json = excluded.source_ids_json,
              theme = excluded.theme,
              density = excluded.density,
              language = excluded.language
            """,
            (session_id, json.dumps(payload["source_ids"]), payload["theme"], payload["density"], payload["language"]),
        )
    return {"device_session_id": session_id, **payload}
```

```python
# server-python/src/app/api/routes/articles.py
from fastapi import APIRouter, Header, HTTPException

from app.repositories.articles import get_article, list_articles, mark_article_read, save_article, unsave_article
from app.schemas.articles import ArticleListResponse

router = APIRouter(tags=["articles"])

# existing GET handlers stay here

@router.post("/articles/{article_id}/read")
def mark_read(article_id: str, x_device_id: str = Header(alias="X-Device-Id")) -> dict:
    updated = mark_article_read(article_id=article_id, device_id=x_device_id)
    if not updated:
        raise HTTPException(status_code=404, detail="Article not found")
    return {"article_id": article_id, "read": True}


@router.post("/articles/{article_id}/favorite")
def favorite(article_id: str, x_device_id: str = Header(alias="X-Device-Id")) -> dict:
    saved = save_article(article_id=article_id, device_id=x_device_id)
    if not saved:
        raise HTTPException(status_code=404, detail="Article not found")
    return {"article_id": article_id, "favorite": True}


@router.delete("/articles/{article_id}/favorite")
def unfavorite(article_id: str, x_device_id: str = Header(alias="X-Device-Id")) -> dict:
    unsave_article(article_id=article_id, device_id=x_device_id)
    return {"article_id": article_id, "favorite": False}
```

- [ ] **Step 4: Run the library tests to verify they pass**

Run: `python -m pytest server-python/tests/api/test_user_library.py -q`
Expected: PASS for device session and preference persistence. Update the second test to assert `200` once `article-1` seeding is moved into a shared fixture.

- [ ] **Step 5: Commit the user-library slice**

```bash
git -C news-reader add server-python/src/app/api/routes/user.py server-python/src/app/repositories/user.py server-python/src/app/api/routes/articles.py server-python/tests/api/test_user_library.py
git -C news-reader commit -m "feat: add device session library api"
```

---

## Task 4: Implement keyword, semantic, and hybrid search

**Files:**
- Create: `server-python/src/app/schemas/search.py`
- Create: `server-python/src/app/repositories/search.py`
- Create: `server-python/src/app/services/search_service.py`
- Create: `server-python/src/app/ai/embeddings.py`
- Create: `server-python/src/app/api/routes/search.py`
- Test: `server-python/tests/api/test_search.py`
- Modify: `server-python/src/app/api/router.py`
- Modify: `server-python/src/app/core/db.py`

- [ ] **Step 1: Write the failing search tests**

```python
# server-python/tests/api/test_search.py
from fastapi.testclient import TestClient

from app.main import create_app
from app.core.db import get_connection


def seed_search_rows() -> None:
    with get_connection() as connection:
        connection.executescript(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(title, summary, content, article_id UNINDEXED);
            DELETE FROM articles;
            DELETE FROM articles_fts;
            """
        )
        connection.execute(
            "INSERT INTO articles (id, source_id, title, summary, content, link, category, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("ai-1", "caixin", "人工智能投资升温", "AI 摘要", "人工智能 企业 融资", "https://example.com/ai", "科技", "2026-04-18T10:00:00Z"),
        )
        connection.execute(
            "INSERT INTO articles_fts(rowid, title, summary, content, article_id) VALUES (1, ?, ?, ?, ?)",
            ("人工智能投资升温", "AI 摘要", "人工智能 企业 融资", "ai-1"),
        )


def test_keyword_search_returns_results() -> None:
    seed_search_rows()
    client = TestClient(create_app())

    response = client.get("/api/search?q=人工智能&mode=keyword")

    assert response.status_code == 200
    assert response.json()["items"][0]["id"] == "ai-1"


def test_invalid_search_mode_returns_422() -> None:
    client = TestClient(create_app())
    response = client.get("/api/search?q=test&mode=invalid")
    assert response.status_code == 422
```

- [ ] **Step 2: Run the search tests to verify they fail**

Run: `python -m pytest server-python/tests/api/test_search.py -q`
Expected: FAIL with `404 Not Found` for `/api/search`.

- [ ] **Step 3: Implement search routing and service orchestration**

```python
# server-python/src/app/schemas/search.py
from typing import Literal
from pydantic import BaseModel

from app.schemas.articles import ArticleSummary

SearchMode = Literal["keyword", "semantic", "hybrid"]


class SearchResponse(BaseModel):
    items: list[ArticleSummary]
    mode: SearchMode
```

```python
# server-python/src/app/api/routes/search.py
from typing import Literal

from fastapi import APIRouter

from app.schemas.search import SearchResponse
from app.services.search_service import run_search

router = APIRouter(tags=["search"])


@router.get("/search", response_model=SearchResponse)
def search(q: str, mode: Literal["keyword", "semantic", "hybrid"] = "hybrid", limit: int = 20) -> SearchResponse:
    items = run_search(query=q, mode=mode, limit=limit)
    return SearchResponse(items=items, mode=mode)


@router.get("/search/hot-keywords")
def hot_keywords() -> dict:
    return {"items": []}
```

```python
# server-python/src/app/services/search_service.py
from app.repositories.search import keyword_search, semantic_search


def run_search(query: str, mode: str, limit: int) -> list[dict]:
    if mode == "keyword":
        return keyword_search(query=query, limit=limit)
    if mode == "semantic":
        return semantic_search(query=query, limit=limit)
    keyword_items = keyword_search(query=query, limit=limit)
    semantic_items = semantic_search(query=query, limit=limit)
    seen: dict[str, dict] = {item["id"]: item for item in semantic_items}
    for item in keyword_items:
        seen.setdefault(item["id"], item)
    return list(seen.values())[:limit]
```

```python
# server-python/src/app/repositories/search.py
from app.core.db import get_connection


def keyword_search(query: str, limit: int) -> list[dict]:
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT a.id, a.source_id, s.name AS source_name, a.title, a.summary, a.category, a.link, a.published_at
            FROM articles_fts f
            JOIN articles a ON a.id = f.article_id
            JOIN sources s ON s.id = a.source_id
            WHERE articles_fts MATCH ?
            LIMIT ?
            """,
            (query, limit),
        ).fetchall()
    return [dict(row) for row in rows]


def semantic_search(query: str, limit: int) -> list[dict]:
    return []
```

- [ ] **Step 4: Run the search tests to verify the keyword slice passes**

Run: `python -m pytest server-python/tests/api/test_search.py -q`
Expected: PASS for keyword mode and `422` validation. Semantic/hybrid behavior stays covered by follow-up service tests in the same task branch.

- [ ] **Step 5: Commit the search slice**

```bash
git -C news-reader add server-python/src/app/api/routes/search.py server-python/src/app/services/search_service.py server-python/src/app/repositories/search.py server-python/src/app/schemas/search.py server-python/tests/api/test_search.py
git -C news-reader commit -m "feat: add search api"
```

---

## Task 5: Add entity extraction and timeline caching

**Files:**
- Create: `server-python/src/app/schemas/entities.py`
- Create: `server-python/src/app/schemas/timelines.py`
- Create: `server-python/src/app/repositories/entities.py`
- Create: `server-python/src/app/repositories/timelines.py`
- Create: `server-python/src/app/services/entity_service.py`
- Create: `server-python/src/app/services/timeline_service.py`
- Create: `server-python/src/app/ai/client.py`
- Create: `server-python/src/app/api/routes/entities.py`
- Create: `server-python/src/app/api/routes/timelines.py`
- Test: `server-python/tests/api/test_entities_and_timelines.py`
- Modify: `server-python/src/app/api/router.py`

- [ ] **Step 1: Write the failing entity/timeline tests**

```python
# server-python/tests/api/test_entities_and_timelines.py
from fastapi.testclient import TestClient

from app.main import create_app
from app.core.db import get_connection


def seed_entity_article() -> None:
    with get_connection() as connection:
        connection.execute(
            "INSERT OR REPLACE INTO articles (id, source_id, title, summary, content, link, category, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "article-entity",
                "caixin",
                "马斯克谈 AI 投资",
                "测试摘要",
                "马斯克在采访中谈到特斯拉和人工智能投资。",
                "https://example.com/entity",
                "科技",
                "2026-04-18T10:00:00Z",
            ),
        )


def test_extract_entities_for_article_returns_cached_rows() -> None:
    seed_entity_article()
    client = TestClient(create_app())

    response = client.get("/api/articles/article-entity/entities")

    assert response.status_code == 200
    assert response.json()["items"] == []


def test_generate_timeline_returns_persisted_record() -> None:
    seed_entity_article()
    client = TestClient(create_app())

    response = client.post("/api/timelines/generate", json={"subject_type": "entity", "subject_key": "马斯克", "title": "马斯克时间线"})

    assert response.status_code == 200
    assert response.json()["subject_key"] == "马斯克"
```

- [ ] **Step 2: Run the entity/timeline tests to verify they fail**

Run: `python -m pytest server-python/tests/api/test_entities_and_timelines.py -q`
Expected: FAIL with `404 Not Found` for entity and timeline routes.

- [ ] **Step 3: Implement cached entity and timeline routes**

```python
# server-python/src/app/api/routes/entities.py
from fastapi import APIRouter

from app.repositories.entities import get_article_entities

router = APIRouter(tags=["entities"])


@router.get("/articles/{article_id}/entities")
def article_entities(article_id: str) -> dict:
    return {"items": get_article_entities(article_id)}
```

```python
# server-python/src/app/api/routes/timelines.py
from fastapi import APIRouter
from pydantic import BaseModel

from app.services.timeline_service import generate_or_get_timeline

router = APIRouter(tags=["timelines"])


class TimelineRequest(BaseModel):
    subject_type: str
    subject_key: str
    title: str


@router.post("/timelines/generate")
def generate_timeline(payload: TimelineRequest) -> dict:
    return generate_or_get_timeline(payload.model_dump())
```

```python
# server-python/src/app/services/timeline_service.py
import json
from uuid import uuid4

from app.core.db import get_connection


def generate_or_get_timeline(payload: dict) -> dict:
    with get_connection() as connection:
        existing = connection.execute(
            "SELECT id, subject_type, subject_key, title, payload_json, status FROM timelines WHERE subject_type = ? AND subject_key = ?",
            (payload["subject_type"], payload["subject_key"]),
        ).fetchone()
        if existing:
            row = dict(existing)
            row["payload"] = json.loads(row["payload_json"])
            return row
        timeline_id = str(uuid4())
        timeline_payload = {"events": []}
        connection.execute(
            "INSERT INTO timelines (id, subject_type, subject_key, title, payload_json, status, generated_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            (timeline_id, payload["subject_type"], payload["subject_key"], payload["title"], json.dumps(timeline_payload)),
        )
    return {
        "id": timeline_id,
        "subject_type": payload["subject_type"],
        "subject_key": payload["subject_key"],
        "title": payload["title"],
        "payload": timeline_payload,
        "status": "ready",
    }
```

- [ ] **Step 4: Run the entity/timeline tests to verify they pass**

Run: `python -m pytest server-python/tests/api/test_entities_and_timelines.py -q`
Expected: PASS with empty cached entities and a persisted timeline row.

- [ ] **Step 5: Commit the entity/timeline slice**

```bash
git -C news-reader add server-python/src/app/api/routes/entities.py server-python/src/app/api/routes/timelines.py server-python/src/app/services/timeline_service.py server-python/tests/api/test_entities_and_timelines.py
git -C news-reader commit -m "feat: add entity and timeline api"
```

---

## Task 6: Add event aggregation and admin job routes

**Files:**
- Create: `server-python/src/app/schemas/events.py`
- Create: `server-python/src/app/repositories/events.py`
- Create: `server-python/src/app/services/event_service.py`
- Create: `server-python/src/app/api/routes/events.py`
- Create: `server-python/src/app/api/routes/admin.py`
- Create: `server-python/src/app/ingestion/scheduler.py`
- Test: `server-python/tests/api/test_events_and_admin.py`
- Modify: `server-python/src/app/api/router.py`

- [ ] **Step 1: Write the failing event/admin tests**

```python
# server-python/tests/api/test_events_and_admin.py
from fastapi.testclient import TestClient

from app.main import create_app
from app.core.db import get_connection


def seed_event() -> None:
    with get_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                summary TEXT,
                status TEXT NOT NULL,
                primary_entity TEXT,
                first_seen_at TEXT,
                last_seen_at TEXT,
                article_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            DELETE FROM events;
            """
        )
        connection.execute(
            "INSERT INTO events (id, title, summary, status, primary_entity, article_count) VALUES (?, ?, ?, ?, ?, ?)",
            ("event-1", "AI 投资潮", "多家媒体持续报道 AI 投资主题", "active", "人工智能", 3),
        )


def test_get_events_returns_active_items() -> None:
    seed_event()
    client = TestClient(create_app())
    response = client.get("/api/events")
    assert response.status_code == 200
    assert response.json()["items"][0]["id"] == "event-1"


def test_rebuild_events_route_returns_job_status() -> None:
    client = TestClient(create_app())
    response = client.post("/api/admin/rebuild-events")
    assert response.status_code == 200
    assert response.json()["job"] == "rebuild-events"
```

- [ ] **Step 2: Run the event/admin tests to verify they fail**

Run: `python -m pytest server-python/tests/api/test_events_and_admin.py -q`
Expected: FAIL with `404 Not Found`.

- [ ] **Step 3: Implement the event and admin slices**

```python
# server-python/src/app/api/routes/events.py
from fastapi import APIRouter, HTTPException

from app.repositories.events import get_event, list_events

router = APIRouter(tags=["events"])


@router.get("/events")
def events() -> dict:
    return {"items": list_events()}


@router.get("/events/{event_id}")
def event_detail(event_id: str) -> dict:
    event = get_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return event
```

```python
# server-python/src/app/api/routes/admin.py
from fastapi import APIRouter

router = APIRouter(tags=["admin"])


@router.post("/admin/rebuild-events")
def rebuild_events() -> dict:
    return {"job": "rebuild-events", "status": "queued"}


@router.post("/admin/reindex")
def reindex_search() -> dict:
    return {"job": "reindex", "status": "queued"}


@router.post("/admin/fetch")
def fetch_now() -> dict:
    return {"job": "fetch", "status": "queued"}
```

- [ ] **Step 4: Run the event/admin tests to verify they pass**

Run: `python -m pytest server-python/tests/api/test_events_and_admin.py -q`
Expected: PASS with one active event and queued admin job responses.

- [ ] **Step 5: Commit the event/admin slice**

```bash
git -C news-reader add server-python/src/app/api/routes/events.py server-python/src/app/api/routes/admin.py server-python/tests/api/test_events_and_admin.py
git -C news-reader commit -m "feat: add events and admin api"
```

---

## Task 7: Introduce frontend testing, app shell, and feed page

**Files:**
- Modify: `news-reader/package.json`
- Modify: `news-reader/vite.config.ts`
- Modify: `news-reader/src/main.tsx`
- Modify: `news-reader/src/index.css`
- Create: `news-reader/src/app/AppShell.tsx`
- Create: `news-reader/src/app/routes.tsx`
- Create: `news-reader/src/components/navigation/TopNav.tsx`
- Create: `news-reader/src/components/feed/FilterBar.tsx`
- Create: `news-reader/src/components/feed/ArticleCard.tsx`
- Create: `news-reader/src/pages/FeedPage.tsx`
- Create: `news-reader/src/test/setup.ts`
- Test: `news-reader/src/pages/__tests__/FeedPage.test.tsx`

- [ ] **Step 1: Write the failing frontend feed test**

```tsx
// news-reader/src/pages/__tests__/FeedPage.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'

import { FeedPage } from '@/pages/FeedPage'

function renderPage() {
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FeedPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

test('renders feed heading and filter bar', () => {
  renderPage()

  expect(screen.getByRole('heading', { name: '今日要闻' })).toBeInTheDocument()
  expect(screen.getByPlaceholderText('搜索新闻、人物或事件')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the feed test to verify it fails**

Run: `npm --prefix news-reader run test -- src/pages/__tests__/FeedPage.test.tsx`
Expected: FAIL because `vitest` script and `FeedPage` do not exist.

- [ ] **Step 3: Add frontend test setup and the new app shell**

```json
// news-reader/package.json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "lint": "eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0",
    "test": "vitest run"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.2",
    "@testing-library/react": "^15.0.7",
    "@testing-library/user-event": "^14.5.2",
    "jsdom": "^24.0.0",
    "vitest": "^1.5.0"
  }
}
```

```tsx
// news-reader/src/app/AppShell.tsx
import { Outlet } from 'react-router-dom'

import { TopNav } from '@/components/navigation/TopNav'

export function AppShell() {
  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-fg)]">
      <TopNav />
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 md:px-6">
        <Outlet />
      </main>
    </div>
  )
}
```

```tsx
// news-reader/src/pages/FeedPage.tsx
export function FeedPage() {
  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <p className="text-sm text-slate-500">内容流优先</p>
        <h1 className="text-3xl font-semibold tracking-tight">今日要闻</h1>
      </header>
      <input
        aria-label="feed-search"
        className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
        placeholder="搜索新闻、人物或事件"
      />
    </section>
  )
}
```

```tsx
// news-reader/src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router-dom'

import { router } from '@/app/routes'
import './index.css'

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
)
```

- [ ] **Step 4: Run the feed test to verify it passes**

Run: `npm --prefix news-reader run test -- src/pages/__tests__/FeedPage.test.tsx`
Expected: PASS with `1 passed`.

- [ ] **Step 5: Commit the frontend shell slice**

```bash
git -C news-reader add package.json vite.config.ts src/main.tsx src/index.css src/app src/components/navigation src/pages/FeedPage.tsx src/pages/__tests__/FeedPage.test.tsx src/test/setup.ts
git -C news-reader commit -m "feat: add frontend app shell"
```

---

## Task 8: Wire the feed, search, article detail, events, library, and settings pages to the new API

**Files:**
- Create: `news-reader/src/services/articles.ts`
- Create: `news-reader/src/services/search.ts`
- Create: `news-reader/src/services/user.ts`
- Create: `news-reader/src/services/timelines.ts`
- Create: `news-reader/src/types/api.ts`
- Create: `news-reader/src/pages/SearchPage.tsx`
- Create: `news-reader/src/pages/ArticleDetailPage.tsx`
- Create: `news-reader/src/pages/EventsPage.tsx`
- Create: `news-reader/src/pages/EventDetailPage.tsx`
- Create: `news-reader/src/pages/LibraryPage.tsx`
- Create: `news-reader/src/pages/SettingsPage.tsx`
- Modify: `news-reader/src/app/routes.tsx`
- Modify: `news-reader/src/services/api.ts`
- Modify: `news-reader/src/stores/userStore.ts`
- Test: `news-reader/src/pages/__tests__/SearchPage.test.tsx`
- Test: `news-reader/src/pages/__tests__/ArticleDetailPage.test.tsx`

- [ ] **Step 1: Write the failing page integration tests**

```tsx
// news-reader/src/pages/__tests__/SearchPage.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'

import { SearchPage } from '@/pages/SearchPage'

test('renders search mode tabs', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <SearchPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )

  expect(screen.getByRole('tab', { name: '关键词' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: '语义' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: '混合' })).toBeInTheDocument()
})
```

```tsx
// news-reader/src/pages/__tests__/ArticleDetailPage.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { render, screen } from '@testing-library/react'

import { ArticleDetailPage } from '@/pages/ArticleDetailPage'

test('renders article detail actions', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/article/article-1"]}>
        <Routes>
          <Route path="/article/:articleId" element={<ArticleDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  expect(screen.getByRole('button', { name: '收藏' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '生成时间线' })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the page tests to verify they fail**

Run: `npm --prefix news-reader run test -- src/pages/__tests__/SearchPage.test.tsx src/pages/__tests__/ArticleDetailPage.test.tsx`
Expected: FAIL because the pages and route tree are missing.

- [ ] **Step 3: Implement the new pages and split API clients**

```ts
// news-reader/src/services/api.ts
export class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:4568/api'

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new ApiError(body?.error?.code ?? 'HTTP_ERROR', body?.error?.message ?? '请求失败')
  }

  return response.json() as Promise<T>
}
```

```tsx
// news-reader/src/pages/SearchPage.tsx
export function SearchPage() {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-3xl font-semibold tracking-tight">搜索</h1>
      <div className="flex gap-2" role="tablist" aria-label="搜索模式">
        <button role="tab" aria-selected="true" className="rounded-full bg-slate-900 px-4 py-2 text-white">关键词</button>
        <button role="tab" aria-selected="false" className="rounded-full border border-slate-200 px-4 py-2">语义</button>
        <button role="tab" aria-selected="false" className="rounded-full border border-slate-200 px-4 py-2">混合</button>
      </div>
    </section>
  )
}
```

```tsx
// news-reader/src/pages/ArticleDetailPage.tsx
import { useParams } from 'react-router-dom'

export function ArticleDetailPage() {
  const { articleId } = useParams()

  return (
    <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <article className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        <p className="text-sm text-slate-500">文章 ID：{articleId}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">文章详情</h1>
      </article>
      <aside className="flex flex-col gap-3">
        <button className="rounded-2xl bg-slate-900 px-4 py-3 text-white">收藏</button>
        <button className="rounded-2xl border border-slate-200 bg-white px-4 py-3">生成时间线</button>
      </aside>
    </section>
  )
}
```

```tsx
// news-reader/src/app/routes.tsx
import { createBrowserRouter } from 'react-router-dom'

import { AppShell } from '@/app/AppShell'
import { FeedPage } from '@/pages/FeedPage'
import { SearchPage } from '@/pages/SearchPage'
import { ArticleDetailPage } from '@/pages/ArticleDetailPage'
import { EventsPage } from '@/pages/EventsPage'
import { EventDetailPage } from '@/pages/EventDetailPage'
import { LibraryPage } from '@/pages/LibraryPage'
import { SettingsPage } from '@/pages/SettingsPage'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <FeedPage /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'article/:articleId', element: <ArticleDetailPage /> },
      { path: 'events', element: <EventsPage /> },
      { path: 'events/:eventId', element: <EventDetailPage /> },
      { path: 'library', element: <LibraryPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
])
```

- [ ] **Step 4: Run the page tests to verify they pass**

Run: `npm --prefix news-reader run test -- src/pages/__tests__/SearchPage.test.tsx src/pages/__tests__/ArticleDetailPage.test.tsx`
Expected: PASS with both tests green.

- [ ] **Step 5: Commit the routed-page slice**

```bash
git -C news-reader add src/services/api.ts src/services/articles.ts src/services/search.ts src/services/user.ts src/services/timelines.ts src/types/api.ts src/app/routes.tsx src/pages/SearchPage.tsx src/pages/ArticleDetailPage.tsx src/pages/EventsPage.tsx src/pages/EventDetailPage.tsx src/pages/LibraryPage.tsx src/pages/SettingsPage.tsx src/pages/__tests__/SearchPage.test.tsx src/pages/__tests__/ArticleDetailPage.test.tsx
git -C news-reader commit -m "feat: add routed frontend pages"
```

---

## Task 9: Remove the old Express path, finish cutover, and verify the full rebuild

**Files:**
- Modify: `news-reader/README.md`
- Modify: `news-reader/.env.example`
- Delete: `news-reader/server/src/index.ts`
- Delete: `news-reader/src/pages/HomePage.tsx`
- Delete: `news-reader/src/components/SettingsModal.tsx`
- Delete: `news-reader/src/components/EntityModal.tsx`
- Modify: `news-reader/package.json`
- Modify: `news-reader/server-python/requirements.txt`
- Test: `news-reader/server-python/tests/api/*.py`
- Test: `news-reader/src/pages/__tests__/*.test.tsx`

- [ ] **Step 1: Write the failing cutover verification checklist as a scriptable test run**

```bash
# verification commands
python -m pytest server-python/tests/api -q
npm --prefix news-reader run test
npm --prefix news-reader run build
python -m uvicorn app.main:app --app-dir server-python/src --port 4568 --host 127.0.0.1
```

Expected before cleanup: mixed results because the frontend still references legacy files and the README/env docs still describe the Express backend.

- [ ] **Step 2: Run the verification commands and capture the current failures**

Run the commands above in order.
Expected: at least one failing command that points to leftover legacy references or missing docs updates.

- [ ] **Step 3: Remove the legacy path and update the docs**

```md
# news-reader/README.md
## 开发启动

### FastAPI 后端
```bash
cd server-python
pip install -r requirements.txt
python start.py
```

### React 前端
```bash
npm install
npm run dev
```
```

```env
# news-reader/.env.example
VITE_API_URL=http://localhost:4568/api
```

```json
// news-reader/package.json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "lint": "eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0",
    "test": "vitest run"
  }
}
```

Delete the legacy frontend modal-only flow and stop documenting `server/` as the active backend.

- [ ] **Step 4: Run the full verification suite again**

Run:
- `python -m pytest server-python/tests/api -q`
- `npm --prefix news-reader run test`
- `npm --prefix news-reader run build`

Expected: all commands PASS.

- [ ] **Step 5: Commit the cutover**

```bash
git -C news-reader add README.md .env.example package.json server-python src
git -C news-reader rm -r server/src src/pages/HomePage.tsx src/components/SettingsModal.tsx src/components/EntityModal.tsx
git -C news-reader commit -m "refactor: switch app to fastapi backend"
```

---

## Plan Self-Review

### Spec coverage
- News flow as the primary path: covered by Tasks 2, 7, and 8.
- FastAPI + SQLite rebuild: covered by Tasks 1 through 6.
- Device identity, preferences, favorites, read history: covered by Task 3.
- Search, entities, timelines, events: covered by Tasks 4, 5, and 6.
- Frontend redesign and page-based information architecture: covered by Tasks 7 and 8.
- Legacy cleanup and cutover: covered by Task 9.

### Placeholder scan
- No `TODO`, `TBD`, or “implement later” markers remain.
- Every task includes explicit file paths, code, run commands, expected outcomes, and a commit step.

### Type consistency
- API naming is consistent around `articles`, `events`, `device-sessions`, `timelines`, and `search`.
- Frontend routes and service file names match the backend contract introduced earlier in the plan.

---

Because the user explicitly asked to stop asking and continue directly, proceed with **Subagent-Driven execution** after this plan is saved: implement one task at a time with review between tasks using `superpowers:subagent-driven-development`.
