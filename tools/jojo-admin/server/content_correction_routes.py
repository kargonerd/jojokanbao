"""Private content correction queue for the local JOJO management console."""
from __future__ import annotations

from typing import Any
from uuid import UUID
from flask import Blueprint, jsonify, request
from operator_rpc import OperatorRpcError, SupabaseOperatorRpcClient

content_corrections_blueprint = Blueprint("content_corrections", __name__)
STATUSES = {"pending", "in_progress", "resolved", "dismissed"}


class SupabaseContentCorrectionClient(SupabaseOperatorRpcClient):
    def list(self, status: str, offset: int) -> dict[str, Any]:
        result = self.rpc("operator_list_content_corrections", {"p_status": status, "p_offset": offset})
        if not isinstance(result, dict) or not isinstance(result.get("items"), list):
            raise OperatorRpcError("纠错服务返回了无效数据")
        return result

    def review(self, correction_id: str, status: str, note: str) -> dict[str, Any]:
        result = self.rpc("operator_review_content_correction", {
            "p_correction_id": correction_id, "p_status": status, "p_note": note,
        })
        if not isinstance(result, dict) or "id" not in result:
            raise OperatorRpcError("纠错服务返回了无效数据")
        return result


@content_corrections_blueprint.get("/api/content-corrections")
def list_content_corrections():
    status = request.args.get("status", "pending")
    try:
        offset = int(request.args.get("offset", "0"))
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "分页位置无效"}), 400
    if status not in STATUSES | {"all"} or offset < 0:
        return jsonify({"success": False, "message": "纠错状态或分页位置无效"}), 400
    try:
        result = SupabaseContentCorrectionClient().list(status, offset)
        return jsonify({"success": True, **result})
    except OperatorRpcError as error:
        return jsonify({"success": False, "message": str(error)}), 502


@content_corrections_blueprint.post("/api/content-corrections/<correction_id>")
def review_content_correction(correction_id: str):
    try:
        UUID(correction_id)
    except ValueError:
        return jsonify({"success": False, "message": "纠错编号无效"}), 400
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"success": False, "message": "处理内容无效"}), 400
    status = body.get("status")
    note = body.get("note")
    if not isinstance(status, str) or status not in STATUSES:
        return jsonify({"success": False, "message": "未知的纠错状态"}), 400
    if not isinstance(note, str) or not 2 <= len(note.strip()) <= 1000:
        return jsonify({"success": False, "message": "请填写 2 至 1000 字的处理说明"}), 400
    try:
        result = SupabaseContentCorrectionClient().review(correction_id, status, note.strip())
        return jsonify({"success": True, "result": result})
    except OperatorRpcError as error:
        return jsonify({"success": False, "message": str(error)}), 502
