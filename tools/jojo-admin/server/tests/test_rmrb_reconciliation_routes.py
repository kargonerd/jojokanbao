import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import rmrb_reconciliation_routes as routes


ROWS = [
    {
        "date": "1946-07-23",
        "page": 1,
        "preservedOrdinal": 21,
        "title": "梁漱溟发表谈话",
        "content": "确认正文一。",
        "reconciliationSignals": ["suspected_title_typo"],
        "suspectedTypoCandidates": [
            {
                "date": "1946-07-23",
                "page": 1,
                "ordinal": 9,
                "title": "梁潄溟发表谈话",
                "editDistance": 1,
            }
        ],
        "nearbyExactMatches": [],
    },
    {
        "date": "1946-07-31",
        "page": 2,
        "preservedOrdinal": 24,
        "title": "另一篇",
        "content": "确认正文二。",
        "reconciliationSignals": ["adjacent_date"],
        "suspectedTypoCandidates": [],
        "nearbyExactMatches": [
            {
                "date": "1946-08-01",
                "page": 2,
                "ordinal": 14,
                "title": "另一篇",
                "kind": "adjacent_date",
            }
        ],
    },
]


class RmrbReconciliationRoutesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.source = self.root / "review.jsonl"
        self.decisions = self.root / "state" / "review-decisions.jsonl"
        self.source.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in ROWS),
            encoding="utf-8",
        )
        self.patches = (
            patch.object(routes, "SOURCE_FILE", self.source),
            patch.object(routes, "REVIEW_ROOT", self.decisions.parent),
            patch.object(routes, "DECISIONS_FILE", self.decisions),
        )
        for item in self.patches:
            item.start()
        app = Flask(__name__)
        app.register_blueprint(routes.rmrb_reconciliation_blueprint)
        self.client = app.test_client()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.directory.cleanup()

    def test_queue_exposes_evidence_in_date_order(self):
        response = self.client.get("/api/rmrb-reconciliation/queue?status=pending")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["total"], 2)
        self.assertEqual(payload["counts"]["pending"], 2)
        first = payload["items"][0]
        self.assertEqual(first["title"], "梁漱溟发表谈话")
        self.assertEqual(first["candidates"][0]["candidateKey"], "1946-07-23|1|9")
        self.assertIn("pageNum", first["candidates"][0]["peopleDataHref"])
        self.assertIn("%221%22", first["candidates"][0]["peopleDataHref"])

    def test_jsonl_correct_is_saved_and_advances_pending_queue(self):
        response = self.client.post(
            "/api/rmrb-reconciliation/decision",
            json={
                "date": "1946-07-23",
                "page": 1,
                "ordinal": 21,
                "resolution": "jsonl_correct",
            },
        )
        self.assertEqual(response.status_code, 200)
        saved = json.loads(self.decisions.read_text(encoding="utf-8"))
        self.assertEqual(saved["resolution"], "jsonl_correct")
        self.assertEqual(len(saved["sourceFingerprint"]), 64)
        queue = self.client.get("/api/rmrb-reconciliation/queue?status=pending").get_json()
        self.assertEqual(queue["total"], 1)
        self.assertEqual(queue["items"][0]["title"], "另一篇")

    def test_merge_rejects_a_candidate_from_another_record(self):
        response = self.client.post(
            "/api/rmrb-reconciliation/decision",
            json={
                "date": "1946-07-23",
                "page": 1,
                "ordinal": 21,
                "resolution": "merge_candidate",
                "candidateKey": "1946-08-01|2|14",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("not valid", response.get_json()["error"])

    def test_merge_and_delete_decision(self):
        response = self.client.post(
            "/api/rmrb-reconciliation/decision",
            json={
                "date": "1946-07-23",
                "page": 1,
                "ordinal": 21,
                "resolution": "merge_candidate",
                "candidateKey": "1946-07-23|1|9",
                "note": "目录字形更可信",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["decision"]["candidate"]["ordinal"], 9)
        reviewed = self.client.get(
            "/api/rmrb-reconciliation/queue?status=reviewed"
        ).get_json()
        self.assertEqual(reviewed["total"], 1)

        deleted = self.client.delete(
            "/api/rmrb-reconciliation/decision",
            json={"date": "1946-07-23", "page": 1, "ordinal": 21},
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertTrue(deleted.get_json()["removed"])
        self.assertEqual(
            self.client.get("/api/rmrb-reconciliation/queue?status=pending").get_json()[
                "total"
            ],
            2,
        )

    def test_manual_metadata_requires_complete_values(self):
        response = self.client.post(
            "/api/rmrb-reconciliation/decision",
            json={
                "date": "1946-07-31",
                "page": 2,
                "ordinal": 24,
                "resolution": "manual_metadata",
                "resolvedDate": "1946-07-31",
                "resolvedPage": 2,
                "resolvedTitle": "",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("incomplete", response.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
