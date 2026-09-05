import json
import base64
import gzip
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

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
        self.source_manager = Mock()
        self.source_manager.snapshot.return_value = {
            "status": "ready",
            "source": "huggingface",
            "message": "HF 待复核队列已就绪",
            "completed": 1,
            "total": 1,
            "revision": "revision-1",
            "error": None,
            "cached": True,
        }
        build_database(self.database)
        self.patches = (
            patch.object(routes, "REVIEW_ROOT", self.root),
            patch.object(routes, "REVIEW_DB", self.database),
            patch.object(routes, "WORKBENCH_DECISIONS", self.decisions),
            patch.object(routes, "SYNC_ROOT", self.sync_root),
            patch.object(routes, "SYNC_STATE", self.sync_root / "review-sync-state.json"),
            patch.object(routes, "PUBLISH_ROOT", self.sync_root / "publish"),
            patch.object(routes, "RELEASES_ROOT", self.sync_root / "releases"),
            patch.object(routes, "PENDING_PUBLICATION", self.root / "manual-review-pending-publication.json"),
            patch.object(routes, "review_source_manager", self.source_manager),
            patch.object(routes, "_remote_release", return_value=None),
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

    def test_accept_saves_a_pasted_image_and_uses_the_image_marker(self):
        image = b"\x89PNG\r\n\x1a\nclipboard-image"
        response = self.client.post(
            "/api/rmrb-review/decision",
            json={
                "date": "1950-01-02",
                "page": 2,
                "peopleDataOrdinal": 4,
                "decision": "accept",
                "content": "",
                "images": [{
                    "name": "table.png",
                    "mediaType": "image/png",
                    "dataUrl": "data:image/png;base64," + base64.b64encode(image).decode("ascii"),
                }],
            },
        )
        self.assertEqual(response.status_code, 200)
        saved = json.loads(self.decisions.read_text(encoding="utf-8"))
        self.assertEqual(saved["content"], "【图片】")
        self.assertEqual(saved["images"][0]["mediaType"], "image/png")
        attachment = Path(saved["images"][0]["path"])
        self.assertEqual(attachment.read_bytes(), image)
        pending = json.loads(
            (self.root / "manual-review-pending-publication.json").read_text(encoding="utf-8")
        )["items"]["1950-01-02|2|4"]
        self.assertIn("payloadSha256", pending)

    def test_accept_downloads_an_embedded_people_data_image(self):
        image = b"\xff\xd8\xffembedded-image"
        source_url = routes.PEOPLE_DATA_IMAGE_PREFIX + "1950/example.jpg?vpn-1"
        remote = MagicMock()
        remote.__enter__.return_value.read.return_value = image
        with patch.object(routes.urllib.request, "urlopen", return_value=remote) as urlopen:
            response = self.client.post(
                "/api/rmrb-review/decision",
                json={
                    "date": "1950-01-02",
                    "page": 2,
                    "peopleDataOrdinal": 4,
                    "decision": "accept",
                    "content": "",
                    "images": [{
                        "name": "example.jpg",
                        "mediaType": "image/jpeg",
                        "sourceUrl": source_url,
                    }],
                },
            )
        self.assertEqual(response.status_code, 200)
        urlopen.assert_called_once()
        saved = json.loads(self.decisions.read_text(encoding="utf-8"))
        self.assertEqual(saved["content"], "【图片】")
        self.assertEqual(saved["images"][0]["sourceUrl"], source_url)
        self.assertEqual(Path(saved["images"][0]["path"]).read_bytes(), image)

    def test_embedded_image_rejects_an_untrusted_source(self):
        response = self.client.post(
            "/api/rmrb-review/decision",
            json={
                "date": "1950-01-02",
                "page": 2,
                "peopleDataOrdinal": 4,
                "decision": "accept",
                "content": "",
                "images": [{
                    "name": "example.jpg",
                    "mediaType": "image/jpeg",
                    "sourceUrl": "https://example.test/example.jpg",
                }],
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("not a People Data image", response.get_json()["error"])

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
        self.assertNotIn("targets", pending["1950-01-01|1|2"])

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

    def test_canonical_annual_row_is_projected_to_the_shared_search_schema(self):
        annual = self.root / "1950.jsonl.gz"
        with gzip.open(annual, "wt", encoding="utf-8") as stream:
            stream.write(json.dumps({
                "date": "1950-01-01",
                "page": 1,
                "ordinal": 2,
                "title": "较早稿",
                "status": "available",
                "content": "确认正文。",
                "pdf": None,
            }, ensure_ascii=False) + "\n")
        canonical = CanonicalPatch(self.root, dataset={"title": "人民日报"})
        canonical.files["newspapers/rmrb/data/articles/1950.jsonl.gz"] = annual

        rows = routes._rmrb_search_desired(
            canonical,
            {("1950-01-01", 1, 2)},
            "hf-commit",
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].document["content"], "确认正文。")
        self.assertEqual(rows[0].document["type"], "newspaper")
        self.assertEqual(rows[0].document["metadata"]["page"], 1)
        self.assertEqual(
            rows[0].document["metadata"]["canonicalObject"],
            "newspapers/rmrb/data/articles/1950.jsonl.gz",
        )

    def test_recovery_rebuilds_text_and_image_inputs_from_the_hf_commit(self):
        key = ("1950-01-01", 1, 2)
        hf = self.root / "hf"
        annual = hf / "newspapers/rmrb/data/articles/1950.jsonl.gz"
        annual.parent.mkdir(parents=True)
        with gzip.open(annual, "wt", encoding="utf-8") as stream:
            stream.write(json.dumps({
                "date": key[0], "page": key[1], "ordinal": key[2],
                "title": "较早稿", "status": "available", "content": "原始段落。",
            }, ensure_ascii=False) + "\n")
        item_path = hf / "newspapers/rmrb/items/1950/01/1950-01-01.json.gz"
        item_path.parent.mkdir(parents=True)
        with gzip.open(item_path, "wt", encoding="utf-8") as stream:
            json.dump({
                "content": {"articles": [{
                    "id": routes.canonical_article_id(*key),
                    "title": "较早稿",
                    "contentState": "available",
                    "body": {"format": "html", "value": "<p>原始段落。</p>"},
                    "assetRefs": ["asset:image-one"],
                }]},
                "assets": [{
                    "id": "asset:image-one", "type": "image", "path": "assets/images/one.png",
                    "sha256": "a" * 64, "mediaType": "image/png",
                }],
            }, stream, ensure_ascii=False)
        image = hf / "newspapers/rmrb/assets/images/one.png"
        image.parent.mkdir(parents=True)
        image.write_bytes(b"image")

        with patch.object(routes, "_hf_source_file", side_effect=lambda name, _revision: hf / name):
            decisions = routes._decisions_from_canonical({key}, "hf-commit")

        self.assertEqual(decisions[key]["content"], "原始段落。")
        self.assertEqual(decisions[key]["decision"], "accept")
        self.assertEqual(decisions[key]["images"][0]["path"], str(image))

    def test_historical_local_decisions_do_not_drive_the_hf_queue(self):
        legacy = self.root / "manual-review-decisions-legacy.jsonl"
        legacy.write_text(json.dumps({
            "date": "1950-01-01",
            "page": 1,
            "peopleDataOrdinal": 2,
            "decision": "reject",
            "reason": "OCR 不完整",
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
        search_publication = {
            "index": "search",
            "scope": "newspaper:rmrb",
            "canonicalRevision": "abc",
            "activation": {"expectedHeads": {}, "heads": {}, "excludedIds": []},
        }
        with patch.object(routes, "_huggingface_token", return_value="token"), patch.object(
            routes, "_hf_revision", return_value="parent"
        ), patch.object(
            routes, "_prepare_publication", return_value=canonical
        ), patch.object(
            routes, "_prepare_delivery", return_value=delivery
        ), patch.object(
            routes, "_sync_huggingface", return_value={"repoId": "owner/dataset", "commit": "abc", "publishedArticles": 1}
        ) as sync_hf, patch.object(
            routes, "_sync_b2", return_value={"remote": "remote/path", "sha256": "digest", "publishedArticles": 1}
        ) as sync_b2, patch.object(
            routes, "_search_index", return_value="search"
        ), patch.object(
            routes, "_search_publication_config", return_value={}
        ), patch.object(
            routes, "_search_client"
        ), patch.object(
            routes, "ensure_unified_mapping", return_value={"valid": True}
        ), patch.object(
            routes, "load_remote_search_state", return_value={"excludedIds": {"search": []}}
        ), patch.object(
            routes, "_remote_release", return_value=None
        ), patch.object(
            routes, "upload_remote_json_object"
        ), patch.object(
            routes, "active_revision_heads", return_value={}
        ), patch.object(
            routes, "_rmrb_search_desired", return_value=[]
        ), patch.object(
            routes.AppendOnlySearchPublisher, "publish", return_value=search_publication
        ), patch.object(
            routes, "publish_search_activation", return_value={"index": "search"}
        ), patch.object(
            routes.shutil, "which", return_value="tool.exe"
        ):
            response = self.client.post(
                "/api/rmrb-review/sync",
                json={},
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
        self.assertEqual(state["lastRelease"]["canonicalCommit"], "abc")
        progress = self.client.get("/api/rmrb-review/sync").get_json()["progress"]
        self.assertEqual(progress["status"], "succeeded")
        self.assertEqual(progress["phase"], "complete")
        self.assertEqual(progress["percent"], 100)
        self.assertEqual(progress["publishedChanges"], 1)

    def test_sync_requires_pending_canonical_changes(self):
        with patch.object(routes, "_hf_revision", return_value="parent"):
            response = self.client.post("/api/rmrb-review/sync", json={})
        self.assertEqual(response.status_code, 409)

    def test_remote_running_release_uses_a_short_cross_workstation_lease(self):
        current = routes.datetime.now(routes.timezone.utc).isoformat()
        self.assertTrue(routes._release_is_live({"status": "running", "updatedAt": current}))
        self.assertFalse(routes._release_is_live({
            "status": "running",
            "updatedAt": "2020-01-01T00:00:00+00:00",
        }))

    def test_another_workstation_resumes_after_canonical_commit(self):
        desired = {
            "repo": "luoxiaozhuang/marxism-dataset",
            "delivery": "jojo-b2-s3:jojo-newspaper",
            "searchIndex": "search",
            "items": {"1950-01-01|1|2": {
                "decision": "accept",
                "payloadSha256": "digest",
            }},
        }
        identifier = routes.release_id(desired)
        receipt = {
            "formatVersion": "jojo-canonical-release/1",
            "releaseId": identifier,
            "scope": "newspaper:rmrb",
            "status": "failed",
            "desired": desired,
            "stages": {
                "canonical": {"status": "succeeded", "attempts": 1, "result": {"commit": "hf-commit"}},
                "delivery": {"status": "failed", "attempts": 1},
                "search": {"status": "pending", "attempts": 0},
                "activation": {"status": "pending", "attempts": 0},
            },
        }
        canonical = CanonicalPatch(self.sync_root / "publish")
        delivery = DeliveryPatch(self.sync_root / "delivery")
        search_publication = {
            "index": "search",
            "scope": "newspaper:rmrb",
            "canonicalRevision": "hf-commit",
            "activation": {"expectedHeads": {}, "heads": {}, "excludedIds": []},
        }
        with patch.object(routes, "_huggingface_token", return_value="token"), patch.object(
            routes, "_search_index", return_value="search"
        ), patch.object(
            routes, "_search_publication_config", return_value={}
        ), patch.object(
            routes, "_remote_release", return_value=receipt
        ), patch.object(
            routes, "_decisions_from_canonical", return_value={
                ("1950-01-01", 1, 2): {"decision": "accept", "content": "正文"}
            }
        ), patch.object(
            routes, "_prepare_publication", return_value=canonical
        ), patch.object(
            routes, "_prepare_delivery", return_value=delivery
        ), patch.object(
            routes, "_sync_huggingface"
        ) as sync_hf, patch.object(
            routes, "_sync_b2", return_value={"publishedArticles": 1}
        ), patch.object(
            routes, "_search_client"
        ), patch.object(
            routes, "ensure_unified_mapping", return_value={"valid": True}
        ), patch.object(
            routes, "load_remote_search_state", return_value={"excludedIds": {"search": []}}
        ), patch.object(
            routes, "active_revision_heads", return_value={}
        ), patch.object(
            routes, "_rmrb_search_desired", return_value=[]
        ), patch.object(
            routes.AppendOnlySearchPublisher, "publish", return_value=search_publication
        ), patch.object(
            routes, "publish_search_activation", return_value={"index": "search"}
        ), patch.object(
            routes, "upload_remote_json_object"
        ), patch.object(
            routes.shutil, "which", return_value="tool.exe"
        ):
            response = self.client.post("/api/rmrb-review/sync", json={})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["releaseId"], identifier)
        sync_hf.assert_not_called()


if __name__ == "__main__":
    unittest.main()
