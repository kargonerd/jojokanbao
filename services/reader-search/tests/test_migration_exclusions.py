import json
import sys
import tempfile
import unittest
from pathlib import Path


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from migration_exclusions import (  # noqa: E402
    build_active_query,
    hit_to_active_result,
    load_excluded_ids,
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

    def test_applied_repair_excludes_only_the_superseded_id(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self._write(directory, "repair-1", {
                "id": "repair-1",
                "index": "news",
                "operation": "repair",
                "supersedesId": "base-id",
                "state": "applied",
            })
            self.assertEqual(load_excluded_ids(directory, "news"), {"base-id"})

    def test_applied_delete_excludes_old_id_and_tombstone(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self._write(directory, "repair-2", {
                "id": "repair-2",
                "index": "news",
                "operation": "delete",
                "supersedesId": "revision-1",
                "state": "applied",
                "result": {"documentId": "tombstone-2"},
            })
            self.assertEqual(
                load_excluded_ids(directory, "news"),
                {"revision-1", "tombstone-2"},
            )

    def test_pending_and_other_index_migrations_do_not_filter(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self._write(directory, "repair-pending", {
                "id": "repair-pending",
                "index": "news",
                "operation": "repair",
                "supersedesId": "pending-old",
                "state": "pending",
            })
            self._write(directory, "repair-other", {
                "id": "repair-other",
                "index": "other",
                "operation": "repair",
                "supersedesId": "other-old",
                "state": "applied",
            })
            self.assertEqual(load_excluded_ids(directory, "news"), set())

    def test_result_exposes_document_id_but_not_legacy_revision_metadata(self):
        result = hit_to_active_result({
            "_id": "revision-2",
            "_source": {
                "@timestamp": "2026-07-26T00:00:00Z",
                "title": "最终标题",
                "content": "最终正文",
                "isRevision": True,
                "supersedesId": "revision-1",
                "deleted": False,
            },
            "highlight": {"title": ["@highlight@最终@/highlight@标题"]},
        })
        self.assertEqual(result["documentId"], "revision-2")
        self.assertEqual(result["title"], "@highlight@最终@/highlight@标题")
        self.assertNotIn("supersedesId", result)
        self.assertNotIn("deleted", result)
        self.assertNotIn("isRevision", result)

    @staticmethod
    def _write(directory: Path, migration_id: str, payload: dict) -> None:
        (directory / f"{migration_id}.json").write_text(
            json.dumps(payload),
            encoding="utf-8",
        )


if __name__ == "__main__":
    unittest.main()
