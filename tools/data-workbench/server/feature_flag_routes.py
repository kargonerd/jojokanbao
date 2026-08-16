"""Local-only Feature Flag administration backed by JOJO_OPERATOR_TOKEN."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import requests
from flask import Blueprint, jsonify, request


ROOT = Path(__file__).resolve().parents[3]
feature_flags_blueprint = Blueprint("feature_flags", __name__)


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


class FeatureFlagAdminError(RuntimeError):
    pass


class SupabaseFeatureFlagAdminClient:
    def __init__(self, *, transport: Any = requests) -> None:
        _load_root_env()
        self.base_url = os.getenv("VITE_SUPABASE_URL", "").strip().rstrip("/")
        self.publishable_key = os.getenv("VITE_SUPABASE_PUBLISHABLE_KEY", "").strip()
        self.operator_token = os.getenv("JOJO_OPERATOR_TOKEN", "").strip()
        self.transport = transport
        if not self.base_url or not self.publishable_key:
            raise FeatureFlagAdminError("Supabase 项目配置缺失")
        if len(self.operator_token) < 32:
            raise FeatureFlagAdminError("JOJO_OPERATOR_TOKEN 未配置或长度不足 32 位")

    def rpc(self, name: str, payload: dict[str, Any] | None = None) -> Any:
        body = {"p_operator_token": self.operator_token, **(payload or {})}
        try:
            response = self.transport.post(
                f"{self.base_url}/rest/v1/rpc/{name}",
                headers={
                    "apikey": self.publishable_key,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json=body,
                timeout=10,
            )
        except requests.RequestException as error:
            raise FeatureFlagAdminError("无法连接 Feature Flag 服务") from error
        if response.ok:
            return response.json()
        try:
            message = response.json().get("message")
        except ValueError:
            message = None
        if message == "Feature flag operator token is invalid":
            raise FeatureFlagAdminError("JOJO_OPERATOR_TOKEN 与数据库配置不一致")
        raise FeatureFlagAdminError(message or f"Feature Flag 服务返回 HTTP {response.status_code}")

    def list_flags(self) -> list[dict[str, Any]]:
        result = self.rpc("operator_list_feature_flags")
        return result if isinstance(result, list) else []

    def search_users(self, query: str) -> list[dict[str, Any]]:
        result = self.rpc("operator_search_feature_users", {"p_query": query})
        return result if isinstance(result, list) else []

    def publish(self, payload: dict[str, Any]) -> dict[str, Any]:
        result = self.rpc("operator_publish_feature_flag", payload)
        if not isinstance(result, dict):
            raise FeatureFlagAdminError("Feature Flag 服务返回了无效数据")
        return result

    def rollback(self, payload: dict[str, Any]) -> dict[str, Any]:
        result = self.rpc("operator_rollback_feature_flag", payload)
        if not isinstance(result, dict):
            raise FeatureFlagAdminError("Feature Flag 服务返回了无效数据")
        return result


@feature_flags_blueprint.get("/api/features")
def list_features():
    try:
        return jsonify({"success": True, "flags": SupabaseFeatureFlagAdminClient().list_flags()})
    except FeatureFlagAdminError as error:
        return jsonify({"success": False, "message": str(error)}), 502


@feature_flags_blueprint.post("/api/features/users")
def search_feature_users():
    query = str((request.get_json(silent=True) or {}).get("query", "")).strip()
    if len(query) < 2:
        return jsonify({"success": False, "message": "至少输入两个字符"}), 400
    try:
        return jsonify({"success": True, "users": SupabaseFeatureFlagAdminClient().search_users(query)})
    except FeatureFlagAdminError as error:
        return jsonify({"success": False, "message": str(error)}), 502


@feature_flags_blueprint.post("/api/features/publish")
def publish_feature():
    body = request.get_json(silent=True) or {}
    required = ("key", "rules", "expectedRevision", "reason", "requestId")
    if any(name not in body for name in required):
        return jsonify({"success": False, "message": "发布参数不完整"}), 400
    try:
        flag = SupabaseFeatureFlagAdminClient().publish({
            "p_key": body["key"],
            "p_rules": body["rules"],
            "p_expected_revision": body["expectedRevision"],
            "p_reason": body["reason"],
            "p_request_id": body["requestId"],
        })
        return jsonify({"success": True, "flag": flag})
    except FeatureFlagAdminError as error:
        return jsonify({"success": False, "message": str(error)}), 502


@feature_flags_blueprint.post("/api/features/rollback")
def rollback_feature():
    body = request.get_json(silent=True) or {}
    required = ("key", "targetRevision", "expectedRevision", "requestId")
    if any(name not in body for name in required):
        return jsonify({"success": False, "message": "回滚参数不完整"}), 400
    try:
        flag = SupabaseFeatureFlagAdminClient().rollback({
            "p_key": body["key"],
            "p_target_revision": body["targetRevision"],
            "p_expected_revision": body["expectedRevision"],
            "p_request_id": body["requestId"],
        })
        return jsonify({"success": True, "flag": flag})
    except FeatureFlagAdminError as error:
        return jsonify({"success": False, "message": str(error)}), 502
