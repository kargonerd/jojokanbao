import sys
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
                        "type": "newspaper",
                        "datasetId": "rmrb",
                        "source": "人民日报",
                        "isRevision": True,
                        "replacedDocumentId": "revision-1",
                        "deleted": False,
                    },
                }],
            },
        }


class FakeSearchState:
    def __init__(self, excluded_getter):
        self._excluded_getter = excluded_getter

    def excluded_ids(self, index):
        return frozenset(self._excluded_getter())

    def status(self):
        return {
            "configured": True,
            "loaded": True,
            "excludedCount": len(self._excluded_getter()),
            "etag": None,
        }


class SearchRevisionApiTests(unittest.TestCase):
    def setUp(self):
        self.original_content_es = search_app.content_es
        self.original_content_index_name = search_app.content_index_name
        self.original_search_state = search_app.search_state
        self.fake_content_es = SearchEs()
        search_app.content_es = self.fake_content_es
        search_app.content_index_name = "content-test"
        self.excluded_ids = {"base-id"}
        search_app.search_state = FakeSearchState(lambda: self.excluded_ids)
        self.client = search_app.app.test_client()

    def tearDown(self):
        search_app.content_es = self.original_content_es
        search_app.content_index_name = self.original_content_index_name
        search_app.search_state = self.original_search_state

    def test_beta_origin_is_allowed_by_cors(self):
        response = self.client.get(
            "/health",
            headers={"Origin": "https://beta.jojokanbao.cn"},
        )
        self.assertEqual(
            response.headers.get("Access-Control-Allow-Origin"),
            "https://beta.jojokanbao.cn",
        )

    def test_unknown_origin_is_not_allowed_by_cors(self):
        response = self.client.get(
            "/health",
            headers={"Origin": "https://untrusted.example"},
        )
        self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))

    def test_unified_content_search_uses_common_fields_and_repair_exclusions(self):
        self.excluded_ids = {"old-content-id"}
        response = self.client.post("/content/search", json={
            "query": "最终正文",
            "types": ["newspaper"],
            "sources": ["人民日报"],
        })

        self.assertEqual(response.status_code, 200)
        result = response.get_json()["data"]["results"][0]
        self.assertEqual(result["documentId"], "revision-2")
        self.assertEqual(self.fake_content_es.calls, 1)
        query = self.fake_content_es.search_query["query"]
        self.assertEqual(
            query["bool"]["must_not"],
            [{"ids": {"values": ["old-content-id"]}}],
        )
        inner = query["bool"]["must"][0]["bool"]
        fields = inner["must"][0]["multi_match"]["fields"]
        self.assertIn("title^4", fields)
        self.assertIn("content", fields)
        self.assertIn({"terms": {"type": ["newspaper"]}}, inner["filter"])


if __name__ == "__main__":
    unittest.main()
