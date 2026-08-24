import importlib.util
import sqlite3
import sys
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "classify_rmrb_jsonl_unaligned.py"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("classify_rmrb_jsonl_unaligned", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def evidence(issue_date: str, page: int, title: str) -> dict:
    return {
        "date": issue_date,
        "page": page,
        "ordinal": 0,
        "title": title,
        "normalizedTitle": MODULE.norm(title),
    }


def source(issue_date: str = "1947-08-31", page: int = 2, title: str = "独立文章") -> dict:
    return {"date": issue_date, "page": page, "title": title, "content": "正文"}


def test_classifies_one_character_edit_on_same_page_as_suspected_typo():
    row = source(title="黄河防泛记")
    result = MODULE.classify_row(
        row,
        {},
        {("1947-08-31", 2): [evidence("1947-08-31", 2, "黄河防汛记")]},
    )

    assert result["reconciliationDecision"] == "review_nearby_conflict"
    assert result["reconciliationSignals"] == ["suspected_title_typo"]


def test_accepts_jsonl_when_no_typo_or_nearby_exact_title_exists():
    row = source(title="人民数据漏收文章")

    result = MODULE.classify_row(row, {}, {})

    assert result["reconciliationDecision"] == "accept_jsonl_canonical"
    assert result["reconciliationSignals"] == []


def test_generic_image_title_uses_caption_instead_of_recurring_image_label():
    row = source(title="图片")
    row["content"] = "麦收\n邹雅刻"

    assert MODULE.normalized_primary_title(row) == MODULE.norm("麦收")


def test_generic_image_without_caption_is_not_treated_as_nearby_exact_title():
    row = source(title="图片")
    row["content"] = "图片"

    assert MODULE.normalized_primary_title(row) == ""


def test_accepted_row_becomes_ordinary_canonical_article_without_source_only():
    row = {
        **source(title="人民数据漏收文章"),
        "preservedOrdinal": 42,
        "sourceOnly": True,
        "reconciliationDecision": "accept_jsonl_canonical",
    }

    canonical = MODULE.canonicalize_accepted_jsonl(row)

    assert canonical == {
        "date": "1947-08-31",
        "page": 2,
        "ordinal": 42,
        "title": "人民数据漏收文章",
        "href": None,
        "content": "正文",
        "contentSource": "jsonl",
        "matchMethod": "jsonl_directory_omission",
    }
    assert "sourceOnly" not in canonical


def test_withholds_exact_title_on_same_date_other_page():
    row = source(title="版次可能错误")
    locations = {
        MODULE.norm("版次可能错误"): [evidence("1947-08-31", 3, "版次可能错误")]
    }

    result = MODULE.classify_row(row, locations, {})

    assert result["reconciliationSignals"] == ["same_date_other_page"]


def test_withholds_exact_title_on_adjacent_date():
    row = source(title="日期可能错误")
    locations = {
        MODULE.norm("日期可能错误"): [evidence("1947-09-01", 2, "日期可能错误")]
    }

    result = MODULE.classify_row(row, locations, {})

    assert result["reconciliationSignals"] == ["adjacent_date"]


def test_withholds_exact_title_on_same_day_of_adjacent_month():
    row = source(title="月份可能错误")
    locations = {
        MODULE.norm("月份可能错误"): [evidence("1947-07-31", 2, "月份可能错误")]
    }

    result = MODULE.classify_row(row, locations, {})

    assert result["reconciliationSignals"] == ["adjacent_month_same_day"]


def test_directory_evidence_only_retains_requested_titles_and_pages(tmp_path: Path):
    directory = tmp_path / "directory.sqlite3"
    connection = sqlite3.connect(directory)
    connection.execute(
        "CREATE TABLE articles (issue_date TEXT, page_number INTEGER, ordinal INTEGER, title TEXT)"
    )
    connection.executemany(
        "INSERT INTO articles VALUES (?, ?, ?, ?)",
        [
            ("1947-08-31", 2, 0, "黄河防汛记"),
            ("1947-08-30", 1, 1, "日期可能错误"),
            ("1947-08-29", 1, 2, "无关文章"),
        ],
    )
    connection.commit()
    connection.close()

    exact, pages = MODULE.load_directory_evidence(
        directory,
        {MODULE.norm("日期可能错误")},
        {("1947-08-31", 2)},
    )

    assert list(exact) == [MODULE.norm("日期可能错误")]
    assert list(pages) == [("1947-08-31", 2)]
    assert pages[("1947-08-31", 2)][0]["title"] == "黄河防汛记"


def test_equal_duplicate_title_groups_pair_by_relative_page_order():
    sources = [
        {
            **source("1949-12-12", 3, "中国人民银行北京分行公告"),
            "content": "第一份公告正文",
            "preservedOrdinal": 47,
        },
        {
            **source("1949-12-12", 3, "中国人民银行北京分行公告"),
            "content": "第二份公告正文",
            "preservedOrdinal": 48,
        },
    ]
    missing = [
        {
            "date": "1949-12-12",
            "page": 3,
            "ordinal": 24,
            "title": "中国人民银行北京分行公告",
            "href": "/24",
        },
        {
            "date": "1949-12-12",
            "page": 3,
            "ordinal": 25,
            "title": "中国人民银行北京分行公告",
            "href": "/25",
        },
    ]

    remaining, resolved = MODULE.resolve_exact_same_page_groups(sources, missing)

    assert remaining == []
    assert [(row["ordinal"], row["content"]) for row in resolved] == [
        (24, "第一份公告正文"),
        (25, "第二份公告正文"),
    ]
    assert all(row["matchMethod"] == "exact_title_ordered_group" for row in resolved)


def test_unequal_duplicate_title_groups_stay_unresolved():
    sources = [
        {
            **source("1949-12-12", 3, "同名公告"),
            "preservedOrdinal": 47,
        }
    ]
    missing = [
        {"date": "1949-12-12", "page": 3, "ordinal": 24, "title": "同名公告"},
        {"date": "1949-12-12", "page": 3, "ordinal": 25, "title": "同名公告"},
    ]

    remaining, resolved = MODULE.resolve_exact_same_page_groups(sources, missing)

    assert remaining == sources
    assert resolved == []


def test_whitespace_only_same_date_title_uses_peopledata_page():
    sources = [{
        **source(
            "1950-06-02",
            2,
            "京市人民广播电台  将举行庆祝六一联欢会  约有各校小同学演出歌剧等节目",
        ),
        "preservedOrdinal": 75,
    }]
    missing = [{
        "date": "1950-06-02",
        "page": 3,
        "ordinal": 32,
        "title": "京市人民广播电台 将举行庆祝六一联欢会 约有各校小同学演出歌剧等节目",
        "href": "/32",
    }]

    remaining, resolved = MODULE.resolve_whitespace_only_same_date_groups(sources, missing)

    assert remaining == []
    assert resolved[0]["page"] == 3
    assert resolved[0]["ordinal"] == 32
    assert resolved[0]["matchMethod"] == "exact_title_whitespace_same_date"


def test_whitespace_rule_does_not_ignore_punctuation_difference():
    sources = [{**source("1950-06-02", 2, "标题甲"), "preservedOrdinal": 75}]
    missing = [{
        "date": "1950-06-02",
        "page": 3,
        "ordinal": 32,
        "title": "标题，甲",
    }]

    remaining, resolved = MODULE.resolve_whitespace_only_same_date_groups(sources, missing)

    assert remaining == sources
    assert resolved == []
