import json
import sys
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
                    "itemsBuilt": [
                        {"datasetId": "dataset-a"},
                        {"datasetId": "dataset-b"},
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
        self.assertTrue(remotes[1].endswith("/content/dataset-a/index.jox"))
        self.assertTrue(remotes[2].endswith("/content/dataset-b/index.jox"))


if __name__ == "__main__":
    unittest.main()
