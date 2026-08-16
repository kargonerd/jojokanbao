from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import patch


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from app import app  # noqa: E402
from feature_flag_routes import FeatureFlagAdminError, SupabaseFeatureFlagAdminClient  # noqa: E402


class FakeResponse:
    def __init__(self, payload, *, ok=True, status_code=200):
        self.payload = payload
        self.ok = ok
        self.status_code = status_code

    def json(self):
        return self.payload


class FakeTransport:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


def configured_env():
    return {
        "VITE_SUPABASE_URL": "https://example.supabase.co",
        "VITE_SUPABASE_PUBLISHABLE_KEY": "publishable",
        "JOJO_OPERATOR_TOKEN": "o" * 32,
    }


def test_client_keeps_operator_token_server_side_and_calls_operator_rpc():
    transport = FakeTransport(FakeResponse([{"key": "agent.chat"}]))
    with patch.dict(os.environ, configured_env(), clear=False):
        client = SupabaseFeatureFlagAdminClient(transport=transport)
        assert client.list_flags() == [{"key": "agent.chat"}]

    url, options = transport.calls[0]
    assert url.endswith("/rest/v1/rpc/operator_list_feature_flags")
    assert options["json"]["p_operator_token"] == "o" * 32
    assert "Authorization" not in options["headers"]


def test_client_rejects_missing_operator_token_before_network_access():
    with patch.dict(os.environ, {
        "VITE_SUPABASE_URL": "https://example.supabase.co",
        "VITE_SUPABASE_PUBLISHABLE_KEY": "publishable",
        "JOJO_OPERATOR_TOKEN": "",
    }, clear=False):
        try:
            SupabaseFeatureFlagAdminClient(transport=FakeTransport(FakeResponse([])))
        except FeatureFlagAdminError as error:
            assert "JOJO_OPERATOR_TOKEN" in str(error)
        else:
            raise AssertionError("missing operator token should fail closed")


def test_routes_list_and_publish_without_browser_login():
    client = app.test_client()
    updated = {
        "key": "agent.chat",
        "revision": 8,
        "rules": [],
        "history": [],
    }
    with patch("feature_flag_routes.SupabaseFeatureFlagAdminClient") as client_class:
        client_class.return_value.list_flags.return_value = [updated]
        listed = client.get("/api/features")
        client_class.return_value.publish.return_value = updated
        published = client.post("/api/features/publish", json={
            "key": "agent.chat",
            "rules": [],
            "expectedRevision": 7,
            "reason": "调整规则",
            "requestId": "request-1",
        })

    assert listed.status_code == 200
    assert listed.get_json()["flags"][0]["key"] == "agent.chat"
    assert published.status_code == 200
    call = client_class.return_value.publish.call_args.args[0]
    assert call["p_expected_revision"] == 7
    assert "operatorToken" not in published.get_json()


def test_route_rolls_back_without_exposing_the_operator_token():
    client = app.test_client()
    updated = {"key": "agent.chat", "revision": 9, "rules": [], "history": []}
    with patch("feature_flag_routes.SupabaseFeatureFlagAdminClient") as client_class:
        client_class.return_value.rollback.return_value = updated
        response = client.post("/api/features/rollback", json={
            "key": "agent.chat",
            "targetRevision": 6,
            "expectedRevision": 8,
            "requestId": "request-rollback-1",
        })

    assert response.status_code == 200
    assert response.get_json()["flag"]["revision"] == 9
    call = client_class.return_value.rollback.call_args.args[0]
    assert call["p_target_revision"] == 6
    assert call["p_expected_revision"] == 8
    assert "operatorToken" not in response.get_json()
