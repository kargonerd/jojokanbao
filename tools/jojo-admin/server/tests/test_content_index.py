import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import content_index
from es_sync import SyncResult, book_documents


class ContentIndexTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "report.json").write_text(json.dumps({"itemsBuilt": [{"itemId": "a:full"}]}))
        self.item = {"datasetId": "a", "itemId": "a:full", "title": "书名", "librarySource": "community",
                     "content": {"chapters": [{"id": "c1", "title": "一", "body": {"format": "text", "value": "正文"}}]}}
        self.collection = {"datasetId": "a", "title": "书名", "items": [{"itemId": "a:full", "downloadPath": "collections/a/items/full.json.gz"}]}
        self.source = Mock()
        self.source.json.return_value = {"collections": [self.collection, {"datasetId": "unrelated", "items": [{"itemId": "b:full"}]}]}
        self.source.json_gz.side_effect = lambda _: self.item
        self.publication = {"repoId": "test/books", "revision": "a" * 40}
        patcher = patch.object(content_index, "HuggingFaceCanonical", return_value=self.source)
        self.factory = patcher.start()
        self.addCleanup(patcher.stop)

    def test_reads_only_job_items_from_the_exact_hf_commit(self):
        sync = Mock()
        sync.run.return_value = SyncResult(created=1, examined=1)
        with patch.object(content_index, "index_status", return_value={"configured": True, "index": "content"}), patch.object(content_index, "repair_config", return_value={}), patch.object(content_index, "KibanaConsoleClient"), patch.object(content_index, "ensure_unified_mapping"), patch.object(content_index, "AppendOnlySync", return_value=sync):
            result = content_index.sync_publication(self.root, self.publication, lambda _: None)
        self.factory.assert_called_once_with("test/books", revision="a" * 40)
        self.source.json_gz.assert_called_once_with("books/collections/a/items/full.json.gz")
        rows = sync.run.call_args.args[0]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].document["metadata"]["librarySource"], "community")
        self.assertEqual(rows[0].document["metadata"]["access"], "authenticated")
        self.assertEqual(result["created"], 1)

    def test_drafts_never_contact_es_even_when_a_child_says_published(self):
        self.collection["publicationStatus"] = "draft"
        self.item["publicationStatus"] = "published"
        with patch.object(content_index, "KibanaConsoleClient") as client:
            result = content_index.sync_publication(self.root, self.publication, lambda _: None)
        self.assertEqual(result["status"], "skipped")
        client.assert_not_called()
        self.assertEqual(list(book_documents(self.collection, self.item, canonical_object="test")), [])

    def test_incomplete_hf_commit_and_invalid_revision_fail_before_indexing(self):
        with self.assertRaisesRegex(ValueError, "Hugging Face"):
            content_index.sync_publication(self.root, {"repoId": "test/books", "revision": "main"}, lambda _: None)
        self.collection["items"] = []
        with self.assertRaisesRegex(ValueError, "缺少"):
            content_index.sync_publication(self.root, self.publication, lambda _: None)

    def test_conflicts_are_reported_as_failure_and_not_success(self):
        sync = Mock()
        sync.run.return_value = SyncResult(conflicts=1, examined=1)
        with patch.object(content_index, "index_status", return_value={"configured": True, "index": "content"}), patch.object(content_index, "repair_config", return_value={}), patch.object(content_index, "KibanaConsoleClient"), patch.object(content_index, "ensure_unified_mapping"), patch.object(content_index, "AppendOnlySync", return_value=sync):
            with self.assertRaisesRegex(RuntimeError, "内容冲突 1"):
                content_index.sync_publication(self.root, self.publication, lambda _: None)
