import gzip
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import rmrb_review_publish as publish


class RmrbReviewPublishTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.hf = self.root / "hf"
        self.delivery = self.root / "b2"
        self.output = self.root / "out"
        self.day = "1950-01-01"
        self.key = (self.day, 1, 0)
        self.article_id = publish._article_id(*self.key)
        self.decisions = {
            self.key: {
                "date": self.day,
                "page": 1,
                "peopleDataOrdinal": 0,
                "title": "待补文章",
                "decision": "accept",
                "content": "人工确认的正文。",
            }
        }
        self._write_sources()

    def tearDown(self):
        self.directory.cleanup()

    def _write_sources(self):
        dataset = {
            "formatVersion": "jojo-dataset/1",
            "datasetId": "rmrb",
            "availability": {
                "text": {
                    "format": "adaptive-calendar/1",
                    "startDate": "1950-01-01",
                    "endDate": "1950-01-02",
                    "default": "available",
                    "years": {"1950": {"include": {"dates": ["01-02"]}}},
                },
                "pdf": {
                    "format": "adaptive-calendar/1",
                    "startDate": "1950-01-01",
                    "endDate": "1950-01-02",
                    "default": "available",
                    "years": {},
                },
            },
        }
        path = self.hf / "newspapers/rmrb/dataset.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(dataset, ensure_ascii=False), encoding="utf-8")
        item = {
            "formatVersion": "jojo-item/1",
            "revision": 1,
            "itemId": f"rmrb:{self.day}",
            "content": {"articles": [{
                "id": self.article_id,
                "order": 1,
                "title": "待补文章",
                "contentState": "missing",
                "body": {"format": "text", "value": ""},
                "assetRefs": [],
            }]},
        }
        publish._write_json_gz(
            self.hf / f"newspapers/rmrb/items/1950/01/{self.day}.json.gz", item,
        )
        publish._write_jsonl_gz(
            self.hf / "newspapers/rmrb/data/articles/1950.jsonl.gz",
            [
                {"date": self.day, "page": 1, "ordinal": 0, "title": "待补文章", "content": "", "status": "missing", "pdf": None},
                {"date": "1950-01-02", "page": 1, "ordinal": 0, "title": "已有文章", "content": "已有", "status": "available", "pdf": None},
            ],
        )
        publish._write_jsonl_gz(
            self.hf / publish.MISSING_INDEX,
            [{"date": self.day, "page": 1, "ordinal": 0, "title": "待补文章", "status": "missing"}],
        )
        prefix = f"content/newspapers/rmrb/items/1950/01/{self.day}"
        manifest = {
            "formatVersion": "jojo-item-manifest/1",
            "revision": 1,
            "itemId": f"rmrb:{self.day}",
            "availability": {"text": "missing", "pdf": "missing"},
            "content": {"articles": [{
                "id": self.article_id,
                "order": 1,
                "title": "待补文章",
                "characterCount": 0,
                "status": "missing",
                "object": None,
            }]},
            "contentStats": {"articleCount": 1, "availableArticleCount": 0, "missingArticleCount": 1, "characterCount": 0},
        }
        publish._write_jox(self.delivery / f"{prefix}/manifest.jox", f"{prefix}/manifest.jox", manifest)
        index_key = "content/newspapers/rmrb/index.jox"
        publish._write_jox(
            self.delivery / index_key,
            index_key,
            {"formatVersion": "jojo-delivery-index/1", "revision": 1, "availability": dataset["availability"]},
        )

    def test_accept_patches_canonical_viewer_and_availability(self):
        patch = publish.prepare_canonical_patch(
            self.decisions, lambda name: self.hf / name, self.output / "canonical",
        )
        self.assertEqual(patch.changed_article_count, 1)
        self.assertTrue(patch.dataset_changed)
        self.assertEqual(len(patch.files), 4)
        item = publish._read_json_gz(patch.issue_files[self.day])
        article = item["content"]["articles"][0]
        self.assertEqual(article["contentState"], "available")
        self.assertEqual(article["body"]["value"], "人工确认的正文。")
        rows = publish._read_jsonl_gz(patch.files["newspapers/rmrb/data/articles/1950.jsonl.gz"])
        self.assertEqual(rows[0]["status"], "available")
        self.assertEqual(publish._read_jsonl_gz(patch.files[publish.MISSING_INDEX]), [])
        self.assertEqual(patch.dataset["availability"]["text"]["years"], {})

    def test_delivery_publishes_fragment_before_mutable_markers(self):
        canonical = publish.prepare_canonical_patch(
            self.decisions, lambda name: self.hf / name, self.output / "canonical",
        )
        patch = publish.prepare_delivery_patch(
            self.decisions, canonical, lambda name: self.delivery / name, self.output / "delivery",
        )
        self.assertEqual(patch.changed_article_count, 1)
        manifest_key = f"content/newspapers/rmrb/items/1950/01/{self.day}/manifest.jox"
        manifest = publish._decode_jox(patch.files[manifest_key], manifest_key)
        descriptor = manifest["content"]["articles"][0]
        self.assertEqual(descriptor["status"], "available")
        self.assertTrue(descriptor["object"].startswith("articles/"))
        self.assertEqual(manifest["contentStats"]["availableArticleCount"], 1)
        self.assertIn("content/newspapers/rmrb/index.jox", patch.files)

    def test_pasted_image_is_published_as_a_canonical_and_delivery_asset(self):
        image = b"\x89PNG\r\n\x1a\nclipboard-image"
        source = self.root / "attachments" / "table.png"
        source.parent.mkdir(parents=True)
        source.write_bytes(image)
        digest = hashlib.sha256(image).hexdigest()
        self.decisions[self.key].update({
            "content": "【图片】",
            "images": [{
                "path": str(source),
                "mediaType": "image/png",
                "sha256": digest,
                "size": len(image),
            }],
        })
        canonical = publish.prepare_canonical_patch(
            self.decisions, lambda name: self.hf / name, self.output / "canonical",
        )
        item = publish._read_json_gz(canonical.issue_files[self.day])
        article = item["content"]["articles"][0]
        asset = next(row for row in item["assets"] if row["type"] == "image")
        self.assertEqual(article["assetRefs"], [asset["id"]])
        self.assertEqual(article["body"]["format"], "html")
        self.assertIn(f'data-asset-id="{asset["id"]}"', article["body"]["value"])
        canonical_asset = f"newspapers/rmrb/assets/images/{digest}.png"
        self.assertEqual(canonical.files[canonical_asset].read_bytes(), image)

        delivery = publish.prepare_delivery_patch(
            self.decisions, canonical, lambda name: self.delivery / name, self.output / "delivery",
        )
        manifest_key = f"content/newspapers/rmrb/items/1950/01/{self.day}/manifest.jox"
        manifest = publish._decode_jox(delivery.files[manifest_key], manifest_key)
        delivered_asset = next(row for row in manifest["assets"] if row["id"] == asset["id"])
        asset_key = f"content/newspapers/rmrb/items/1950/01/{self.day}/{delivered_asset['object']}"
        self.assertIn(asset_key, delivery.files)
        self.assertEqual(
            publish._transform_jox(delivery.files[asset_key].read_bytes(), asset_key),
            image,
        )

    def test_reject_uses_article_state_without_publishing_a_fragment(self):
        self.decisions[self.key].update({"decision": "reject", "content": ""})
        canonical = publish.prepare_canonical_patch(
            self.decisions, lambda name: self.hf / name, self.output / "canonical",
        )
        item = publish._read_json_gz(canonical.issue_files[self.day])
        article = item["content"]["articles"][0]
        self.assertEqual(article["contentState"], "rejected")
        self.assertEqual(article["body"]["value"], "")
        rows = publish._read_jsonl_gz(
            canonical.files["newspapers/rmrb/data/articles/1950.jsonl.gz"]
        )
        self.assertEqual(rows[0]["status"], "rejected")
        self.assertEqual(publish._read_jsonl_gz(canonical.files[publish.MISSING_INDEX]), [])

        delivery = publish.prepare_delivery_patch(
            self.decisions, canonical, lambda name: self.delivery / name, self.output / "delivery",
        )
        manifest_key = f"content/newspapers/rmrb/items/1950/01/{self.day}/manifest.jox"
        manifest = publish._decode_jox(delivery.files[manifest_key], manifest_key)
        descriptor = manifest["content"]["articles"][0]
        self.assertEqual(descriptor["status"], "rejected")
        self.assertIsNone(descriptor["object"])
        self.assertEqual(manifest["contentStats"]["rejectedArticleCount"], 1)
        self.assertEqual(manifest["contentStats"]["missingArticleCount"], 0)
        self.assertFalse(any("/articles/" in name for name in delivery.files))

    def test_missing_transition_restores_a_false_reject_to_the_queue(self):
        self.decisions[self.key].update({"decision": "missing", "content": ""})
        shard = self.hf / "newspapers/rmrb/data/articles/1950.jsonl.gz"
        rows = publish._read_jsonl_gz(shard)
        rows[0]["status"] = "rejected"
        publish._write_jsonl_gz(shard, rows)
        item_path = self.hf / f"newspapers/rmrb/items/1950/01/{self.day}.json.gz"
        item = publish._read_json_gz(item_path)
        item["content"]["articles"][0]["contentState"] = "rejected"
        publish._write_json_gz(item_path, item)
        manifest_key = f"content/newspapers/rmrb/items/1950/01/{self.day}/manifest.jox"
        manifest_path = self.delivery / manifest_key
        manifest = publish._decode_jox(manifest_path, manifest_key)
        manifest["content"]["articles"][0]["status"] = "rejected"
        manifest["contentStats"].update({"missingArticleCount": 0, "rejectedArticleCount": 1})
        publish._write_jox(manifest_path, manifest_key, manifest)

        canonical = publish.prepare_canonical_patch(
            self.decisions, lambda name: self.hf / name, self.output / "canonical",
        )
        restored = publish._read_json_gz(canonical.issue_files[self.day])
        self.assertEqual(restored["content"]["articles"][0]["contentState"], "missing")
        missing = publish._read_jsonl_gz(canonical.files[publish.MISSING_INDEX])
        self.assertEqual(len(missing), 1)

        delivery = publish.prepare_delivery_patch(
            self.decisions, canonical, lambda name: self.delivery / name, self.output / "delivery",
        )
        manifest = publish._decode_jox(delivery.files[manifest_key], manifest_key)
        self.assertEqual(manifest["content"]["articles"][0]["status"], "missing")

    def test_jsonl_supplement_append_preserves_existing_rows_and_adds_delivery_fragment(self):
        source_key = (self.day, 2, 5)
        source_rows = {source_key: {
            "date": self.day,
            "page": 2,
            "ordinal": 5,
            "title": "JSONL 原题\n作者",
            "content": "此前没有表示的可信正文。",
            "contentSource": "jsonl",
            "matchMethod": "jsonl_directory_omission",
        }}
        canonical = publish.prepare_canonical_jsonl_supplement_append(
            source_rows, lambda name: self.hf / name, self.output / "canonical-supplements",
        )
        self.assertEqual(canonical.changed_article_count, 1)
        item = publish._read_json_gz(canonical.issue_files[self.day])
        self.assertEqual(len(item["content"]["articles"]), 2)
        self.assertEqual(item["content"]["articles"][0]["contentState"], "missing")
        appended = item["content"]["articles"][1]
        self.assertEqual(appended["id"], publish._article_id(*source_key))
        self.assertEqual(appended["body"]["value"], "此前没有表示的可信正文。")
        self.assertNotIn("sourceOnly", appended["extensions"]["rmrb"])
        self.assertEqual(
            appended["extensions"]["rmrb"]["matchMethod"],
            "jsonl_directory_omission",
        )
        self.assertEqual(item["content"]["pages"][0]["number"], 2)
        self.assertEqual(item["content"]["placements"][0]["articleId"], appended["id"])
        viewer = publish._read_jsonl_gz(
            canonical.files["newspapers/rmrb/data/articles/1950.jsonl.gz"]
        )
        viewer_append = next(row for row in viewer if int(row["ordinal"]) == 5)
        self.assertNotIn("sourceOnly", viewer_append)
        self.assertNotIn(publish.MISSING_INDEX, canonical.files)

        delivery = publish.prepare_delivery_jsonl_supplement_append(
            source_rows,
            canonical,
            lambda name: self.delivery / name,
            self.output / "delivery-supplements",
        )
        self.assertEqual(delivery.changed_article_count, 1)
        manifest_key = f"content/newspapers/rmrb/items/1950/01/{self.day}/manifest.jox"
        manifest = publish._decode_jox(delivery.files[manifest_key], manifest_key)
        descriptors = manifest["content"]["articles"]
        self.assertEqual(len(descriptors), 2)
        self.assertEqual(descriptors[-1]["id"], appended["id"])
        self.assertEqual(descriptors[-1]["status"], "available")
        self.assertEqual(manifest["contentStats"]["missingArticleCount"], 1)
        self.assertEqual(manifest["contentStats"]["availableArticleCount"], 1)
        fragment_key = f"content/newspapers/rmrb/items/1950/01/{self.day}/{descriptors[-1]['object']}"
        self.assertIn(fragment_key, delivery.files)


if __name__ == "__main__":
    unittest.main()
