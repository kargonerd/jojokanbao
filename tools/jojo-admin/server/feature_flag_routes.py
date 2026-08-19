"""Local-only Feature Flag administration backed by JOJO_OPERATOR_TOKEN."""
from __future__ import annotations

from typing import Any

from flask import Blueprint, jsonify, request
from operator_rpc import OperatorRpcError, SupabaseOperatorRpcClient


feature_flags_blueprint = Blueprint("feature_flags", __name__)

FeatureFlagAdminError = OperatorRpcError


class SupabaseFeatureFlagAdminClient(SupabaseOperatorRpcClient):
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
