"""Local-only annotation moderation backed by the existing operator token."""
from __future__ import annotations

from typing import Any

from flask import Blueprint, jsonify, request
from operator_rpc import OperatorRpcError, SupabaseOperatorRpcClient


annotation_moderation_blueprint = Blueprint("annotation_moderation", __name__)

AnnotationModerationError = OperatorRpcError


class SupabaseAnnotationModerationClient(SupabaseOperatorRpcClient):
    def list_reports(self, status: str) -> list[dict[str, Any]]:
        result = self.rpc("operator_list_annotation_reports", {"p_status": status})
        return result if isinstance(result, list) else []

    def moderate(self, comment_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        result = self.rpc("operator_moderate_annotation_comment", {
            "p_comment_id": comment_id,
            "p_action": payload["action"],
            "p_reason": payload["reason"],
            "p_request_id": payload.get("requestId"),
        })
        if not isinstance(result, dict):
            raise AnnotationModerationError("评论审核服务返回了无效数据")
        return result


@annotation_moderation_blueprint.get("/api/moderation/comments")
def list_annotation_reports():
    status = request.args.get("status", "pending")
    if status not in {"pending", "resolved", "dismissed", "all"}:
        return jsonify({"success": False, "message": "未知的审核状态"}), 400
    try:
        reports = SupabaseAnnotationModerationClient().list_reports(status)
        return jsonify({"success": True, "items": reports})
    except AnnotationModerationError as error:
        return jsonify({"success": False, "message": str(error)}), 502


@annotation_moderation_blueprint.post("/api/moderation/comments/<comment_id>")
def moderate_annotation_comment(comment_id: str):
    body = request.get_json(silent=True) or {}
    action = body.get("action")
    reason = str(body.get("reason", "")).strip()
    if action not in {"hide", "restore", "dismiss"}:
        return jsonify({"success": False, "message": "未知的审核动作"}), 400
    if len(reason) < 2:
        return jsonify({"success": False, "message": "请填写至少两个字符的审核理由"}), 400
    if len(reason) > 500:
        return jsonify({"success": False, "message": "审核理由不能超过 500 个字符"}), 400
    try:
        result = SupabaseAnnotationModerationClient().moderate(comment_id, {
            "action": action,
            "reason": reason,
            "requestId": body.get("requestId"),
        })
        return jsonify({"success": True, "result": result})
    except AnnotationModerationError as error:
        return jsonify({"success": False, "message": str(error)}), 502
