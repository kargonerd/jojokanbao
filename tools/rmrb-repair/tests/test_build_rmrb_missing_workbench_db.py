import importlib.util
import json
import sqlite3
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "build_rmrb_missing_workbench_db.py"
SPEC = importlib.util.spec_from_file_location("build_rmrb_missing_workbench_db", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_build_indexes_only_empty_content(tmp_path):
    source = tmp_path / "merged.jsonl"
    rows = [
        {"date": "1950-01-01", "page": 1, "ordinal": 0, "title": "有正文", "content": "正文"},
        {"date": "1950-01-01", "page": 1, "ordinal": 1, "title": "无正文", "href": "/x", "content": "", "matchMethod": "none", "contentSource": None},
    ]
    source.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    output = tmp_path / "workbench.sqlite3"
    report = MODULE.build(source, output)
    assert report["missingCount"] == 1
    with sqlite3.connect(output) as connection:
        assert connection.execute("select title from missing_articles").fetchall() == [("无正文",)]
