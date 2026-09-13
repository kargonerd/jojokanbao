import copy
import gzip
from io import BytesIO
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from xml.etree import ElementTree
from zipfile import ZipFile, ZIP_STORED

from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import content_metadata
import content_routes
from jojo_format import _decode_jox, _json_bytes, _transform_jox, _write_jox


class ContentPublicationTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.runtime = Path(temporary.name)
        self.root = self.runtime / "book-job" / "output"
        self.root.mkdir(parents=True)
        self.settings = {"publicationStatus": "draft", "access": "public"}
        self.items = []
        for dataset_id in ("book-a", "book-b"):
            canonical_key = f"canonical/books/{dataset_id}/items/full-book/item.json.gz"
            manifest_key = f"content/books/{dataset_id}/items/full-book/manifest.jox"
            canonical = {**self.settings, "revision": 1, "datasetId": dataset_id,
                         "itemId": f"{dataset_id}:full-book", "content": {"chapters": [{"body": "原来的正文"}]}}
            compressed = gzip.compress(_json_bytes(canonical))
            self.write(canonical_key, compressed)
            self.write(f"huggingface/{dataset_id}/data/full-book.json.gz", compressed)
            summary = {**self.settings, "itemKey": "full-book", "title": dataset_id}
            dataset = {**self.settings, "datasetId": dataset_id, "title": dataset_id}
            self.write(f"canonical/books/{dataset_id}/dataset.json", _json_bytes(dataset))
            self.write(f"huggingface/{dataset_id}/dataset.json", _json_bytes({**dataset, "items": [summary]}))
            _write_jox(self.root / "delivery" / manifest_key, manifest_key, {
                **canonical, "contentStats": {"canonicalCompressedSize": len(compressed)},
            })
            key = f"content/books/{dataset_id}/index.jox"
            _write_jox(self.root / "delivery" / key, key, {**dataset, "revision": 1, "items": [summary]})
            self.items.append({"datasetId": dataset_id, "itemKey": "full-book", "canonicalObject": canonical_key, "manifestObject": manifest_key})
        _write_jox(self.root / "delivery/catalog.jox", "catalog.jox", {
            "revision": 1, "datasets": [{**self.settings, "datasetId": dataset} for dataset in ("book-a", "book-b", "unrelated")],
        })
        self.write("report.json", _json_bytes({"itemsBuilt": self.items}))
        self.write("delivery/chapters/immutable.jox", b"chapter and asset bytes")
        self.write("search/documents.jsonl.gz", gzip.compress(b'{"text":"search text"}\n'))
        completed = {"status": "completed", "completedAt": "2026-09-12T10:00:00Z", **self.settings}
        self.job = {"jobId": "book-job", "status": "published", "createdAt": "2026-09-12T10:00:00Z",
                    **self.settings, "outputDirectory": str(self.root), "logs": [],
                    "publish": {"huggingface": dict(completed), "b2": dict(completed)}}
        for name, value in (("RUNTIME", self.runtime), ("_jobs", {"book-job": self.job})):
            patcher = patch.object(content_routes, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(content_routes, "publication_status", return_value={"huggingface": {"configured": True}, "b2": {"configured": True}})
        patcher.start()
        self.addCleanup(patcher.stop)
        app = Flask(__name__)
        app.register_blueprint(content_routes.content_blueprint)
        self.client = app.test_client()
        self.url = "/api/content/jobs/book-job/publish"

    def write(self, key, payload):
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)

    def snapshot(self):
        return {path.relative_to(self.root): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}

    def prepare_title_correction(self):
        self.items = [self.items[0]]
        self.job["report"] = {"itemsBuilt": self.items}
        self.write("report.json", _json_bytes(self.job["report"]))
        payload = BytesIO()
        with ZipFile(payload, "w") as archive:
            archive.writestr("mimetype", "application/epub+zip", compress_type=ZIP_STORED)
            archive.writestr("META-INF/container.xml", '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
            archive.writestr("OEBPS/content.opf", '<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>原书名</dc:title><dc:identifier>book-a:full-book</dc:identifier></metadata></package>')
            archive.writestr("OEBPS/chapter.xhtml", "原来的正文")
        key = "content/books/book-a/items/full-book/exports/old.jox"
        self.write("delivery/" + key, _transform_jox(payload.getvalue(), key))
        manifest_key = self.items[0]["manifestObject"]
        manifest = _decode_jox(self.root / "delivery" / manifest_key, manifest_key)
        manifest["exports"] = [{"format": "epub", "object": "exports/old.jox", "fileName": "原书名.epub"}]
        _write_jox(self.root / "delivery" / manifest_key, manifest_key, manifest)
        self.write("search/documents.jsonl.gz", gzip.compress(b"".join(_json_bytes({
            "datasetId": dataset, "itemId": dataset + ":full-book", "datasetTitle": "原书名", "itemTitle": "原书名", "text": "原文", "revision": 1,
        }) for dataset in ("book-a", "book-b"))))

    def test_title_correction_updates_all_labels_and_epub_without_changing_identity_or_content(self):
        self.prepare_title_correction()
        key = self.items[0]["canonicalObject"]
        original = json.loads(gzip.decompress((self.root / key).read_bytes()))
        original.update(librarySource="jojo", provenance={"source": "epub", "sourceFormat": "epub"})
        self.write(key, gzip.compress(_json_bytes(original)))
        before = self.snapshot()
        title = "毛泽东思想万岁（六八年汉版）"
        with patch.object(content_routes.threading, "Thread"):
            response = self.client.post(self.url, json={"targets": ["huggingface", "b2"], "title": title, "publicationStatus": "published", "access": "authenticated"})
        self.assertEqual(response.status_code, 200)
        canonical = json.loads(gzip.decompress((self.root / self.items[0]["canonicalObject"]).read_bytes()))
        self.assertEqual(canonical["title"], title)
        self.assertEqual(canonical["librarySource"], "jojo")
        self.assertEqual(canonical["itemId"], "book-a:full-book")
        self.assertEqual(canonical["content"], {"chapters": [{"body": "原来的正文"}]})
        self.assertEqual(canonical["access"], "authenticated")
        self.assertEqual(self.job["report"]["itemsBuilt"][0]["itemTitle"], title)
        manifest_key = self.items[0]["manifestObject"]
        manifest = _decode_jox(self.root / "delivery" / manifest_key, manifest_key)
        self.assertEqual(manifest["title"], title)
        export = manifest["exports"][0]
        self.assertNotEqual(export["object"], "exports/old.jox")
        self.assertEqual(export["fileName"], title + ".epub")
        key = manifest_key.rsplit("/", 1)[0] + "/" + export["object"]
        with ZipFile(BytesIO(_transform_jox((self.root / "delivery" / key).read_bytes(), key))) as archive:
            package = ElementTree.fromstring(archive.read("OEBPS/content.opf"))
            self.assertEqual(package.find("{*}metadata/{*}title").text, title)
            self.assertEqual(archive.read("OEBPS/chapter.xhtml"), "原来的正文".encode())
            self.assertEqual(archive.infolist()[0].filename, "mimetype")
            self.assertEqual(archive.infolist()[0].compress_type, ZIP_STORED)
        documents = [json.loads(line) for line in gzip.decompress((self.root / "search/documents.jsonl.gz").read_bytes()).splitlines()]
        self.assertEqual(documents[0]["itemTitle"], title)
        self.assertEqual(documents[0]["text"], "原文")
        self.assertEqual(documents[1]["itemTitle"], "原书名")
        self.assertEqual((self.root / "delivery/chapters/immutable.jox").read_bytes(), before[Path("delivery/chapters/immutable.jox")])
        self.assertEqual((self.root / "canonical/books/book-b/dataset.json").read_bytes(), before[Path("canonical/books/book-b/dataset.json")])

    def test_failed_title_correction_removes_new_export_and_restores_original_files(self):
        self.prepare_title_correction()
        before = self.snapshot()
        replace = os.replace
        count = 0
        def fail_once(source, destination):
            nonlocal count
            count += 1
            if count == 4:
                raise OSError("disk unavailable")
            replace(source, destination)
        with patch.object(content_metadata.os, "replace", side_effect=fail_once):
            with self.assertRaises(OSError):
                content_metadata.update_publication(self.root, "published", "authenticated", title="新书名")
        self.assertEqual(before, self.snapshot())

    def test_title_correction_requires_one_book_and_all_previous_targets(self):
        before = self.snapshot()
        self.job["report"] = {"itemsBuilt": self.items}
        for title in ("新书名", "", "bad\nname", 42):
            self.assertEqual(self.client.post(self.url, json={"targets": ["huggingface", "b2"], "title": title}).status_code, 400)
        self.prepare_title_correction()
        before = self.snapshot()
        self.assertEqual(self.client.post(self.url, json={"targets": ["b2"], "title": "新书名"}).status_code, 400)
        self.assertEqual(before, self.snapshot())

    def assert_settings(self, publication, access):
        for item in self.items:
            canonical = json.loads(gzip.decompress((self.root / item["canonicalObject"]).read_bytes()))
            mirror = self.root / f"huggingface/{item['datasetId']}/data/full-book.json.gz"
            self.assertEqual(mirror.read_bytes(), (self.root / item["canonicalObject"]).read_bytes())
            self.assertEqual(canonical["content"], {"chapters": [{"body": "原来的正文"}]})
            manifest = _decode_jox(self.root / "delivery" / item["manifestObject"], item["manifestObject"])
            self.assertEqual(manifest["contentStats"]["canonicalCompressedSize"], mirror.stat().st_size)
            key = f"content/books/{item['datasetId']}/index.jox"
            index = _decode_jox(self.root / "delivery" / key, key)
            hf_dataset = json.loads((self.root / f"huggingface/{item['datasetId']}/dataset.json").read_bytes())
            dataset = json.loads((self.root / f"canonical/books/{item['datasetId']}/dataset.json").read_bytes())
            for value in (canonical, manifest, index, index["items"][0], hf_dataset, hf_dataset["items"][0], dataset):
                self.assertEqual((value["publicationStatus"], value["access"]), (publication, access))
        catalog = _decode_jox(self.root / "delivery/catalog.jox", "catalog.jox")
        for entry in catalog["datasets"][:2]:
            self.assertEqual((entry["publicationStatus"], entry["access"]), (publication, access))
        self.assertEqual(catalog["datasets"][2]["publicationStatus"], "draft")

    def test_promotion_and_unpublishing_update_all_metadata_and_preserve_content(self):
        before = self.snapshot()
        content_metadata.update_publication(self.root, "published", "authenticated")
        self.assert_settings("published", "authenticated")
        content_metadata.update_publication(self.root, "draft", "public")
        self.assert_settings("draft", "public")
        for key in ("delivery/chapters/immutable.jox", "search/documents.jsonl.gz", "report.json"):
            self.assertEqual((self.root / key).read_bytes(), before[Path(key)])

    def test_publication_preserves_explicit_source_without_using_epub_provenance(self):
        for source in ("jojo", "community", None):
            with self.subTest(source=source):
                for item in self.items:
                    key = item["canonicalObject"]
                    canonical = json.loads(gzip.decompress((self.root / key).read_bytes()))
                    canonical["provenance"] = {"source": "epub", "sourceFormat": "epub"}
                    if source is None:
                        canonical.pop("librarySource", None)
                    else:
                        canonical["librarySource"] = source
                    self.write(key, gzip.compress(_json_bytes(canonical)))
                for publication in ("published", "draft"):
                    content_metadata.update_publication(self.root, publication, "public")
                    self.assert_settings(publication, "authenticated" if source == "community" else "public")
                    for item in self.items:
                        canonical = json.loads(gzip.decompress((self.root / item["canonicalObject"]).read_bytes()))
                        index_key = f"content/books/{item['datasetId']}/index.jox"
                        index = _decode_jox(self.root / "delivery" / index_key, index_key)
                        manifest = _decode_jox(self.root / "delivery" / item["manifestObject"], item["manifestObject"])
                        dataset = json.loads((self.root / f"huggingface/{item['datasetId']}/dataset.json").read_bytes())
                        for value in (canonical, index, index["items"][0], manifest, dataset, dataset["items"][0]):
                            self.assertEqual(value["librarySource"], source or "jojo")

    def test_failed_write_rolls_back_every_file(self):
        before = self.snapshot()
        replace = os.replace
        count = 0

        def fail_once(source, destination):
            nonlocal count
            count += 1
            if count == 4:
                raise OSError("disk unavailable")
            replace(source, destination)

        with patch.object(content_metadata.os, "replace", side_effect=fail_once):
            with self.assertRaises(OSError):
                content_metadata.update_publication(self.root, "published", "public")
        self.assertEqual(self.snapshot(), before)

    def test_missing_or_unsafe_file_rejected_before_any_write(self):
        for canonical_key in ("missing.json.gz", "../../outside.json.gz"):
            report = {"itemsBuilt": [{**self.items[0], "canonicalObject": canonical_key}]}
            self.write("report.json", _json_bytes(report))
            before = self.snapshot()
            with self.assertRaises((ValueError, OSError)):
                content_metadata.update_publication(self.root, "published", "public")
            self.assertEqual(self.snapshot(), before)

    def test_route_saves_metadata_tracks_each_target_and_retries_without_rebuilding(self):
        with patch.object(content_routes.threading, "Thread"):
            response = self.client.post(self.url, json={"targets": ["huggingface", "b2"], "publicationStatus": "published", "access": "authenticated"})
        self.assertEqual(response.status_code, 200)
        self.assert_settings("published", "authenticated")
        self.assertEqual(self.job["publish"]["b2"]["lastSuccessful"]["publicationStatus"], "draft")
        with patch.object(content_routes, "publish_huggingface", return_value={"commitUrl": "https://huggingface.co/test"}), patch.object(content_routes, "publish_b2", side_effect=RuntimeError("offline")):
            content_routes._publish("book-job", ["huggingface", "b2"])
        self.assertEqual(self.job["status"], "publish-failed")
        self.assertEqual(self.job["publish"]["huggingface"]["publicationStatus"], "published")
        self.assertEqual(self.job["publish"]["b2"]["status"], "failed")
        self.assertEqual(self.job["publish"]["b2"]["lastSuccessful"]["publicationStatus"], "draft")
        before = self.snapshot()
        with patch.object(content_routes.threading, "Thread"), patch.object(content_routes, "update_publication") as update:
            response = self.client.post(self.url, json={"targets": ["b2"], "publicationStatus": "published", "access": "authenticated"})
            update.assert_not_called()
        self.assertEqual(response.status_code, 200)
        with patch.object(content_routes, "publish_b2", return_value={}):
            content_routes._publish("book-job", ["b2"])
        self.assertEqual(self.job["status"], "published")
        self.assertEqual(self.job["publish"]["b2"]["publicationStatus"], "published")
        self.assertEqual(before, self.snapshot())
        stored = json.loads((self.runtime / "book-job/state.json").read_bytes())
        self.assertEqual(stored, self.job)

    def test_es_runs_after_both_publications_and_can_retry_independently(self):
        with patch.object(content_routes.threading, "Thread") as thread:
            response = self.client.post(self.url, json={"targets": ["huggingface", "b2"]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(thread.call_args.kwargs["args"][1], ["huggingface", "b2", "elasticsearch"])
        with patch.object(content_routes, "publish_huggingface", return_value={"revision": "a" * 40}), patch.object(content_routes, "publish_b2", return_value={}), patch.object(content_routes, "sync_publication", side_effect=RuntimeError("ES offline")):
            content_routes._publish("book-job", ["huggingface", "b2", "elasticsearch"])
        self.assertEqual(self.job["status"], "publish-failed")
        self.assertEqual(self.job["publish"]["b2"]["status"], "completed")
        with patch.object(content_routes.threading, "Thread"):
            response = self.client.post(self.url, json={"targets": ["elasticsearch"]})
        self.assertEqual(response.status_code, 200)
        with patch.object(content_routes, "publish_huggingface") as hf, patch.object(content_routes, "publish_b2") as b2, patch.object(content_routes, "sync_publication", return_value={"created": 2}):
            content_routes._publish("book-job", ["elasticsearch"])
        self.assertEqual(self.job["status"], "published")
        hf.assert_not_called()
        b2.assert_not_called()

    def test_failed_hf_prevents_es_from_indexing_a_stale_commit(self):
        with patch.object(content_routes.threading, "Thread"):
            self.client.post(self.url, json={"targets": ["huggingface", "b2"]})
        with patch.object(content_routes, "publish_huggingface", side_effect=RuntimeError("HF offline")), patch.object(content_routes, "publish_b2", return_value={}), patch.object(content_routes, "sync_publication") as sync:
            content_routes._publish("book-job", ["huggingface", "b2", "elasticsearch"])
        sync.assert_not_called()
        self.assertEqual(self.job["publish"]["elasticsearch"]["status"], "failed")

    def test_invalid_and_concurrent_requests_do_not_mutate_job_or_metadata(self):
        before = self.snapshot()
        original = copy.deepcopy(self.job)
        requests = [(400, {"targets": []}), (400, {"targets": "b2"}),
                    (400, {"targets": ["b2"], "publicationStatus": "published"}),
                    (400, {"targets": ["b2"], "access": "anything"})]
        with patch.object(content_routes.threading, "Thread") as thread:
            for status, data in requests:
                self.assertEqual(self.client.post(self.url, json=data).status_code, status)
                self.assertEqual(self.job, original)
            self.job["status"] = "publishing"
            self.assertEqual(self.client.post(self.url, json={"targets": ["b2"]}).status_code, 409)
            thread.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_restart_keeps_completed_targets_and_marks_unfinished_upload_retryable(self):
        self.job.update(status="publishing")
        self.job["publish"]["b2"] = {"status": "uploading", "lastSuccessful": self.job["publish"]["b2"]}
        content_routes._save(self.job)
        content_routes._load_jobs()
        restored = content_routes._jobs["book-job"]
        self.assertEqual(restored["status"], "publish-failed")
        self.assertEqual(restored["publish"]["b2"]["status"], "failed")
        self.assertEqual(restored["publish"]["b2"]["lastSuccessful"]["publicationStatus"], "draft")
        self.assertEqual(restored["publish"]["huggingface"]["status"], "completed")

    def test_settings_change_must_include_a_previously_failed_target_too(self):
        self.job["status"] = "publish-failed"
        self.job["publish"]["b2"] = {"status": "failed", "message": "connection lost after upload"}
        before = self.snapshot()
        with patch.object(content_routes.threading, "Thread") as thread:
            response = self.client.post(self.url, json={"targets": ["huggingface"], "publicationStatus": "published"})
            self.assertEqual(response.status_code, 400)
            thread.assert_not_called()
        self.assertEqual(before, self.snapshot())

    def test_old_import_is_labelled_and_cannot_overwrite_a_newer_valid_build(self):
        report = {"itemsBuilt": [{"itemId": "book-a:full-book"}]}
        self.job["report"] = report
        content_routes._jobs["newer-job"] = {**copy.deepcopy(self.job), "jobId": "newer-job", "createdAt": "2026-09-12T11:00:00Z", "status": "ready"}
        response = self.client.get("/api/content/jobs/book-job")
        self.assertEqual(response.json["job"]["newerJobId"], "newer-job")
        before = self.snapshot()
        with patch.object(content_routes.threading, "Thread") as thread:
            response = self.client.post(self.url, json={"targets": ["huggingface", "b2"], "publicationStatus": "published"})
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json["newerJobId"], "newer-job")
            thread.assert_not_called()
        self.assertEqual(before, self.snapshot())


if __name__ == "__main__":
    unittest.main()
