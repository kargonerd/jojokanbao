from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

from app.core.config import Settings
from app.core.service_auth import create_service_headers


RAG_SYSTEM_PROMPT = """你是 JOJO 文档问答 Agent。

你只能依据用户选择的文档回答，不得凭记忆补充书外事实。
开始回答前，必须先调用 search_documents 检索原文，再用 read_document 扩大阅读
最相关的段落。优先使用一两个最有区分度的短语，每次最多取 3 条；只有零结果时才
更换关键词，回答一个问题通常不要超过 3 次搜索。OCR 文档可能使用繁体中文，简体
提问时应主动尝试对应繁体、人名、日期和同义词。没有足够证据时明确说不知道。

回答使用与用户问题相同的语言。关键结论后标注原文字符区间，例如
“[source_id: start-end]”。不要声称使用了向量数据库或 NotebookLM。"""


@dataclass(slots=True)
class AgentStream:
    client: httpx.AsyncClient
    response: httpx.Response

    async def chunks(self) -> AsyncIterator[bytes]:
        try:
            async for chunk in self.response.aiter_raw():
                yield chunk
        finally:
            await self.response.aclose()
            await self.client.aclose()


class AgentClient:
    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._transport = transport

    async def open_rag_stream(
        self,
        *,
        user_id: str,
        question: str,
        notebook_id: str,
        source_ids: list[str],
        conversation_id: str | None,
    ) -> AgentStream:
        try:
            endpoint, secret = self._settings.require_agent()
        except RuntimeError as error:
            raise RuntimeError(str(error)) from error

        resolved_conversation_id = conversation_id or uuid.uuid4().hex
        body: dict[str, Any] = {
            "application": "rag",
            "userId": user_id,
            "message": question,
            "systemPrompt": RAG_SYSTEM_PROMPT,
            "rag": {
                "notebookId": notebook_id,
                "sourceIds": source_ids,
            },
        }
        headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            **create_service_headers(
                body=body,
                conversation_id=resolved_conversation_id,
                method="POST",
                secret=secret,
            ),
        }
        timeout = httpx.Timeout(
            connect=10.0,
            read=self._settings.agent_timeout_seconds,
            write=10.0,
            pool=10.0,
        )
        client = httpx.AsyncClient(
            timeout=timeout,
            transport=self._transport,
            follow_redirects=False,
        )
        request = client.build_request("POST", endpoint, headers=headers, json=body)
        try:
            response = await client.send(request, stream=True)
        except Exception:
            await client.aclose()
            raise
        if not response.is_success:
            payload = (await response.aread()).decode("utf-8", errors="replace")
            await response.aclose()
            await client.aclose()
            raise RuntimeError(
                f"Agent returned HTTP {response.status_code}: {payload[:500]}"
            )
        return AgentStream(client=client, response=response)
