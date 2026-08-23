import gzip
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rmrb_review_source import (
    MISSING_INDEX,
    HfSnapshot,
    ReviewSourceManager,
    build_review_cache,
    cache_revision,
)


def write_shard(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")


class RmrbReviewSourceTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.shard = self.root / "1950.jsonl.gz"
        self.database = self.root / "hf-missing-workbench.sqlite3"
        write_shard(self.shard, [
            {"date": "1950-01-01", "page": 1, "ordinal": 0, "title": "已有", "status": "available", "content": "正文"},
            {"date": "1950-01-01", "page": 1, "ordinal": 1, "title": "待补", "status": "missing", "content": ""},
            {"date": "1950-01-01", "page": 1, "ordinal": 2, "title": "无效目录", "status": "rejected", "content": ""},
            {"date": "1950-01-01", "page": 1, "ordinal": 3, "title": "旧图片状态", "status": "image", "content": "【图片】"},
        ])

    def tearDown(self):
        self.directory.cleanup()

    def test_builds_queue_from_only_hf_missing_rows(self):
        count = build_review_cache(
            [self.shard], self.database, "owner/dataset", "revision-1",
        )
        self.assertEqual(count, 1)
        self.assertEqual(cache_revision(self.database), "revision-1")
        with closing(sqlite3.connect(self.database)) as connection:
            rows = connection.execute(
                "SELECT issue_date, page_number, ordinal, title, match_method FROM missing_articles"
            ).fetchall()
        self.assertEqual(rows, [("1950-01-01", 1, 1, "待补", "hf-canonical")])

    def test_cold_start_downloads_and_warm_start_reuses_revision(self):
        files = (MISSING_INDEX,)
        downloads: list[str] = []

        def snapshot(repo_id: str, token: str) -> HfSnapshot:
            self.assertEqual(repo_id, "owner/dataset")
            return HfSnapshot("revision-1", files)

        def download(repo_id: str, token: str, revision: str, filename: str) -> Path:
            downloads.append(filename)
            return self.shard

        manager = ReviewSourceManager(snapshot, download)
        manager.ensure_started(self.database, "owner/dataset", "")
        manager.wait(5)
        self.assertEqual(manager.snapshot(self.database)["status"], "ready")
        self.assertEqual(downloads, list(files))

        warm_downloads: list[str] = []
        warm = ReviewSourceManager(snapshot, lambda *args: warm_downloads.append(str(args)) or self.shard)
        warm.ensure_started(self.database, "owner/dataset", "")
        warm.wait(5)
        self.assertEqual(warm.snapshot(self.database)["status"], "ready")
        self.assertEqual(warm_downloads, [])


if __name__ == "__main__":
    unittest.main()
