import sys
import unittest
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
                        "datasetId": "book-a",
                        "datasetTitle": "测试书库",
                        "itemId": "book-a:full-book",
                        "itemTitle": "测试书",
                        "targetId": "chapter:1",
                        "targetTitle": "第一章",
                        "text": "苹果正文",
                        "manifestObject": "content/books/book-a/items/full-book/manifest.jox",
                        "fragmentObject": "content/books/book-a/items/full-book/chapters/a.jox",
                    },
                    "highlight": {"text": ["<mark>苹果</mark>正文"]},
                }],
            },
        }


class ContentSearchTests(unittest.TestCase):
    def setUp(self):
        self.original_es = search_app.es
        self.fake_es = ContentSearchEs()
        search_app.es = self.fake_es
        self.client = search_app.app.test_client()

    def tearDown(self):
        search_app.es = self.original_es

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
        self.assertEqual(payload["results"][0]["targetId"], "chapter:1")
        self.assertEqual(self.fake_es.index, search_app.content_index_name)
        self.assertEqual(self.fake_es.body["query"]["bool"]["filter"], [
            {"bool": {
                "should": [
                    {"terms": {"datasetId": ["book-a"]}},
                    {"match_phrase": {"datasetId": "book-a"}},
                ],
                "minimum_should_match": 1,
            }},
            {"bool": {
                "should": [
                    {"terms": {"itemId": ["book-a:full-book"]}},
                    {"match_phrase": {"itemId": "book-a:full-book"}},
                ],
                "minimum_should_match": 1,
            }},
        ])

    def test_search_returns_distinct_fragments_after_chunk_overfetch(self):
        class DuplicateChunks(ContentSearchEs):
            def search(inner_self, *, index, body):
                inner_self.index = index
                inner_self.body = body
                base = super(DuplicateChunks, inner_self).search(index=index, body=body)
                first = base['hits']['hits'][0]
                second = {
                    **first,
                    '_source': {
                        **first['_source'],
                        'targetId': 'chapter:2',
                        'targetTitle': '第二章',
                        'fragmentObject': 'content/books/book-a/items/full-book/chapters/b.jox',
                    },
                }
                base['hits']['hits'] = [first, first, second]
                base['hits']['total'] = {'value': 3}
                return base

        self.fake_es = DuplicateChunks()
        search_app.es = self.fake_es
        response = self.client.post('/content/search', json={'query': '苹果', 'size': 2})
        results = response.get_json()['data']['results']
        self.assertEqual(self.fake_es.body['size'], 10)
        self.assertEqual([item['targetId'] for item in results], ['chapter:1', 'chapter:2'])


if __name__ == "__main__":
    unittest.main()
