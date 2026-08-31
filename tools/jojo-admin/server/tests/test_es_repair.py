import json
import sys
import unittest
from tempfile import TemporaryDirectory
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from es_repair import active_query, clean_repair_document, revision_id
from es_migrations import (
    active_revision_heads,
    apply_migration,
    create_migration,
    excluded_document_ids,
    list_migrations,
    preview_migration,
    search_state_payload,
    write_search_state,
)
from publish_search_state import (
    merge_search_state,
    publish_applied_search_state,
    validate_publication_target,
)


class RepairLogicTest(unittest.TestCase):
    def test_revision_id_is_stable_and_content_sensitive(self):
        doc = {"title": "修复稿", "content": "正文"}
        self.assertEqual(revision_id("old-id", doc, False), revision_id("old-id", doc, False))
        self.assertNotEqual(revision_id("old-id", doc, False), revision_id("old-id", {**doc, "content": "新正文"}, False))
        self.assertNotEqual(revision_id("old-id", doc, False), revision_id("old-id", doc, True))

    def test_active_query_uses_recorded_excluded_ids(self):
        wrapped = active_query({"match": {"content": "测试"}}, {"b", "a"})
        self.assertEqual(wrapped["bool"]["must"], [{"match": {"content": "测试"}}])
        self.assertEqual(wrapped["bool"]["must_not"], [{"ids": {"values": ["a", "b"]}}])

    def test_migration_keeps_reason_local_and_es_payload_clean(self):
        class FakeClient:
            config = {"index": "test-index"}
            calls = []

            def create_revision(self, replaced_document_id, document, *, deleted=False):
                self.calls.append((replaced_document_id, document, deleted))
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

    def test_preview_is_deterministic_and_does_not_write_a_file(self):
        with TemporaryDirectory() as temp:
            directory = Path(temp)
            first = preview_migration(
                "old-id",
                {"title": "新标题", "content": "新正文"},
                deleted=False,
                reason="读者反馈错字",
                index="test-index",
            )
            second = preview_migration(
                "old-id",
                {"content": "新正文", "title": "新标题"},
                deleted=False,
                reason="读者反馈错字",
                index="test-index",
            )

            self.assertEqual(first["previewHash"], second["previewHash"])
            self.assertEqual(first["migration"]["state"], "pending")
            self.assertEqual(first["esPayload"]["replacedDocumentId"], "old-id")
            self.assertNotIn("deleted", first["esPayload"])
            self.assertNotIn("isRevision", first["esPayload"])
            self.assertEqual(list(directory.iterdir()), [])

    def test_preview_hash_changes_when_reason_or_document_changes(self):
        base = preview_migration(
            "old-id",
            {"title": "标题", "content": "正文"},
            deleted=False,
            reason="原因一",
            index="test-index",
        )
        changed_reason = preview_migration(
            "old-id",
            {"title": "标题", "content": "正文"},
            deleted=False,
            reason="原因二",
            index="test-index",
        )
        changed_document = preview_migration(
            "old-id",
            {"title": "标题", "content": "修改后正文"},
            deleted=False,
            reason="原因一",
            index="test-index",
        )

        self.assertNotEqual(base["previewHash"], changed_reason["previewHash"])
        self.assertNotEqual(base["previewHash"], changed_document["previewHash"])

    def test_unified_repair_keeps_filterable_ids_and_business_fields(self):
        document = {
            "@timestamp": "2026-08-29T00:00:00Z",
            "type": "newspaper",
            "datasetId": "rmrb",
            "itemId": "rmrb:1988-09-09",
            "title": "修订标题",
            "content": "修订正文",
            "date": "1988-09-09",
            "source": "人民日报",
            "metadata": {"publicationId": "rmrb", "page": 4, "ordinal": 12},
            "repairReason": "不应进入 ES",
        }
        clean = clean_repair_document(document)
        preview = preview_migration(
            "old-id",
            document,
            deleted=False,
            reason="线上反馈",
            index="test-index",
        )

        self.assertEqual(
            set(clean),
            {"type", "datasetId", "itemId", "title", "content", "date", "source", "metadata"},
        )
        self.assertNotIn("replacedDocumentId", preview["esPayload"])
        self.assertNotIn("repairReason", preview["esPayload"])

    def test_unified_repair_rejects_missing_metadata(self):
        with self.assertRaisesRegex(ValueError, "metadata"):
            clean_repair_document({
                "type": "book",
                "datasetId": "book-a",
                "itemId": "book-a:main",
                "title": "章节",
                "content": "正文",
                "source": "书名",
            })

    def test_applied_migrations_build_index_scoped_exclusions(self):
        with TemporaryDirectory() as temp:
            directory = Path(temp)
            repair = create_migration(
                "base-id",
                {"title": "修复", "content": "正文"},
                deleted=False,
                reason="",
                index="news",
                directory=directory,
            )
            delete = create_migration(
                repair["id"],
                {"title": "修复", "content": "正文"},
                deleted=True,
                reason="",
                index="news",
                directory=directory,
            )
            for migration, document_id in (
                (repair, repair["id"]),
                (delete, delete["id"]),
            ):
                path = directory / f"{migration['id']}.json"
                migration["state"] = "applied"
                migration["result"] = {"documentId": document_id}
                path.write_text(
                    json.dumps(migration),
                    encoding="utf-8",
                )

            self.assertEqual(
                excluded_document_ids("news", directory),
                {"base-id", repair["id"], delete["id"]},
            )
            self.assertEqual(excluded_document_ids("other", directory), set())

            self.assertEqual(
                search_state_payload(["news", "other"], directory),
                {
                    "formatVersion": "jojo-search-state/2",
                    "excludedIds": {
                        "news": ["base-id", delete["id"], repair["id"]],
                        "other": [],
                    },
                    "heads": {
                        "news": {"base-id": None, repair["id"]: None},
                        "other": {},
                    },
                    "canonicalRevisions": {},
                },
            )
            output = directory / "runtime" / "search-state.json"
            write_search_state(output, ["news", "other"], directory)
            self.assertEqual(
                json.loads(output.read_text(encoding="utf-8")),
                search_state_payload(["news", "other"], directory),
            )

    def test_applied_migrations_resolve_the_current_revision(self):
        with TemporaryDirectory() as temp:
            directory = Path(temp)
            first = create_migration(
                "base-id",
                {"title": "第二版", "content": "正文 B"},
                deleted=False,
                reason="",
                index="news",
                directory=directory,
            )
            second = create_migration(
                first["id"],
                {"title": "第三版", "content": "正文 C"},
                deleted=False,
                reason="",
                index="news",
                directory=directory,
            )
            for migration in (first, second):
                migration["state"] = "applied"
                migration["result"] = {"documentId": migration["id"]}
                (directory / f"{migration['id']}.json").write_text(
                    json.dumps(migration), encoding="utf-8",
                )

            self.assertEqual(
                active_revision_heads("news", directory),
                {"base-id": second["id"], first["id"]: second["id"]},
            )

    def test_deleted_revision_resolves_to_no_active_document(self):
        with TemporaryDirectory() as temp:
            directory = Path(temp)
            deletion = create_migration(
                "base-id",
                {"title": "标题", "content": "正文"},
                deleted=True,
                reason="",
                index="news",
                directory=directory,
            )
            deletion["state"] = "applied"
            deletion["result"] = {"documentId": deletion["id"]}
            (directory / f"{deletion['id']}.json").write_text(
                json.dumps(deletion), encoding="utf-8",
            )

            self.assertEqual(active_revision_heads("news", directory), {"base-id": None})

    def test_remote_state_is_merged_and_unconfigured_indexes_are_removed(self):
        merged = merge_search_state(
            {
                "excludedIds": {
                    "news": ["remote-old"],
                    "aitest-1tk2lxru": ["test-only"],
                }
            },
            {"excludedIds": {"news": ["local-new"]}},
            ["news"],
        )
        self.assertEqual(
            merged,
            {
                "formatVersion": "jojo-search-state/2",
                "excludedIds": {"news": ["local-new", "remote-old"]},
                "heads": {},
                "canonicalRevisions": {},
            },
        )

    def test_publish_preserves_remote_repairs_from_another_workstation(self):
        with TemporaryDirectory() as temp:
            directory = Path(temp)
            migration = create_migration(
                "local-old",
                {"title": "修复", "content": "正文"},
                deleted=False,
                reason="",
                index="news",
                directory=directory,
            )
            migration["state"] = "applied"
            migration["result"] = {"documentId": migration["id"]}
            (directory / f"{migration['id']}.json").write_text(
                json.dumps(migration), encoding="utf-8"
            )
            uploaded = []
            result = publish_applied_search_state(
                "news",
                directory=directory,
                config={
                    "bucket": "private-bucket",
                    "region": "ap-beijing",
                    "key": "runtime/search/search-state.json",
                    "profile": "",
                    "indices": ["news"],
                },
                remote_loader=lambda _: {"excludedIds": {"news": ["remote-old"]}},
                uploader=lambda _, payload: uploaded.append(payload),
            )

            self.assertEqual(
                uploaded,
                [{
                    "formatVersion": "jojo-search-state/2",
                    "excludedIds": {"news": ["local-old", "remote-old"]},
                    "heads": {"news": {"local-old": migration["id"]}},
                    "canonicalRevisions": {},
                }],
            )
            self.assertEqual(result["excluded"], 2)

    def test_repair_target_must_be_an_explicit_served_index(self):
        with self.assertRaisesRegex(ValueError, "不在 SEARCH_STATE_INDICES"):
            validate_publication_target("aitest-1tk2lxru", {
                "bucket": "private-bucket",
                "region": "ap-beijing",
                "key": "runtime/search/search-state.json",
                "profile": "",
                "indices": ["production"],
            })


if __name__ == "__main__":
    unittest.main()
