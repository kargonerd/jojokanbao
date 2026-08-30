import json
from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from es_sync import (
    AppendOnlySync,
    IndexedDocument,
    UNIFIED_MAPPING,
    book_documents,
    ensure_unified_mapping,
    latest_news_references,
    news_document,
    newspaper_document,
    plain_text,
    stable_document_id,
)


class UnifiedDocumentTest(unittest.TestCase):
    def test_html_is_reduced_to_searchable_plain_text(self):
        self.assertEqual(
            plain_text("<h1>标题</h1><p>第一段 <b>正文</b></p><script>坏内容</script>", "html"),
            "标题\n第一段 正文",
        )

    def test_book_is_one_document_per_chapter(self):
        rows = list(book_documents(
            {"datasetId": "book-a", "title": "测试文集", "language": "zh-CN"},
            {
                "datasetId": "book-a",
                "itemId": "book-a:volume-1",
                "title": "测试文集 第一卷",
                "language": "zh-CN",
                "metadata": {
                    "authors": ["作者甲"],
                    "publisher": "测试社",
                    "publishedDate": "2020-01-02",
                },
                "content": {"chapters": [
                    {
                        "id": "chapter:1",
                        "order": 1,
                        "title": "第一章",
                        "body": {"format": "html", "value": "<p>第一章正文</p>"},
                    },
                    {
                        "id": "chapter:2",
                        "order": 2,
                        "title": "第二章",
                        "body": {"format": "text", "value": "第二章正文"},
                    },
                ]},
            },
            canonical_object="books/collections/test/items/volume-1.json.gz",
        ))

        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0].document["type"], "book")
        self.assertEqual(rows[0].document["title"], "第一章")
        self.assertEqual(rows[0].document["content"], "第一章正文")
        self.assertEqual(rows[0].document["source"], "测试文集")
        self.assertEqual(rows[0].document["date"], "2020-01-02")
        self.assertEqual(rows[0].document["datasetId"], "book-a")
        self.assertEqual(rows[0].document["itemId"], "book-a:volume-1")
        self.assertEqual(rows[0].document["metadata"]["itemTitle"], "测试文集 第一卷")
        self.assertEqual(rows[0].document["metadata"]["chapterId"], "chapter:1")
        self.assertNotEqual(rows[0].document_id, rows[1].document_id)

    def test_newspaper_indexes_only_available_body(self):
        available = newspaper_document(
            {
                "date": "1988-09-09",
                "page": 4,
                "ordinal": 12,
                "title": "失明以后",
                "body": "文章正文",
                "status": "available",
                "pdf": "https://example.test/1988-09-09.pdf",
            },
            publication_id="rmrb",
            publication_title="人民日报",
            canonical_object="newspapers/rmrb/data/articles/1988.jsonl.gz",
        )
        missing = newspaper_document(
            {
                "date": "1988-09-09", "page": 4, "ordinal": 13,
                "title": "缺失", "content": "", "status": "missing",
            },
            publication_id="rmrb",
            publication_title="人民日报",
            canonical_object="newspapers/rmrb/data/articles/1988.jsonl.gz",
        )

        self.assertIsNotNone(available)
        assert available is not None
        self.assertEqual(available.document["type"], "newspaper")
        self.assertEqual(available.document["datasetId"], "rmrb")
        self.assertEqual(available.document["itemId"], "rmrb:1988-09-09")
        self.assertEqual(available.document["content"], "文章正文")
        self.assertEqual(available.document["metadata"]["page"], 4)
        self.assertEqual(available.document["metadata"]["ordinal"], 12)
        self.assertIsNone(missing)

    def test_newspaper_keeps_legacy_content_fallback(self):
        legacy = newspaper_document(
            {
                "date": "1947-01-01",
                "page": 1,
                "ordinal": 1,
                "title": "旧格式文章",
                "content": "旧格式正文",
                "status": "available",
            },
            publication_id="rmrb",
            publication_title="人民日报",
            canonical_object="newspapers/rmrb/data/articles/1947.jsonl.gz",
        )

        self.assertIsNotNone(legacy)
        assert legacy is not None
        self.assertEqual(legacy.document["content"], "旧格式正文")

    def test_current_news_uses_same_business_fields(self):
        row = news_document({
            "articleId": "ap-123",
            "source": {"id": "ap", "name": "AP News"},
            "canonicalUrl": "https://example.test/article",
            "title": "Test story",
            "authors": ["Reporter"],
            "language": "en",
            "publishedAt": "2026-08-29T01:02:03Z",
            "publisherCategories": ["World"],
            "publisherSections": [],
            "body": {"format": "html", "value": "<p>Full story.</p>"},
            "contentStatus": "full",
        }, canonical_object="canonical/ap/articles/hash.json.gz")

        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(
            set(row.document),
            {
                "@timestamp", "type", "datasetId", "itemId", "title", "content",
                "date", "source", "metadata",
            },
        )
        self.assertEqual(row.document["type"], "news")
        self.assertEqual(row.document["datasetId"], "ap")
        self.assertEqual(row.document["itemId"], "ap-123")
        self.assertEqual(row.document["content"], "Full story.")

    def test_news_keeps_only_the_latest_canonical_object_per_article(self):
        references = latest_news_references([
            ("canonical/ap/dates/2026/08/2026-08-28.json.gz", {
                "updatedAt": "2026-08-28T01:00:00Z",
                "articles": [{
                    "articleId": "ap:one",
                    "object": "canonical/ap/articles/old.json.gz",
                    "publishedAt": "2026-08-28T00:00:00Z",
                }],
            }),
            ("canonical/ap/dates/2026/08/2026-08-29.json.gz", {
                "updatedAt": "2026-08-29T02:00:00Z",
                "articles": [
                    {
                        "articleId": "ap:one",
                        "object": "canonical/ap/articles/new.json.gz",
                        "publishedAt": "2026-08-29T00:00:00Z",
                    },
                    {
                        "articleId": "ap:two",
                        "object": "canonical/ap/articles/two.json.gz",
                        "publishedAt": "2026-08-29T01:00:00Z",
                    },
                ],
            }),
        ])

        self.assertEqual(
            [reference["object"] for reference in references],
            ["canonical/ap/articles/new.json.gz", "canonical/ap/articles/two.json.gz"],
        )

    def test_logical_id_does_not_change_with_content(self):
        self.assertEqual(
            stable_document_id("newspaper", "rmrb", "1988-09-09", 4, 12),
            stable_document_id("newspaper", "rmrb", "1988-09-09", 4, 12),
        )


class FakeClient:
    def __init__(self, mapping=None, existing=None):
        self.mapping = mapping or UNIFIED_MAPPING
        self.existing = existing or {}

    def request(self, method, path, body=None):
        if path.endswith("/_mapping") and method == "GET":
            return 200, {"backing-index": {"mappings": self.mapping}}
        if path.endswith("/_search") and method == "POST":
            document_ids = body["query"]["ids"]["values"]
            hits = [
                {"_id": document_id, "_source": self.existing[document_id]}
                for document_id in document_ids
                if document_id in self.existing
            ]
            return 200, {"hits": {"hits": hits}}
        raise AssertionError((method, path, body))

    def request_raw(self, method, path, body):
        self.last_bulk = body
        items = []
        lines = body.strip().splitlines()
        for position in range(0, len(lines), 2):
            document_id = json.loads(lines[position])["create"]["_id"]
            status = 409 if document_id in self.existing else 201
            items.append({"create": {"status": status}})
        return 200, {"errors": any(item["create"]["status"] >= 400 for item in items), "items": items}


class AppendOnlySyncTest(unittest.TestCase):
    def test_mapping_accepts_only_the_strict_unified_contract(self):
        client = FakeClient(mapping=UNIFIED_MAPPING)
        result = ensure_unified_mapping(client, "test")

        self.assertTrue(result["valid"])
        self.assertEqual(result["schema"], "jojo-search/1")
        self.assertEqual(UNIFIED_MAPPING["properties"]["metadata"]["enabled"], False)

    def test_polluted_dynamic_mapping_is_rejected_before_sync(self):
        client = FakeClient(mapping={
            "dynamic": True,
            "properties": {
                **UNIFIED_MAPPING["properties"],
                "releaseId": {"type": "text"},
                "metadata": {"properties": {"publicationId": {"type": "text"}}},
            },
        })

        with self.assertRaisesRegex(ValueError, "dynamic.*strict.*旧格式字段.*releaseId"):
            ensure_unified_mapping(client, "test")

    def test_incomplete_mapping_is_rejected_instead_of_mutated(self):
        client = FakeClient(mapping={
            "dynamic": "strict",
            "properties": {"@timestamp": {"type": "date"}},
        })

        with self.assertRaisesRegex(ValueError, "缺少字段"):
            ensure_unified_mapping(client, "test")

    def test_rerun_is_unchanged_but_different_body_is_a_conflict(self):
        base = {
            "@timestamp": "1988-09-09",
            "type": "newspaper",
            "datasetId": "rmrb",
            "itemId": "rmrb:1988-09-09",
            "title": "失明以后",
            "content": "原正文",
            "date": "1988-09-09",
            "source": "人民日报",
            "metadata": {"publicationId": "rmrb", "page": 4, "ordinal": 12},
        }
        client = FakeClient(existing={"same": base, "changed": base})
        result = AppendOnlySync(client, "test", batch_size=10).run([
            IndexedDocument("new", base),
            IndexedDocument("same", {**base, "@timestamp": "2026-08-29T00:00:00Z"}),
            IndexedDocument("changed", {**base, "content": "修订正文"}),
        ])

        self.assertEqual(result.created, 1)
        self.assertEqual(result.unchanged, 1)
        self.assertEqual(result.conflicts, 1)
        self.assertEqual(result.conflict_ids, ["changed"])
        bulk_actions = [
            json.loads(line)["create"]["_id"]
            for line in client.last_bulk.strip().splitlines()[::2]
        ]
        self.assertEqual(bulk_actions, ["new"])

    def test_serverless_id_search_makes_rerun_idempotent(self):
        document = {
            "@timestamp": "2026-08-29",
            "type": "news",
            "datasetId": "xinhua",
            "itemId": "xinhua:one",
            "title": "标题",
            "content": "正文",
            "date": "2026-08-29",
            "source": "新华社",
            "metadata": {"articleId": "one"},
        }
        client = FakeClient(existing={"same": document})
        result = AppendOnlySync(client, "test").run([IndexedDocument("same", document)])

        self.assertEqual(result.unchanged, 1)
        self.assertEqual(result.conflicts, 0)

    def test_sync_compares_canonical_with_the_active_repair(self):
        base = {
            "@timestamp": "1988-09-09",
            "type": "newspaper",
            "datasetId": "rmrb",
            "itemId": "rmrb:1988-09-09",
            "title": "失明以后",
            "content": "正文 B",
            "date": "1988-09-09",
            "source": "人民日报",
            "metadata": {"page": 4, "ordinal": 12},
        }
        client = FakeClient(existing={
            "base-id": {**base, "content": "正文 A"},
            "repair-id": base,
        })
        result = AppendOnlySync(
            client,
            "test",
            revision_heads={"base-id": "repair-id"},
        ).run([IndexedDocument("base-id", base)])

        self.assertEqual(result.unchanged, 1)
        self.assertEqual(result.conflicts, 0)
        self.assertEqual(result.created, 0)

    def test_sync_reports_conflict_against_the_active_repair_id(self):
        canonical = {
            "@timestamp": "1988-09-09",
            "type": "newspaper",
            "datasetId": "rmrb",
            "itemId": "rmrb:1988-09-09",
            "title": "失明以后",
            "content": "正文 C",
            "date": "1988-09-09",
            "source": "人民日报",
            "metadata": {"page": 4, "ordinal": 12},
        }
        client = FakeClient(existing={
            "base-id": {**canonical, "content": "正文 A"},
            "repair-id": {**canonical, "content": "正文 B"},
        })
        result = AppendOnlySync(
            client,
            "test",
            revision_heads={"base-id": "repair-id"},
        ).run([IndexedDocument("base-id", canonical)])

        self.assertEqual(result.conflicts, 1)
        self.assertEqual(result.conflict_ids, ["repair-id"])

    def test_sync_respects_an_applied_deletion(self):
        document = {
            "@timestamp": "2026-08-29",
            "type": "news",
            "datasetId": "xinhua",
            "itemId": "xinhua:one",
            "title": "标题",
            "content": "正文",
            "date": "2026-08-29",
            "source": "新华社",
            "metadata": {},
        }
        result = AppendOnlySync(
            FakeClient(existing={"base-id": document}),
            "test",
            revision_heads={"base-id": None},
        ).run([IndexedDocument("base-id", document)])

        self.assertEqual(result.unchanged, 1)
        self.assertEqual(result.conflicts, 0)
        self.assertEqual(result.created, 0)


if __name__ == "__main__":
    unittest.main()
