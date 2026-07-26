import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import app


class WorkspaceRoutesTest(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_overview_is_the_root_workspace(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("数据工作台".encode("utf-8"), response.data)
        self.assertIn(b'href="/pdf"', response.data)
        self.assertIn(b'href="/es-repair"', response.data)

    def test_pdf_and_es_modules_share_navigation(self):
        pdf = self.client.get("/pdf")
        es = self.client.get("/es-repair")
        self.assertEqual(pdf.status_code, 200)
        self.assertEqual(es.status_code, 200)
        self.assertIn("PDF 数据管理".encode("utf-8"), pdf.data)
        self.assertIn("ES 数据管理".encode("utf-8"), es.data)
        self.assertIn(b"workspace-nav", pdf.data)
        self.assertIn(b"workspace-nav", es.data)


if __name__ == "__main__":
    unittest.main()
