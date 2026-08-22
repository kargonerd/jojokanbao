import json
import gzip
import os
import sys
from types import SimpleNamespace
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

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
    @patch.object(content_publish, "_huggingface_token", return_value="cached-cli-token")
    def test_status_accepts_cli_login(self, _token):
        with patch.dict(os.environ, {
            "HF_DATASET_REPO": "owner/public-content", "HF_DATASET_PRIVATE": "false",
        }, clear=False):
            status = content_publish.publication_status()["huggingface"]
        self.assertTrue(status["configured"])
        self.assertEqual(status["repoId"], "owner/public-content")
        self.assertFalse(status["private"])

    @patch.object(content_publish, "_huggingface_token", return_value="cached-cli-token")
    def test_publish_uses_cli_token_and_verifies_public_repo(self, _token):
        calls = {}

        class FakeApi:
            def __init__(self, token):
                calls["token"] = token

            def create_repo(self, **kwargs):
                calls["create"] = kwargs

            def upload_large_folder(self, **kwargs):
                calls["upload"] = kwargs
                folder = Path(kwargs["folder_path"])
                calls["remote"] = [".gitattributes", *sorted(
                    path.relative_to(folder).as_posix()
                    for path in folder.rglob("*")
                    if path.is_file() and ".cache" not in path.relative_to(folder).parts
                )]

            def repo_info(self, **_kwargs):
                return SimpleNamespace(private=False, sha="abc")

            def list_repo_files(self, **_kwargs):
                return calls["remote"]

            def delete_files(self, **kwargs):
                calls["delete"] = kwargs

        module = SimpleNamespace(HfApi=FakeApi)
        with TemporaryDirectory() as temp, patch.dict(
            os.environ,
            {"HF_DATASET_REPO": "owner/public-content", "HF_DATASET_PRIVATE": "false", "HF_TOKEN": ""},
            clear=False,
        ), patch.dict(sys.modules, {"huggingface_hub": module}):
            root = Path(temp)
            (root / "huggingface" / "book-a" / "data").mkdir(parents=True)
            (root / "huggingface" / "README.md").write_text("root", encoding="utf-8")
            (root / "huggingface" / "book-a" / "dataset.json").write_text(json.dumps({
                "datasetId": "book-a", "title": "测试书", "type": "book", "language": "zh-CN",
                "items": [{"itemId": "book-a:full-book", "itemKey": "full-book", "title": "测试书", "order": 1}],
            }, ensure_ascii=False), encoding="utf-8")
            with gzip.open(root / "huggingface" / "book-a" / "data" / "main.json.gz", "wt", encoding="utf-8") as stream:
                json.dump({
                    "itemId": "book-a:full-book", "datasetId": "book-a", "title": "测试书", "type": "book",
                    "language": "zh-CN", "metadata": {"authors": ["作者甲"], "publisher": "测试社"},
                    "content": {"toc": [{"id": "toc:1", "order": 1, "title": "第一章", "targetId": "chapter:1"}],
                                "chapters": [{"id": "chapter:1", "order": 1, "title": "第一章"}]},
                    "assets": [], "annotations": [],
                }, stream, ensure_ascii=False)
            result = content_publish.publish_huggingface(root, lambda _message: None)

        self.assertEqual(calls["token"], "cached-cli-token")
        self.assertFalse(calls["create"]["private"])
        self.assertEqual(calls["upload"]["repo_type"], "dataset")
        self.assertEqual(calls["upload"]["num_workers"], 4)
        self.assertFalse(result["private"])
        self.assertEqual(result["remoteFiles"], len(calls["remote"]))
        self.assertTrue(result["commit"].endswith("/commit/abc"))
        self.assertNotIn("delete", calls)

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
            self.assertTrue((collection / "items" / "full-book.json.gz").exists())
            self.assertIn("第一章", (collection / "items" / "full-book.md").read_text(encoding="utf-8"))
            self.assertFalse((collection / "assets").exists())
            with __import__("tarfile").open(collection / "assets.tar") as archive:
                self.assertEqual(archive.getnames(), ["assets/one.png", "assets/two.jpg"])
            self.assertEqual(stats["sourceFiles"], 5)
            self.assertEqual(stats["bundledAssets"], 2)


if __name__ == "__main__":
    unittest.main()
