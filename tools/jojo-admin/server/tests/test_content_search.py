import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from content_search import search_content


class FakeClient:
    def __init__(self):
        self.call = None

    def request(self, method, path, body):
        self.call = (method, path, body)
        return 200, {"hits": {"total": {"value": 2}, "hits": [
            {"_score": 3, "_source": {"datasetId": "books", "fragmentObject": "content/books/a.jox", "text": "甲"}},
            {"_score": 2, "_source": {"datasetId": "books", "fragmentObject": "content/books/a.jox", "text": "重复"}},
        ]}}


class ContentSearchTest(unittest.TestCase):
    def test_search_filters_top_level_scopes_and_deduplicates_fragments(self):
        client = FakeClient()
        with patch.dict(os.environ, {
            "ES_CONTENT_INDEX": "content-index",
        }, clear=False):
            result = search_content({"query": "童年时代", "datasetIds": ["books"], "size": 5}, client)

        self.assertEqual(client.call[1], "content-index/_search")
        filters = client.call[2]["query"]["bool"]["filter"]
        self.assertEqual(filters, [{"bool": {
            "should": [
                {"terms": {"datasetId": ["books"]}},
                {"match_phrase": {"datasetId": "books"}},
            ],
            "minimum_should_match": 1,
        }}])
        self.assertEqual(result["data"]["total"], 2)
        self.assertEqual(len(result["data"]["results"]), 1)

    def test_empty_query_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "搜索词为空"):
            search_content({}, FakeClient())


if __name__ == "__main__":
    unittest.main()
