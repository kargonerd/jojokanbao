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
                    "highlight": {
                        "title": ["第<mark>一</mark>章"],
                        "content": ["<mark>苹果</mark>正文"],
                    },
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
        self.assertEqual(payload["results"][0]["titleHighlights"], ["第<mark>一</mark>章"])
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
        self.assertEqual(self.fake_es.body['query']['bool']['should'][0], {
            'match_phrase': {'title': {'query': '苹果', 'boost': 16}},
        })
        self.assertEqual(self.fake_es.body['_source'], [
            'type', 'datasetId', 'itemId', 'title', 'content', 'date', 'source', 'metadata',
        ])
        self.assertEqual(self.fake_es.body['from'], 0)
        self.assertEqual(self.fake_es.body['track_total_hits'], 10000)

    def test_new_frontend_filters_paginates_and_sorts_the_unified_index(self):
        response = self.client.post('/content/search', json={
            'query': '教育',
            'page': 3,
            'size': 10,
            'datasetIds': ['rmrb'],
            'types': ['newspaper'],
            'startDate': '1988-06-01',
            'endDate': '1988-06-30',
            'sort': 'timeDesc',
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.fake_es.body['from'], 20)
        self.assertEqual(self.fake_es.body['size'], 10)
        self.assertEqual(self.fake_es.body['query']['bool']['filter'], [
            {'terms': {'datasetId': ['rmrb']}},
            {'terms': {'type': ['newspaper']}},
            {'range': {'date': {'gte': '1988-06-01', 'lte': '1988-06-30'}}},
        ])
        self.assertEqual(self.fake_es.body['sort'], [
            {'date': {'order': 'desc', 'missing': '_last'}},
            {'_score': {'order': 'desc'}},
        ])

    def test_rejects_invalid_dates_and_pages_beyond_the_result_window(self):
        incomplete = self.client.post('/content/search', json={
            'query': '教育', 'startDate': '1988-06-01',
        })
        malformed = self.client.post('/content/search', json={
            'query': '教育', 'startDate': '1988-02-30', 'endDate': '1988-03-01',
        })
        reversed_range = self.client.post('/content/search', json={
            'query': '教育', 'startDate': '1988-07-01', 'endDate': '1988-06-01',
        })
        too_deep = self.client.post('/content/search', json={
            'query': '教育', 'page': 1001, 'size': 10,
        })

        self.assertEqual(incomplete.status_code, 400)
        self.assertEqual(malformed.status_code, 400)
        self.assertEqual(reversed_range.status_code, 400)
        self.assertEqual(too_deep.status_code, 400)


if __name__ == "__main__":
    unittest.main()
