import json
import sys
import tempfile
import unittest
from pathlib import Path


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

import app as search_app  # noqa: E402


class SearchEs:
    def __init__(self):
        self.search_query = None
        self.calls = 0

    def search(self, *, index, body):
        self.calls += 1
        self.search_query = body
        return {
            "timed_out": False,
            "hits": {
                "total": {"value": 1},
                "hits": [{
                    "_id": "revision-2",
                    "_source": {
                        "@timestamp": "2026-07-26T00:00:00Z",
                        "title": "最终标题",
                        "content": "最终正文",
                        "date": "2026-07-26",
                        "page": 3,
                        "source": "rmrb",
                        "isRevision": True,
                        "supersedesId": "revision-1",
                        "deleted": False,
                    },
                }],
            },
        }


class SearchRevisionApiTests(unittest.TestCase):
    def setUp(self):
        self.original_es = search_app.es
        self.original_migrations_dir = search_app.migrations_dir
        self.temp_dir = tempfile.TemporaryDirectory()
        self.fake_es = SearchEs()
        search_app.es = self.fake_es
        search_app.migrations_dir = Path(self.temp_dir.name)
        (search_app.migrations_dir / "repair-test.json").write_text(
            json.dumps({
                "id": "repair-test",
                "index": search_app.index_name,
                "operation": "repair",
                "supersedesId": "base-id",
                "state": "applied",
            }),
            encoding="utf-8",
        )
        self.client = search_app.app.test_client()

    def tearDown(self):
        search_app.es = self.original_es
        search_app.migrations_dir = self.original_migrations_dir
        self.temp_dir.cleanup()

    def test_search_filters_chain_before_pagination_and_returns_document_id(self):
        response = self.client.get("/search?keyword=最终&page=2&size=5")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()["data"]
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["results"][0]["documentId"], "revision-2")
        self.assertNotIn("supersedesId", payload["results"][0])
        self.assertEqual(self.fake_es.calls, 1)

        query = self.fake_es.search_query
        self.assertEqual(query["from"], 5)
        self.assertEqual(query["size"], 5)
        self.assertEqual(
            query["query"]["bool"]["must_not"],
            [{"ids": {"values": ["base-id"]}}],
        )


if __name__ == "__main__":
    unittest.main()
