import copy
import gzip
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import content_cache
from jojo_format import _write_jox, _json_bytes, _transform_jox


class ContentCacheTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.manifest = "content/books/book-a/items/full-book/manifest.jox"
        self.index = "content/books/book-a/index.jox"
        settings = {"publicationStatus": "published", "access": "authenticated"}
        self.values = {
            self.manifest: {**settings, "content": {"chapters": [{"object": "chapters/new.jox"}]}},
            self.index: {**settings, "items": [{"itemId": "book-a:full-book", **settings}]},
            "catalog.jox": {"datasets": [{"datasetId": "book-a", **settings}]},
        }
        (self.root / "report.json").write_text(json.dumps({"itemsBuilt": [{"datasetId": "book-a", "manifestObject": self.manifest}]}))
        for key, value in self.values.items():
            location = "delivery" if key == self.manifest else ".publish/merged"
            _write_jox(self.root / location / key, key, value)
        self.session = Mock()
        self.session.__enter__ = Mock(return_value=self.session)
        self.session.__exit__ = Mock(return_value=False)

    def response(self, key, value):
        return Mock(content=_transform_jox(gzip.compress(_json_bytes(value)), key))

    def test_reads_only_mutable_objects_and_waits_for_stale_cdn(self):
        calls = {}

        def get(url, **_):
            key = url.split("example.test/", 1)[1]
            calls[key] = calls.get(key, 0) + 1
            value = copy.deepcopy(self.values[key])
            if key == self.index and calls[key] == 1:
                value["publicationStatus"] = "draft"
            if key == "catalog.jox":
                value["datasets"].append({"datasetId": "unrelated", "publicationStatus": "published"})
            return self.response(key, value)

        self.session.get.side_effect = get
        with patch.object(content_cache.requests, "Session", return_value=self.session), patch.object(content_cache.time, "sleep"), patch.dict(content_cache.os.environ, {"VITE_CONTENT_CDN_BASE": "https://example.test/"}):
            result = content_cache.refresh_book_delivery(self.root, lambda _: None)
        self.assertEqual(result["status"], "verified")
        self.assertEqual(calls[self.index], 2)
        self.assertEqual(calls[self.manifest], 1)
        self.assertEqual(set(calls), set(self.values))

    def test_timeout_does_not_hide_a_wrong_reading_gate(self):
        def get(url, **_):
            key = next(key for key in self.values if url.endswith(key))
            value = copy.deepcopy(self.values[key])
            if key == self.manifest:
                value["access"] = "public"
            return self.response(key, value)

        self.session.get.side_effect = get
        with patch.object(content_cache.requests, "Session", return_value=self.session), patch.object(content_cache.time, "monotonic", side_effect=[0, 181]):
            with self.assertRaisesRegex(RuntimeError, "线上缓存尚未更新"):
                content_cache.refresh_book_delivery(self.root, lambda _: None)

    def test_transient_network_failure_retries_unverified_objects(self):
        calls = {}

        def get(url, **_):
            key = next(key for key in self.values if url.endswith(key))
            calls[key] = calls.get(key, 0) + 1
            if key == self.manifest and calls[key] == 1:
                raise content_cache.requests.ConnectionError("temporary failure")
            return self.response(key, self.values[key])

        self.session.get.side_effect = get
        with patch.object(content_cache.requests, "Session", return_value=self.session), patch.object(content_cache.time, "sleep"):
            result = content_cache.refresh_book_delivery(self.root, lambda _: None)
        self.assertEqual(result["status"], "verified")
        self.assertEqual(calls[self.manifest], 2)
        self.assertEqual(calls[self.index], 1)


if __name__ == "__main__":
    unittest.main()
