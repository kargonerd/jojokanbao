import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import rmrb_review_routes as routes


def build_database(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE missing_articles (
            issue_date TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            ordinal INTEGER NOT NULL,
            title TEXT NOT NULL,
            href TEXT,
            match_method TEXT,
            content_source TEXT,
            PRIMARY KEY (issue_date, page_number, ordinal)
        ) WITHOUT ROWID;
        """
    )
    connection.executemany(
        "INSERT INTO missing_articles VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            ("1950-01-01", 1, 2, "较早稿", "/https/example/rmrb/pd.html?position=2", None, None),
            ("1950-01-02", 2, 4, "较晚稿", None, None, None),
        ),
    )
    connection.commit()
    connection.close()


class RmrbReviewRoutesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.database = self.root / "merged-missing-workbench.sqlite3"
        self.decisions = self.root / "manual-review-decisions-workbench.jsonl"
        build_database(self.database)
        self.patches = (
            patch.object(routes, "REVIEW_ROOT", self.root),
            patch.object(routes, "REVIEW_DB", self.database),
            patch.object(routes, "WORKBENCH_DECISIONS", self.decisions),
            patch.object(routes, "SOURCE_PDF_ROOT", self.root / "pdfs"),
        )
        for item in self.patches:
            item.start()
        app = Flask(__name__)
        app.register_blueprint(routes.rmrb_review_blueprint)
        self.client = app.test_client()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.directory.cleanup()

    def test_queue_is_date_ordered_and_pending_only(self):
        response = self.client.get("/api/rmrb-review/queue?pendingOnly=1&limit=40")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["total"], 2)
        self.assertEqual([row["title"] for row in payload["items"]], ["较早稿", "较晚稿"])
        self.assertTrue(payload["items"][0]["peopleDataHref"].startswith("https://webvpn.zju.edu.cn/"))

    def test_accept_strips_copy_marker_and_hides_record(self):
        response = self.client.post(
            "/api/rmrb-review/decision",
            json={
                "date": "1950-01-01",
                "page": 1,
                "peopleDataOrdinal": 2,
                "decision": "accept",
                "content": "正文（人民数据库资料）结尾。",
                "reason": "人工确认",
            },
        )
        self.assertEqual(response.status_code, 200)
        saved = json.loads(self.decisions.read_text(encoding="utf-8"))
        self.assertEqual(saved["content"], "正文结尾。")
        self.assertFalse(saved["sourceCorpusModified"])
        self.assertFalse(saved["elasticsearchChanged"])

        queue = self.client.get("/api/rmrb-review/queue?pendingOnly=1").get_json()
        self.assertEqual(queue["total"], 1)
        self.assertEqual(queue["items"][0]["title"], "较晚稿")
        stats = self.client.get("/api/rmrb-review/stats").get_json()
        self.assertEqual(stats["counts"], {"accept": 1, "pending": 1, "reject": 0})

    def test_accept_requires_content(self):
        response = self.client.post(
            "/api/rmrb-review/decision",
            json={
                "date": "1950-01-02",
                "page": 2,
                "peopleDataOrdinal": 4,
                "decision": "accept",
                "content": "",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("requires", response.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
