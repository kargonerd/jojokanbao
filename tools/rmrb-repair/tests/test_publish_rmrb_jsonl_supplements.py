import importlib.util
import json
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).resolve().parents[1] / "publish_rmrb_jsonl_supplements.py"
SPEC = importlib.util.spec_from_file_location("publish_rmrb_jsonl_supplements", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_supplement_input_requires_safe_classification_report(tmp_path: Path):
    source = tmp_path / "supplements.jsonl"
    row = {
        "date": "1988-09-09",
        "page": 4,
        "ordinal": 50,
        "title": "未对齐原题",
        "content": "可信正文",
        "contentSource": "jsonl",
        "matchMethod": "jsonl_directory_omission",
    }
    source.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
    report = tmp_path / "report.json"
    report.write_text(json.dumps({
        "safe": True,
        "accepted": str(source.resolve()),
        "counters": {"acceptedJsonlCanonicalRows": 1},
    }), encoding="utf-8")

    years, loaded_report = MODULE.load_supplement_rows(source, report)

    assert loaded_report["safe"] is True
    assert list(years) == ["1988"]
    assert list(years["1988"]) == [("1988-09-09", 4, 50)]

    report.write_text(json.dumps({
        "safe": False,
        "accepted": str(source.resolve()),
        "counters": {"acceptedJsonlCanonicalRows": 1},
    }), encoding="utf-8")
    with pytest.raises(ValueError, match="not safe"):
        MODULE.load_supplement_rows(source, report)
