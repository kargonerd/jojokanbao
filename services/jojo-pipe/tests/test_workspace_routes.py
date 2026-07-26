import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as app_module

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
        self.assertEqual(response.status_code, 200)
        self.assertIn("数据工作台".encode("utf-8"), response.data)

    def test_client_routes_fall_back_to_react_entry(self):
        pdf = self.client.get("/pdf")
        es = self.client.get("/es")
        self.assertEqual(pdf.status_code, 200)
        self.assertEqual(es.status_code, 200)
        self.assertEqual(pdf.data, es.data)
        self.assertIn(b"id='root'", pdf.data)

    def test_api_route_is_not_shadowed_by_spa_fallback(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "ok")


if __name__ == "__main__":
    unittest.main()
