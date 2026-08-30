import sys
import unittest
from pathlib import Path


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from migration_exclusions import (  # noqa: E402
    build_active_query,
    hit_to_active_result,
)


class MigrationExclusionsTests(unittest.TestCase):
    def test_active_query_uses_one_ids_filter(self):
        query = build_active_query(
            {"query_string": {"query": "测试"}},
            ["old-b", "old-a", "old-a"],
        )
        self.assertEqual(query["bool"]["must"], [{"query_string": {"query": "测试"}}])
        self.assertEqual(
            query["bool"]["must_not"],
            [{"ids": {"values": ["old-a", "old-b"]}}],
        )

    def test_result_exposes_document_id_but_not_legacy_revision_metadata(self):
        result = hit_to_active_result({
            "_id": "revision-2",
            "_source": {
                "@timestamp": "2026-07-26T00:00:00Z",
                "title": "最终标题",
                "content": "最终正文",
                "isRevision": True,
                "replacedDocumentId": "revision-1",
                "deleted": False,
            },
            "highlight": {"title": ["@highlight@最终@/highlight@标题"]},
        })
        self.assertEqual(result["documentId"], "revision-2")
        self.assertEqual(result["title"], "@highlight@最终@/highlight@标题")
        self.assertNotIn("supersedesId", result)
        self.assertNotIn("replacedDocumentId", result)
        self.assertNotIn("deleted", result)
        self.assertNotIn("isRevision", result)

if __name__ == "__main__":
    unittest.main()
