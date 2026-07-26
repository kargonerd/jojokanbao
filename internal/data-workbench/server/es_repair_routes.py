"""Flask routes for the local ES repair workbench."""
import hmac

from flask import Blueprint, jsonify, request

from es_repair import KibanaConsoleClient, repair_config
from es_migrations import apply_migration, create_migration, list_migrations, preview_migration


es_repair_blueprint = Blueprint("es_repair", __name__)


@es_repair_blueprint.get("/api/es-repair/status")
def status():
    config = repair_config()
    safe = {
        "configured": all(config.get(k) for k in ("kibana_url", "username", "password")),
        "index": config["index"],
        "spaceId": config["space_id"],
    }
    try:
        client = KibanaConsoleClient(config)
        result = client.search_active("", 1)
        return jsonify({"success": True, **safe, "activeDocuments": result["total"]})
    except Exception as exc:
        return jsonify({"success": False, **safe, "message": str(exc)}), 502


@es_repair_blueprint.post("/api/es-repair/search")
def search():
    data = request.get_json(silent=True) or {}
    try:
        result = KibanaConsoleClient().search_active(str(data.get("query", "")), int(data.get("size", 20)))
        return jsonify({"success": True, **result})
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 502


@es_repair_blueprint.post("/api/es-repair/apply")
def apply():
    data = request.get_json(silent=True) or {}
    supersedes_id = str(data.get("supersedesId", "")).strip()
    deleted = bool(data.get("deleted"))
    document = data.get("document") or {}
    if not supersedes_id:
        return jsonify({"success": False, "message": "缺少被替代文档的 documentId"}), 400
    if not deleted and (not document.get("title") or not document.get("content")):
        return jsonify({"success": False, "message": "修复文档必须包含标题和正文"}), 400
    try:
        client = KibanaConsoleClient()
        preview = preview_migration(
            supersedes_id,
            document,
            deleted=deleted,
            reason=str(data.get("reason", "")),
            index=client.config["index"],
        )
        supplied_hash = str(data.get("previewHash", ""))
        if not supplied_hash or not hmac.compare_digest(supplied_hash, preview["previewHash"]):
            return jsonify({
                "success": False,
                "message": "migration 预览已变化，请重新生成并确认",
            }), 409
        migration = create_migration(
            supersedes_id,
            document,
            deleted=deleted,
            reason=str(data.get("reason", "")),
            index=client.config["index"],
        )
        applied = apply_migration(migration["id"], client=client)
        result = applied["result"]
        return jsonify({
            "success": True,
            **result,
            "migration": applied,
            "message": "墓碑已追加" if deleted else "修复版本已追加",
        })
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 502


@es_repair_blueprint.post("/api/es-repair/preview")
def preview():
    data = request.get_json(silent=True) or {}
    supersedes_id = str(data.get("supersedesId", "")).strip()
    deleted = bool(data.get("deleted"))
    document = data.get("document") or {}
    if not supersedes_id:
        return jsonify({"success": False, "message": "缺少被替代文档的 documentId"}), 400
    if not deleted and (not document.get("title") or not document.get("content")):
        return jsonify({"success": False, "message": "修复文档必须包含标题和正文"}), 400
    try:
        client = KibanaConsoleClient()
        result = preview_migration(
            supersedes_id,
            document,
            deleted=deleted,
            reason=str(data.get("reason", "")),
            index=client.config["index"],
        )
        return jsonify({"success": True, **result})
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 502


@es_repair_blueprint.get("/api/es-repair/migrations")
def migrations():
    return jsonify({"success": True, "items": list_migrations()})


@es_repair_blueprint.post("/api/es-repair/migrations/<migration_id>/apply")
def replay_migration(migration_id: str):
    try:
        migration = apply_migration(migration_id)
        return jsonify({"success": True, "migration": migration})
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 502
