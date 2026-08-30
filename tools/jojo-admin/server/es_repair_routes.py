"""Flask routes for the local JOJO Admin ES repair page."""
import hmac

from flask import Blueprint, jsonify, request

from es_repair import KibanaConsoleClient, repair_config
from es_migrations import apply_migration, create_migration, list_migrations, preview_migration
from publish_search_state import (
    publication_config,
    publish_applied_search_state,
    validate_publication_target,
)


es_repair_blueprint = Blueprint("es_repair", __name__)


@es_repair_blueprint.get("/api/es-repair/status")
def status():
    config = repair_config()
    state_config = publication_config()
    safe = {
        "configured": all(
            config.get(k) for k in ("kibana_url", "username", "password", "index", "space_id")
        ),
        "index": config["index"],
        "spaceId": config["space_id"],
        "searchState": {
            "configured": bool(
                state_config["bucket"] and state_config["region"] and state_config["key"]
            ),
            "object": f"cos://{state_config['bucket']}/{state_config['key']}",
            "indices": state_config["indices"],
        },
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
    replaced_document_id = str(data.get("replacedDocumentId", "")).strip()
    deleted = bool(data.get("deleted"))
    document = data.get("document") or {}
    if not replaced_document_id:
        return jsonify({"success": False, "message": "缺少被替代文档的 documentId"}), 400
    if not deleted and (not document.get("title") or not document.get("content")):
        return jsonify({"success": False, "message": "修复文档必须包含标题和正文"}), 400
    try:
        client = KibanaConsoleClient()
        preview = preview_migration(
            replaced_document_id,
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
        validate_publication_target(client.config["index"])
        migration = create_migration(
            replaced_document_id,
            document,
            deleted=deleted,
            reason=str(data.get("reason", "")),
            index=client.config["index"],
        )
        applied = apply_migration(migration["id"], client=client)
        result = applied["result"]
        published = publish_applied_search_state(client.config["index"])
        return jsonify({
            "success": True,
            **result,
            "migration": applied,
            "searchState": published,
            "message": "墓碑已追加" if deleted else "修复版本已追加",
        })
    except Exception as exc:
        applied = locals().get("applied")
        return jsonify({
            "success": False,
            "repairApplied": bool(applied),
            "migration": applied,
            "message": (
                f"ES 修订已写入，但 search-state 发布失败，可直接重试发布：{exc}"
                if applied else str(exc)
            ),
        }), 502


@es_repair_blueprint.post("/api/es-repair/preview")
def preview():
    data = request.get_json(silent=True) or {}
    replaced_document_id = str(data.get("replacedDocumentId", "")).strip()
    deleted = bool(data.get("deleted"))
    document = data.get("document") or {}
    if not replaced_document_id:
        return jsonify({"success": False, "message": "缺少被替代文档的 documentId"}), 400
    if not deleted and (not document.get("title") or not document.get("content")):
        return jsonify({"success": False, "message": "修复文档必须包含标题和正文"}), 400
    try:
        client = KibanaConsoleClient()
        result = preview_migration(
            replaced_document_id,
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
        pending = next(
            (item for item in list_migrations() if item.get("id") == migration_id),
            None,
        )
        if pending is None:
            raise FileNotFoundError(f"migration 不存在：{migration_id}")
        validate_publication_target(str(pending.get("index") or ""))
        migration = apply_migration(migration_id)
        index = migration["index"]
        published = publish_applied_search_state(index)
        return jsonify({
            "success": True,
            "migration": migration,
            "searchState": published,
        })
    except Exception as exc:
        applied = locals().get("migration")
        return jsonify({
            "success": False,
            "repairApplied": bool(applied),
            "migration": applied,
            "message": (
                f"ES 修订已写入，但 search-state 发布失败，可直接重试发布：{exc}"
                if applied else str(exc)
            ),
        }), 502


@es_repair_blueprint.post("/api/es-repair/publish-state")
def publish_state():
    try:
        index = repair_config()["index"]
        validate_publication_target(index)
        published = publish_applied_search_state(index)
        return jsonify({"success": True, "searchState": published})
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 502
