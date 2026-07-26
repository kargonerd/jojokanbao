import sys
import unittest
from pathlib import Path


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

import app as search_app  # noqa: E402


class SearchEs:
    def __init__(self):
        self.search_query = None

    def search(self, *, index, body):
        if body.get("_source") == ["supersedesId"]:
            return {
                "hits": {
                    "total": {"value": 2},
                    "hits": [
                        {"_source": {"supersedesId": "base-id"}},
                        {"_source": {"supersedesId": "revision-1"}},
                    ],
                }
            }
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
        self.fake_es = SearchEs()
        search_app.es = self.fake_es
        search_app.revision_state.clear()
        self.client = search_app.app.test_client()

    def tearDown(self):
        search_app.es = self.original_es
        search_app.revision_state.clear()

    def test_search_filters_chain_before_pagination_and_returns_document_id(self):
        response = self.client.get("/search?keyword=最终&page=2&size=5")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()["data"]
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["results"][0]["documentId"], "revision-2")
        self.assertNotIn("supersedesId", payload["results"][0])

        query = self.fake_es.search_query
        self.assertEqual(query["from"], 5)
        self.assertEqual(query["size"], 5)
        self.assertEqual(
            query["query"]["bool"]["must_not"],
            [
                {"term": {"deleted": True}},
                {"ids": {"values": ["base-id", "revision-1"]}},
            ],
        )


if __name__ == "__main__":
    unittest.main()
