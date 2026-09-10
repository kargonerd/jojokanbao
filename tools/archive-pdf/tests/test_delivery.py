import copy
import gzip
import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delivery import DATASET, INDEX, Delivery, add_pdf_date, issue_keys, prepare_issue, publish_issue
from jojo_format import _available_dates, _decode_jox, _transform_jox


def calendar(end="2026-07-18"):
    return {"format": "adaptive-calendar/1", "startDate": "2026-07-16", "endDate": end,
            "default": "available", "years": {"2026": {"exclude": {"dates": ["07-17"]}}}}


class Store:
    def __init__(self, values, events):
        self.values = values
        self.events = events

    def read(self, key):
        return copy.deepcopy(self.values.get(key))

    def publish(self, *args, **kwargs):
        self.events.append((args, kwargs))

    def unchanged(self, key):
        pass


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.pdf = self.root / "source.pdf"
        self.pdf.write_bytes(b"%PDF-1.7\n" + bytes(range(256)) * 32)
        self.day = date(2026, 7, 20)
        self.events = []
        self.canonical = Store({DATASET: {"datasetId": "rmrb", "availability": {"text": calendar(), "pdf": calendar()}, "custom": "preserved"}}, self.events)
        self.delivery = Store({INDEX: {"datasetId": "rmrb", "revision": 5, "access": "public", "aiEnabled": False}}, self.events)

    def prepare(self):
        return prepare_issue(self.day, self.pdf, self.canonical, self.delivery, self.root)

    def test_extended_calendars_preserve_gaps_and_do_not_invent_text(self):
        result = add_pdf_date({"text": calendar(), "pdf": calendar()}, self.day)
        self.assertEqual(_available_dates(result["pdf"]), {"2026-07-16", "2026-07-18", "2026-07-20"})
        self.assertEqual(_available_dates(result["text"]), {"2026-07-16", "2026-07-18"})
        self.assertEqual(result["pdf"]["endDate"], "2026-07-20")

    def test_stages_new_issue_and_range_decodable_pdf_without_uploads(self):
        plan = self.prepare()
        self.assertEqual(self.events, [])
        self.assertTrue(all(key.startswith("content/newspapers/rmrb/") for key in plan["delivery"]))
        encoded = plan["delivery"][plan["asset"]].read_bytes()
        self.assertEqual(_transform_jox(encoded, plan["asset"]), self.pdf.read_bytes())
        manifest = _decode_jox(plan["delivery"][plan["manifest"]], plan["manifest"])
        self.assertEqual(manifest["availability"], {"text": "missing", "pdf": "available"})
        self.assertEqual(manifest["assets"][0]["sha256"], Path(plan["asset"]).name.split(".")[0])
        index = _decode_jox(plan["delivery"][INDEX], INDEX)
        self.assertEqual(index["revision"], 6)
        self.assertFalse(index["aiEnabled"])
        item = json.loads(gzip.decompress(plan["canonical"][issue_keys(self.day)[0]].read_bytes()))
        self.assertEqual(item["content"]["pages"], [])
        self.assertEqual(item["content"]["placements"], [])
        self.assertEqual(item["annotations"], [])
        self.assertEqual(item["revision"], 1)
        self.assertIn("provenance", item)

    def test_s3_synthetic_directory_means_the_exact_object_is_missing(self):
        from subprocess import CompletedProcess
        response = CompletedProcess([], 0, json.dumps({"Path": "", "Size": -1, "IsDir": True}).encode(), b"")
        with patch("delivery.subprocess.run", return_value=response) as run:
            self.assertIsNone(Delivery("test:bucket", self.root).read("missing/manifest.jox"))
            run.assert_called_once()

    def test_preserves_reviewed_articles_and_unrelated_metadata(self):
        item_key, _, manifest_key = issue_keys(self.day)
        item = {"itemId": f"rmrb:{self.day}", "datasetId": "rmrb", "content": {"articles": [{"body": "reviewed"}]},
                "assets": [{"id": "image", "type": "image"}], "access": "authenticated"}
        manifest = {**copy.deepcopy(item), "revision": 12, "availability": {"text": "available", "pdf": "missing"},
                    "contentStats": {"characterCount": 8}}
        self.canonical.values[item_key] = item
        self.delivery.values[manifest_key] = manifest
        plan = self.prepare()
        result = _decode_jox(plan["delivery"][manifest_key], manifest_key)
        self.assertEqual(result["content"], manifest["content"])
        self.assertEqual(result["contentStats"], manifest["contentStats"])
        self.assertEqual(result["access"], "authenticated")
        self.assertIn({"id": "image", "type": "image"}, result["assets"])
        self.assertEqual(result["availability"]["text"], "available")
        self.assertEqual(result["revision"], 13)

    def test_publication_orders_canonical_media_manifest_then_index(self):
        plan = self.prepare()
        publish_issue(self.day, plan, self.canonical, self.delivery)
        self.assertIsInstance(self.events[0][0][0], dict)
        self.assertEqual([event[0][0] for event in self.events[1:]], [plan["asset"], plan["manifest"], INDEX])
        self.assertTrue(self.events[1][1]["immutable"])

    def test_failed_canonical_publish_leaves_delivery_untouched(self):
        plan = self.prepare()
        def fail(*args):
            raise RuntimeError("parent commit conflict")
        self.canonical.publish = fail
        with self.assertRaisesRegex(RuntimeError, "conflict"):
            publish_issue(self.day, plan, self.canonical, self.delivery)
        self.assertEqual(self.events, [])

    def test_concurrent_operator_edit_stops_before_publication(self):
        plan = self.prepare()
        def changed(key):
            raise RuntimeError("changed")
        self.delivery.unchanged = changed
        with self.assertRaisesRegex(RuntimeError, "changed"):
            publish_issue(self.day, plan, self.canonical, self.delivery)
        self.assertEqual(self.events, [])

    def test_force_content_uses_new_object_without_replacing_previous_asset(self):
        first = self.prepare()["asset"]
        self.pdf.write_bytes(b"%PDF-1.7\nreplacement")
        second = self.prepare()["asset"]
        self.assertNotEqual(first, second)
        self.assertTrue((self.root / "delivery" / first).exists())

    def test_refuses_missing_delivery_for_a_reviewed_canonical_issue(self):
        item_key, _, _ = issue_keys(self.day)
        self.canonical.values[item_key] = {"itemId": f"rmrb:{self.day}", "datasetId": "rmrb", "content": {"articles": [{"body": "reviewed"}]}}
        with self.assertRaisesRegex(ValueError, "complete Delivery"):
            self.prepare()


if __name__ == "__main__":
    unittest.main()
