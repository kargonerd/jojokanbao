import copy
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import Mock, patch

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
            with patch.object(sync, "get_page_urls", return_value=["https://publisher.test/page.pdf"]), \
                 patch.object(sync, "download_pdf"), patch.object(sync, "merge_pdfs"):
                source = sync.obtain_pdf(date(2026, 9, 10), Path(directory), canonical, Mock(), refresh=True)
                self.assertEqual(source.name, "merged.pdf")
                canonical.file.assert_not_called()

    def test_date_validation_rejects_invalid_or_noncompact_dates(self):
        for value in ("20260230", "2026-09-10", "2026091", "../../tmp"):
            with self.assertRaises(sync.argparse.ArgumentTypeError):
                sync.compact_date(value)


if __name__ == "__main__":
    unittest.main()
