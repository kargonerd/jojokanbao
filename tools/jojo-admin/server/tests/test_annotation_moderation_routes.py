from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import patch


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from annotation_moderation_routes import (  # noqa: E402
    AnnotationModerationError,
    SupabaseAnnotationModerationClient,
)
from app import app  # noqa: E402


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

    def request(self, method, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


def configured_env():
    return {
        "VITE_SUPABASE_URL": "https://example.supabase.co",
        "VITE_SUPABASE_PUBLISHABLE_KEY": "publishable",
    }


def test_client_forwards_session_to_cloud_moderation_api():
    transport = FakeTransport(FakeResponse({"items":[{"commentId": "comment-1"}]}))
    with patch.dict(os.environ, configured_env(), clear=False):
        client = SupabaseAnnotationModerationClient(transport=transport, access_token="staff-session")
        assert client.list_reports("pending") == [{"commentId": "comment-1"}]

    url, options = transport.calls[0]
    assert url.endswith("/admin/moderation/comments")
    assert options["params"]["status"] == "pending"
    assert options["headers"]["Authorization"] == "Bearer staff-session"


def test_client_fails_closed_without_admin_session():
    with patch.dict(os.environ, configured_env(), clear=False):
        try:
            SupabaseAnnotationModerationClient(transport=FakeTransport(FakeResponse([])), access_token="")
        except AnnotationModerationError as error:
            assert "登录" in str(error)
        else:
            raise AssertionError("missing session should fail closed")


def test_routes_validate_and_forward_moderation_without_exposing_token():
    client = app.test_client()
    with patch("annotation_moderation_routes.SupabaseAnnotationModerationClient") as client_class:
        client_class.return_value.list_reports.return_value = [{"commentId": "comment-1"}]
        listed = client.get("/api/moderation/comments?status=pending")
        client_class.return_value.moderate.return_value = {"success": True}
        moderated = client.post("/api/moderation/comments/comment-1", json={
            "action": "hide",
            "reason": "人身攻击",
        })

    assert listed.status_code == 200
    assert listed.get_json()["items"][0]["commentId"] == "comment-1"
    assert moderated.status_code == 200
    assert "operatorToken" not in moderated.get_json()
    client_class.return_value.moderate.assert_called_once_with("comment-1", {
        "action": "hide",
        "reason": "人身攻击",
    })


def test_routes_reject_unknown_status_action_and_empty_reason():
    client = app.test_client()
    assert client.get("/api/moderation/comments?status=unknown").status_code == 400
    assert client.post("/api/moderation/comments/comment-1", json={"action": "delete", "reason": "测试"}).status_code == 400
    assert client.post("/api/moderation/comments/comment-1", json={"action": "hide", "reason": ""}).status_code == 400
    assert client.post("/api/moderation/comments/comment-1", json={"action": "hide", "reason": "过" * 501}).status_code == 400
