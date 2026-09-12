from __future__ import annotations
import os
import sys
from pathlib import Path
from unittest.mock import patch
from flask import Flask

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))
from content_correction_routes import content_corrections_blueprint, SupabaseContentCorrectionClient
from operator_rpc import OperatorRpcError

ID = "01234567-0000-0000-0000-000000000000"

def client():
    app = Flask(__name__)
    app.register_blueprint(content_corrections_blueprint)
    return app.test_client()

def test_routes_forward_queue_and_resolution_without_exposing_operator_token():
    with patch("content_correction_routes.SupabaseContentCorrectionClient") as factory:
        factory.return_value.list.return_value = {"items": [{"id": ID}], "total": 1}
        result = client().get("/api/content-corrections?status=in_progress&offset=50")
        assert result.status_code == 200
        assert result.get_json()["total"] == 1
        factory.return_value.list.assert_called_once_with("in_progress", 50)
        factory.return_value.review.return_value = {"id": ID, "status": "resolved"}
        result = client().post(f"/api/content-corrections/{ID}", json={"status": "resolved", "note": " 原文已校正 "})
        assert result.status_code == 200
        factory.return_value.review.assert_called_once_with(ID, "resolved", "原文已校正")
        assert "token" not in str(result.get_json()).lower()

def test_routes_reject_invalid_filters_ids_and_notes_before_calling_rpc():
    with patch("content_correction_routes.SupabaseContentCorrectionClient") as factory:
        assert client().get("/api/content-corrections?status=unknown").status_code == 400
        assert client().get("/api/content-corrections?offset=-1").status_code == 400
        assert client().get("/api/content-corrections?offset=oops").status_code == 400
        assert client().post("/api/content-corrections/not-uuid", json={}).status_code == 400
        for payload in [{"status": "resolved", "note": ""}, {"status": "gone", "note": "测试"}, {"status": [], "note": "测试"}, {"status": "resolved", "note": "文" * 1001}, [1, 2]]:
            assert client().post(f"/api/content-corrections/{ID}", json=payload).status_code == 400
        factory.assert_not_called()

def test_client_uses_existing_private_operator_rpc_contract():
    config = {"VITE_SUPABASE_URL": "https://example.supabase.co", "VITE_SUPABASE_PUBLISHABLE_KEY": "public", "JOJO_OPERATOR_TOKEN": "o" * 32}
    with patch.dict(os.environ, config), patch.object(SupabaseContentCorrectionClient, "rpc") as rpc:
        rpc.return_value = {"items": [], "total": 0}
        assert SupabaseContentCorrectionClient().list("pending", 0) == {"items": [], "total": 0}
        rpc.assert_called_with("operator_list_content_corrections", {"p_status": "pending", "p_offset": 0})
        rpc.return_value = {"id": ID}
        SupabaseContentCorrectionClient().review(ID, "dismissed", "无需更改")
        rpc.assert_called_with("operator_review_content_correction", {"p_correction_id": ID, "p_status": "dismissed", "p_note": "无需更改"})

def test_service_failure_is_not_reported_as_saved():
    with patch("content_correction_routes.SupabaseContentCorrectionClient", side_effect=OperatorRpcError("服务暂不可用")):
        response = client().post(f"/api/content-corrections/{ID}", json={"status": "resolved", "note": "原文已校正"})
        assert response.status_code == 502
        assert response.get_json()["success"] is False
