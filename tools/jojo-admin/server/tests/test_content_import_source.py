"""Explicit import choices survive HTTP, persisted jobs and the pipeline command."""
from io import BytesIO
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import content_routes


class ContentImportSourceTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name, value in (("RUNTIME", self.root), ("_jobs", {})):
            patcher = patch.object(content_routes, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        app = Flask(__name__)
        app.register_blueprint(content_routes.content_blueprint)
        self.client = app.test_client()

    def test_both_import_endpoints_require_a_valid_choice_before_creating_files_or_jobs(self):
        with patch.object(content_routes.threading, "Thread") as thread:
            for source in (None, "", "unknown"):
                fields = {} if source is None else {"librarySource": source}
                with self.subTest(source=source):
                    response = self.client.post("/api/content/import-files", data={
                        **fields, "files": (BytesIO(b"test"), "book.epub"),
                    })
                    self.assertEqual(response.status_code, 400)
                    self.assertIn("请选择", response.get_json()["message"])
                    self.assertEqual(self.client.post("/api/content/import-paths", json={**fields, "paths": []}).status_code, 400)
            thread.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(content_routes._jobs, {})

    def test_file_format_never_overrides_the_saved_choice_or_pipeline_argument(self):
        for suffix in ("epub", "json"):
            for source in ("jojo", "community"):
                with self.subTest(suffix=suffix, source=source), patch.object(content_routes.threading, "Thread"):
                    response = self.client.post("/api/content/import-files", data={
                        "files": (BytesIO(b"fixture"), f"book.{suffix}"),
                        "librarySource": source, "access": "public",
                    })
                    self.assertEqual(response.status_code, 200)
                    job = response.get_json()["job"]
                    gate = "authenticated" if source == "community" else "public"
                    self.assertEqual((job["librarySource"], job["access"]), (source, gate))
                    output = Path(job["outputDirectory"])
                    output.mkdir(parents=True)
                    (output / "report.json").write_text('{"itemsBuilt": []}', encoding="utf-8")
                    with patch.object(content_routes.subprocess, "Popen") as popen:
                        popen.return_value.stdout = []
                        popen.return_value.wait.return_value = 0
                        content_routes._build(job["jobId"])
                        command = popen.call_args.args[0]
                        self.assertEqual(command[command.index("--library-source") + 1], source)
                        self.assertIn("--authenticated" if source == "community" else "--public", command)
                    saved = json.loads((self.root / job["jobId"] / "state.json").read_text(encoding="utf-8"))
                    self.assertEqual((saved["status"], saved["librarySource"], saved["access"]), ("ready", source, gate))
                    content_routes._jobs.clear()
                    content_routes._load_jobs()
                    self.assertEqual(content_routes._jobs[job["jobId"]]["librarySource"], source)

    def test_scripted_json_import_can_choose_the_shared_library(self):
        file = self.root / "book.json"
        file.write_text("{}", encoding="utf-8")
        with patch.object(content_routes.threading, "Thread"):
            response = self.client.post("/api/content/import-paths", json={
                "paths": [str(file)], "librarySource": "community", "access": "public",
            })
        self.assertEqual(response.status_code, 200)
        job = response.get_json()["job"]
        self.assertEqual((job["librarySource"], job["access"]), ("community", "authenticated"))


if __name__ == "__main__":
    unittest.main()
