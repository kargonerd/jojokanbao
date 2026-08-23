import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "merge_rmrb_peopledata_xlsx.py"
SPEC = importlib.util.spec_from_file_location("merge_rmrb_peopledata_xlsx", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_choose_prefers_exact_title_on_the_same_page():
    canonical = {"page": 2, "title": "在福冈"}
    candidates = [
        {"page": 1, "title": "在福冈", "content": "错误版次"},
        {"page": 2, "title": "在 福冈", "content": "正确正文"},
    ]
    selected, method = MODULE.choose(canonical, candidates)
    assert selected["content"] == "正确正文"
    assert method == "exact_title"


def test_choose_does_not_guess_between_distinct_duplicate_bodies():
    canonical = {"page": 2, "title": "更正"}
    candidates = [
        {"page": 2, "title": "更正", "content": "第一则"},
        {"page": 2, "title": "更正", "content": "第二则"},
    ]
    selected, method = MODULE.choose(canonical, candidates)
    assert selected is None
    assert method == "ambiguous"
