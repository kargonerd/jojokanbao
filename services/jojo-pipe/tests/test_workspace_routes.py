import sys
import tempfile
import unittest
from pathlib import Path

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
            "<!doctype html><title>JOJO 看报 · 数据工作台</title><div id='root'></div>",
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
            self.assertIn("数据工作台".encode("utf-8"), response.data)
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


if __name__ == "__main__":
    unittest.main()
