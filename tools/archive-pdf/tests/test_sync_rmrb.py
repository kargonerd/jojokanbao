import copy
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import Mock, patch

from pypdf import PdfReader, PdfWriter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sync_rmrb as sync


class SyncTests(unittest.TestCase):
    def test_rejects_partial_page_list(self):
        with patch.object(sync, "get_text", side_effect=["pageLink pageLink", "attachement/a.pdf", "missing"]):
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                sync.get_page_urls(Mock(), date(2026, 9, 10))

    def test_dry_run_does_not_publish_and_keeps_staged_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "source.pdf"
            pdf.write_bytes(b"%PDF-1.7\nsource")
            canonical = Mock()
            delivery = Mock()
            delivery.read.return_value = None
            plan = {"asset": "content/asset.jox", "manifest": "content/manifest.jox", "canonical": {"newspapers/rmrb/item": pdf}, "delivery": {"content/asset.jox": pdf}}
            with patch.multiple(sync, WORK_DIR=root, HuggingFace=Mock(return_value=canonical), Delivery=Mock(return_value=delivery)), \
                 patch.object(sync, "obtain_pdf", return_value=pdf), \
                 patch.object(sync, "linearize_pdf"), patch.object(sync, "prepare_issue", return_value=plan), \
                 patch.object(sync, "publish_issue") as publish:
                report = sync.sync_day(date(2026, 7, 19), dry_run=True)
                self.assertFalse(report["published"])
                publish.assert_not_called()
                self.assertTrue((root / "20260719/publication.json").exists())

    def test_force_fetches_fresh_source_even_if_canonical_pdf_exists(self):
        canonical = Mock()
        canonical.read.return_value = {"assets": [{"type": "pdf", "path": "existing.pdf"}]}
        with tempfile.TemporaryDirectory() as directory:
            sources = [sync.PageSource(
                url="https://publisher.test/page.pdf", label="第01版（要闻）",
                image_width=None, image_height=None, articles=(),
            )]
            with patch.object(sync, "get_page_sources", return_value=sources), \
                 patch.object(sync, "download_pdf"), patch.object(sync, "merge_pdfs"):
                source = sync.obtain_pdf(date(2026, 9, 10), Path(directory), canonical, Mock(), refresh=True)
                self.assertEqual(source.name, "merged.pdf")
                canonical.file.assert_not_called()

    def test_parse_page_source_maps_titles_to_article_rectangles(self):
        html = """
        <p class="left ban">第01版：要闻</p>
        <img width="400" height="575" src="page.jpg" USEMAP=#PagePicMap>
        <MAP name="PagePicMap">
          <Area coords="300,40,390,200" shape="polygon" href="../../../content/202611/28/content_2.html">
          <Area coords="10,40,290,200" shape="polygon" href="../../../content/202611/28/content_1.html">
        </MAP>
        <ul class="news-list">
          <li><span>·</span><a href="../../../content/202611/28/content_1.html">左侧头条</a></li>
          <li><span>·</span><a href="../../../content/202611/28/content_2.html">右侧报道</a></li>
        </ul>
        """
        source = sync.parse_page_source(html, "https://example.test/page.pdf", 1)
        self.assertEqual(source.label, "要闻")
        self.assertEqual((source.image_width, source.image_height), (400, 575))
        self.assertEqual([title for title, _ in source.articles], ["左侧头条", "右侧报道"])
        self.assertEqual(source.articles[0][1], (10.0, 40.0, 290.0, 200.0))

    def test_bookmark_rect_converts_image_space_to_pdf_space(self):
        rect = sync.bookmark_rect((100, 50, 300, 250), 400, 575, 1000, 1500)
        self.assertAlmostEqual(rect[0], 250.0)
        self.assertAlmostEqual(rect[2], 750.0)
        self.assertAlmostEqual(rect[3], 1500 - 50 / 575 * 1500)
        self.assertAlmostEqual(rect[1], 1500 - 250 / 575 * 1500)

    def test_merge_pdfs_writes_edition_and_article_bookmarks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            part = root / "01.pdf"
            writer = PdfWriter()
            writer.add_blank_page(width=1000, height=1500)
            with part.open("wb") as stream:
                writer.write(stream)
            source = sync.PageSource(
                url="https://example.test/page.pdf", label="第01版（要闻）",
                image_width=400, image_height=575,
                articles=(("头条", (100, 50, 300, 250)),),
            )
            output = root / "merged.pdf"
            sync.merge_pdfs([(part, source)], output)
            items = []
            def flatten(nodes):
                for node in nodes:
                    if isinstance(node, list):
                        flatten(node)
                    else:
                        items.append(node)
            flatten(PdfReader(str(output)).outline)
            self.assertEqual([item.title for item in items], ["第01版（要闻）", "头条"])
            article = next(item for item in items if item.title == "头条")
            self.assertEqual(str(article.dest_array[1]), "/FitR")
            self.assertAlmostEqual(float(article.dest_array[2]), 250.0, places=3)
            self.assertAlmostEqual(float(article.dest_array[5]), 1500 - 50 / 575 * 1500, places=3)

    def test_local_source_dir_replaces_remote_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "20260910.pdf"
            source.write_bytes(b"%PDF-1.7\nlocal")
            canonical = Mock()
            canonical.read.return_value = None
            result = sync.obtain_pdf(date(2026, 9, 10), root, canonical, Mock(), source_dir=root)
            self.assertEqual(result, source)

    def test_local_source_dir_reports_missing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = Mock()
            canonical.read.return_value = None
            with self.assertRaisesRegex(FileNotFoundError, "Missing local source PDF"):
                sync.obtain_pdf(date(2026, 9, 10), root, canonical, Mock(), source_dir=root)

    def test_local_source_dir_rejects_non_pdf(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "20260910.pdf").write_bytes(b"not a pdf")
            canonical = Mock()
            canonical.read.return_value = None
            with self.assertRaisesRegex(ValueError, "not a PDF"):
                sync.obtain_pdf(date(2026, 9, 10), root, canonical, Mock(), source_dir=root)

    def test_date_validation_rejects_invalid_or_noncompact_dates(self):
        for value in ("20260230", "2026-09-10", "2026091", "../../tmp"):
            with self.assertRaises(sync.argparse.ArgumentTypeError):
                sync.compact_date(value)


if __name__ == "__main__":
    unittest.main()
