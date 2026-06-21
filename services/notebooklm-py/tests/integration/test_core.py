"""Integration tests for client initialization and core functionality."""

import pytest

from notebooklm import NotebookLMClient


class TestClientInitialization:
    @pytest.mark.asyncio
    async def test_client_initialization(self, auth_tokens):
        async with NotebookLMClient(auth_tokens) as client:
            assert client._core.auth == auth_tokens
            assert client._core._http_client is not None

    @pytest.mark.asyncio
    async def test_client_context_manager_closes(self, auth_tokens):
        async with NotebookLMClient(auth_tokens) as client:
            assert client._core._http_client is not None  # client is open
        assert client._core._http_client is None  # closed after exit

    @pytest.mark.asyncio
    async def test_client_raises_if_not_initialized(self, auth_tokens):
        client = NotebookLMClient(auth_tokens)
        with pytest.raises(RuntimeError, match="not initialized"):
            await client.notebooks.list()
