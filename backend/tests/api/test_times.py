from __future__ import annotations

import asyncio

import httpx
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import app
from app.times.router import get_times_service
from app.times.service import TimesFeedService


def times_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "test",
        "allowed_origins": ("https://reader.jojokanbao.cn",),
        "supabase_url": None,
        "supabase_publishable_key": None,
        "auth_timeout_seconds": 1.0,
        "rsshub_url": "https://rsshub.example.test",
        "rsshub_access_key": "protected-key",
        "rsshub_timeout_seconds": 1.0,
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def test_times_service_aggregates_protected_rsshub_routes() -> None:
    seen_keys: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_keys.append(request.url.params.get("key"))
        slug = request.url.path.strip("/").replace("/", "-")
        return httpx.Response(200, content=f"""
          <rss version="2.0"><channel><item>
            <title>{slug} headline</title>
            <link>https://news.example.test/{slug}</link>
            <description><![CDATA[<p>Summary for {slug}</p>]]></description>
            <pubDate>Thu, 21 Aug 2026 10:00:00 GMT</pubDate>
          </item></channel></rss>
        """.encode())

    service = TimesFeedService(times_settings(), transport=httpx.MockTransport(handler))
    news = asyncio.run(service.list_news(100))

    assert len(news) == 20
    assert all(key == "protected-key" for key in seen_keys)
    assert news[0]["url"].startswith("https://news.example.test/")
    assert "protected-key" not in str(news)


def test_times_routes_return_web_contract() -> None:
    item = {
        "id": "news-1",
        "title": "测试新闻",
        "summary": "摘要",
        "content": "正文",
        "url": "https://news.example.test/1",
        "publishedAt": "2026-08-21T10:00:00+00:00",
        "source": {"name": "测试来源"},
    }

    class FakeTimesService:
        async def list_news(self, limit: int):
            return [item][:limit]

        async def get_news(self, news_id: str):
            return item if news_id == item["id"] else None

        async def stats(self):
            return {"total": 1, "sourceCount": 1}

        async def digest(self, limit: int):
            return {
                "articleCount": 1,
                "hotKeywords": [],
                "attentionLanes": [],
                "starterQuestions": [],
                "sourceCounts": [{"name": "测试来源", "count": 1}],
            }

    app.dependency_overrides[get_times_service] = FakeTimesService
    try:
        client = TestClient(app, raise_server_exceptions=False)
        assert client.get("/v1/times/news").json() == [item]
        assert client.get("/v1/times/stats").json() == {"total": 1, "sourceCount": 1}
        assert client.get("/v1/times/news/news-1").json()["news"] == item
        assert client.get("/v1/times/news/missing").status_code == 404
    finally:
        app.dependency_overrides.pop(get_times_service, None)
