"""Shared server-side Supabase RPC client for JOJO Workbench operators."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parents[3]


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


class OperatorRpcError(RuntimeError):
    pass


class SupabaseOperatorRpcClient:
    def __init__(self, *, transport: Any = requests) -> None:
        _load_root_env()
        self.base_url = os.getenv("VITE_SUPABASE_URL", "").strip().rstrip("/")
        self.publishable_key = os.getenv("VITE_SUPABASE_PUBLISHABLE_KEY", "").strip()
        self.operator_token = os.getenv("JOJO_OPERATOR_TOKEN", "").strip()
        self.transport = transport
        if not self.base_url or not self.publishable_key:
            raise OperatorRpcError("Supabase 项目配置缺失")
        if len(self.operator_token) < 32:
            raise OperatorRpcError("JOJO_OPERATOR_TOKEN 未配置或长度不足 32 位")

    def rpc(self, name: str, payload: dict[str, Any] | None = None) -> Any:
        try:
            response = self.transport.post(
                f"{self.base_url}/rest/v1/rpc/{name}",
                headers={
                    "apikey": self.publishable_key,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json={"p_operator_token": self.operator_token, **(payload or {})},
                timeout=10,
            )
        except requests.RequestException as error:
            raise OperatorRpcError("无法连接 Workbench 数据服务") from error
        if response.ok:
            return response.json()
        try:
            message = response.json().get("message")
        except ValueError:
            message = None
        if message == "Feature flag operator token is invalid":
            raise OperatorRpcError("JOJO_OPERATOR_TOKEN 与数据库配置不一致")
        raise OperatorRpcError(message or f"Workbench 数据服务返回 HTTP {response.status_code}")
