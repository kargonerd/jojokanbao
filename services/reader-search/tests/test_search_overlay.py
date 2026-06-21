import sys
import tempfile
import unittest
from pathlib import Path


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from search_overlay import merge_search_hits, parse_rmrb_markdown  # noqa: E402


def hit(source, score=1):
    return {
        "_score": score,
        "_source": source,
    }


class SearchOverlayTests(unittest.TestCase):
    def test_delta_version_replaces_base_even_with_lower_score(self):
        base_hits = [
            hit(
                {
                    "logicalId": "rmrb:a.md",
                    "version": 1,
                    "deleted": False,
                    "title": "old title",
                    "content": "old content",
                },
                score=10,
            )
        ]
        delta_hits = [
            hit(
                {
                    "logicalId": "rmrb:a.md",
                    "version": 2,
                    "deleted": False,
                    "title": "new title",
                    "content": "new content",
                },
                score=2,
            )
        ]

        total, results = merge_search_hits(
            base_hits,
            delta_hits,
            {"rmrb:a.md": {"version": 2, "deleted": False}},
            offset=0,
            size=10,
        )

        self.assertEqual(total, 1)
        self.assertEqual(results[0]["version"], 2)
        self.assertEqual(results[0]["title"], "new title")

    def test_patch_state_filters_deleted_base_hit_without_delta_hit(self):
        base_hits = [
            hit(
                {
                    "logicalId": "rmrb:deleted.md",
                    "version": 1,
                    "deleted": False,
                    "title": "deleted title",
                    "content": "deleted content",
                },
                score=10,
            )
        ]

        total, results = merge_search_hits(
            base_hits,
            [],
            {"rmrb:deleted.md": {"version": 2, "deleted": True}},
            offset=0,
            size=10,
        )

        self.assertEqual(total, 0)
        self.assertEqual(results, [])

    def test_parse_rmrb_markdown_uses_source_path_as_logical_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            article_dir = root / "7z" / "1946年05月"
            article_dir.mkdir(parents=True)
            article = article_dir / "1946-05-15_测试文章.md"
            article.write_text(
                "### 测试文章\n作者\n1946-05-15\n第2版()\n专栏：\n正文内容",
                encoding="utf-8",
            )

            doc = parse_rmrb_markdown(article, root)

        self.assertEqual(doc["logicalId"], "rmrb:7z/1946年05月/1946-05-15_测试文章.md")
        self.assertEqual(doc["date"], "1946-05-15")
        self.assertEqual(doc["page"], 2)
        self.assertEqual(doc["content"], "正文内容")


if __name__ == "__main__":
    unittest.main()
