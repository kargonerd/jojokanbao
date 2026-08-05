from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.auth import get_current_user
from app.core.config import Settings, get_settings
from app.core.models import CurrentUser
from app.core.service_auth import create_service_headers
from app.main import app
from app.rag.agent_client import AgentClient
from app.rag.documents import (
    DEMO_NOTEBOOK_ID,
    DEMO_SOURCE_ID,
    RagDocumentRepository,
)


SECRET = "0123456789abcdef0123456789abcdef"


def configured_settings(document: Path) -> Settings:
    return Settings(
        environment="test",
        allowed_origins=("http://localhost:8080",),
        supabase_url="https://project.supabase.co",
        supabase_publishable_key="publishable-key",
        auth_timeout_seconds=1.0,
        agent_internal_url="https://agent.example/internal-agent",
        agent_service_secret=SECRET,
        agent_timeout_seconds=10.0,
        rag_document_path=str(document),
        rag_document_title="测试文档",
    )


def test_python_service_signature_matches_agent_fixture() -> None:
    headers = create_service_headers(
        body={
            "application": "rag",
            "message": "你好",
            "rag": {"notebookId": "book", "sourceIds": ["source"]},
            "systemPrompt": "只依据原文",
            "userId": "user-1",
        },
        conversation_id="conversation-001",
        method="POST",
        secret=SECRET,
        now=1_800_000_000,
        nonce="nonce_0000000000000000000099",
    )

    assert headers["X-JOJO-Service-Signature"] == (
        "9UvMA80GDuJnyan_xsFDM9NjEg7MG7WJBplc-G91XDY"
    )


def test_document_repository_searches_and_reads_raw_markdown(tmp_path: Path) -> None:
    document = tmp_path / "book.md"
    document.write_text(
        "# 第一章\n王洪文参与了工總司的活动。\n"
        "# 第二章\n这里是用于扩大阅读范围的后续内容。",
        encoding="utf-8",
    )
    repository = RagDocumentRepository(configured_settings(document))

    result = asyncio.run(repository.search(
        notebook_id=DEMO_NOTEBOOK_ID,
        source_ids=[DEMO_SOURCE_ID],
        query="王洪文",
        max_results=5,
    ))
    assert len(result["matches"]) == 1
    assert "工總司" in result["matches"][0]["text"]

    excerpt = asyncio.run(repository.read(
        notebook_id=DEMO_NOTEBOOK_ID,
        source_ids=[DEMO_SOURCE_ID],
        source_id=DEMO_SOURCE_ID,
        start=result["matches"][0]["start"],
        length=80,
    ))
    assert excerpt["title"] == "测试文档"
    assert "王洪文" in excerpt["text"]


def test_internal_document_endpoint_requires_valid_service_signature(
    tmp_path: Path,
) -> None:
    document = tmp_path / "book.md"
    document.write_text("王洪文与工總司。\n", encoding="utf-8")
    settings = configured_settings(document)
    body = {
        "user_id": "user-1",
        "notebook_id": DEMO_NOTEBOOK_ID,
        "source_ids": [DEMO_SOURCE_ID],
        "operation": "search",
        "query": "工總司",
        "max_results": 3,
    }
    headers = create_service_headers(
        body=body,
        conversation_id="conversation-001",
        method="POST",
        secret=SECRET,
    )
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            "/v1/internal/rag/documents",
            headers=headers,
            json=body,
        )
        replay = client.post(
            "/v1/internal/rag/documents",
            headers=headers,
            json=body,
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["matches"][0]["query"] == "工總司"
    assert replay.status_code == 401


def test_rag_chat_authenticates_user_and_streams_agent_events(
    tmp_path: Path,
    monkeypatch,
) -> None:
    document = tmp_path / "book.md"
    document.write_text("测试内容", encoding="utf-8")
    settings = configured_settings(document)
    observed: dict[str, object] = {}

    class FakeStream:
        async def chunks(self):
            yield 'event: text_delta\ndata: {"delta":"回答"}\n\n'.encode()
            yield (
                b'event: done\ndata: {"conversationId":"conversation-001",'
                b'"usage":{"totalTokens":12,"cost":{"total":0.01}}}\n\n'
            )

    async def fake_open(self, **kwargs):
        observed.update(kwargs)
        return FakeStream()

    async def fake_user() -> CurrentUser:
        return CurrentUser(id="user-123")

    monkeypatch.setattr(AgentClient, "open_rag_stream", fake_open)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_current_user] = fake_user
    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            "/v1/rag/chat/stream",
            json={
                "notebook_id": DEMO_NOTEBOOK_ID,
                "question": "王洪文是谁？",
                "source_ids": [DEMO_SOURCE_ID],
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert "event: text_delta" in response.text
    assert "event: done" in response.text
    assert observed["user_id"] == "user-123"
    assert observed["question"] == "王洪文是谁？"
