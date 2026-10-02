import sys
import unittest
from pathlib import Path


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from migration_exclusions import build_active_query  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
