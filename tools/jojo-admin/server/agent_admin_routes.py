"""Local-only Agent credential administration for the JOJO Console."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
from flask import Blueprint, jsonify


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CREDENTIAL_SERVICE_URL = "https://agent-global.jojokanbao.cn"
agent_admin_blueprint = Blueprint("agent_admin", __name__)


def _load_root_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if value[:1] == value[-1:] and value[:1] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


class AgentAdminError(RuntimeError):
    pass


class AgentCredentialAdmin:
    def __init__(
        self,
        *,
        transport: Any = requests,
    ) -> None:
        _load_root_env()
        self.transport = transport
        self.operator_token = os.getenv("JOJO_OPERATOR_TOKEN", "").strip()
        self.service_url = (
            os.getenv("JOJO_CREDENTIAL_SERVICE_URL", "").strip()
            or DEFAULT_CREDENTIAL_SERVICE_URL
        ).rstrip("/")
        codex_auth_path = os.getenv("JOJO_CODEX_AUTH_PATH", "").strip()
        agent_auth_path = os.getenv("JOJO_AGENT_AUTH_PATH", "").strip()
        configured_path = codex_auth_path or agent_auth_path
        if configured_path:
            candidate = Path(configured_path).expanduser()
            self.auth_path = candidate if candidate.is_absolute() else ROOT / candidate
            self.source_label = "指定的 Agent OAuth 文件"
            self.path_hint = (
                "JOJO_CODEX_AUTH_PATH" if codex_auth_path else "JOJO_AGENT_AUTH_PATH"
            )
        else:
            self.auth_path = ROOT / "agent" / "auth.json"
            self.source_label = "Agent OAuth 文件"
            self.path_hint = "agent/auth.json"

    def _target(self) -> str:
        parsed = urlparse(self.service_url)
        if not parsed.hostname or (
            parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}
        ):
            raise AgentAdminError("Agent 凭据服务地址必须使用 HTTPS")
        return f"{self.service_url}/gateway/credentials"

    def _credential(self) -> dict[str, Any]:
        if not self.auth_path.exists():
            raise AgentAdminError("没有找到 Agent 专用 Codex OAuth 凭据")
        try:
            content = json.loads(self.auth_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise AgentAdminError("Agent 专用 Codex OAuth 凭据无法读取") from error

        pi_credential = content.get("openai-codex") if isinstance(content, dict) else None
        if not isinstance(pi_credential, dict) or pi_credential.get("type") != "oauth":
            raise AgentAdminError("Agent 专用凭据必须使用 openai-codex OAuth 格式")
        access = pi_credential.get("access")
        refresh = pi_credential.get("refresh")
        expires = pi_credential.get("expires")

        if not isinstance(access, str) or not access:
            raise AgentAdminError("Agent 专用凭据中没有 Codex access token")
        if not isinstance(refresh, str) or not refresh:
            raise AgentAdminError("Agent 专用凭据中没有 Codex refresh token")
        if not isinstance(expires, (int, float)):
            raise AgentAdminError("Agent 专用 Codex 凭据缺少有效期")
        return {
            "type": "oauth",
            "access": access,
            "refresh": refresh,
            "expires": int(expires),
        }

    def status(self) -> dict[str, Any]:
        credential_error = None
        credential = None
        try:
            credential = self._credential()
        except AgentAdminError as error:
            credential_error = str(error)

        parsed = urlparse(self.service_url)
        expires = credential["expires"] if credential else None
        expires_at = (
            datetime.fromtimestamp(expires / 1000, tz=timezone.utc).isoformat()
            if expires is not None
            else None
        )
        expired = expires is not None and expires <= int(datetime.now(tz=timezone.utc).timestamp() * 1000)
        operator_configured = len(self.operator_token) >= 32
        service_configured = bool(parsed.hostname) and (
            parsed.scheme == "https" or parsed.hostname in {"localhost", "127.0.0.1"}
        )
        return {
            "operatorConfigured": operator_configured,
            "serviceConfigured": service_configured,
            "targetOrigin": f"{parsed.scheme}://{parsed.netloc}" if parsed.netloc else None,
            "credential": {
                "available": credential is not None,
                "sourceLabel": self.source_label,
                "pathHint": self.path_hint,
                "type": "OAuth" if credential else None,
                "expiresAt": expires_at,
                "expired": expired,
                "error": credential_error,
            },
            "canPush": operator_configured and service_configured and credential is not None,
        }

    def push(self) -> dict[str, Any]:
        if len(self.operator_token) < 32:
            raise AgentAdminError("JOJO_OPERATOR_TOKEN 未配置或长度不足 32 位")
        credential = self._credential()
        try:
            response = self.transport.post(
                self._target(),
                headers={
                    "Authorization": f"Bearer {self.operator_token}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json={
                    "scope": "agent",
                    "provider": "openai-codex",
                    "credential": credential,
                },
                timeout=20,
            )
        except requests.RequestException as error:
            raise AgentAdminError("无法连接 Agent 凭据服务") from error
        if response.status_code == 401:
            raise AgentAdminError("远端 Agent 的 JOJO_OPERATOR_TOKEN 与本机不一致")
        if not response.ok:
            raise AgentAdminError(f"Agent 凭据服务返回 HTTP {response.status_code}")
        return {
            "targetOrigin": self.status()["targetOrigin"],
            "pushedAt": datetime.now(tz=timezone.utc).isoformat(),
        }


@agent_admin_blueprint.get("/api/agent/credentials/status")
def agent_credential_status():
    return jsonify({"success": True, "status": AgentCredentialAdmin().status()})


@agent_admin_blueprint.post("/api/agent/credentials/push")
def push_agent_credential():
    try:
        result = AgentCredentialAdmin().push()
        return jsonify({"success": True, "result": result})
    except AgentAdminError as error:
        return jsonify({"success": False, "message": str(error)}), 502
