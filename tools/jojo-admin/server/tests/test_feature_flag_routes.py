from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
import requests


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
    transport = FakeTransport(FakeResponse([{"key": "rag.workspace"}]))
    with patch.dict(os.environ, configured_env(), clear=False):
        client = SupabaseFeatureFlagAdminClient(transport=transport)
        assert client.list_flags() == [{"key": "rag.workspace"}]

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
        "key": "rag.workspace",
        "revision": 8,
        "rules": [],
        "config": {},
        "history": [],
    }
    with patch("feature_flag_routes.SupabaseFeatureFlagAdminClient") as client_class:
        client_class.return_value.list_flags.return_value = [updated]
        listed = client.get("/api/features")
        client_class.return_value.publish.return_value = updated
        published = client.post("/api/features/publish", json={
            "key": "rag.workspace",
            "rules": [],
            "config": {},
            "expectedRevision": 7,
            "reason": "调整规则",
            "requestId": "request-1",
        })

    assert listed.status_code == 200
    assert listed.get_json()["flags"][0]["key"] == "rag.workspace"
    assert published.status_code == 200
    call = client_class.return_value.publish.call_args.args[0]
    assert call["p_expected_revision"] == 7
    assert call["p_config"] == {}
    assert "operatorToken" not in published.get_json()


def test_route_rolls_back_without_exposing_the_operator_token():
    client = app.test_client()
    updated = {"key": "rag.workspace", "revision": 9, "rules": [], "config": {}, "history": []}
    with patch("feature_flag_routes.SupabaseFeatureFlagAdminClient") as client_class:
        client_class.return_value.rollback.return_value = updated
        response = client.post("/api/features/rollback", json={
            "key": "rag.workspace",
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


def publish_payload(**updates):
    return {
        "p_key": "reader.speech", "p_rules": [{"serve": False}], "p_config": {},
        "p_expected_revision": 1, "p_reason": "测试兼容旧签名", "p_request_id": "same-request-id",
        **updates,
    }


def missing_config_signature(**updates):
    return {
        "code": "PGRST202",
        "message": "Could not find the function public.operator_publish_feature_flag(p_config, p_expected_revision, p_key, p_operator_token, p_reason, p_request_id, p_rules) in the schema cache",
        **updates,
    }


class SequenceTransport:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


@pytest.mark.parametrize("include_config", [True, False])
def test_publish_falls_back_once_only_for_missing_config_signature(include_config):
    updated = {"key": "reader.speech", "revision": 2, "rules": [{"serve": False}]}
    transport = SequenceTransport(
        FakeResponse(missing_config_signature(), ok=False, status_code=404),
        FakeResponse(updated),
    )
    payload = publish_payload()
    if not include_config:
        del payload["p_config"]
    original = dict(payload)
    with patch.dict(os.environ, configured_env(), clear=False):
        result = SupabaseFeatureFlagAdminClient(transport=transport).publish(payload)
    assert result == updated and payload == original
    assert len(transport.calls) == 2
    current, legacy = [options["json"] for _, options in transport.calls]
    assert current["p_config"] == {} and "p_config" not in legacy
    assert legacy == {key: value for key, value in current.items() if key != "p_config"}
    assert legacy["p_request_id"] == "same-request-id" and legacy["p_expected_revision"] == 1
    assert all(url.endswith("/rpc/operator_publish_feature_flag") for url, _ in transport.calls)


def test_publish_new_signature_preserves_nonempty_config_without_retry():
    payload = publish_payload(p_config={"publicMarkThreshold": 3})
    transport = FakeTransport(FakeResponse({"key": "reader.annotations", "config": payload["p_config"]}))
    with patch.dict(os.environ, configured_env(), clear=False):
        result = SupabaseFeatureFlagAdminClient(transport=transport).publish(payload)
    assert result["config"] == {"publicMarkThreshold": 3}
    assert len(transport.calls) == 1
    assert transport.calls[0][1]["json"]["p_config"] == {"publicMarkThreshold": 3}


def test_publish_legacy_schema_refuses_to_drop_nonempty_config():
    transport = FakeTransport(FakeResponse(missing_config_signature(), ok=False, status_code=404))
    with patch.dict(os.environ, configured_env(), clear=False):
        with pytest.raises(FeatureFlagAdminError, match="非空配置未保存"):
            SupabaseFeatureFlagAdminClient(transport=transport).publish(publish_payload(p_config={"publicMarkThreshold": 3}))
    assert len(transport.calls) == 1


@pytest.mark.parametrize("status,error", [
    (403, {"code": "42501", "message": "Feature flag operator token is invalid"}),
    (409, {"code": "40001", "message": "Feature flag revision conflict"}),
    (502, {"code": "PGRST202", "message": missing_config_signature()["message"]}),
    (404, {"code": "PGRST205", "message": missing_config_signature()["message"]}),
    (404, missing_config_signature(message="Could not find the function public.another_rpc(p_config) in the schema cache")),
    (404, missing_config_signature(message="Could not find the function public.operator_publish_feature_flag(p_key) in the schema cache")),
    (404, missing_config_signature(message="Could not find the function public.operator_publish_feature_flag(p_config, p_key, p_extra) in the schema cache")),
    (404, missing_config_signature(message="function missing")),
])
def test_other_errors_never_retry_a_publish(status, error):
    transport = FakeTransport(FakeResponse(error, ok=False, status_code=status))
    with patch.dict(os.environ, configured_env(), clear=False):
        with pytest.raises(FeatureFlagAdminError):
            SupabaseFeatureFlagAdminClient(transport=transport).publish(publish_payload())
    assert len(transport.calls) == 1


def test_timeout_has_unknown_outcome_and_is_not_retried():
    transport = SequenceTransport(requests.Timeout("response may have been lost"))
    with patch.dict(os.environ, configured_env(), clear=False):
        with pytest.raises(FeatureFlagAdminError, match="无法连接"):
            SupabaseFeatureFlagAdminClient(transport=transport).publish(publish_payload())
    assert len(transport.calls) == 1


def test_legacy_retry_failure_is_not_retried_again():
    transport = SequenceTransport(
        FakeResponse(missing_config_signature(), ok=False, status_code=404),
        FakeResponse({"code": "40001", "message": "Feature flag revision conflict"}, ok=False, status_code=409),
    )
    with patch.dict(os.environ, configured_env(), clear=False):
        with pytest.raises(FeatureFlagAdminError, match="revision conflict"):
            SupabaseFeatureFlagAdminClient(transport=transport).publish(publish_payload())
    assert len(transport.calls) == 2


@pytest.mark.parametrize("config", [None, [], "", 0])
def test_invalid_config_fails_before_network_access(config):
    transport = SequenceTransport()
    with patch.dict(os.environ, configured_env(), clear=False):
        with pytest.raises(FeatureFlagAdminError, match="JSON 对象"):
            SupabaseFeatureFlagAdminClient(transport=transport).publish(publish_payload(p_config=config))
    assert not transport.calls


def test_publish_route_defaults_missing_config_to_empty_object():
    with patch("feature_flag_routes.SupabaseFeatureFlagAdminClient") as client_class:
        client_class.return_value.publish.return_value = {"key": "reader.speech", "revision": 2}
        response = app.test_client().post("/api/features/publish", json={
            "key": "reader.speech", "rules": [], "expectedRevision": 1,
            "reason": "保持关闭", "requestId": "request-missing-config",
        })
    assert response.status_code == 200
    assert client_class.return_value.publish.call_args.args[0]["p_config"] == {}
