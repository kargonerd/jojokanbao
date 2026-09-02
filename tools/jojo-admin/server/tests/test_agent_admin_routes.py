from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import patch


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from agent_admin_routes import AgentCredentialAdmin  # noqa: E402
from app import app  # noqa: E402


class FakeResponse:
    def __init__(self, *, status_code=204):
        self.status_code = status_code
        self.ok = status_code < 400


class FakeTransport:
    def __init__(self, response=None):
        self.response = response or FakeResponse()
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


def write_agent_auth(auth_path: Path) -> None:
    auth_path.parent.mkdir(parents=True)
    auth_path.write_text(json.dumps({
        "openai-codex": {
            "type": "oauth",
            "access": "access-secret",
            "refresh": "refresh-secret",
            "expires": 2_000_000_000_000,
        }
    }), encoding="utf-8")


def write_user_codex_auth(home: Path) -> None:
    auth_path = home / ".codex" / "auth.json"
    auth_path.parent.mkdir(parents=True)
    auth_path.write_text(json.dumps({
        "tokens": {
            "access_token": "user-access-secret",
            "refresh_token": "user-refresh-secret",
        }
    }), encoding="utf-8")


def configured_env():
    return {
        "JOJO_OPERATOR_TOKEN": "o" * 64,
        "JOJO_CREDENTIAL_SERVICE_URL": "https://agent.example.com",
        "JOJO_CODEX_AUTH_PATH": "",
        "JOJO_AGENT_AUTH_PATH": "",
    }


def test_status_reports_readiness_without_returning_secrets(tmp_path):
    write_agent_auth(tmp_path / "agent" / "auth.json")
    with (
        patch("agent_admin_routes.ROOT", tmp_path),
        patch.dict(os.environ, configured_env(), clear=False),
    ):
        status = AgentCredentialAdmin().status()

    assert status["operatorConfigured"] is True
    assert status["credential"]["available"] is True
    assert status["credential"]["sourceLabel"] == "Agent OAuth 文件"
    assert status["credential"]["pathHint"] == "agent/auth.json"
    assert status["canPush"] is True
    assert "access" not in json.dumps(status)
    assert "refresh-secret" not in json.dumps(status)
    assert "o" * 64 not in json.dumps(status)


def test_push_uses_operator_bearer_and_codex_oauth(tmp_path):
    write_agent_auth(tmp_path / "agent" / "auth.json")
    transport = FakeTransport()
    with (
        patch("agent_admin_routes.ROOT", tmp_path),
        patch.dict(os.environ, configured_env(), clear=False),
    ):
        result = AgentCredentialAdmin(transport=transport).push()

    url, options = transport.calls[0]
    assert url == "https://agent.example.com/gateway/credentials"
    assert options["headers"]["Authorization"] == f"Bearer {'o' * 64}"
    assert options["json"]["provider"] == "openai-codex"
    assert options["json"]["credential"]["type"] == "oauth"
    assert result["targetOrigin"] == "https://agent.example.com"


def test_configured_auth_path_overrides_repository_default(tmp_path):
    repository_root = tmp_path / "repository"
    configured_path = tmp_path / "operator" / "auth.json"
    write_agent_auth(repository_root / "agent" / "auth.json")
    write_agent_auth(configured_path)
    env = {**configured_env(), "JOJO_CODEX_AUTH_PATH": str(configured_path)}

    with (
        patch("agent_admin_routes.ROOT", repository_root),
        patch.dict(os.environ, env, clear=False),
    ):
        admin = AgentCredentialAdmin()
        status = admin.status()

    assert admin.auth_path == configured_path
    assert status["credential"]["available"] is True
    assert status["credential"]["sourceLabel"] == "指定的 Agent OAuth 文件"
    assert status["credential"]["pathHint"] == "JOJO_CODEX_AUTH_PATH"


def test_agent_auth_path_is_supported_when_legacy_path_is_unset(tmp_path):
    configured_path = tmp_path / "agent-owned" / "auth.json"
    write_agent_auth(configured_path)
    env = {**configured_env(), "JOJO_AGENT_AUTH_PATH": str(configured_path)}

    with patch.dict(os.environ, env, clear=False):
        admin = AgentCredentialAdmin()
        status = admin.status()

    assert admin.auth_path == configured_path
    assert status["credential"]["available"] is True
    assert status["credential"]["pathHint"] == "JOJO_AGENT_AUTH_PATH"


def test_user_codex_auth_is_never_used_as_fallback(tmp_path):
    repository_root = tmp_path / "repository"
    repository_root.mkdir()
    write_user_codex_auth(tmp_path)

    with (
        patch("agent_admin_routes.ROOT", repository_root),
        patch.object(Path, "home", return_value=tmp_path) as home,
        patch.dict(os.environ, configured_env(), clear=False),
    ):
        admin = AgentCredentialAdmin()
        status = admin.status()

    home.assert_not_called()
    assert admin.auth_path == repository_root / "agent" / "auth.json"
    assert status["credential"]["available"] is False
    assert status["credential"]["pathHint"] == "agent/auth.json"
    assert status["credential"]["error"] == "没有找到 Agent 专用 Codex OAuth 凭据"
    assert status["canPush"] is False


def test_configured_path_rejects_native_codex_token_format(tmp_path):
    write_user_codex_auth(tmp_path)
    auth_path = tmp_path / ".codex" / "auth.json"
    env = {**configured_env(), "JOJO_CODEX_AUTH_PATH": str(auth_path)}

    with patch.dict(os.environ, env, clear=False):
        status = AgentCredentialAdmin().status()

    assert status["credential"]["available"] is False
    assert status["credential"]["error"] == (
        "Agent 专用凭据必须使用 openai-codex OAuth 格式"
    )
    assert status["canPush"] is False


def test_routes_do_not_require_browser_login():
    client = app.test_client()
    status = {
        "operatorConfigured": True,
        "serviceConfigured": True,
        "targetOrigin": "https://agent.example.com",
        "credential": {"available": True},
        "canPush": True,
    }
    with patch("agent_admin_routes.AgentCredentialAdmin") as admin_class:
        admin_class.return_value.status.return_value = status
        response = client.get("/api/agent/credentials/status")

    assert response.status_code == 200
    assert response.get_json()["status"]["canPush"] is True
