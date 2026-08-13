from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sys
import tempfile
import unittest
from zoneinfo import ZoneInfo


TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

from rsshub_coverage import (  # noqa: E402
    Publisher,
    build_report,
    build_url,
    parse_feed,
    render_markdown,
    summarize_entries,
    write_outputs,
)


NOW = datetime(2026, 8, 13, 2, 0, tzinfo=timezone.utc)
ZONE = ZoneInfo("Asia/Shanghai")


class RsshubCoverageTests(unittest.TestCase):
    def test_build_url_encodes_access_key_without_changing_route(self) -> None:
        publisher = Publisher("test", "Test", "Global", "/test/latest", 100, "test")
        self.assertEqual(
            build_url("https://rsshub.example.test/", publisher, "secret +/value"),
            "https://rsshub.example.test/test/latest?limit=100&key=secret+%2B%2Fvalue",
        )

    def test_feed_dates_and_description_richness_are_summarized(self) -> None:
        entries = parse_feed(
            b"""<?xml version='1.0'?><rss xmlns:content='http://purl.org/rss/1.0/modules/content/'><channel>
              <item><title>Today</title><link>https://example.test/today</link>
                <pubDate>Thu, 13 Aug 2026 01:00:00 GMT</pubDate><description>short</description></item>
              <item><title>Yesterday</title><link>https://example.test/yesterday</link>
                <pubDate>Wed, 12 Aug 2026 12:00:00 GMT</pubDate><content:encoded>long text</content:encoded></item>
              <item><title>Undated</title><link>https://example.test/undated</link></item>
            </channel></rss>"""
        )
        result = summarize_entries(entries, NOW, ZONE, requested_limit=3)
        self.assertEqual(result["today_count"], 1)
        self.assertEqual(result["yesterday_count"], 1)
        self.assertEqual(result["undated_count"], 1)
        self.assertEqual(result["description_nonempty_rate"], 0.667)
        self.assertTrue(result["feed_window_saturated"])

    def test_report_and_artifacts_preserve_failures(self) -> None:
        report = build_report(
            "https://rsshub.example.test",
            [
                {
                    "key": "ok", "name": "Working", "region": "Global", "status": "ok", "http_status": 200,
                    "today_count": 4, "yesterday_count": 3, "recent_count": 7, "item_count": 10,
                    "description_nonempty_rate": 1.0, "long_description_rate": 0.5,
                    "feed_window_saturated": False,
                },
                {"key": "bad", "name": "Blocked", "region": "Global", "status": "http_error", "http_status": 503, "error": "HTTP 503"},
            ],
            NOW,
            "Asia/Shanghai",
        )
        self.assertEqual(report["summary"]["available_publisher_rate"], 0.5)
        self.assertEqual(report["summary"]["returned_recent_items"], 7)
        self.assertIn("Blocked", render_markdown(report))
        with tempfile.TemporaryDirectory() as directory:
            write_outputs(report, Path(directory))
            self.assertTrue((Path(directory) / "coverage.json").is_file())
            self.assertTrue((Path(directory) / "coverage.csv").is_file())
            self.assertTrue((Path(directory) / "summary.md").is_file())


if __name__ == "__main__":
    unittest.main()
