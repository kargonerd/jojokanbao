import sys
import unittest
from pathlib import Path


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from revision_chain import (  # noqa: E402
    RevisionStateCache,
    build_active_query,
    hit_to_active_result,
    read_superseded_ids,
)


class FakeEs:
    def __init__(self, hits, relation="eq"):
        self.hits = hits
        self.relation = relation
        self.calls = 0

    def search(self, *, index, body):
        self.calls += 1
        return {
            "hits": {
                "total": {"value": len(self.hits), "relation": self.relation},
                "hits": self.hits[:body.get("size", len(self.hits))],
            }
        }


class RevisionChainTests(unittest.TestCase):
    def test_active_query_filters_every_superseded_id_and_tombstone(self):
        query = build_active_query(
            {"query_string": {"query": "测试"}},
            ["old-b", "old-a", "old-a"],
        )
        self.assertEqual(query["bool"]["must"], [{"query_string": {"query": "测试"}}])
        self.assertEqual(query["bool"]["must_not"][0], {"term": {"deleted": True}})
        self.assertEqual(
            query["bool"]["must_not"][1],
            {"ids": {"values": ["old-a", "old-b"]}},
        )

    def test_chain_edges_hide_base_and_intermediate_versions(self):
        es = FakeEs([
            {"_source": {"supersedesId": "base-id"}},
            {"_source": {"supersedesId": "revision-1"}},
        ])
        self.assertEqual(
            read_superseded_ids(es, "news"),
            {"base-id", "revision-1"},
        )

    def test_state_cache_avoids_a_revision_query_per_search(self):
        es = FakeEs([{"_source": {"supersedesId": "base-id"}}])
        cache = RevisionStateCache(ttl_seconds=60)
        self.assertEqual(cache.get(es, "news"), {"base-id"})
        self.assertEqual(cache.get(es, "news"), {"base-id"})
        self.assertEqual(es.calls, 1)

    def test_limit_fails_closed_instead_of_leaking_old_versions(self):
        es = FakeEs([
            {"_source": {"supersedesId": "a"}},
            {"_source": {"supersedesId": "b"}},
        ])
        with self.assertRaises(RuntimeError):
            read_superseded_ids(es, "news", limit=1)

    def test_inexact_total_fails_closed_at_the_limit(self):
        es = FakeEs(
            [{"_source": {"supersedesId": "a"}}],
            relation="gte",
        )
        with self.assertRaises(RuntimeError):
            read_superseded_ids(es, "news", limit=1)

    def test_result_exposes_document_id_but_not_revision_metadata(self):
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


if __name__ == "__main__":
    unittest.main()
