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
from rmrb_review_publish import CanonicalPatch, DeliveryPatch


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
        self.sync_root = self.root / "sync"
        build_database(self.database)
        self.patches = (
            patch.object(routes, "REVIEW_ROOT", self.root),
            patch.object(routes, "REVIEW_DB", self.database),
            patch.object(routes, "WORKBENCH_DECISIONS", self.decisions),
            patch.object(routes, "SYNC_ROOT", self.sync_root),
            patch.object(routes, "SYNC_STATE", self.sync_root / "review-sync-state.json"),
            patch.object(routes, "PUBLISH_ROOT", self.sync_root / "publish"),
            patch.object(routes, "PUBLICATION_STATE", self.sync_root / "publication-state.json"),
            patch.object(routes, "PENDING_PUBLICATION", self.root / "manual-review-pending-publication.json"),
        )
        for item in self.patches:
            item.start()
        with routes.SYNC_PROGRESS_LOCK:
            routes.SYNC_PROGRESS.update({
                "status": "idle",
                "phase": "idle",
                "message": "等待发布",
                "completed": 0,
                "total": 0,
                "percent": 0,
                "startedAt": None,
                "updatedAt": None,
                "finishedAt": None,
                "publishedChanges": 0,
            })
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
        self.assertEqual(stats["counts"], {"pending": 1, "pendingPublication": 1})

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

    def test_reject_is_staged_for_formal_publication(self):
        response = self.client.post(
            "/api/rmrb-review/decision",
            json={
                "date": "1950-01-01",
                "page": 1,
                "peopleDataOrdinal": 2,
                "decision": "reject",
                "reason": "确认是重复目录项",
            },
        )
        self.assertEqual(response.status_code, 200)
        pending = json.loads(
            (self.root / "manual-review-pending-publication.json").read_text(encoding="utf-8")
        )["items"]
        self.assertEqual(pending["1950-01-01|1|2"]["decision"], "reject")
        self.assertEqual(pending["1950-01-01|1|2"]["targets"], ["huggingface", "b2"])

    def test_reject_requires_a_catalog_error_reason(self):
        response = self.client.post(
            "/api/rmrb-review/decision",
            json={
                "date": "1950-01-01",
                "page": 1,
                "peopleDataOrdinal": 2,
                "decision": "reject",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("reason", response.get_json()["error"])

    def test_missing_tombstone_restores_legacy_reject_to_queue(self):
        legacy = self.root / "manual-review-decisions-legacy.jsonl"
        legacy.write_text(json.dumps({
            "date": "1950-01-01",
            "page": 1,
            "peopleDataOrdinal": 2,
            "decision": "reject",
            "reason": "OCR 不完整",
        }, ensure_ascii=False) + "\n", encoding="utf-8")
        self.decisions.write_text(json.dumps({
            "date": "1950-01-01",
            "page": 1,
            "peopleDataOrdinal": 2,
            "decision": "missing",
            "reason": "恢复人工复核",
        }, ensure_ascii=False) + "\n", encoding="utf-8")

        queue = self.client.get("/api/rmrb-review/queue?pendingOnly=1").get_json()
        self.assertEqual(queue["total"], 2)
        self.assertEqual(queue["items"][0]["title"], "较早稿")

    def test_publishes_formal_data_without_remote_annotation_ledger(self):
        self.client.post(
            "/api/rmrb-review/decision",
            json={
                "date": "1950-01-01",
                "page": 1,
                "peopleDataOrdinal": 2,
                "decision": "accept",
                "content": "确认正文。",
            },
        )
        canonical = CanonicalPatch(self.sync_root / "publish", accepted_count=1, changed_article_count=1)
        delivery = DeliveryPatch(self.sync_root / "delivery", changed_article_count=1)
        with patch.object(routes, "_prepare_publication", return_value=canonical), patch.object(
            routes, "_prepare_delivery", return_value=delivery
        ), patch.object(
            routes, "_sync_huggingface", return_value={"repoId": "owner/dataset", "commit": "abc", "publishedArticles": 1}
        ) as sync_hf, patch.object(
            routes, "_sync_b2", return_value={"remote": "remote/path", "sha256": "digest", "publishedArticles": 1}
        ) as sync_b2:
            response = self.client.post(
                "/api/rmrb-review/sync",
                json={"targets": ["huggingface", "b2"]},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["stagedCount"], 1)
        self.assertEqual(payload["pendingPublication"], 0)
        self.assertEqual(payload["canonicalChanges"], 1)
        sync_hf.assert_called_once()
        sync_b2.assert_called_once()
        self.assertFalse((self.sync_root / "review-decisions.jsonl.gz").exists())
        self.assertFalse((self.sync_root / "review-decisions.manifest.json").exists())
        state = json.loads((self.sync_root / "review-sync-state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["targets"]["huggingface"]["acceptedCount"], 1)
        self.assertEqual(state["targets"]["b2"]["acceptedCount"], 1)
        progress = self.client.get("/api/rmrb-review/sync").get_json()["progress"]
        self.assertEqual(progress["status"], "succeeded")
        self.assertEqual(progress["phase"], "complete")
        self.assertEqual(progress["percent"], 100)
        self.assertEqual(progress["publishedChanges"], 1)

    def test_sync_requires_at_least_one_known_target(self):
        response = self.client.post("/api/rmrb-review/sync", json={"targets": []})
        self.assertEqual(response.status_code, 400)
        response = self.client.post("/api/rmrb-review/sync", json={"targets": ["unknown"]})
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
