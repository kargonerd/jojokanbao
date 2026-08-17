from __future__ import annotations

import base64
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


def jwt_with_exp(exp: int) -> str:
    encoded = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    return f"header.{encoded}.signature"


def write_codex_auth(home: Path) -> None:
    auth_path = home / ".codex" / "auth.json"
    auth_path.parent.mkdir(parents=True)
    auth_path.write_text(json.dumps({
        "tokens": {
            "access_token": jwt_with_exp(2_000_000_000),
            "refresh_token": "refresh-secret",
        }
    }), encoding="utf-8")


def configured_env():
    return {
        "JOJO_OPERATOR_TOKEN": "o" * 64,
        "JOJO_CREDENTIAL_SERVICE_URL": "https://agent.example.com",
        "JOJO_CODEX_AUTH_PATH": "",
    }


def test_status_reports_readiness_without_returning_secrets(tmp_path):
    write_codex_auth(tmp_path)
    with patch.dict(os.environ, configured_env(), clear=False):
        status = AgentCredentialAdmin(home=tmp_path).status()

    assert status["operatorConfigured"] is True
    assert status["credential"]["available"] is True
    assert status["credential"]["pathHint"] == "~/.codex/auth.json"
    assert status["canPush"] is True
    assert "access" not in json.dumps(status)
    assert "refresh-secret" not in json.dumps(status)
    assert "o" * 64 not in json.dumps(status)


def test_push_uses_operator_bearer_and_codex_oauth(tmp_path):
    write_codex_auth(tmp_path)
    transport = FakeTransport()
    with patch.dict(os.environ, configured_env(), clear=False):
        result = AgentCredentialAdmin(transport=transport, home=tmp_path).push()

    url, options = transport.calls[0]
    assert url == "https://agent.example.com/gateway/credentials"
    assert options["headers"]["Authorization"] == f"Bearer {'o' * 64}"
    assert options["json"]["provider"] == "openai-codex"
    assert options["json"]["credential"]["type"] == "oauth"
    assert result["targetOrigin"] == "https://agent.example.com"


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
