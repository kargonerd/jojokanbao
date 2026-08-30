import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as app_module
from progress_manager import progress_manager

app = app_module.app


class WorkspaceRoutesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        dist = Path(cls.temp_dir.name)
        (dist / "index.html").write_text(
            "<!doctype html><title>JOJO 看报 · 管理台</title><div id='root'></div>",
            encoding="utf-8",
        )
        app_module.FRONTEND_DIST = dist

    @classmethod
    def tearDownClass(cls):
        cls.temp_dir.cleanup()

    def setUp(self):
        self.client = app.test_client()

    def test_overview_is_the_root_workspace(self):
        response = self.client.get("/")
        try:
            self.assertEqual(response.status_code, 200)
            self.assertIn("管理台".encode("utf-8"), response.data)
        finally:
            response.close()

    def test_client_routes_fall_back_to_react_entry(self):
        pdf = self.client.get("/pdf")
        es = self.client.get("/es")
        try:
            self.assertEqual(pdf.status_code, 200)
            self.assertEqual(es.status_code, 200)
            self.assertEqual(pdf.data, es.data)
            self.assertIn(b"id='root'", pdf.data)
        finally:
            pdf.close()
            es.close()

    def test_api_route_is_not_shadowed_by_spa_fallback(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "ok")

    def test_content_import_path_accepts_epub_and_kindle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("book.json", "book.epub", "book.azw", "ignore.txt"):
                (root / name).write_bytes(b"test")
            with patch("content_routes._new_job", return_value={"jobId": "test"}) as create:
                response = self.client.post("/api/content/import-paths", json={"paths": [directory]})

        self.assertEqual(response.status_code, 200)
        suffixes = {Path(value).suffix for value in create.call_args.args[0]}
        self.assertEqual(suffixes, {".json", ".epub", ".azw"})

    def test_content_browser_upload_preserves_ebook_suffix(self):
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch("content_routes.RUNTIME", Path(directory)),
                patch("content_routes._new_job", return_value={"jobId": "test"}) as create,
            ):
                response = self.client.post("/api/content/import-files", data={
                    "files": [
                        (BytesIO(b"epub"), "example.epub"),
                        (BytesIO(b"mobi"), "example.mobi"),
                    ],
                }, content_type="multipart/form-data")

        self.assertEqual(response.status_code, 200)
        suffixes = [Path(value).suffix for value in create.call_args.args[0]]
        self.assertEqual(suffixes, [".epub", ".mobi"])

    def test_progress_contract_exposes_results_for_react_workflow(self):
        task_id = "workspace-contract-test"
        staging = {
            "success": True,
            "staging_id": "staging-contract-test",
            "preview": [{"original": "a.pdf", "renamed": "A20260101.pdf"}],
        }
        progress_manager.create_task(task_id, 1, 1)
        progress_manager.set_result(task_id, staging)
        progress_manager.complete(task_id)
        try:
            response = self.client.get(f"/api/progress/{task_id}")
            payload = response.data.decode("utf-8")
            self.assertIn('"status": "completed"', payload)
            self.assertIn('"results":', payload)
            self.assertIn('"staging_id": "staging-contract-test"', payload)
        finally:
            progress_manager.cleanup(task_id)

    @patch("es_repair_routes.KibanaConsoleClient")
    def test_es_preview_is_read_only(self, client_class):
        client_class.return_value.config = {"index": "news-test"}
        with (
            patch("es_repair_routes.create_migration") as create,
            patch("es_repair_routes.apply_migration") as apply,
        ):
            response = self.client.post(
                "/api/es-repair/preview",
                json={
                    "replacedDocumentId": "old-id",
                    "document": {"title": "修复稿", "content": "正文"},
                    "reason": "读者反馈",
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["migration"]["index"], "news-test")
        self.assertEqual(len(payload["previewHash"]), 64)
        create.assert_not_called()
        apply.assert_not_called()

    @patch("es_repair_routes.KibanaConsoleClient")
    def test_es_apply_rejects_missing_preview_hash_before_writing(self, client_class):
        client_class.return_value.config = {"index": "news-test"}
        with (
            patch("es_repair_routes.create_migration") as create,
            patch("es_repair_routes.apply_migration") as apply,
        ):
            response = self.client.post(
                "/api/es-repair/apply",
                json={
                    "replacedDocumentId": "old-id",
                    "document": {"title": "修复稿", "content": "正文"},
                    "reason": "读者反馈",
                },
            )

        self.assertEqual(response.status_code, 409)
        create.assert_not_called()
        apply.assert_not_called()

    @patch("es_repair_routes.KibanaConsoleClient")
    def test_es_apply_publishes_search_state_after_revision(self, client_class):
        client_class.return_value.config = {"index": "news-test"}
        with (
            patch(
                "es_repair_routes.preview_migration",
                return_value={"previewHash": "confirmed"},
            ),
            patch(
                "es_repair_routes.create_migration",
                return_value={"id": "repair-" + "a" * 40},
            ),
            patch(
                "es_repair_routes.apply_migration",
                return_value={
                    "index": "news-test",
                    "result": {"documentId": "revision-id", "created": True},
                },
            ) as apply,
            patch("es_repair_routes.validate_publication_target") as validate,
            patch(
                "es_repair_routes.publish_applied_search_state",
                return_value={"excluded": 1},
            ) as publish,
        ):
            response = self.client.post(
                "/api/es-repair/apply",
                json={
                    "replacedDocumentId": "old-id",
                    "document": {"title": "修复稿", "content": "正文"},
                    "previewHash": "confirmed",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["success"])
        validate.assert_called_once_with("news-test")
        apply.assert_called_once()
        publish.assert_called_once_with("news-test")

    @patch("es_repair_routes.KibanaConsoleClient")
    def test_es_apply_reports_partial_success_when_state_publish_fails(self, client_class):
        client_class.return_value.config = {"index": "news-test"}
        with (
            patch(
                "es_repair_routes.preview_migration",
                return_value={"previewHash": "confirmed"},
            ),
            patch(
                "es_repair_routes.create_migration",
                return_value={"id": "repair-" + "b" * 40},
            ),
            patch(
                "es_repair_routes.apply_migration",
                return_value={
                    "index": "news-test",
                    "result": {"documentId": "revision-id", "created": True},
                },
            ),
            patch("es_repair_routes.validate_publication_target"),
            patch(
                "es_repair_routes.publish_applied_search_state",
                side_effect=RuntimeError("COS unavailable"),
            ),
        ):
            response = self.client.post(
                "/api/es-repair/apply",
                json={
                    "replacedDocumentId": "old-id",
                    "document": {"title": "修复稿", "content": "正文"},
                    "previewHash": "confirmed",
                },
            )

        self.assertEqual(response.status_code, 502)
        payload = response.get_json()
        self.assertTrue(payload["repairApplied"])
        self.assertIn("可直接重试发布", payload["message"])


if __name__ == "__main__":
    unittest.main()
