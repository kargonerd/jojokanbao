import json
import gzip
import os
import sys
from types import SimpleNamespace
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import content_publish


class B2PublishTest(unittest.TestCase):
    def make_build(self, root: Path) -> None:
        (root / "delivery" / "content").mkdir(parents=True)
        (root / "raw").mkdir()
        (root / "canonical").mkdir()
        (root / "report.json").write_text(
            json.dumps(
                {
                    "supersededDatasetIds": ["old-dataset"],
                    "itemsBuilt": [
                        {"datasetId": "dataset-a", "manifestObject": "content/books/dataset-a/items/full-book/manifest.jox"},
                        {"datasetId": "dataset-b", "manifestObject": "content/books/dataset-b/items/full-book/manifest.jox"},
                    ]
                }
            ),
            encoding="utf-8",
        )

    @patch.object(content_publish.shutil, "which", return_value="rclone.exe")
    @patch.object(content_publish, "_run")
    @patch.object(content_publish, "_try_copy_remote", return_value=False)
    def test_first_publish_only_probes_catalog(self, try_copy, _run, _which):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            self.make_build(root)
            content_publish.publish_b2(root, lambda _message: None)

        self.assertEqual(try_copy.call_count, 1)
        self.assertTrue(try_copy.call_args.args[0].endswith("/catalog.jox"))
        final_command = _run.call_args_list[-1].args[0]
        self.assertEqual(final_command[0:2], ["rclone", "copy"])
        self.assertIn("+ /catalog.jox", final_command)
        self.assertNotIn("copyto", final_command)
        commands = [call.args[0] for call in _run.call_args_list]
        merge_command = next(command for command in commands if command[0] == "pnpm")
        self.assertIn("--remove-dataset", merge_command)
        self.assertIn("old-dataset", merge_command)
        delivery_commands = [
            command for command in commands
            if command[0] == "rclone" and "jojo-newspaper" in command[3]
        ]
        self.assertFalse(any("jojo-news-raw" in " ".join(command) for command in commands))
        self.assertFalse(any(str(root / "raw") in command for command in commands))
        self.assertFalse(any(str(root / "canonical") in command for command in commands))
        self.assertTrue(delivery_commands)
        self.assertTrue(all("--s3-no-check-bucket" in command for command in delivery_commands))

    @patch.object(content_publish.shutil, "which", return_value="rclone.exe")
    @patch.object(content_publish, "_run")
    @patch.object(content_publish, "_try_copy_remote", return_value=True)
    def test_incremental_publish_reads_known_dataset_indexes(self, try_copy, _run, _which):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            self.make_build(root)
            content_publish.publish_b2(root, lambda _message: None)

        remotes = [call.args[0] for call in try_copy.call_args_list]
        self.assertEqual(len(remotes), 3)
        self.assertTrue(remotes[0].endswith("/catalog.jox"))
        self.assertTrue(remotes[1].endswith("/content/books/dataset-a/index.jox"))
        self.assertTrue(remotes[2].endswith("/content/books/dataset-b/index.jox"))


class HuggingFacePublishTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "build"
        self.root.mkdir()
        self.remote = {
            ".gitattributes": b"preserve LFS rules",
            "README.md": b"shared dataset card",
            "raw/newspapers/rmrb/original.pdf": b"original PDF",
            "newspapers/rmrb/dataset.json": b"newspaper data",
            "canonical/retained.json": b"unrelated data",
            "collections/legacy.json": b"legacy root data",
        }
        self.head = "base"
        self.versions = {}
        self.api = Mock()
        self.api.repo_info.side_effect = lambda **_: SimpleNamespace(private=False, sha=self.head)
        self.api.list_repo_tree.side_effect = self.list_tree
        self.api.hf_hub_download.side_effect = self.download
        self.api.create_commit.side_effect = self.commit
        self.constructor = Mock(return_value=self.api)

        class EntryNotFoundError(Exception):
            pass

        self.entry_not_found = EntryNotFoundError
        module = SimpleNamespace(
            HfApi=self.constructor,
            CommitOperationAdd=lambda **kwargs: SimpleNamespace(kind="add", **kwargs),
            CommitOperationDelete=lambda **kwargs: SimpleNamespace(kind="delete", **kwargs),
        )
        for patcher in (
            patch.object(content_publish, "_load_root_env"),
            patch.object(content_publish, "_huggingface_token", return_value="cached-cli-token"),
            patch.dict(os.environ, {
                "HF_DATASET_REPO": "owner/public-content", "HF_DATASET_PRIVATE": "false", "HF_UPLOAD_WORKERS": "4",
            }),
            patch.dict(sys.modules, {
                "huggingface_hub": module,
                "huggingface_hub.errors": SimpleNamespace(EntryNotFoundError=EntryNotFoundError),
            }),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def list_tree(self, **kwargs):
        if not kwargs.get("path_in_repo"):
            self.assertFalse(kwargs["recursive"])
            return iter(SimpleNamespace(path=key) for key in {path.split("/")[0] for path in self.remote})
        self.assertEqual(kwargs["path_in_repo"], "books")
        self.assertTrue(kwargs["recursive"])
        files = self.versions.setdefault(kwargs["revision"], dict(self.remote))
        rows = [SimpleNamespace(path=key, size=len(data)) for key, data in files.items() if key.startswith("books/")]
        if not rows:
            raise self.entry_not_found()
        # Include a folder to ensure directories never become deletion targets.
        return iter([SimpleNamespace(path="books/collections"), *rows])

    def download(self, **kwargs):
        self.assertEqual(kwargs["revision"], "base")
        target = Path(self.temp.name) / "cache" / kwargs["filename"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.versions[kwargs["revision"]][kwargs["filename"]])
        return str(target)

    def commit(self, **kwargs):
        if kwargs["parent_commit"] != self.head:
            raise RuntimeError("concurrent commit conflict")
        self.assertEqual(kwargs["revision"], "main")
        updated = dict(self.remote)
        for operation in kwargs["operations"]:
            self.assertTrue(operation.path_in_repo.startswith("books/"))
            if operation.kind == "delete":
                self.assertFalse(operation.is_folder)
                del updated[operation.path_in_repo]
            else:
                updated[operation.path_in_repo] = Path(operation.path_or_fileobj).read_bytes()
        self.remote = updated
        self.head = "published"
        self.versions[self.head] = dict(updated)
        return SimpleNamespace(oid=self.head)

    def make_book(self, root=None, dataset_id="book-a", title="测试书", keys=("full-book",)):
        root = root or self.root
        source = root / "huggingface" / dataset_id
        (source / "data").mkdir(parents=True, exist_ok=True)
        items = []
        for order, key in enumerate(keys):
            item_id = f"{dataset_id}:{key}"
            items.append({"itemId": item_id, "itemKey": key, "order": order, "title": title, "path": f"data/{key}.json.gz"})
            with gzip.open(source / "data" / f"{key}.json.gz", "wt", encoding="utf-8") as stream:
                json.dump({
                    "datasetId": dataset_id, "itemId": item_id, "title": title, "type": "book",
                    "content": {"chapters": [{"id": "chapter:1", "title": "第一章"}]},
                }, stream)
        (source / "dataset.json").write_text(json.dumps({
            "datasetId": dataset_id, "title": title, "type": "book", "items": items,
            "itemPath": "items/{itemKey}/item.json.gz",
        }), encoding="utf-8")
        (root / "search").mkdir(exist_ok=True)
        with gzip.open(root / "search" / "documents.jsonl.gz", "at", encoding="utf-8") as stream:
            for item in items:
                stream.write(json.dumps({"datasetId": dataset_id, "itemId": item["itemId"], "text": title}) + "\n")

    def seed_remote_books(self, books):
        root = Path(self.temp.name) / "remote-build"
        for dataset_id, title, keys in books:
            self.make_book(root, dataset_id, title, keys)
        snapshot, _ = content_publish._prepare_huggingface_snapshot(root, lambda _: None)
        self.remote.update({f"books/{path.relative_to(snapshot).as_posix()}": path.read_bytes()
                            for path in snapshot.rglob("*") if path.is_file()})

    def publish(self):
        return content_publish.publish_huggingface(self.root, lambda _: None)

    @patch.object(content_publish, "_huggingface_token", return_value="cached-cli-token")
    def test_status_accepts_cli_login(self, _token):
        with patch.dict(os.environ, {
            "HF_DATASET_REPO": "owner/public-content", "HF_DATASET_PRIVATE": "false",
        }, clear=False):
            status = content_publish.publication_status()["huggingface"]
        self.assertTrue(status["configured"])
        self.assertEqual(status["repoId"], "owner/public-content")
        self.assertFalse(status["private"])

    def test_publish_uses_books_prefix_and_preserves_shared_repository(self):
        protected = dict(self.remote)
        self.make_book()
        result = self.publish()
        self.constructor.assert_called_once_with(token="cached-cli-token")
        self.assertFalse(self.api.create_repo.call_args.kwargs["private"])
        self.assertEqual(self.api.create_commit.call_args.kwargs["num_threads"], 4)
        self.assertFalse(result["private"])
        self.assertEqual(result["scope"], "books/")
        self.assertEqual(result["remoteFiles"], sum(key.startswith("books/") for key in self.remote))
        self.assertTrue(result["commit"].endswith("/commit/published"))
        self.assertEqual(result["deletedFiles"], 0)
        self.assertEqual({key: self.remote[key] for key in protected}, protected)
        self.api.delete_files.assert_not_called()
        self.api.upload_large_folder.assert_not_called()

    def test_incremental_publish_merges_catalog_search_and_only_deletes_owned_files(self):
        self.seed_remote_books([("book-a", "测试书", ("full-book",)), ("book-b", "另一本书", ("full-book",))])
        stale = "books/collections/测试书/items/old[1].json.gz"
        self.remote[stale] = b"superseded"
        self.remote["books/reconciliation.json"] = b"audit evidence"
        self.remote["books/collections/测试书-r1/retained.json"] = b"unowned revision"
        protected = {key: value for key, value in self.remote.items()
                     if not key.startswith("books/collections/测试书/") and key not in {
                         "books/catalog.json", "books/README.md", "books/ASSETS.md", "books/data/search-documents.jsonl.gz"}}
        self.make_book(title="改名后的测试书")
        result = self.publish()
        self.assertEqual(result["deletedFiles"], 1)
        self.assertNotIn(stale, self.remote)
        self.assertEqual({key: self.remote[key] for key in protected}, protected)
        catalog = json.loads(self.remote["books/catalog.json"])
        self.assertEqual((catalog["collectionCount"], catalog["itemCount"]), (2, 2))
        updated = next(row for row in catalog["collections"] if row["datasetId"] == "book-a")
        self.assertEqual(updated["path"], "collections/测试书")
        self.assertEqual(updated["title"], "改名后的测试书")
        self.assertTrue(all(f"books/{item['downloadPath']}" in self.remote for row in catalog["collections"] for item in row["items"]))
        documents = [json.loads(line) for line in gzip.decompress(self.remote["books/data/search-documents.jsonl.gz"]).splitlines()]
        self.assertEqual({row["datasetId"]: row["text"] for row in documents}, {"book-a": "改名后的测试书", "book-b": "另一本书"})
        self.assertIn("另一本书", self.remote["books/README.md"].decode())
        self.api.create_commit.assert_called_once()

    def test_partial_series_is_rejected_without_deleting_other_volumes(self):
        self.seed_remote_books([("book-a", "测试书", ("volume-1", "volume-2"))])
        self.make_book(keys=("volume-1",))
        with self.assertRaisesRegex(RuntimeError, "缺卷"):
            self.publish()
        self.api.create_commit.assert_not_called()

    def test_missing_item_is_rejected_before_remote_access(self):
        self.make_book()
        (self.root / "huggingface/book-a/data/full-book.json.gz").unlink()
        with self.assertRaisesRegex(RuntimeError, "缺少 Item"):
            self.publish()
        self.constructor.assert_not_called()

    def test_empty_build_is_rejected_before_remote_access(self):
        (self.root / "huggingface").mkdir()
        with self.assertRaisesRegex(RuntimeError, "没有可发布"):
            self.publish()
        self.constructor.assert_not_called()

    def test_visibility_is_checked_before_upload(self):
        self.make_book()
        self.api.repo_info.side_effect = lambda **_: SimpleNamespace(private=True, sha="base")
        with self.assertRaisesRegex(RuntimeError, "不是预期"):
            self.publish()
        self.api.create_commit.assert_not_called()
        self.api.list_repo_tree.assert_not_called()

    def test_missing_search_is_rejected_without_committing(self):
        self.make_book()
        (self.root / "search/documents.jsonl.gz").unlink()
        with self.assertRaisesRegex(RuntimeError, "缺少书籍搜索"):
            self.publish()
        self.api.create_commit.assert_not_called()

    def test_missing_parent_revision_never_allows_unguarded_commit(self):
        self.make_book()
        self.api.repo_info.side_effect = lambda **_: SimpleNamespace(private=False, sha=None)
        with self.assertRaisesRegex(RuntimeError, "父提交"):
            self.publish()
        self.api.create_commit.assert_not_called()

    def test_missing_asset_is_rejected_before_remote_access(self):
        self.make_book()
        item_path = self.root / "huggingface/book-a/data/full-book.json.gz"
        with gzip.open(item_path, "rt", encoding="utf-8") as stream:
            item = json.load(stream)
        item["assets"] = [{"path": "assets/missing.png"}]
        with gzip.open(item_path, "wt", encoding="utf-8") as stream:
            json.dump(item, stream)
        with self.assertRaisesRegex(RuntimeError, "缺少媒体"):
            self.publish()
        self.constructor.assert_not_called()

    def test_uncatalogued_books_are_not_treated_as_first_publish(self):
        self.remote["books/unknown.json"] = b"retain"
        self.make_book()
        with self.assertRaisesRegex(RuntimeError, "缺少 catalog"):
            self.publish()
        self.api.create_commit.assert_not_called()

    def test_new_book_cannot_overwrite_another_books_directory(self):
        self.seed_remote_books([("book-b", "测试书", ("full-book",))])
        self.make_book()
        with self.assertRaisesRegex(RuntimeError, "目录已被占用"):
            self.publish()
        self.api.create_commit.assert_not_called()

    def test_unsafe_remote_catalog_path_aborts_without_committing(self):
        self.seed_remote_books([("book-a", "测试书", ("full-book",))])
        catalog = json.loads(self.remote["books/catalog.json"])
        catalog["collections"][0]["path"] = "collections/../../raw"
        self.remote["books/catalog.json"] = json.dumps(catalog).encode()
        self.make_book()
        with self.assertRaisesRegex(RuntimeError, "路径段"):
            self.publish()
        self.api.create_commit.assert_not_called()

    def test_network_error_is_not_treated_as_an_empty_repository(self):
        self.make_book()
        self.api.list_repo_tree.side_effect = OSError("network unavailable")
        with self.assertRaisesRegex(OSError, "network unavailable"):
            self.publish()
        self.api.create_commit.assert_not_called()

    def test_missing_tree_page_is_not_treated_as_an_empty_repository(self):
        self.seed_remote_books([("book-a", "测试书", ("full-book",))])
        self.make_book()

        def broken_page(**kwargs):
            if kwargs.get("path_in_repo"):
                raise self.entry_not_found("missing page")
            return self.list_tree(**kwargs)

        self.api.list_repo_tree.side_effect = broken_page
        with self.assertRaisesRegex(self.entry_not_found, "missing page"):
            self.publish()
        self.api.create_commit.assert_not_called()

    def test_incremental_publish_requires_existing_search_data(self):
        self.seed_remote_books([("book-b", "另一本书", ("full-book",))])
        del self.remote["books/data/search-documents.jsonl.gz"]
        self.make_book()
        with self.assertRaisesRegex(RuntimeError, "远端书籍搜索数据缺失"):
            self.publish()
        self.api.create_commit.assert_not_called()

    def test_cross_dataset_migration_requires_explicit_reconciliation(self):
        self.seed_remote_books([("old-book", "旧书", ("full-book",))])
        self.make_book()
        (self.root / "report.json").write_text(json.dumps({"supersededDatasetIds": ["old-book"]}), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "跨书目合并"):
            self.publish()
        self.api.create_commit.assert_not_called()

    def test_search_document_with_unknown_owner_is_rejected(self):
        self.make_book()
        with gzip.open(self.root / "search/documents.jsonl.gz", "at", encoding="utf-8") as stream:
            stream.write(json.dumps({"datasetId": "other", "itemId": "other:full-book"}) + "\n")
        with self.assertRaisesRegex(RuntimeError, "身份不符"):
            self.publish()
        self.api.create_commit.assert_not_called()

    def test_snapshot_cache_tracks_search_and_recovers_missing_files(self):
        self.make_book()
        snapshot, _ = content_publish._prepare_huggingface_snapshot(self.root, lambda _: None)
        (snapshot / "collections/测试书/items/full-book.json.gz").unlink()
        snapshot, _ = content_publish._prepare_huggingface_snapshot(self.root, lambda _: None)
        self.assertTrue((snapshot / "collections/测试书/items/full-book.json.gz").exists())
        with gzip.open(self.root / "search/documents.jsonl.gz", "wt", encoding="utf-8") as stream:
            stream.write(json.dumps({"datasetId": "book-a", "itemId": "book-a:full-book", "text": "updated search data"}) + "\n")
        snapshot, _ = content_publish._prepare_huggingface_snapshot(self.root, lambda _: None)
        self.assertIn(b"updated search data", gzip.decompress((snapshot / "data/search-documents.jsonl.gz").read_bytes()))

    def test_concurrent_commit_conflict_never_retries_or_cleans_up(self):
        self.make_book()
        original = dict(self.remote)

        def concurrent_commit(**kwargs):
            self.head = "other-writer"
            return self.commit(**kwargs)

        self.api.create_commit.side_effect = concurrent_commit
        with self.assertRaisesRegex(RuntimeError, "concurrent commit conflict"):
            self.publish()
        self.api.create_commit.assert_called_once()
        self.api.delete_files.assert_not_called()
        self.assertEqual(self.remote, original)

    def test_snapshot_bundles_dataset_assets_but_keeps_json_browseable(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "huggingface"
            (source / "book-a" / "assets").mkdir(parents=True)
            (source / "book-a" / "data").mkdir()
            (source / "README.md").write_text("root", encoding="utf-8")
            (source / "book-a" / "dataset.json").write_text(json.dumps({
                "datasetId": "book-a", "title": "测试书", "type": "book", "language": "zh-CN",
                "description": "测试简介", "items": [
                    {"itemId": "book-a:full-book", "itemKey": "full-book", "title": "测试书", "order": 1},
                ],
            }, ensure_ascii=False), encoding="utf-8")
            with gzip.open(source / "book-a" / "data" / "full-book.json.gz", "wt", encoding="utf-8") as stream:
                json.dump({
                    "itemId": "book-a:full-book", "datasetId": "book-a", "title": "测试书", "type": "book",
                    "language": "zh-CN", "metadata": {"authors": ["作者甲"], "publisher": "测试社"},
                    "content": {"toc": [{"id": "toc:1", "order": 1, "title": "第一章", "targetId": "chapter:1"}],
                                "chapters": [{"id": "chapter:1", "order": 1, "title": "第一章"}]},
                    "assets": [{"path": "assets/one.png"}, {"path": "assets/two.jpg"}], "annotations": [],
                }, stream, ensure_ascii=False)
            (source / "book-a" / "assets" / "one.png").write_bytes(b"one")
            (source / "book-a" / "assets" / "two.jpg").write_bytes(b"two")

            snapshot, stats = content_publish._prepare_huggingface_snapshot(root, lambda _message: None)

            collection = snapshot / "collections" / "测试书"
            self.assertTrue((snapshot / "catalog.json").exists())
            self.assertIn("Marxism Dataset", (snapshot / "README.md").read_text(encoding="utf-8"))
            self.assertTrue((collection / "dataset.json").exists())
            dataset = json.loads((collection / "dataset.json").read_text(encoding="utf-8"))
            self.assertEqual(dataset["itemPath"], "items/{itemKey}.json.gz")
            self.assertEqual(dataset["items"][0]["path"], "items/full-book.json.gz")
            self.assertTrue((collection / "items" / "full-book.json.gz").exists())
            self.assertIn("第一章", (collection / "items" / "full-book.md").read_text(encoding="utf-8"))
            self.assertFalse((collection / "assets").exists())
            with __import__("tarfile").open(collection / "assets.tar") as archive:
                self.assertEqual(archive.getnames(), ["assets/one.png", "assets/two.jpg"])
            self.assertEqual(stats["sourceFiles"], 5)
            self.assertEqual(stats["bundledAssets"], 2)
            (collection / "assets.tar").unlink()
            content_publish._prepare_huggingface_snapshot(root, lambda _: None)
            self.assertTrue((collection / "assets.tar").exists())


if __name__ == "__main__":
    unittest.main()
