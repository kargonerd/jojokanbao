from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from app.core.config import Settings


DEMO_NOTEBOOK_ID = "revolution-and-rebellion"
DEMO_SOURCE_ID = "shanghai-cultural-revolution-volume-1"
MAX_DOCUMENT_CHARACTERS = 2_000_000
MAX_SEARCH_RESULTS = 8
SEARCH_CONTEXT_CHARACTERS = 350
MAX_READ_CHARACTERS = 6_000


@dataclass(frozen=True, slots=True)
class LoadedDocument:
    source_id: str
    title: str
    text: str


class RagDocumentRepository:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._cached: LoadedDocument | None = None
        self._cache_signature: tuple[str, float] | None = None

    def configured(self) -> bool:
        return bool(self._settings.rag_document_path or self._settings.rag_document_url)

    async def load(self) -> LoadedDocument:
        path_value = self._settings.rag_document_path
        if path_value:
            path = Path(path_value).expanduser().resolve()
            stat = await asyncio.to_thread(path.stat)
            signature = (str(path), stat.st_mtime)
            if self._cached is not None and self._cache_signature == signature:
                return self._cached
            text = await asyncio.to_thread(path.read_text, encoding="utf-8")
            return self._remember(text, signature)

        url = self._settings.rag_document_url
        if not url:
            raise RuntimeError("RAG document is not configured")
        now = time.monotonic()
        if (
            self._cached is not None
            and self._cache_signature is not None
            and self._cache_signature[0] == url
            and now - self._cache_signature[1] < 300
        ):
            return self._cached
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
        return self._remember(response.text, (url, now))

    def _remember(
        self,
        text: str,
        signature: tuple[str, float],
    ) -> LoadedDocument:
        if not text.strip():
            raise RuntimeError("RAG document is empty")
        if len(text) > MAX_DOCUMENT_CHARACTERS:
            raise RuntimeError("RAG document exceeds the 2,000,000 character limit")
        self._cached = LoadedDocument(
            source_id=DEMO_SOURCE_ID,
            title=self._settings.rag_document_title,
            text=text,
        )
        self._cache_signature = signature
        return self._cached

    async def notebooks(self) -> list[dict[str, Any]]:
        if not self.configured():
            return []
        document = await self.load()
        return [{
            "id": DEMO_NOTEBOOK_ID,
            "title": document.title,
            "sources_count": 1,
        }]

    async def sources(self, notebook_id: str) -> list[dict[str, Any]]:
        if notebook_id != DEMO_NOTEBOOK_ID or not self.configured():
            return []
        document = await self.load()
        return [{
            "id": document.source_id,
            "title": document.title,
            "published": True,
        }]

    async def search(
        self,
        *,
        notebook_id: str,
        source_ids: list[str],
        query: str,
        max_results: int,
    ) -> dict[str, Any]:
        document = await self._selected_document(notebook_id, source_ids)
        terms = self._search_terms(query)
        folded = document.text.casefold()
        matches: list[dict[str, Any]] = []
        seen: set[int] = set()
        for term in terms:
            start = 0
            folded_term = term.casefold()
            while len(matches) < min(max_results, MAX_SEARCH_RESULTS):
                index = folded.find(folded_term, start)
                if index < 0:
                    break
                start = index + max(1, len(folded_term))
                window_start = max(0, index - SEARCH_CONTEXT_CHARACTERS)
                if any(abs(window_start - previous) < 200 for previous in seen):
                    continue
                seen.add(window_start)
                window_end = min(
                    len(document.text),
                    index + len(term) + SEARCH_CONTEXT_CHARACTERS,
                )
                matches.append({
                    "source_id": document.source_id,
                    "title": document.title,
                    "query": term,
                    "start": window_start,
                    "end": window_end,
                    "text": document.text[window_start:window_end],
                })
            if len(matches) >= min(max_results, MAX_SEARCH_RESULTS):
                break
        return {
            "query": query,
            "matches": matches,
            "hint": (
                "No literal matches. Try shorter terms, synonyms, names, dates, "
                "or traditional Chinese variants."
                if not matches
                else None
            ),
        }

    async def read(
        self,
        *,
        notebook_id: str,
        source_ids: list[str],
        source_id: str,
        start: int,
        length: int,
    ) -> dict[str, Any]:
        document = await self._selected_document(notebook_id, source_ids)
        if source_id != document.source_id:
            raise ValueError("Source is not selected")
        resolved_start = min(max(start, 0), len(document.text))
        resolved_length = min(max(length, 1), MAX_READ_CHARACTERS)
        end = min(len(document.text), resolved_start + resolved_length)
        return {
            "source_id": document.source_id,
            "title": document.title,
            "start": resolved_start,
            "end": end,
            "total_characters": len(document.text),
            "text": document.text[resolved_start:end],
        }

    async def _selected_document(
        self,
        notebook_id: str,
        source_ids: list[str],
    ) -> LoadedDocument:
        if notebook_id != DEMO_NOTEBOOK_ID:
            raise ValueError("Notebook not found")
        document = await self.load()
        if document.source_id not in source_ids:
            raise ValueError("No configured source is selected")
        return document

    @staticmethod
    def _search_terms(query: str) -> list[str]:
        normalized = query.strip()
        if not normalized:
            raise ValueError("Search query is required")
        parts = [
            part.strip()
            for part in re.split(r"[\s,，、;；|]+", normalized)
            if len(part.strip()) >= 2
        ]
        return list(dict.fromkeys([normalized, *parts]))
