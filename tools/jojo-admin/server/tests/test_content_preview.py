import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import content_routes


class ContentPreviewTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.runtime = Path(self.directory.name)
        self.delivery = self.runtime / "book-job" / "output" / "delivery"
        self.delivery.mkdir(parents=True)
        self.payload = b"generated-reader-payload"
        (self.delivery / "manifest.jox").write_bytes(self.payload)
        self.job = {"status": "ready", "publicationStatus": "draft", "publish": {}}
        self.jobs = {"book-job": self.job}
        self.runtime_patch = patch.object(content_routes, "RUNTIME", self.runtime)
        self.jobs_patch = patch.object(content_routes, "_jobs", self.jobs)
        self.runtime_patch.start()
        self.jobs_patch.start()
        self.addCleanup(self.runtime_patch.stop)
        self.addCleanup(self.jobs_patch.stop)
        app = Flask(__name__)
        app.register_blueprint(content_routes.content_blueprint)
        self.client = app.test_client()
        self.url = "/api/content/jobs/book-job/preview/delivery/"

    def test_reads_exact_generated_bytes_without_publishing_draft(self):
        with patch.object(content_routes, "publish_huggingface") as hf, patch.object(content_routes, "publish_b2") as b2:
            with self.client.get(self.url + "manifest.jox") as response:
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data, self.payload)
                self.assertEqual(response.mimetype, "application/octet-stream")
                self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(self.job, {"status": "ready", "publicationStatus": "draft", "publish": {}})
            hf.assert_not_called()
            b2.assert_not_called()

    def test_blocks_pending_jobs_and_handles_missing_content(self):
        self.job["status"] = "building"
        self.assertEqual(self.client.get(self.url + "manifest.jox").status_code, 409)
        self.job["status"] = "ready"
        self.assertEqual(self.client.get(self.url + "missing.jox").status_code, 404)
        self.assertEqual(self.client.get(self.url.replace("book-job", "unknown") + "manifest.jox").status_code, 404)

    def test_keeps_preview_available_during_and_after_publication(self):
        for status in ("publishing", "published", "publish-failed"):
            self.job["status"] = status
            with self.subTest(status=status), self.client.get(self.url + "manifest.jox") as response:
                self.assertEqual(response.status_code, 200)

    def test_refuses_source_files_and_path_traversal(self):
        (self.delivery / "source.html").write_text("private source", encoding="utf-8")
        (self.delivery.parent / "private.jox").write_bytes(b"outside delivery")
        for key in ("source.html", "../private.jox", "%2e%2e/private.jox", "..%5cprivate.jox", "C:%5cprivate.jox"):
            with self.subTest(key=key):
                self.assertEqual(self.client.get(self.url + key).status_code, 404)

    def test_refuses_symlinks_outside_delivery(self):
        outside = self.delivery.parent / "private.jox"
        outside.write_bytes(b"outside delivery")
        try:
            (self.delivery / "link.jox").symlink_to(outside)
        except OSError:
            self.skipTest("Symlinks are not permitted on this host")
        self.assertEqual(self.client.get(self.url + "link.jox").status_code, 404)


if __name__ == "__main__":
    unittest.main()
