from __future__ import annotations

import asyncio
import json

import httpx
from fastapi.testclient import TestClient
from fastapi.security import HTTPAuthorizationCredentials

from app.core.config import Settings
from app.core.errors import FeatureNotAvailableError
from app.features.dependencies import get_feature_flag_repository, require_feature
from app.features.models import FeatureDecision
from app.features.repository import SupabaseFeatureFlagRepository
from app.main import app


client = TestClient(app, raise_server_exceptions=False)


class FakeRepository:
    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self.calls: list[tuple[tuple[str, ...], str | None, str | None]] = []

    async def evaluate(self, keys, *, access_token, visitor_id):
        self.calls.append((keys, access_token, visitor_id))
        return [FeatureDecision(key=key, enabled=self.enabled, revision=7) for key in keys]


def test_feature_evaluations_are_subject_specific_and_private() -> None:
    repository = FakeRepository()
    app.dependency_overrides[get_feature_flag_repository] = lambda: repository
    try:
        response = client.get(
            "/v1/features/evaluations?keys=library.bookshelf,agent.chat",
            headers={
                "Authorization": "Bearer reader-token",
                "X-JOJO-Visitor-ID": "12345678-1234-4234-8234-123456789abc",
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["flags"] == {"library.bookshelf": True, "agent.chat": True}
    assert response.json()["revision"]
    assert response.headers["cache-control"] == "private, max-age=30"
    assert response.headers["etag"]
    assert response.headers["vary"] == "Authorization, X-JOJO-Visitor-ID"
    assert repository.calls == [(
        ("library.bookshelf", "agent.chat"),
        "reader-token",
        "12345678-1234-4234-8234-123456789abc",
    )]


def test_feature_evaluations_reject_invalid_keys_and_visitor_ids() -> None:
    repository = FakeRepository()
    app.dependency_overrides[get_feature_flag_repository] = lambda: repository
    try:
        invalid_key = client.get("/v1/features/evaluations?keys=Bad Flag")
        invalid_visitor = client.get(
            "/v1/features/evaluations?keys=agent.chat",
            headers={"X-JOJO-Visitor-ID": "pick-a-bucket"},
        )
    finally:
        app.dependency_overrides.clear()

    assert invalid_key.status_code == 422
    assert invalid_key.json()["error"]["code"] == "invalid_feature_keys"
    assert invalid_visitor.status_code == 422
    assert invalid_visitor.json()["error"]["code"] == "invalid_visitor_id"
    assert repository.calls == []


def test_require_feature_fails_closed() -> None:
    gate = require_feature("agent.chat")
    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="reader-token")

    asyncio.run(gate(credentials=credentials, repository=FakeRepository(enabled=True)))
    try:
        asyncio.run(gate(credentials=credentials, repository=FakeRepository(enabled=False)))
    except FeatureNotAvailableError as error:
        assert error.code == "feature_not_available"
    else:
        raise AssertionError("FeatureNotAvailableError was not raised")


def test_supabase_feature_repository_calls_the_authoritative_rpc() -> None:
    def upstream(request: httpx.Request) -> httpx.Response:
        assert request.url == "https://project.supabase.co/rest/v1/rpc/get_my_feature_flags"
        assert request.headers["authorization"] == "Bearer access-token"
        assert request.headers["apikey"] == "publishable-key"
        assert json.loads(request.read()) == {"p_keys": ["agent.chat"], "p_visitor_id": None}
        return httpx.Response(200, json=[{"flag_key": "agent.chat", "enabled": True, "revision": 9}])

    settings = Settings(
        environment="test",
        allowed_origins=("https://reader.jojokanbao.cn",),
        supabase_url="https://project.supabase.co",
        supabase_publishable_key="publishable-key",
        auth_timeout_seconds=1.0,
    )
    repository = SupabaseFeatureFlagRepository(settings, transport=httpx.MockTransport(upstream))
    decisions = asyncio.run(repository.evaluate(("agent.chat",), access_token="access-token", visitor_id=None))

    assert decisions == [FeatureDecision(key="agent.chat", enabled=True, revision=9)]
