import sys
import unittest
from unittest.mock import patch
from pathlib import Path


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

import app as search_app  # noqa: E402


class ContentSearchEs:
    def __init__(self):
        self.index = None
        self.body = None

    def search(self, *, index, body):
        self.index = index
        self.body = body
        return {
            "hits": {
                "total": {"value": 1},
                "hits": [{
                    "_score": 4.2,
                    "_source": {
                        "type": "book",
                        "datasetId": "book-a",
                        "itemId": "book-a:full-book",
                        "title": "第一章",
                        "content": "苹果正文",
                        "source": "测试书库",
                        "metadata": {"chapterId": "chapter:1"},
                    },
                    "highlight": {"content": ["<mark>苹果</mark>正文"]},
                }],
            },
        }


class ContentSearchTests(unittest.TestCase):
    def setUp(self):
        self.original_content_es = search_app.content_es
        self.original_content_index_name = search_app.content_index_name
        self.fake_es = ContentSearchEs()
        search_app.content_es = self.fake_es
        search_app.content_index_name = "content-test"
        self.client = search_app.app.test_client()

    def tearDown(self):
        search_app.content_es = self.original_content_es
        search_app.content_index_name = self.original_content_index_name

    def test_search_applies_stable_dataset_and_item_filters(self):
        response = self.client.post("/content/search", json={
            "query": "苹果",
            "size": 5,
            "datasetIds": ["book-a"],
            "itemIds": ["book-a:full-book"],
        })
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()["data"]
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["results"][0]["metadata"]["chapterId"], "chapter:1")
        self.assertEqual(self.fake_es.index, search_app.content_index_name)
        self.assertEqual(self.fake_es.body["query"]["bool"]["filter"], [
            {"terms": {"datasetId": ["book-a"]}},
            {"terms": {"itemId": ["book-a:full-book"]}},
        ])

    def test_content_client_requires_its_own_complete_credentials(self):
        with patch.dict("os.environ", {
            "CONTENT_ELASTICSEARCH_URL": "https://content.example",
            "CONTENT_ELASTICSEARCH_USERNAME": "elastic",
        }, clear=True):
            self.assertIsNone(search_app.create_elasticsearch_client(
                "CONTENT_ELASTICSEARCH", require_auth=True
            ))

    def test_search_uses_only_the_unified_canonical_fields(self):
        response = self.client.post('/content/search', json={'query': '苹果', 'size': 2})
        results = response.get_json()['data']['results']
        self.assertEqual(len(results), 1)
        self.assertEqual(self.fake_es.body['size'], 2)
        self.assertEqual(
            self.fake_es.body['query']['bool']['must'][0]['multi_match']['fields'],
            ['title^4', 'content'],
        )
        self.assertEqual(self.fake_es.body['_source'], [
            'type', 'datasetId', 'itemId', 'title', 'content', 'date', 'source', 'metadata',
        ])


if __name__ == "__main__":
    unittest.main()
