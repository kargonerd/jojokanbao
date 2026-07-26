import sys
import unittest
from tempfile import TemporaryDirectory
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from es_repair import active_query, revision_id
from es_migrations import apply_migration, create_migration, list_migrations


class RepairLogicTest(unittest.TestCase):
    def test_revision_id_is_stable_and_content_sensitive(self):
        doc = {"title": "修复稿", "content": "正文"}
        self.assertEqual(revision_id("old-id", doc, False), revision_id("old-id", doc, False))
        self.assertNotEqual(revision_id("old-id", doc, False), revision_id("old-id", {**doc, "content": "新正文"}, False))
        self.assertNotEqual(revision_id("old-id", doc, False), revision_id("old-id", doc, True))

    def test_active_query_suppresses_old_versions_and_tombstones(self):
        wrapped = active_query({"match": {"content": "测试"}}, ["b", "a", "a"])
        self.assertEqual(wrapped["bool"]["must"], [{"match": {"content": "测试"}}])
        self.assertEqual(wrapped["bool"]["must_not"][0], {"term": {"deleted": True}})
        self.assertEqual(wrapped["bool"]["must_not"][1]["ids"]["values"], ["a", "b"])

    def test_migration_keeps_reason_local_and_es_payload_clean(self):
        class FakeClient:
            config = {"index": "test-index"}
            calls = []

            def create_revision(self, supersedes_id, document, *, deleted=False):
                self.calls.append((supersedes_id, document, deleted))
                return {"created": True, "alreadyExists": False, "documentId": "revision-id"}

        with TemporaryDirectory() as temp:
            directory = Path(temp)
            migration = create_migration(
                "old-id",
                {"title": "新标题", "content": "新正文"},
                deleted=False,
                reason="读者反馈错字",
                index="test-index",
                directory=directory,
            )
            client = FakeClient()
            applied = apply_migration(migration["id"], client=client, directory=directory)

            self.assertEqual(applied["reason"], "读者反馈错字")
            self.assertEqual(applied["state"], "applied")
            self.assertEqual(client.calls, [("old-id", {"title": "新标题", "content": "新正文"}, False)])
            self.assertNotIn("reason", client.calls[0][1])
            self.assertEqual(len(list_migrations(directory)), 1)


if __name__ == "__main__":
    unittest.main()
